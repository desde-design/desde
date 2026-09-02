/**
 * In-process MCP server exposing Editor's domain-specific tools to
 * the Claude Agent SDK. Mirrors the bridge-coupled tools from the
 * legacy `agent-tools/` registry — `read_file`, `list_files`,
 * `search_files`, `propose_overwrite`, `propose_new_file` are dropped
 * in favor of the SDK's built-in `Read`, `Glob`, `Grep`, `Edit`, and
 * `Write`. See Phase 1 spec, "Tool mapping" section.
 *
 * The server runs in the same Node process as the SDK runtime — no
 * subprocess, no transport overhead. Its tools become available to the
 * model under the namespace `mcp__editor__<toolname>`.
 *
 * Tool inventory:
 *   - get_selection / get_page_info / pin_selections — round-trip to
 *     the iframe via the bridge.
 *   - propose_prop_edit — emits a chat-UI proposal that lives on as a
 *     DOM overlay until Save flushes it.
 *   - list_read_roots / list_commits / read_file_at_commit /
 *     diff_file / search_external_files — read-only access to the
 *     worktree and declared external repos. The built-in `Read` is
 *     worktree-scoped (see `edit-ack.ts`); externals MUST go through
 *     these tools so reads are commit-bound and reproducible across
 *     turns.
 *
 * Handlers live in sibling files so the `desde-mcp` HTTP
 * proxy can call the identical code: bridge-round-trip + verify/ask
 * handlers in `editor-tool-handlers.ts`, the read-root/git/verification
 * family in `read-root-tools.ts`, and the filesystem-structural write
 * tools (delete/rename/insert/scaffold/manage-package) in
 * `fs-structural-tools.ts`. This file keeps the `tool()` schema
 * declarations and wires them to those handlers. `propose_prop_edit` is
 * the exception — it needs the orchestrator's `emitEdit` callback, which
 * only exists inside the SDK runtime.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

import type {
  BridgeClient,
  EditProposalPayload,
} from '../agent-tools/types'
import { saveScreenshotPlanHandler } from './save-screenshot-plan-tool'
import { healPlanStepHandler } from './heal-plan-step-tool'
import type { ScreenshotPlanStep } from '../core'
import type { PackageManagerAdapter } from '../core/package-manager-adapter'
import type { ReadRootRegistry } from '../core/read-roots'
import type { VerificationAdapter } from '../core/verification-adapter'
import {
  deleteFileHandler,
  downloadAssetHandler,
  insertComponentHandler,
  insertElementHandler,
  managePackageHandler,
  renameFileHandler,
  scaffoldRouteHandler,
} from './fs-structural-tools'
import { askUserQuestion, verifyEdit, verifyGoalTool } from './editor-tool-handlers'
import {
  diffFile,
  listCommits,
  listReadRoots,
  readFileAtCommit,
  runVerification,
  searchExternalFiles,
  sessionDiff,
  sessionStatus,
} from './read-root-tools'
import { LIVE_SURFACE_CAPABILITIES } from './live-surface-registry'
import {
  getComponent as getComponentTool,
  getDesignTokens as getDesignTokensTool,
  listComponents as listComponentsTool,
  searchComponents as searchComponentsTool,
  type GetGrounding,
} from './grounding-tools'

/**
 * Result the orchestrator's `emitEdit` returns to the tool handler.
 * Matches the legacy orchestrator's `emitEdit` signature so worktree-
 * session mode's "fire-and-forget" emit (return ok immediately, user
 * acks the whole session on Save) drops in unchanged.
 */
export type EmitEditResult =
  | { ok: true; editId: string }
  | { ok: false; reason: string }

export interface BuildEditorToolServerOpts {
  bridge: BridgeClient
  signal?: AbortSignal
  emitEdit: (payload: EditProposalPayload) => Promise<EmitEditResult>
  /**
   * Read-root registry for the session. When undefined, the git/read-
   * root tools still register but return a clean "not configured"
   * error when invoked — matches the legacy orchestrator's behavior
   * for sessions without a `desde.config.json`.
   */
  readRoots?: ReadRootRegistry
  /**
   * Worktree session's pinned base commit. Powers `session_status` /
   * `session_diff` (answer "what has THIS session changed against its
   * base"). When undefined those tools register but return a clean
   * "requires a worktree session" error — non-worktree-session runs.
   */
  rootCommitSha?: string
  /**
   * Substrate-neutral verification runner. Powers `run_verification`.
   * Absent in non-CLI contexts; the tool then surfaces a clean
   * "not configured" error.
   */
  verificationAdapter?: VerificationAdapter
  /**
   * Absolute path of the repo root the SDK is editing — in branch mode
   * (the only edit substrate) this is the user's working tree, edited
   * in place. Powers the structural write tools (`delete_file`,
   * `rename_file`, `insert_component`, `insert_element`,
   * `scaffold_route`, `manage_package`). Required when those tools are
   * to function; their handlers refuse with "not configured" otherwise.
   * There is no per-op commit — edits are ordinary uncommitted
   * working-tree changes; undo comes from the per-edit backup journal
   * (`.desde/backups/`, see backup-journal.ts).
   */
  worktreeRoot?: string
  /**
   * Deterministically replays a editor write into the Vite dev
   * pipeline (the CLI wires `invalidateViteModules`) so the dev server
   * re-serves the file immediately instead of waiting on the OS
   * watcher, which can drop/delay events under load. Called with
   * repo-relative paths after each successful structural write.
   * Optional — absent (tests / non-CLI), the OS watcher remains the
   * only signal, matching SDK Write/Edit behavior.
   */
  invalidateFiles?: (files: string[]) => void
  /**
   * A2 (round-2 whole-branch review finding, 2026-08-19): orders each
   * structural write tool's `brokeredWrite` call — including its
   * edit-ledger append — against a concurrent Commit/Publish/branch
   * mutation. The six structural tools call `brokeredWrite` directly
   * with no outer tree-gate wrapping of their own (unlike the CLI edit
   * route, which already wraps its OWN `brokeredWrite` call at the route
   * layer), so without this their ledger rows were never ordered against
   * `withTreeLock` at all. Optional; the CLI supplies
   * `acquireTreeGateShared` (`editor-cli/src/server/session-lock.ts`).
   * See `AcquireTreeGate`'s doc comment in `write-broker.ts` for the full
   * layering reasoning.
   */
  acquireTreeGate?: import('./write-broker').AcquireTreeGate
  /**
   * The prototype's web policy. `download_asset` reuses its host allowlist —
   * downloads add no trust surface beyond what the user already granted
   * WebFetch.
   */
  webPolicy?: import('../core/web-policy').WebPolicy
  /**
   * Substrate-neutral package-manager adapter. Powers `manage_package`.
   * Absent in non-CLI contexts; the tool then surfaces a clean
   * "not configured" error.
   */
  packageManagerAdapter?: PackageManagerAdapter
  /**
   * Lazily resolves the shared design-system {@link GroundingService} (the
   * SAME memoized instance the inspector endpoints use). When provided, the
   * read-only grounding query tools (`list_components`, `get_component`,
   * `search_components`, `get_design_tokens`) are registered so the agent is
   * grounded in the prototype's real components + tokens. Absent → the tools
   * are not registered (no design-system grounding available).
   */
  getGrounding?: GetGrounding
  /**
   * The agent's isolated review surface (CLI: a headless Playwright sidecar).
   * When present, the view+drive tools (navigate / interact / capture_screenshot)
   * and the verify_edit / verify_goal DOM reads run against this surface instead
   * of the bridge → user's live iframe, so the agent reviewing its own work
   * never disrupts the page the user is watching. Absent → bridge (prior
   * behavior). See [src/editor/core/review-surface.ts].
   */
  reviewSurface?: import('../core/review-surface').ReviewSurface
  /**
   * Gate for the canvas + screenshot-plan surface's two plan-authoring
   * tools (`save_screenshot_plan`, `heal_plan_step`). DORMANT by product
   * decision 2026-08-04 — the surface is undertested, so it's default
   * OFF pending further investment (see CLAUDE.md § "Screenshot Capture").
   * Absent/false → the tools are not registered (mirrors the
   * `getGrounding` gate above). Set `editor.canvas: true` in
   * `.desde/config.json` (or `EDITOR_CANVAS=1`) to
   * restore — all handler code, tests, and smoke harnesses stay intact;
   * only registration is gated.
   */
  canvasEnabled?: boolean
}

/**
 * Build the in-process MCP server. Each tool's description is the same
 * as the legacy registry so the model's tool-selection prompt context
 * stays identical across the migration.
 */
export function buildEditorToolServer(
  opts: BuildEditorToolServerOpts,
): McpSdkServerConfigWithInstance {
  const {
    bridge,
    signal,
    emitEdit,
    readRoots,
    rootCommitSha,
    verificationAdapter,
    worktreeRoot,
    invalidateFiles,
    webPolicy,
    packageManagerAdapter,
    getGrounding,
    reviewSurface,
    canvasEnabled,
    acquireTreeGate,
  } = opts
  const rootCtx = { bridge, signal, readRoots, rootCommitSha, verificationAdapter }

  // Read-only design-system grounding tools — registered only when a
  // GroundingService resolver is available (CLI/worktree-session mode). The
  // agent uses these to enumerate real components/props/variants/tokens rather
  // than guessing. Spread into the tools array below.
  const groundingTools = getGrounding
    ? [
        tool(
          'list_components',
          "List the design-system components available in this prototype (name, design system, description). Call this to discover what you can build with before writing markup — prefer real catalog components over inventing raw HTML/CSS.",
          {},
          () => listComponentsTool(getGrounding),
        ),
        tool(
          'get_component',
          "Get a component's full manifest: its props (name, type, required, default, description, and `control.options` — the allowed VARIANT values), slots, events, import path, and rendering hints. Call this before setting a prop or choosing a variant so you use real prop names and valid values, not guesses.",
          {
            name: z
              .string()
              .describe(
                'Exact component name (e.g. "UiButton"). Use list_components / search_components first if unsure.',
              ),
          },
          (input) => getComponentTool(getGrounding, input),
        ),
        tool(
          'search_components',
          'Find components whose name or description matches a substring. Use to locate the right component when you only know roughly what you want (e.g. "modal", "select").',
          {
            query: z.string().describe('Case-insensitive substring to match.'),
          },
          (input) => searchComponentsTool(getGrounding, input),
        ),
        tool(
          'get_design_tokens',
          "List the prototype's design tokens (name, value, category, subcategory, description). Optionally filter by category. Use a token (e.g. `--acme-color-background-primary`) instead of hardcoding a hex/px value whenever one exists.",
          {
            category: z
              .string()
              .optional()
              .describe(
                'Optional category filter: color | space | font-size | font-weight | line-height | border-radius | border-width | shadow | other.',
              ),
          },
          (input) => getDesignTokensTool(getGrounding, input),
        ),
      ]
    : []

  // Grounded WRITE tool — insert a catalog component. Gated on grounding for
  // the same reason as the query tools above: without a manifest it can only
  // refuse, so don't surface it. Spread into the tools array below.
  const insertComponentTools = getGrounding
    ? [
        tool(
          'insert_component',
          "Insert a design-system component as a child of a target element. Goes through the deterministic edit pipeline and AUTO-ADDS the component's import — prefer this over rewriting the whole SFC with Edit/Write when adding a component instance. First resolve the component with list_components / search_components / get_component (so you use a real catalog component), then identify the DESTINATION PARENT element (the container the new node goes inside) with get_selection and pass its source file + line + column. The change is written to the working tree immediately (uncommitted — the user commits it). For complex/bound props or restructuring, insert plainly here then refine with propose_prop_edit or Edit.",
          {
            componentName: z
              .string()
              .describe('Exact catalog component name (e.g. "UiButton"). Must exist in the design system — check with get_component first; insertion is refused otherwise.'),
            file: z
              .string()
              .describe('Worktree-relative path of the SFC that contains the destination parent (from get_selection).'),
            line: z
              .number()
              .int()
              .describe("1-based source line of the DESTINATION PARENT element (the container the component becomes a child of), from get_selection's source location."),
            column: z
              .number()
              .int()
              .describe('1-based source column of the destination parent element (from get_selection).'),
            destIndex: z
              .number()
              .int()
              .optional()
              .describe("0-based index among the parent's element children. Omit or pass -1 to append at the end."),
            props: z
              .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
              .optional()
              .describe('Attributes for the inserted component. Strings become literal attrs (`k="v"`); numbers/booleans become bound attrs (`:k="…"`). For bound expressions / v-model, insert plainly then use Edit.'),
            text: z
              .string()
              .optional()
              .describe('Optional default-slot text content. Omit for a self-closing element.'),
          },
          ({ componentName, file, line, column, destIndex, props, text }) =>
            insertComponentHandler({
              worktreeRoot,
              invalidateFiles,
              emitEdit,
              getGrounding,
              input: { componentName, file, line, column, destIndex, props, text },
              acquireTreeGate,
            }),
        ),
      ]
    : []

  // Canvas + screenshot-plan surface — DORMANT by product decision
  // 2026-08-04 (undertested, deliver editor sooner, invest later — see
  // CLAUDE.md § "Screenshot Capture"). Gated on `canvasEnabled`, same
  // conditional-registration pattern as `groundingTools` /
  // `insertComponentTools` above. Set `editor.canvas: true` in
  // `.desde/config.json` (or `EDITOR_CANVAS=1`) to
  // restore — the handlers (`saveScreenshotPlanHandler`,
  // `healPlanStepHandler`), replay/heal plumbing, and their tests are
  // untouched; only registration is skipped.
  const screenshotPlanTools = canvasEnabled
    ? [
        tool(
          'save_screenshot_plan',
          "Save a durable SCREENSHOT PLAN after walking a flow live. Use this when the user asks to 'capture/snapshot a flow' or 'make screenshots of going through X'. First WALK the flow with navigate + interact + capture_screenshot to confirm each step works and to capture the resolved targets; THEN call this once with the full ordered steps. Each step is one of: navigate {kind:'navigate', route}, interact {kind:'interact', action, target:{role,name,text,description,resolvedSelector}}, or capture {kind:'capture', capture:{scope:'viewport'|'selector', selector?, label}}. The plan is validated and written to .desde/screenshot-plans/<id>.json so it can be replayed deterministically later (no LLM); the shell then replays it and persists the captured screens as frames on the workspace Canvas. Put the resolvedSelector each interact tool returned into that step's target so replay is fast.",
          {
            name: z.string().describe("Short human name for the plan, e.g. 'Create a model'."),
            baseUrl: z
              .string()
              .describe("The prototype's base URL the plan replays against — use the current page's origin (from get_page_info)."),
            prompt: z
              .string()
              .optional()
              .describe('The original natural-language description of the flow, if the user gave one.'),
            steps: z
              .array(
                z.object({
                  intent: z.string().describe('Short NL description of this step.'),
                  kind: z.enum(['navigate', 'interact', 'capture']),
                  route: z.string().optional().describe("kind='navigate': the pathname (+optional hash)."),
                  action: z.enum(['click', 'fill', 'select']).optional().describe("kind='interact'."),
                  target: z
                    .object({
                      role: z.string().optional(),
                      name: z.string().optional(),
                      text: z.string().optional(),
                      description: z.string().describe('NL intent — what the healer re-resolves against.'),
                      resolvedSelector: z.string().optional().describe('The selector the interact tool returned (replay cache).'),
                    })
                    .optional()
                    .describe("kind='interact': the semantic target."),
                  value: z.string().optional().describe("kind='interact' (fill/select): the value."),
                  capture: z
                    .object({
                      scope: z.enum(['viewport', 'selector']),
                      selector: z.string().optional(),
                      label: z.string().describe('Human label for this screenshot.'),
                    })
                    .optional()
                    .describe("kind='capture'."),
                }),
              )
              .describe('The ordered flow steps (navigate / interact / capture).'),
          },
          ({ name, baseUrl, prompt, steps }) =>
            saveScreenshotPlanHandler({
              worktreeRoot,
              input: {
                name,
                baseUrl,
                prompt,
                steps: steps as unknown as ScreenshotPlanStep[],
              },
            }),
        ),

        tool(
          'heal_plan_step',
          "Repair a BROKEN interact step in a saved screenshot plan (its cached element no longer resolves during replay). First navigate to the step's page and re-find the element the step's `description` refers to; then call this with `planId`, `stepIndex`, and the re-identified semantic `target` (role + name). The tool INDEPENDENTLY resolves your target on the live page and VALIDATES it matches the step's original intent before writing the new selector back — it does NOT trust your word. If it REJECTS (role mismatch / unrelated element / not found), your target was wrong: pick the element the description actually means, or tell the user the element is gone. Don't call it more than ~3 times for the same step.",
          {
            planId: z.string().describe('The screenshot plan id (the <id> in .desde/screenshot-plans/<id>.json).'),
            stepIndex: z.number().int().describe('0-based index of the broken interact step in the plan.'),
            target: z
              .object({
                role: z.string().optional().describe("ARIA role of the element, e.g. 'button'."),
                name: z.string().optional().describe('Accessible name / visible label you re-identified.'),
                text: z.string().optional().describe('Visible-text fallback.'),
              })
              .describe('The semantic target you re-found for the broken step.'),
          },
          ({ planId, stepIndex, target }) =>
            healPlanStepHandler({
              worktreeRoot,
              bridge,
              signal,
              input: { planId, stepIndex, target },
            }),
        ),
      ]
    : []

  return createSdkMcpServer({
    name: 'editor',
    version: '1',
    tools: [
      // Live-surface (bridge round-trip) tools — selection / page-info / pin,
      // registered from the registry rail (live-surface-registry.ts) so a new
      // bridge tool (screenshot, navigate) is a single entry there, not an
      // inline wire + a hand-added name.
      ...LIVE_SURFACE_CAPABILITIES.map((cap) =>
        tool(cap.name, cap.description, cap.inputSchema, (input) =>
          cap.run({ bridge, signal, worktreeRoot, reviewSurface }, input),
        ),
      ),

      tool(
        'propose_prop_edit',
        "Propose a prop/attribute change on the currently-selected component. Live-previews in the iframe immediately via a DOM overlay; flushed to the worktree on Save. Use this for simple value changes that don't require rewriting source code. For complex shape changes, use the Edit tool to rewrite the source file directly.",
        {
          selector: z
            .string()
            .describe(
              'CSS selector for the target element. Use `get_selection` first and pass its `selector` back here verbatim.',
            ),
          targetId: z
            .string()
            .optional()
            .describe(
              'Stable bridge target id from `get_selection.targetId`. Optional but recommended — drift detection prefers this over the selector when both are present.',
            ),
          propName: z
            .string()
            .describe(
              'Name of the prop or attribute to set on the component (e.g. "variant", "size", "disabled").',
            ),
          value: z
            .union([z.string(), z.number(), z.boolean(), z.null()])
            .describe(
              'New value for the prop. Must be a string, number, boolean, or null. For complex props or template restructuring use the Edit tool on the source file instead.',
            ),
        },
        async ({ selector, targetId, propName, value }) => {
          const ack = await emitEdit({
            type: 'prop_edit',
            selector,
            targetId,
            propName,
            value,
          })
          if (!ack.ok) {
            return {
              content: [
                { type: 'text', text: `rejected: ${ack.reason}` },
              ],
              isError: true,
            }
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  editId: ack.editId,
                  summary: `Buffered prop edit: ${propName} = ${JSON.stringify(value)}`,
                }),
              },
            ],
          }
        },
      ),

      tool(
        'list_read_roots',
        'List every readable root for this session — the implicit "worktree" plus any externals declared in desde.config.json. Returns names + descriptions only, never raw filesystem paths. Call this first if you plan to use list_commits / read_file_at_commit / diff_file / search_external_files with a non-worktree root.',
        {},
        () => listReadRoots(rootCtx),
      ),

      tool(
        'list_commits',
        'List commits in a read root (default "worktree"). Returns oldest-to-newest, up to 100 entries. Use this to see what\'s changed recently, find the commit that introduced a bug, or browse history before drilling in with diff_file / read_file_at_commit. For external repos (declared in desde.config.json) this is how you discover refs to read at.',
        {
          root: z
            .string()
            .optional()
            .describe('Read root name (default "worktree"). Call list_read_roots to see what is available.'),
          limit: z
            .number()
            .optional()
            .describe('Max commits to return. Default 30, hard cap 100.'),
          sinceRef: z
            .string()
            .optional()
            .describe(
              'Only return commits reachable from HEAD but NOT from this ref. E.g. "main" to see commits the current branch has that main does not.',
            ),
          path: z
            .string()
            .optional()
            .describe('Restrict to commits that touched this repo-relative path.'),
          grep: z.string().optional().describe('Filter by commit-message substring.'),
          author: z.string().optional().describe('Filter by author substring.'),
        },
        (input) => listCommits(rootCtx, input),
      ),

      tool(
        'read_file_at_commit',
        'Read a file\'s contents at a specific commit in a read root. Use sha="HEAD" to read the current state of an external repo. Up to 200KB; oversized files return an error with the actual size so you can decide whether to drill in with diff_file instead. This is the ONLY way to read files outside the worktree — the built-in Read tool is worktree-scoped.',
        {
          root: z
            .string()
            .optional()
            .describe('Read root name (default "worktree").'),
          path: z.string().describe('Repo-relative path to read.'),
          sha: z
            .string()
            .describe('Commit sha or named ref (HEAD, HEAD~1, branch name, tag).'),
        },
        (input) => readFileAtCommit(rootCtx, input),
      ),

      tool(
        'diff_file',
        'Single-file unified diff between two refs in a read root. Defaults: fromRef = previous commit (HEAD~1), toRef = HEAD. Use this to see what changed in a file across a commit, branch, or arbitrary range. Output is capped at 500 lines; longer diffs are truncated with a marker.',
        {
          root: z
            .string()
            .optional()
            .describe('Read root name (default "worktree").'),
          path: z.string().describe('Repo-relative path of the file to diff.'),
          fromRef: z
            .string()
            .optional()
            .describe('Starting ref (default "HEAD~1").'),
          toRef: z.string().optional().describe('Ending ref (default "HEAD").'),
        },
        (input) => diffFile(rootCtx, input),
      ),

      tool(
        'search_external_files',
        'Search files in a declared external read root for a regex pattern (uses `git grep`, scoped to the root\'s tracked files at HEAD). For the worktree, use the built-in Grep tool instead — it already works. Use this when you want to find how a component is used in production source, or pull patterns from a reference codebase.',
        {
          root: z
            .string()
            .describe('Read root name (must NOT be "worktree" — use the built-in Grep for that).'),
          query: z.string().describe('Regex pattern to search for.'),
          paths: z
            .array(z.string())
            .optional()
            .describe(
              'Optional pathspec list to narrow the search (e.g. ["src/components/**"]). Repo-relative.',
            ),
        },
        (input) => searchExternalFiles(rootCtx, input),
      ),

      tool(
        'session_status',
        "Snapshot of the current editing session's worktree: branch, base commit, HEAD, how many commits the session has accumulated, and any uncommitted dirty files. Use this to see what you have changed so far — auto-commit usually keeps the tree clean, but iteration-data edits and bridge mutations can land uncommitted, and this is the only way to see them. Read-only.",
        {},
        () => sessionStatus(rootCtx),
      ),

      tool(
        'session_diff',
        'Unified diff of what the current editing session has changed against its base commit (committed + uncommitted). Pass no `path` for the full session diff across all files; pass a worktree-relative path to scope it. Use this when you need to see exactly what code has changed during this session before making related edits.',
        {
          path: z
            .string()
            .optional()
            .describe('Optional worktree-relative path to limit the diff to a single file.'),
          maxLines: z
            .number()
            .optional()
            .describe('Override the default 500-line cap. Hard ceiling 2000.'),
        },
        (input) => sessionDiff(rootCtx, input),
      ),

      tool(
        'delete_file',
        "Delete a file from the repo. The unlink happens immediately as an uncommitted working-tree change; the prior content is saved to the backup journal (.desde/backups/) so it can be recovered. Use when refactoring requires removing an obsolete file — extracting a component out, removing dead code, etc. The path MUST live inside the repo; absolute paths or `..` traversal are rejected. If you also need to keep the contents under a different name, use rename_file instead.",
        {
          path: z
            .string()
            .describe(
              'Worktree-relative path of the file to delete (e.g. "src/components/Old.vue").',
            ),
        },
        ({ path }) =>
          deleteFileHandler({
            worktreeRoot,
            invalidateFiles,
            emitEdit,
            input: { path },
            acquireTreeGate,
          }),
      ),

      tool(
        'download_asset',
        "Download an image from the web into the repo (e.g. a photo or logo the user linked). Writes the bytes as an uncommitted working-tree change. ONLY image types are allowed (.png/.jpg/.jpeg/.gif/.webp/.avif/.svg/.ico), and ONLY from a host the user has already allowlisted for WebFetch in desde.config.json — the same trust boundary, no wider. Private and loopback addresses are always refused. The destination must be inside the repo and must NOT already exist. Use this instead of telling the user to save a file by hand.",
        {
          url: z.string().describe('Absolute https:// URL of the image.'),
          destPath: z
            .string()
            .describe('Worktree-relative destination (e.g. "public/hero.png"). Must not exist.'),
        },
        ({ url, destPath }) =>
          downloadAssetHandler({
            worktreeRoot,
            invalidateFiles,
            emitEdit,
            ...(webPolicy ? { webPolicy } : {}),
            input: { url, destPath },
            acquireTreeGate,
          }),
      ),

      tool(
        'rename_file',
        "Rename or move a file inside the repo. The rename happens immediately as an uncommitted working-tree change; the prior content is saved to the backup journal (.desde/backups/). The destination MUST live inside the repo, MUST NOT already exist, and MUST either share the source's extension or have an allowed new-file extension. Use when restructuring — moving a component into a subdirectory, renaming for clarity, etc.",
        {
          from: z
            .string()
            .describe('Worktree-relative path of the source file.'),
          to: z
            .string()
            .describe('Worktree-relative path of the destination file.'),
        },
        ({ from, to }) =>
          renameFileHandler({
            worktreeRoot,
            invalidateFiles,
            emitEdit,
            input: { from, to },
            acquireTreeGate,
          }),
      ),

      tool(
        'insert_element',
        "Insert a plain/primitive element (e.g. <div>, <p>, <img>, <ul><li>…, <button>) OR bare text as a child of a target element. Goes through the deterministic edit pipeline (written to the working tree immediately, uncommitted) — prefer this over rewriting the whole SFC with Edit/Write when adding a primitive element or text. For a DESIGN-SYSTEM catalog component (a Button, Card, … from the prototype's design system) use insert_component instead — it resolves the tag and AUTO-ADDS the import; insert_element does NOT add imports. Identify the DESTINATION PARENT (the container the new node goes inside) with get_selection and pass its source file + line + column. For complex/bound props, insert plainly then refine with Edit.",
        {
          snippet: z
            .string()
            .describe(
              'For contentKind "element" (default): a SINGLE template element, e.g. \'<div class="card"></div>\', \'<p>Hello</p>\', \'<img src="/logo.png" alt="Logo" />\'. For contentKind "text": the plain text to insert (HTML-escaped automatically; no {{ }} interpolation).',
            ),
          file: z
            .string()
            .describe('Worktree-relative path of the SFC that contains the destination parent (from get_selection).'),
          line: z
            .number()
            .int()
            .describe("1-based source line of the DESTINATION PARENT element (the container the new node becomes a child of), from get_selection's source location."),
          column: z
            .number()
            .int()
            .describe('1-based source column of the destination parent element (from get_selection).'),
          destIndex: z
            .number()
            .int()
            .optional()
            .describe("0-based index among the parent's element children. Omit or pass -1 to append at the end."),
          contentKind: z
            .enum(['element', 'text'])
            .optional()
            .describe("'element' (default) inserts a single template element; 'text' inserts bare text content into the container."),
        },
        ({ snippet, file, line, column, destIndex, contentKind }) =>
          insertElementHandler({
            worktreeRoot,
            invalidateFiles,
            emitEdit,
            input: { snippet, file, line, column, destIndex, contentKind },
            acquireTreeGate,
          }),
      ),

      tool(
        'scaffold_route',
        "Create a NEW page and register its route in one step. Use this to add a page that doesn't exist yet (e.g. \"add an /about page\", \"create a settings screen\") — it writes a minimal page component AND wires it into the router (via a lazy import, so no manual import edit). Both files are written to the working tree immediately (uncommitted — the user commits them). After scaffolding, call navigate to the new path to view it, then flesh out the page with insert_component / insert_element / Edit. Refuses (with a reason) rather than guess when the routing setup is unrecognized, the path duplicates an existing route, or the path has no nameable segment (e.g. '/' or '/:id').",
        {
          path: z
            .string()
            .describe(
              "The route path to create, e.g. '/about' or '/settings/profile'. Must have at least one static segment to name the page after. A leading slash is added if missing.",
            ),
          name: z
            .string()
            .optional()
            .describe("Optional vue-router route name. Derived from the path (e.g. 'settings-profile') when omitted."),
          heading: z
            .string()
            .optional()
            .describe('Optional <h1> heading for the scaffolded page. Defaults to the humanized page name.'),
          routerFile: z
            .string()
            .optional()
            .describe('Optional worktree-relative path to the router config. Auto-detected (src/router/index.ts, …) when omitted; pass it if auto-detection reports it could not find or disambiguate the router.'),
        },
        ({ path, name, heading, routerFile }) =>
          scaffoldRouteHandler({
            worktreeRoot,
            invalidateFiles,
            emitEdit,
            input: { path, name, heading, routerFile },
            acquireTreeGate,
          }),
      ),

      // Canvas + screenshot-plan surface — dormant by default (see the
      // `screenshotPlanTools` doc comment above); empty array when
      // `canvasEnabled` is falsy.
      ...screenshotPlanTools,

      tool(
        'manage_package',
        "Add or remove an npm package dependency. The package.json edit lands as an uncommitted working-tree change, then the substrate's install command runs to sync node_modules + lockfile. Use this instead of editing package.json by hand — going through the package manager avoids drift between manifest and lockfile. The installed dependency is available to the prototype on the next dev-server reload (which usually happens automatically). Long-running: install can take 20–60s for fresh deps.",
        {
          operation: z
            .enum(['add', 'remove'])
            .describe('Whether to add or remove a package.'),
          packageName: z
            .string()
            .describe(
              'NPM package name (e.g. "lodash", "@acme/design-system"). Scoped names are allowed.',
            ),
          versionSpec: z
            .string()
            .optional()
            .describe(
              'Version spec for `add` (defaults to "latest"). Use semver ranges ("^1.2.3"), exact versions ("1.2.3"), or tags ("latest", "next").',
            ),
          dev: z
            .boolean()
            .optional()
            .describe(
              'When true, `add` lands in devDependencies. Ignored for `remove` (the operation scans both). Defaults to false.',
            ),
        },
        ({ operation, packageName, versionSpec, dev }) =>
          managePackageHandler({
            worktreeRoot,
            invalidateFiles,
            emitEdit,
            packageManagerAdapter,
            signal,
            input: { operation, packageName, versionSpec, dev },
            acquireTreeGate,
          }),
      ),

      // insert_component is grounding-dependent (it resolves the component →
      // tag + import path from the manifest), so it's gated on getGrounding
      // exactly like the read-only grounding query tools below — never expose
      // a write tool the agent can pick but that can't succeed.
      ...insertComponentTools,

      tool(
        'run_verification',
        "Run a verification command (typecheck / lint / test / build) in the worktree. Returns the substrate label (e.g. 'npm'), exit code, stdout, stderr, duration, and the exact command that ran. Output is capped at 32KB each on stdout and stderr — the TAIL is preserved on overflow because failure summaries usually appear at the bottom. When the script is missing and no builtin fallback exists, returns ok=false with noScript=true plus the list of available scripts so you can suggest the right one. Use this BEFORE telling the user a change is correct — type errors and lint failures often catch regressions you missed.",
        {
          check: z
            .enum(['typecheck', 'lint', 'test', 'build'])
            .describe(
              'Which verification verb to run. Mapped to a substrate-specific command by the adapter (e.g. `npm run typecheck`).',
            ),
        },
        (input) => runVerification(rootCtx, input),
      ),

      tool(
        'verify_edit',
        "Confirm a VALUE edit (a text or attribute change) actually took effect in the LIVE DOM, and — if it didn't — find out WHY. Call this right after a value edit instead of assuming it worked: pass the source file + line you edited, a CSS selector for the element the value renders into (from get_selection), the value you expect to see, and how it surfaces (`field`). Returns `{ pass, observed, expected, cause?, hint? }`. On `pass:false` the `cause` tells you the failure mode (e.g. `bound-binding`, `v-model`, `dynamic-vbind`, `conditional`, `selector-missing`) and `hint` says how to fix it — make the TARGETED correction it suggests (edit the binding/ref, not the literal) and re-verify. May instead return `{ skipped: true, reason }` when the prototype's bridge is too old to read live values — then fall back to capture_screenshot. For STYLE / layout / color and any other 'does it look right' change, use capture_screenshot instead (computed styles can't be string-compared reliably).",
        {
          file: z
            .string()
            .describe('Worktree-relative path of the SFC the edit rewrote (from get_selection / the file you edited).'),
          line: z
            .number()
            .int()
            .describe('1-based source line you edited — used to classify why a mismatch happened (bound vs literal).'),
          selector: z
            .string()
            .describe('CSS selector for the element the value renders into (from get_selection — pass its `selector` verbatim).'),
          expectedValue: z
            .string()
            .describe('The value you expect to observe in the live DOM, stringified exactly as it should appear.'),
          field: z
            .enum(['textContent', 'attribute'])
            .describe("How the value surfaces: 'textContent' (the element's text) or 'attribute' (a DOM attribute — pass `attribute`). For computed styles, use capture_screenshot instead."),
          attribute: z
            .string()
            .optional()
            .describe("Attribute name to read — required when field is 'attribute' (e.g. \"placeholder\", \"href\")."),
        },
        ({ file, line, selector, expectedValue, field, attribute }) =>
          verifyEdit(
            { bridge, signal, worktreeRoot, reviewSurface },
            { file, line, selector, expectedValue, field, attribute },
          ),
      ),

      tool(
        'verify_goal',
        "Confirm a MEASURABLE layout/sizing goal actually holds in the LIVE DOM — judged deterministically, not by eye. Use this for goals that compile to a measurable check: \"fit the content width\" / \"no overflow\", \"fit on screen\", \"align this with <selector>\", \"match the size of <selector>\", \"enough contrast\". Pass the natural-language `goal` and a `selector` for the element it's about (from get_selection); name any SECOND element in the goal text as a real CSS selector (e.g. \"align with .header\") so it can be measured. Returns `{ pass, status, detail }` — `detail` lists each predicate's verdict. Returns `{ skipped, reason }` when the goal is purely aesthetic (no measurable predicate) or the element can't be measured (then use capture_screenshot), or when the bridge is too old to read measurements. This is for GEOMETRY/contrast you can measure; for exact text/attribute use verify_edit, and for subjective 'does it look right' use capture_screenshot.",
        {
          goal: z
            .string()
            .describe('The natural-language layout/sizing goal to verify, e.g. "make this fit the content width" or "align this with .header".'),
          selector: z
            .string()
            .describe('CSS selector for the primary element the goal is about (from get_selection — pass its `selector` verbatim).'),
        },
        ({ goal, selector }) =>
          verifyGoalTool({ bridge, signal, reviewSurface }, { goal, selector }),
      ),

      tool(
        'ask_user_question',
        'Ask the user to choose among options when you need a decision you cannot infer from the codebase or context. Present a clear question and a concise list of options. Prefer this over guessing — the user\'s explicit choice prevents a wrong assumption from cascading into several incorrect edits. Single-select by default; pass multiSelect: true when multiple choices are valid simultaneously.',
        {
          question: z
            .string()
            .describe('The question to ask the user. Be specific about what decision is needed and why you need their input.'),
          options: z
            .array(z.string())
            .min(1)
            .describe('The list of options to present to the user. Each should be a concise, actionable choice.'),
          multiSelect: z
            .boolean()
            .optional()
            .describe('When true, the user can select multiple options. Defaults to false (single-select).'),
        },
        ({ question, options, multiSelect }) =>
          askUserQuestion({ bridge, signal }, { question, options, multiSelect }),
      ),

      // Design-system grounding query tools (only when a GroundingService is
      // available — see `groundingTools` above).
      ...groundingTools,
    ],
  })
}

/**
 * Result shape both filesystem-write tools return to the SDK. The index
 * signature satisfies the SDK's `CallToolResult` (which uses one for
 * forward-compat). Exported so the colocated test file can introspect
 * it directly.
 */
export interface FileWriteToolResult {
  [k: string]: unknown
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}
