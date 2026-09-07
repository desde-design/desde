/**
 * Pure handlers for Editor's bridge-coupled tools. Shared between:
 *   - The in-process SDK MCP server ([editor-tools.ts](./editor-tools.ts)),
 *     which wraps these in `tool(...)` registrations.
 *   - The HTTP endpoint `POST /api/editor/mcp/tool/:name` exposed
 *     by editor-cli for the local `claude` CLI proxy.
 *
 * Keeping the handlers here ensures the two surfaces (SDK runtime and
 * stdio proxy) call identical code — change a bridge message shape
 * here and both paths track it. `propose_prop_edit` stays in
 * `editor-tools.ts` because it requires the orchestrator-supplied
 * `emitEdit` callback, which the proxy path does not have.
 *
 * The git/read-root/verification tools (`list_read_roots`, `list_commits`,
 * `read_file_at_commit`, `diff_file`, `search_external_files`,
 * `session_status`, `session_diff`, `run_verification`) live in
 * `read-root-tools.ts` (split out in Phase 4, share-readiness) — thin
 * adapters over the `agent-tools/git-tools.ts` +
 * `agent-tools/verification-tools.ts` `ToolEntry` instances.
 */
import { readFile } from 'node:fs/promises'

import { resolveRepoPath } from '../agent-tools/read-tools'
import type { BridgeClient } from '../agent-tools/types'
import type { ReviewSurface } from '../core/review-surface'
import type {
  EditExpectation,
  FailureCause,
  RenderAccessor,
  Measurements,
  VerificationResult,
  VerifyDeps,
} from '../verification'
// `translateGoal` is the LLM translate step (server-only — it imports the
// provider registry). NOT re-exported from the verification barrel (which the
// browser UI imports), so import it directly. `verifyGoal` IS barrel-safe (it
// takes `translate` as an injected dep). This handler file is server-side only.
import { translateGoal } from '../verification/translate-goal'
// NAMED import is correct here. This is a `.ts` module: the Next bundler resolves
// the re-export normally, and editor-cli's tsx loads it in a CJS context where
// `import { verifyRender }` compiles to a property read on `require(...)` that
// resolves the re-export at runtime (verified live + by probe — verifyEdit
// returns pass:true under tsx). The `.mts` live-smoke scripts need a DEFAULT
// import instead only because they run in a strict-ESM context where cjs-module-
// lexer can't see the index's re-exported names — a different module system, not
// this one. Do not "align" the two.
import { verifyRender, verifyGoal } from '../verification'

import { imageFromDataUrl } from './media-content'
import { locateSelectorRoute } from './locate-selector-route'

export interface EditorToolContext {
  bridge: BridgeClient
  signal?: AbortSignal
  /**
   * The agent's isolated review surface (CLI: a headless Playwright sidecar).
   * When present, the agent's view+drive operations — navigate, interact,
   * capture_screenshot, and the verify_edit / verify_goal DOM reads — run
   * against THIS surface instead of the bridge → user's live iframe, so the
   * agent reviewing its own work never disrupts the page the user is watching.
   * Absent (tests, non-CLI, or surface-boot failure) → the handlers fall back
   * to the bridge, preserving the prior single-surface behavior.
   * See [src/editor/core/review-surface.ts].
   */
  reviewSurface?: ReviewSurface
  /**
   * The project's resolved non-chat provider, for `verify_goal`'s translate
   * step — the only LLM touch in any tool handler. Absent (tests, non-CLI)
   * falls back to the registry's own default, which is the previous behaviour.
   */
  resolveLlmProvider?: () => import('../llm-providers/types').CompletionProvider
}

/**
 * Index signature is required so this type satisfies the SDK's
 * `CallToolResult`, which uses one for forward-compat with future
 * content fields. The wrapper `tool(...)` registration in
 * `editor-tools.ts` returns this directly to the SDK.
 *
 * Content is text-only — the common case for almost every tool. The one
 * exception (`capture_screenshot`) returns `EditorImageToolResult` below;
 * kept as a separate type so the dozens of `result.content[0].text` read sites
 * across handlers + tests stay type-safe instead of forcing a narrow on every
 * one for a single image-producing tool.
 */
export interface EditorToolResult {
  [k: string]: unknown
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/**
 * An MCP content block a tool can return. `image` is what `capture_screenshot`
 * returns so the SDK forwards it to the model as a vision input (`data` is
 * base64 WITHOUT the `data:` prefix).
 */
export type EditorContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/** Result variant for tools (only `capture_screenshot`) that emit an image. */
export interface EditorImageToolResult {
  [k: string]: unknown
  content: EditorContentBlock[]
  isError?: boolean
}

export interface PinSelectionsInput {
  selectors: string[]
}

export async function getSelection(
  ctx: EditorToolContext,
): Promise<EditorToolResult> {
  try {
    const result = await ctx.bridge.send('chat:get_selection', undefined, {
      signal: ctx.signal,
    })
    return {
      content: [{ type: 'text', text: JSON.stringify(result ?? null) }],
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: (err as Error).message }],
      isError: true,
    }
  }
}

export async function getPageInfo(
  ctx: EditorToolContext,
): Promise<EditorToolResult> {
  try {
    // When the agent drives an isolated surface, `navigate`/`interact` move THAT
    // surface — so "what page am I on" must report the surface's route, not the
    // user's live iframe. Otherwise the agent navigates the surface to /b but is
    // told it's still on the user's /a, desyncing route/state-dependent planning.
    const result = ctx.reviewSurface
      ? await ctx.reviewSurface.getPageInfo()
      : await ctx.bridge.send('chat:get_page_info', undefined, {
          signal: ctx.signal,
        })
    return {
      content: [{ type: 'text', text: JSON.stringify(result ?? null) }],
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: (err as Error).message }],
      isError: true,
    }
  }
}

/**
 * Navigate the prototype to `route` (Phase 1 of editor-creation-navigation.md).
 * A bridge-backed live-surface capability: the shell `chat:navigate` handler
 * posts the bridge NAVIGATE and resolves when the (re-injected, after a
 * cross-page hard reload) bridge reports the new route — so this is NOT a
 * within-one-bridge correlated round-trip; the resolution lives shell-side.
 * Longer timeout than the default since a cross-page nav reloads the iframe.
 */
export async function navigate(
  ctx: EditorToolContext,
  input: { route: string },
): Promise<EditorToolResult> {
  try {
    const result = ctx.reviewSurface
      ? await ctx.reviewSurface.navigate(input.route)
      : ((await ctx.bridge.send(
          'chat:navigate',
          { route: input.route },
          { signal: ctx.signal, timeoutMs: 20_000 },
        )) as { route?: string; alreadyThere?: boolean } | null)
    const where = result?.route ?? input.route
    return {
      content: [
        {
          type: 'text',
          text: result?.alreadyThere
            ? `Already on ${where}.`
            : `Navigated to ${where}.`,
        },
      ],
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Navigation failed: ${(err as Error).message}` }],
      isError: true,
    }
  }
}

export interface InteractInput {
  action: 'click' | 'fill' | 'select'
  /** ARIA role of the target (e.g. 'button', 'link', 'textbox'). */
  role?: string
  /** Accessible name / label of the target (e.g. 'Create model'). */
  name?: string
  /** Visible-text fallback when there's no accessible name. */
  text?: string
  /** Last-known-good selector to try first (replay cache). */
  selector?: string
  /** Value to type/select (fill / select actions). */
  value?: string
}

/**
 * Click / fill / select an element by SEMANTIC TARGET (Phase 3 of
 * editor-screenshot-flows.md). Two bridge round-trips over the Phase-2
 * capabilities: `chat:resolve_target` (the cheap a11y-resolve validity gate)
 * then `chat:perform_interact` (the act). On success it returns the RESOLVED
 * target (role + name + stable selector) so the agent can record it as a
 * `SemanticTarget` step in the screenshot plan it emits.
 */
export async function interact(
  ctx: EditorToolContext,
  input: InteractInput,
): Promise<EditorToolResult> {
  try {
    const resolved = ctx.reviewSurface
      ? await ctx.reviewSurface.resolveTarget({
          role: input.role,
          name: input.name,
          text: input.text,
          selector: input.selector,
        })
      : ((await ctx.bridge.send(
          'chat:resolve_target',
          { target: { role: input.role, name: input.name, text: input.text, selector: input.selector } },
          { signal: ctx.signal, timeoutMs: 15_000 },
        )) as { found?: boolean; selector?: string; role?: string; name?: string } | null)

    if (!resolved?.found || !resolved.selector) {
      const desc = input.name ?? input.text ?? input.role ?? '(unspecified)'
      return {
        content: [
          {
            type: 'text',
            text: `Could not resolve a ${input.action} target "${desc}" on the current page. It may not be rendered here. Navigate to the right page first, or refine role/name/text.`,
          },
        ],
        isError: true,
      }
    }

    const outcome = ctx.reviewSurface
      ? await ctx.reviewSurface.performInteract({
          selector: resolved.selector,
          action: input.action,
          value: input.value,
        })
      : ((await ctx.bridge.send(
          'chat:perform_interact',
          { selector: resolved.selector, action: input.action, value: input.value },
          { signal: ctx.signal, timeoutMs: 15_000 },
        )) as { ok?: boolean; error?: string } | null)

    if (!outcome?.ok) {
      return {
        content: [
          {
            type: 'text',
            text: `Resolved ${resolved.selector} but the ${input.action} failed: ${outcome?.error ?? 'unknown error'}.`,
          },
        ],
        isError: true,
      }
    }

    // Success — hand back the resolved target so the agent records it verbatim
    // (role + name + resolvedSelector) in the plan's SemanticTarget.
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            action: input.action,
            resolved: {
              role: resolved.role ?? input.role,
              name: resolved.name ?? input.name,
              resolvedSelector: resolved.selector,
            },
          }),
        },
      ],
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `interact failed: ${(err as Error).message}` }],
      isError: true,
    }
  }
}

export async function pinSelections(
  ctx: EditorToolContext,
  input: PinSelectionsInput,
): Promise<EditorToolResult> {
  try {
    const result = await ctx.bridge.send(
      'chat:pin_selections',
      { selectors: input.selectors },
      { signal: ctx.signal },
    )
    return {
      content: [{ type: 'text', text: JSON.stringify(result ?? null) }],
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: (err as Error).message }],
      isError: true,
    }
  }
}

export type CaptureScreenshotScope = 'viewport' | 'element' | 'selector'

export interface CaptureScreenshotInput {
  scope: CaptureScreenshotScope
  /** Required when scope is 'selector'; ignored otherwise. */
  selector?: string
}

/** Reply shape from the shell-side `chat:capture_screenshot` handler. */
interface CaptureScreenshotReply {
  dataUrl?: string
  width?: number
  height?: number
}

/**
 * Capture a screenshot of the running prototype and return it as a vision
 * input the model can see. Round-trips to the shell (`chat:capture_screenshot`,
 * which drives the bridge's html2canvas capture), then runs the resulting data
 * URL through the media-content service ([media-content.ts](./media-content.ts))
 * — the single image→model path that validates the format and enforces the
 * size cap.
 *
 * Failure modes are surfaced as `isError` text (so the agent can adjust scope
 * and retry) rather than throwing into the turn: a failed/timed-out capture, a
 * malformed reply, or an over-cap image (whose reason carries a scope-down
 * hint).
 */
export interface CaptureScreenshotContext extends EditorToolContext {
  /**
   * Absolute worktree root. When present, a `scope:'selector'` capture that
   * misses (the element isn't in the current page's DOM) triggers the
   * auto-navigate recovery: resolve the selector to its source + route, navigate
   * there, and retry. Absent (non-CLI contexts) → the miss is a clean error.
   */
  worktreeRoot?: string
}

/** A text-only error tool result. */
function errResult(text: string): EditorImageToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/**
 * Parse the shell handler's `[capture:<reason>] <message>` token (added in
 * editor-surface's `chat:capture_screenshot`). The reason lets the tool tell a
 * recoverable selector miss (`no-match`) from a real failure; the clean message
 * (token stripped) is what the agent sees.
 */
function parseCaptureError(message: string): { reason?: string; clean: string } {
  const m = message.match(/^\[capture:([a-z-]+)\]\s*([\s\S]*)$/)
  return m ? { reason: m[1], clean: m[2] } : { clean: message }
}

type RawCaptureResult =
  | { ok: true; result: EditorImageToolResult }
  | { ok: false; reason?: string; errorResult: EditorImageToolResult }

/**
 * Resolve the user's CURRENT selection to a CSS selector via the bridge.
 * scope:'element' means "the element the user has selected" — that lives in the
 * user's live iframe, not the agent's review surface, so we read it over the
 * bridge (user context) and then capture it by selector on the surface.
 */
async function resolveSelectionSelector(ctx: EditorToolContext): Promise<string | null> {
  try {
    const sel = (await ctx.bridge.send('chat:get_selection', undefined, {
      signal: ctx.signal,
    })) as { selector?: string } | null
    return sel?.selector ?? null
  } catch {
    return null
  }
}

/**
 * One capture + image validation against the agent's review surface, NO
 * recovery. `scope:'element'` is resolved to a selector by the caller
 * ({@link captureScreenshot}) before reaching here, so this only sees
 * viewport/selector.
 */
async function rawCaptureSurface(
  ctx: EditorToolContext,
  surface: ReviewSurface,
  input: CaptureScreenshotInput,
): Promise<RawCaptureResult> {
  let cap: Awaited<ReturnType<ReviewSurface['capture']>>
  try {
    cap = await surface.capture({ scope: input.scope, selector: input.selector })
  } catch (err) {
    return {
      ok: false,
      errorResult: errResult(
        `Screenshot capture failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    }
  }
  if (!cap.dataUrl) {
    return {
      ok: false,
      reason: cap.reason,
      errorResult: errResult(`Screenshot capture failed: ${cap.error ?? cap.reason ?? 'no image'}`),
    }
  }
  const parsed = imageFromDataUrl(cap.dataUrl)
  if (!parsed.ok) {
    return { ok: false, reason: 'unusable', errorResult: errResult(`Screenshot unusable: ${parsed.reason}`) }
  }
  const dims = cap.width && cap.height ? ` (${cap.width}×${cap.height})` : ''
  return {
    ok: true,
    result: {
      content: [
        { type: 'text', text: `Captured screenshot of scope '${input.scope}'${dims}.` },
        { type: 'image', data: parsed.image.data, mimeType: parsed.image.mimeType },
      ],
    },
  }
}

/** One capture round-trip + image validation, with NO recovery. */
async function rawCapture(
  ctx: EditorToolContext,
  input: CaptureScreenshotInput,
): Promise<RawCaptureResult> {
  if (ctx.reviewSurface) return rawCaptureSurface(ctx, ctx.reviewSurface, input)
  let reply: CaptureScreenshotReply | null
  try {
    reply = (await ctx.bridge.send(
      'chat:capture_screenshot',
      { scope: input.scope, selector: input.selector },
      {
        signal: ctx.signal,
        // The shell-side capture hook self-times-out at 15s; give the bridge
        // round-trip a wider window so the clean shell result wins the race.
        timeoutMs: 20_000,
      },
    )) as CaptureScreenshotReply | null
  } catch (err) {
    const { reason, clean } = parseCaptureError(err instanceof Error ? err.message : String(err))
    return { ok: false, reason, errorResult: errResult(`Screenshot capture failed: ${clean}`) }
  }
  if (!reply || !reply.dataUrl) {
    return { ok: false, reason: 'no-image', errorResult: errResult('Screenshot capture returned no image.') }
  }
  const parsed = imageFromDataUrl(reply.dataUrl)
  if (!parsed.ok) {
    return { ok: false, reason: 'unusable', errorResult: errResult(`Screenshot unusable: ${parsed.reason}`) }
  }
  const dims = reply.width && reply.height ? ` (${reply.width}×${reply.height})` : ''
  return {
    ok: true,
    result: {
      content: [
        { type: 'text', text: `Captured screenshot of scope '${input.scope}'${dims}.` },
        { type: 'image', data: parsed.image.data, mimeType: parsed.image.mimeType },
      ],
    },
  }
}

/** Best-effort current pathname from a `chat:get_page_info` reply. */
function pathFromPageInfo(info: unknown): string | undefined {
  if (!info || typeof info !== 'object') return undefined
  const o = info as Record<string, unknown>
  const direct = o.route ?? o.pathname ?? o.path
  if (typeof direct === 'string' && direct) return direct
  if (typeof o.url === 'string') {
    try {
      return new URL(o.url).pathname
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Navigate the prototype; resolves true when the nav didn't throw. */
async function tryNavigate(ctx: EditorToolContext, route: string): Promise<boolean> {
  try {
    if (ctx.reviewSurface) {
      await ctx.reviewSurface.navigate(route)
    } else {
      await ctx.bridge.send('chat:navigate', { route }, { signal: ctx.signal, timeoutMs: 20_000 })
    }
    return true
  } catch {
    return false
  }
}

/**
 * Recover a `no-match` selector capture by navigating to where the selector
 * actually lives, then retrying. Returns the captured image on success, a
 * source-grounded error when it can locate the selector but can't reach it, or
 * null when it has nothing better to offer than the original error.
 */
async function recoverByNavigating(
  ctx: EditorToolContext,
  worktreeRoot: string,
  selector: string,
): Promise<EditorImageToolResult | null> {
  let currentUrl: string | undefined
  try {
    currentUrl = pathFromPageInfo(
      ctx.reviewSurface
        ? await ctx.reviewSurface.getPageInfo()
        : await ctx.bridge.send('chat:get_page_info', undefined, { signal: ctx.signal }),
    )
  } catch {
    // best-effort — param fill / restore just degrade without it
  }

  let located: Awaited<ReturnType<typeof locateSelectorRoute>>
  try {
    located = await locateSelectorRoute({ worktreeRoot, selector, currentUrl })
  } catch {
    return null
  }
  // Nothing found in source → let the caller surface the original miss.
  if (!located.ok && located.sourceFiles.length === 0) return null

  // Try the navigable candidates (cap reloads). First one that yields the
  // element wins; leave the iframe there (that's the page the agent wants).
  const tried: string[] = []
  for (const url of located.navigableUrls.slice(0, 2)) {
    tried.push(url)
    if (!(await tryNavigate(ctx, url))) continue
    const retry = await rawCapture(ctx, { scope: 'selector', selector })
    if (retry.ok) {
      const note = {
        type: 'text' as const,
        text:
          `The selector wasn't on the page you were viewing${currentUrl ? ` (${currentUrl})` : ''}; ` +
          `auto-navigated to ${url} (renders ${located.sourceFiles.join(', ')}) and captured it there.`,
      }
      return { content: [note, ...retry.result.content] }
    }
  }
  // Couldn't capture after navigating — restore the user's page and explain.
  if (tried.length > 0 && currentUrl) await tryNavigate(ctx, currentUrl)

  const where = located.sourceFiles.length ? located.sourceFiles.join(', ') : 'an unknown source file'
  if (located.routes.length === 0) {
    return errResult(
      `Screenshot capture failed: "${selector}" is defined in ${where}, but no route renders that component ` +
        `(likely a child of a non-routed component). Navigate to the page that shows it, then capture again.`,
    )
  }
  const patterns = located.routes.map((r) => r.path).join(', ')
  if (located.navigableUrls.length === 0) {
    return errResult(
      `Screenshot capture failed: "${selector}" is defined in ${where}, rendered at ${patterns}. ` +
        `Those routes need params (e.g. an :id) I couldn't fill from the current page${currentUrl ? ` (${currentUrl})` : ''}. ` +
        `Navigate there with a concrete id, then capture again.`,
    )
  }
  return errResult(
    `Screenshot capture failed: "${selector}" is defined in ${where}. I navigated to ${tried.join(', ')} ` +
      `but it still wasn't capturable there. Check the route/state, then capture again.`,
  )
}

/**
 * Capture a screenshot of the running prototype and return it as a vision input
 * the model can see. Round-trips to the shell (`chat:capture_screenshot`), then
 * runs the data URL through the media-content service (the single image→model
 * path that validates format + enforces the size cap).
 *
 * Failure modes surface as `isError` text (so the agent can adjust scope and
 * retry) rather than throwing into the turn. The one exception is a
 * `scope:'selector'` MISS with worktree access: instead of erroring, the tool
 * resolves the selector to its source + route, navigates there, and retries —
 * see {@link recoverByNavigating}.
 */
export async function captureScreenshot(
  ctx: CaptureScreenshotContext,
  input: CaptureScreenshotInput,
): Promise<EditorImageToolResult> {
  // Surface + scope:'element': the user's selection lives in the user's live
  // iframe, not the agent's surface — resolve it to a selector via the bridge
  // UP FRONT, so the capture AND the no-match auto-navigate recovery both
  // operate on that selector. (The bridge path keeps handling 'element'
  // shell-side, so this translation is surface-only.) Without this, a selected
  // element that the agent's surface isn't currently showing would miss with no
  // recovery — see codex review.
  let effective = input
  if (ctx.reviewSurface && input.scope === 'element') {
    const sel = await resolveSelectionSelector(ctx)
    if (!sel) {
      return errResult(
        "Screenshot capture failed: nothing is selected. Select an element, or use scope:'selector' with a CSS selector.",
      )
    }
    effective = { scope: 'selector', selector: sel }
  }

  const first = await rawCapture(ctx, effective)
  if (first.ok) return first.result

  if (
    effective.scope === 'selector' &&
    effective.selector &&
    first.reason === 'no-match' &&
    ctx.worktreeRoot
  ) {
    const recovered = await recoverByNavigating(ctx, ctx.worktreeRoot, effective.selector)
    if (recovered) return recovered
  }
  return first.errorResult
}

// ─── verify_edit ───────────────────────────────────────────────────
//
// Expose the deterministic L2 render oracle (src/editor/verification) to the
// agent: after a value edit, confirm the change actually rendered in the live
// DOM, and — on mismatch — classify *why* so the agent can make a targeted
// correction (edit the binding, not the literal) instead of guessing. Reuses
// `verifyRender` verbatim; the only I/O is the bridge read
// (`chat:read_rendered_value`) and an optional worktree source-line read for
// failure classification.
//
// Scope is VALUE verification — `textContent` and `attribute`, which compare
// string-exact. Computed STYLE is deliberately NOT a verify_edit field: the
// bridge reads it back via getComputedStyle, which canonicalizes values
// (`red`→`rgb(255,0,0)`, `0.5rem`→px, shorthands expand), so a raw expected
// literal would false-fail. Style/layout is the VISUAL surface — the agent
// checks it with `capture_screenshot` (the plan's mode (b)).

/** Where on the matched element the edited value renders. */
export type VerifyEditField = 'textContent' | 'attribute'

export interface VerifyEditInput {
  /** Worktree-relative path of the SFC the edit rewrote (for failure classification). */
  file: string
  /** 1-based source line the edit touched (for failure classification). */
  line: number
  /** CSS selector for the element the value renders into. */
  selector: string
  /** The value you expect to observe in the live DOM (stringified as it should appear). */
  expectedValue: string
  /** How the value surfaces: element text or a DOM attribute. */
  field: VerifyEditField
  /** Attribute name — required when `field === 'attribute'` (e.g. "placeholder"). */
  attribute?: string
}

export interface VerifyEditContext extends EditorToolContext {
  /**
   * Absolute worktree root. When provided, the handler reads the edited
   * source line to classify *why* a mismatch happened (bound-binding /
   * v-model / dynamic-vbind …). Absent → classification degrades to DOM-state
   * heuristics (selector-missing / hmr-stale).
   */
  worktreeRoot?: string
  /**
   * Injectable clock for the L2 poll loop (`VerifyDeps.now`/`sleep`). Unset in
   * production (real timers); tests inject a virtual clock so the 3s poll /
   * 600ms confirm-stable waits are instant and immune to machine load.
   */
  verifyTiming?: Pick<VerifyDeps, 'now' | 'sleep'>
}

/** Action-oriented guidance per failure cause — turns the oracle's `cause` into a next step. */
const VERIFY_HINTS: Record<FailureCause, string> = {
  'bound-binding':
    'The value comes from a bound expression / component prop, not a literal: editing a literal attribute won\'t stick. Edit the bound expression or the ref/state it reads. If several props are bound and you\'re unsure which one renders this value, check the component manifest (get_component) to find the prop, then edit the state behind it.',
  'v-model':
    'The value is two-way bound via v-model. Change the bound state/ref that backs it, not a literal attribute.',
  'dynamic-vbind':
    'The value comes from a dynamic v-bind (`v-bind="…"` spread or `:[name]="…"`). Edit the source object/expression that supplies it.',
  conditional:
    'The element is conditionally rendered (v-if / v-show). It may not be in the DOM right now. Check the condition or that you are on the right route/state.',
  'css-hidden':
    'The element is present but hidden by CSS (display / visibility / clip). The edit may have applied. Verify visually with capture_screenshot.',
  'css-overridden':
    "The edit is in the source and parses, but another CSS rule owns this property. So nothing changed on screen. This is a scope problem, not a code problem: re-apply at a broader scope (patch the design token, or the stylesheet that declares the winning rule) instead of rewriting the same override. Don't add more specificity to the losing rule. If the winning rule is BOTH inside an `@layer` AND `!important` (e.g. a design system's layered utilities, or Tailwind's global important mode), specificity and a broader stylesheet scope cannot win it either: for `!important` declarations the cascade reverses and the EARLIEST layer wins, so an unlayered override is the weakest of all. The only remedies there are to emit the override into an earlier cascade layer than the winner's, or to edit the winning utility/rule directly.",
  'hmr-stale':
    "The source changed but the live DOM still shows the old value. Either HMR hasn't applied yet, the selector points at the wrong element, or the value is actually sourced elsewhere: if this is a component, the text/value may come from a bound prop, a ref, or a store; read the source and edit the binding/state that feeds it.",
  'selector-missing':
    'The target element was not found in the DOM. Check the selector, or whether the element is conditionally rendered (v-if/route).',
  unknown:
    'Could not determine why the value did not render. Inspect the source and the live DOM to find where the value actually comes from.',
}

/** Short present-state description per cause — keeps `detail` consistent with a refined `cause`. */
const CAUSE_SUMMARY: Record<FailureCause, string> = {
  'bound-binding': 'the value comes from a bound expression / component prop, not the literal',
  'v-model': 'the value is two-way bound via v-model',
  'dynamic-vbind': 'the value comes from a dynamic / spread v-bind',
  conditional: 'the element is conditionally rendered (v-if / v-show)',
  'css-hidden': 'the element is present but hidden by CSS',
  'css-overridden': 'another CSS rule wins the cascade for this property',
  'hmr-stale': "the change hasn't applied to the live DOM (HMR stale, wrong selector, or value sourced elsewhere)",
  'selector-missing': 'the target element was not found in the DOM',
  unknown: 'the cause could not be determined',
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether the element opened on this source line is a component (vs a native
 * HTML element): PascalCase or hyphenated tags. A component commonly renders a
 * bound PROP as its visible text (`<KButton :label="x"/>`); a native element's
 * text is slot text, which an attribute never feeds.
 */
function lineOpensComponent(line: string): boolean {
  const m = line.match(/<\s*([A-Za-z][\w.-]*)/)
  if (!m) return false
  const tag = m[1]
  return /[A-Z]/.test(tag[0]) || tag.includes('-')
}

/**
 * Field-aware failure classification for the agent's `verify_edit`.
 *
 * Mirrors the taxonomy of `verification/classify-failure.ts`. The agent ACTS on
 * the resulting `hint`, so the goal is to point it at the right fix without
 * over-claiming a *specific* prop we can't actually identify from a source line.
 *   - v-model / dynamic-or-spread v-bind shadow ANY surface (field-independent).
 *   - attribute edit → only the SPECIFIC `:attr=` binding for that attribute.
 *   - text edit → `{{ }}` / v-text / v-html provably bind text. ALSO: a
 *     COMPONENT whose start tag carries any bound attr is treated as likely
 *     bound — components routinely render a prop (label/title/…) as their text,
 *     and the common case this feature repairs is exactly a literal edit that
 *     can't stick because the text comes from a prop. We can't tell WHICH prop
 *     without the manifest, so the `bound-binding` hint sends the agent to
 *     get_component to identify it. A NATIVE element is NOT flagged from an
 *     attr: its slot text is never fed by `:class` etc., so an unrelated
 *     binding must not be blamed — that distinction (component vs native) is the
 *     one we *can* read from the line. (Precise prop→surface mapping is manifest
 *     territory, deferred — see tasks/editor-self-correct-loop-plan.md Phase 4.)
 * Falls through to DOM-state causes (conditional / selector-missing / hmr-stale)
 * otherwise — those hints still tell the agent to find where the value comes from.
 *
 * `sourceText` is the element's START-TAG window (its line plus following lines
 * up to the tag close), not a single line — so a binding on an adjacent line of
 * a multi-line tag (`<KButton\n  :label="title"\n/>`) is still seen.
 * `elementPresent` disambiguates a `null` read: when the element IS in the DOM
 * but the attribute/value is absent, it's not a missing selector.
 */
function classifyVerifyFailure(opts: {
  field: VerifyEditField
  attribute?: string
  sourceText: string | null
  observedValue: string | null
  /** True when the target element is in the DOM (probed when the read was null). */
  elementPresent?: boolean
}): FailureCause {
  const text = opts.sourceText ?? ''

  // Element absent → it's a selector / route / condition problem, NOT a binding
  // problem (a binding can't explain a value that has no element in the DOM). A
  // null read with no presence probe (or a failed probe) means absent; a
  // non-null read, or a successful presence probe, means present. Check this
  // BEFORE binding detection so a stale selector / unrendered component isn't
  // mislabeled `bound-binding`.
  const elementAbsent = opts.observedValue === null && !opts.elementPresent
  if (elementAbsent) {
    if (/\bv-(if|else-if|show)\b/.test(text) || /\bhidden\b/.test(text)) return 'conditional'
    return 'selector-missing'
  }

  // The element IS present (value present-but-wrong, or attr absent). Now a
  // binding can explain the failure — but only one that drives the checked
  // SURFACE. (A `v-model` feeding `value` doesn't explain a failed `placeholder`
  // edit; `:class` doesn't feed slot text on a native element.) Which exact prop
  // of a COMPONENT renders the text is manifest territory we don't have here, so
  // for component text we flag "bound" generically and let the hint send the
  // agent to get_component.
  const hasSpread = /\bv-bind\s*=/.test(text) || /:\[[^\]]+\]\s*=/.test(text)
  const hasPlainVModel = /\bv-model\s*=/.test(text) // v-model="…" (no argument)
  if (opts.field === 'attribute' && opts.attribute) {
    const attr = escapeRegExp(opts.attribute)
    if (new RegExp(`(?::|v-bind:)${attr}\\s*=`).test(text)) return 'bound-binding'
    if (new RegExp(`\\bv-model:${attr}\\s*=`).test(text)) return 'v-model'
    // A plain v-model drives the form-control value/checked only.
    if ((opts.attribute === 'value' || opts.attribute === 'checked') && hasPlainVModel) {
      return 'v-model'
    }
    if (hasSpread) return 'dynamic-vbind'
  } else if (opts.field === 'textContent') {
    if (/\{\{/.test(text) || /\bv-(text|html)\b/.test(text)) return 'bound-binding'
    // On a component, any binding on the tag is a plausible text source; on a
    // native element, slot text is never fed by an attr/v-model/spread.
    if (
      lineOpensComponent(text) &&
      (/(?::|v-bind:)[\w-]+\s*=/.test(text) || /\bv-model(:[\w-]+)?\s*=/.test(text) || hasSpread)
    ) {
      return 'bound-binding'
    }
  }

  // Element present but no surface-driving binding → the edit didn't apply.
  return 'hmr-stale'
}

function deriveAccessor(input: VerifyEditInput): RenderAccessor | { error: string } {
  if (input.field === 'attribute') {
    if (!input.attribute) {
      return { error: "field 'attribute' requires `attribute` (the attribute name)." }
    }
    return { kind: 'attr', name: input.attribute }
  }
  return { kind: 'text' }
}

/**
 * `verify_edit` — confirm a value edit reached the live DOM, and classify
 * the failure cause when it didn't.
 *
 * Round-trips to the bridge (`chat:read_rendered_value`) to read the current
 * rendered value and compares against `expectedValue` (with a short
 * confirm-stable recheck to defeat the live-override false-pass). The check is
 * **L2-only** (DOM is the oracle) — the same design as the React-side verifier:
 * we never gate on the source line, so a stale/approximate `line` (common for
 * Edit/Write rewrites) can't produce a spurious "literal not found" failure.
 * The source line is read *only* on an L2 failure, to classify the `cause`
 * (bound-binding / v-model / …) so the agent gets an actionable `hint`.
 *
 * Returns `{ pass, observed, expected, cause?, hint?, detail }` as JSON text —
 * or `{ skipped, reason }` when the live bridge is too old to answer
 * `READ_RENDERED_VALUE` (an ungated read would time out → false failure).
 *
 * Never throws — a reader error or unusable input is surfaced as `isError`
 * text so the agent can adjust and retry rather than failing the turn.
 */
export async function verifyEdit(
  ctx: VerifyEditContext,
  input: VerifyEditInput,
): Promise<EditorToolResult> {
  const accessor = deriveAccessor(input)
  if ('error' in accessor) {
    return { content: [{ type: 'text', text: `verify_edit: ${accessor.error}` }], isError: true }
  }
  if (!input.selector) {
    return {
      content: [{ type: 'text', text: 'verify_edit: a CSS selector is required.' }],
      isError: true,
    }
  }

  // One bridge read that doubles as a capability probe. The shell handler
  // returns `{ value, supported }`; `supported:false` means the live bridge
  // doesn't implement READ_RENDERED_VALUE (older than the verify bridge). In
  // that case we CANNOT verify — report skipped rather than poll to a timeout
  // and emit a false failure that would push the agent into a needless loop.
  let probe: { value?: string | null; supported?: boolean } | null
  try {
    probe = ctx.reviewSurface
      ? await ctx.reviewSurface.readRenderedValue(input.selector, accessor)
      : ((await ctx.bridge.send(
          'chat:read_rendered_value',
          { selector: input.selector, accessor },
          { signal: ctx.signal },
        )) as { value?: string | null; supported?: boolean } | null)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `verify_edit failed: ${msg}` }], isError: true }
  }
  if (probe?.supported === false) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            skipped: true,
            reason:
              "This prototype's bridge is too old to read live rendered values, so the edit can't be value-verified. Verify visually with capture_screenshot instead, or tell the user the change is in source but couldn't be auto-verified.",
            expected: input.expectedValue,
          }),
        },
      ],
    }
  }

  // Bridge-backed DOM read for the verify poll. Null = selector matched
  // nothing or the accessor had no value (the verifier treats that as a fail
  // with a `selector-missing` cause).
  const readRenderedValue = async (
    selector: string,
    acc: EditExpectation['accessor'],
  ): Promise<string | null> => {
    if (ctx.reviewSurface) {
      const reply = await ctx.reviewSurface.readRenderedValue(selector, acc)
      return reply.value ?? null
    }
    const reply = (await ctx.bridge.send(
      'chat:read_rendered_value',
      { selector, accessor: acc },
      { signal: ctx.signal },
    )) as { value?: string | null } | null
    return reply?.value ?? null
  }

  // L2-only: no `readSourceAt`, so verifyRender never runs the L1 presence
  // check. We classify the failure ourselves below using the actual source
  // line (advisory — a wrong line at worst yields a less-precise cause, never
  // a false failure).
  const expectation: EditExpectation = {
    editId: 'verify_edit',
    label: `${input.field === 'attribute' ? input.attribute : input.field} = ${JSON.stringify(input.expectedValue)}`,
    selector: input.selector,
    accessor,
    expectedValue: input.expectedValue,
    provenance: 'deterministic',
  }

  let result
  try {
    result = await verifyRender(expectation, {
      readRenderedValue,
      pollIntervalMs: 150,
      timeoutMs: 3000,
      // The agent path may verify after propose_prop_edit, which applies an
      // instant DOM override before HMR rewrites source. Re-check after a window
      // that outlasts HMR so a reverted override fails honestly. Matches the
      // React verifier's tuned CONFIRM_STABLE_MS (useEditVerification.ts) — kept
      // in lockstep so both surfaces survive the same slow-HMR revert window.
      confirmStableMs: 600,
      ...ctx.verifyTiming,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `verify_edit failed: ${msg}` }], isError: true }
  }

  const pass = result.status === 'pass'
  // On failure, refine the cause using the edited element's start-tag window so
  // the agent gets an actionable hint (e.g. bound-binding → edit the ref). The
  // source read is path-traversal guarded and best-effort; if it fails we keep
  // verifyRender's DOM-only classification.
  let cause: FailureCause | undefined = result.status === 'fail' ? result.cause : undefined
  if (result.status === 'fail' && ctx.worktreeRoot) {
    const sourceText = await readSourceTagWindow(ctx.worktreeRoot, input.file, input.line)
    if (sourceText != null) {
      // Disambiguate a null read: probe whether the element is in the DOM at all
      // (a present element with an absent attribute is NOT a missing selector).
      // Only needed when the value came back null; cheap text read of the same
      // selector ('' for an empty element ⇒ present; null ⇒ truly missing).
      let elementPresent: boolean | undefined
      if ((result.observedValue ?? null) === null) {
        elementPresent = (await readRenderedValue(input.selector, { kind: 'text' })) !== null
      }
      cause = classifyVerifyFailure({
        field: input.field,
        attribute: input.attribute,
        sourceText,
        observedValue: result.observedValue ?? null,
        elementPresent,
      })
    }
  }
  // `detail` must agree with the FINAL cause. verifyRender computed its detail
  // from its own DOM-only classification; if we refined the cause from the
  // source window, that detail now contradicts `cause` — rebuild it so the
  // agent never gets `cause: "bound-binding"` next to an HMR-failure detail.
  const detail =
    result.status === 'fail' && cause && cause !== result.cause
      ? `Did not take effect: expected ${JSON.stringify(input.expectedValue)}, DOM shows ${JSON.stringify(
          result.observedValue ?? null,
        )} (${CAUSE_SUMMARY[cause]}).`
      : result.detail
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          pass,
          observed: result.observedValue ?? null,
          expected: result.expectedValue,
          ...(cause ? { cause, hint: VERIFY_HINTS[cause] } : {}),
          detail,
        }),
      },
    ],
  }
}

// ─── verify_goal ───────────────────────────────────────────────────
//
// The L3a rung of the verification ladder (tasks/editor-edit-verification.md
// P2): for a FUZZY / measurable layout goal ("make this fit the content width",
// "align this with .header", "match the size of .card", "enough contrast"),
// compile the goal to a measurable predicate and judge it DETERMINISTICALLY.
//
// The boundary is load-bearing: the LLM only *translates* the goal into
// predicates (`translateGoal`); pure code *judges* them (`predicates.ts`). The
// only I/O is the bridge measurement read (`chat:read_measurements`).
//
// This complements the other two verify surfaces:
//   - verify_edit  — exact value (text / attribute), string-compared.
//   - capture_screenshot — purely visual / aesthetic judgment (vision).
//   - verify_goal  — a measurable geometric/contrast goal, judged by code.

export interface VerifyGoalInput {
  /** The fuzzy / NL goal, e.g. "make this fit the content width". */
  goal: string
  /** CSS selector of the primary element the goal is about (from get_selection). */
  selector: string
}

/**
 * `verify_goal` — confirm a fuzzy/measurable layout goal actually holds in the
 * live DOM, judged deterministically.
 *
 * Probes `chat:read_measurements` once (doubles as the bridge capability gate:
 * `supported:false` ⇒ the live bridge is too old for READ_MEASUREMENTS ⇒
 * `{ skipped }` rather than a false failure). Then composes the LLM translator
 * + the pure predicate judge via `verifyGoal`. Returns
 * `{ pass, status, detail }` — or `{ skipped, reason }` when the goal isn't
 * measurable (purely aesthetic → use capture_screenshot) or the DOM can't be read.
 *
 * Never throws — verification is best-effort; a reader/translate error surfaces
 * as `isError` text so the agent can adjust rather than failing the turn.
 */
export async function verifyGoalTool(
  ctx: EditorToolContext,
  input: VerifyGoalInput,
): Promise<EditorToolResult> {
  if (!input.goal || !input.goal.trim()) {
    return { content: [{ type: 'text', text: 'verify_goal: a goal is required.' }], isError: true }
  }
  if (!input.selector) {
    return { content: [{ type: 'text', text: 'verify_goal: a CSS selector is required.' }], isError: true }
  }

  // One read that doubles as a capability probe (mirrors verify_edit).
  let probe: { measurements?: Measurements | null; supported?: boolean } | null
  try {
    probe = ctx.reviewSurface
      ? await ctx.reviewSurface.readMeasurements(input.selector)
      : ((await ctx.bridge.send(
          'chat:read_measurements',
          { selector: input.selector },
          { signal: ctx.signal },
        )) as { measurements?: Measurements | null; supported?: boolean } | null)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `verify_goal failed: ${msg}` }], isError: true }
  }
  if (probe?.supported === false) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            skipped: true,
            reason:
              "This prototype's bridge is too old to read live measurements, so the goal can't be measured. Verify visually with capture_screenshot instead.",
            goal: input.goal,
          }),
        },
      ],
    }
  }

  // Bridge-backed measurement read for the verifier. Null = no match / read
  // failure (verifyGoal degrades the affected predicate to indeterminate).
  const readMeasurements = async (
    selector: string,
    signal?: AbortSignal,
  ): Promise<Measurements | null> => {
    if (ctx.reviewSurface) {
      const reply = await ctx.reviewSurface.readMeasurements(selector)
      return reply.measurements ?? null
    }
    const reply = (await ctx.bridge.send(
      'chat:read_measurements',
      { selector },
      { signal },
    )) as { measurements?: Measurements | null } | null
    return reply?.measurements ?? null
  }

  let result: VerificationResult
  try {
    result = await verifyGoal(
      { editId: 'verify_goal', goal: input.goal, selector: input.selector },
      {
        // The only LLM touch in this tool. The provider comes from the CLI's
        // per-request `resolveLlmConfig`, so a project that names a provider in
        // `.desde/config.json` gets it here too rather than only in the five
        // route-driven lanes.
        translate: (args) =>
          translateGoal({
            ...args,
            signal: ctx.signal,
            ...(ctx.resolveLlmProvider ? { resolveProvider: ctx.resolveLlmProvider } : {}),
          }),
        readMeasurements,
        signal: ctx.signal,
      },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `verify_goal failed: ${msg}` }], isError: true }
  }

  if (result.status === 'skipped') {
    // A translate-step INFRASTRUCTURE failure (LLM auth / refusal / bad output)
    // is NOT a benign "use a screenshot" skip — surface it as an actionable
    // error so a broken provider config doesn't silently degrade verification.
    if (result.skipReason === 'translate-error') {
      return {
        content: [{ type: 'text', text: `verify_goal could not run: ${result.detail}` }],
        isError: true,
      }
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            skipped: true,
            reason: result.detail,
            goal: input.goal,
            hint: 'Not measurable as a predicate (likely purely aesthetic, or the element/secondary target could not be measured). Verify visually with capture_screenshot.',
          }),
        },
      ],
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          pass: result.status === 'pass',
          status: result.status,
          goal: input.goal,
          detail: result.detail,
        }),
      },
    ],
  }
}

/**
 * Safety-net cap on the start-tag scan in each direction. The real bound is the
 * tag boundary (`<Tag` backward, `>` forward); this just stops a runaway scan
 * if those markers are missing. Generous so a design-system component with many
 * props (each on its own line) isn't truncated below its bound prop.
 */
const TAG_WINDOW_MAX_LINES = 60

/**
 * Read the full START-TAG window around `line` from the worktree for failure
 * classification — the element's opening tag, which may span multiple lines.
 * The agent may report ANY line of the tag (the `<Tag` line OR an attribute
 * line), so we scan **both** directions from `line`:
 *   - backward to the line that opens the tag (`<Tag`), bailing if we cross a
 *     prior tag's close first (the edited line isn't inside a start tag then);
 *   - forward to the line that closes the start tag (`>` / `/>`).
 * Each capped at {@link TAG_WINDOW_MAX_LINES}. This captures bindings anywhere
 * in a multi-line tag (`<KButton\n  label="x"\n  :label="title"\n/>`) that a
 * single-line read would miss. Path-traversal guarded; resolves null on any
 * read problem so classification degrades to DOM-only signals rather than
 * throwing.
 */
async function readSourceTagWindow(
  worktreeRoot: string,
  file: string,
  line: number,
): Promise<string | null> {
  const safe = await resolveRepoPath(worktreeRoot, file)
  if (!safe.ok) return null
  let lines: string[]
  try {
    lines = (await readFile(safe.absolute, 'utf8')).split('\n')
  } catch {
    return null
  }
  const start = line - 1
  if (start < 0 || start >= lines.length) return null
  // Boundary detection ignores `<`/`>` inside quoted attribute values, so a
  // bound expression like `:disabled="count > 0"` doesn't read as a tag close
  // (codex) and `:foo="a < b"` doesn't read as a tag open.
  const unquoted = (s: string): string => s.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '')
  const opensTag = (s: string): boolean => /<\s*[A-Za-z][\w.-]*/.test(unquoted(s))
  const closesTag = (s: string): boolean => unquoted(s).includes('>')

  // Backward to the tag's opening line.
  let top = start
  for (let i = start, steps = 0; i >= 0 && steps < TAG_WINDOW_MAX_LINES; i--, steps++) {
    if (opensTag(lines[i])) { top = i; break }
    // A `>` on a line ABOVE the edited one closes a prior tag — stop here so we
    // don't pull an unrelated element's attributes into the window.
    if (i < start && closesTag(lines[i])) { top = i + 1; break }
    top = i
  }
  // Forward to the start tag's close.
  let bottom = start
  for (let i = start, steps = 0; i < lines.length && steps < TAG_WINDOW_MAX_LINES; i++, steps++) {
    bottom = i
    if (closesTag(lines[i])) break
  }
  return lines.slice(top, bottom + 1).join('\n')
}

export interface AskUserQuestionInput {
  question: string
  options: string[]
  multiSelect?: boolean
}

/**
 * Asks the user a multiple-choice question and waits for their answer.
 *
 * Emits a `bridge_request` SSE event with messageType `ask_user_question`.
 * The shell renders an inline choice UI; the user's click resolves the
 * request. Uses a 10-minute timeout to accommodate human think-time;
 * aborting the turn (Stop button) cancels the pending question.
 *
 * Wire contract:
 *   Payload sent → `{ question, options, multiSelect }`
 *   Expected reply → `{ selected: string[] }` (1-element for single-select)
 */
export async function askUserQuestion(
  ctx: EditorToolContext,
  input: AskUserQuestionInput,
): Promise<EditorToolResult> {
  if (!input.options || input.options.length === 0) {
    return {
      content: [{ type: 'text', text: 'ask_user_question failed: options must be a non-empty array' }],
      isError: true,
    }
  }
  try {
    const result = await ctx.bridge.send(
      'ask_user_question',
      {
        question: input.question,
        options: input.options,
        multiSelect: input.multiSelect ?? false,
      },
      {
        signal: ctx.signal,
        timeoutMs: 600_000, // 10-minute human-response window
      },
    )
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `ask_user_question failed: ${msg}` }],
      isError: true,
    }
  }
}

