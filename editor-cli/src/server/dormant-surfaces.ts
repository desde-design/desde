/**
 * Which DORMANT product surfaces this project has turned back on.
 *
 * Five surfaces live here. All are gates rather than deletions: every component,
 * store, handler and colocated test stays intact and in the default test
 * run, because a dormant surface whose tests rot is one that cannot be
 * un-dormanted.
 *
 * - **`codeView`** — the in-app CodeMirror pane reached from the
 *   prototype's right-click menu via "Open in editor". It needs visual
 *   work and should not ship half finished.
 * - **`notes`** — the second kind of DOM-anchored annotation beside
 *   comments. Turning it off is also what makes the rail's Comments tab
 *   honest: comments and notes had been merged into one list precisely
 *   because they behave identically at the UI layer, which is why the tab
 *   ended up named after neither.
 * - **`canvas`** — the Canvas tab, the "Screenshot to canvas" button, and
 *   the agent's plan-authoring tools. Dormant by product decision
 *   2026-08-04 (undertested; deliver the editor sooner, invest later).
 *   It joined this module on 2026-09-01, and the reason is worth keeping:
 *   its gate had been living as an inline expression at one call site while
 *   its ROUTES were ungated, so `/api/editor/canvases/*` and
 *   `/api/editor/screenshot-plans/*` answered every verb — 17 and 8
 *   endpoints, create/patch/delete included — with the surface switched
 *   off. That is precisely the drifted pair this module's own comment
 *   below warns about, in the module that warns about it.
 * - **`neutralChat`** — the Desde-owned chat runtime that every non-Anthropic
 *   provider dispatches on. Its first caller is the model catalog resolver
 *   (`model-catalog-source.ts`), which will not serve a `neutral` provider's
 *   group while this is off; `resolveChatRuntime`'s dispatch-side refusal is
 *   the second caller. **This is the one entry in the module that is
 *   opt-OUT, not opt-IN.** Every other surface here is dormant because it is
 *   unfinished, so absence means off. Neutral chat shipped, so absence means
 *   on: a user who has stored an OpenAI key sees a picker that offers
 *   something they can run, and only an explicit `false` in the project
 *   config or an exact `EDITOR_NEUTRAL_CHAT=0` turns it back off. See
 *   `isNeutralChatEnabled`'s own doc comment for the reasoning; the
 *   `=== true` rule two paragraphs down does not apply to it.
 *
 * **Why this module exists at all.** Each gate is read in two places: the
 * bootstrap script, which decides what the client is allowed to OFFER, and
 * the route handler, which decides what the server is willing to DO. Those
 * two must agree. Computing the same boolean twice from the same fields at
 * two call sites is exactly how they drift, and a drifted pair is worse
 * than either failure alone: UI-only gating leaves the API open behind a
 * dormant surface, and dispatch-only gating leaves controls that fail on
 * click. One function, two callers.
 *
 * **Where the config lives, and why it is not `lanes`.** These read
 * `editor.*` in `<repoRoot>/.desde/config.json`, the same block
 * `editor.canvas` uses, because they are SURFACES. `lanes` is a different
 * file (`desde.config.json`) and a different thing: a subset of
 * wire-format edit KINDS. Neither of these is an edit kind.
 *
 * **The `=== true` comparison is the whole mechanism.** An opt-in flag
 * whose absent state reads as enabled is not a gate, so a missing key, a
 * malformed value and an explicit `false` all mean dormant.
 */

/**
 * The slice of the server context these gates read. Narrow on purpose: the
 * helper should not need the whole context to answer a yes or no.
 */
export interface DormantSurfaceConfig {
  editor?: {
    codeView?: boolean
    notes?: boolean
    vscodeLink?: boolean
    canvas?: boolean
    neutralChat?: boolean
  }
}

/**
 * Env-var escape hatches, matching `EDITOR_CANVAS=1`. Useful for a one-off
 * "let me open a file" without editing a config file. Either source
 * enables; neither can disable, since absent already means dormant.
 */
const CODE_VIEW_ENV = "EDITOR_CODE_VIEW"
const NOTES_ENV = "EDITOR_NOTES"
const VSCODE_LINK_ENV = "EDITOR_VSCODE_LINK"
const CANVAS_ENV = "EDITOR_CANVAS"
const NEUTRAL_CHAT_ENV = "EDITOR_NEUTRAL_CHAT"

function enabled(configured: boolean | undefined, envVar: string): boolean {
  return configured === true || process.env[envVar] === "1"
}

/** Is the in-app code view turned back on for this project? */
export function isCodeViewEnabled(ctx: DormantSurfaceConfig): boolean {
  return enabled(ctx.editor?.codeView, CODE_VIEW_ENV)
}

/** Is the Notes surface turned back on for this project? */
export function isNotesEnabled(ctx: DormantSurfaceConfig): boolean {
  return enabled(ctx.editor?.notes, NOTES_ENV)
}

/**
 * Is the canvas + screenshot-plan surface turned back on for this project?
 *
 * Read by three callers, which is why it had to move here: the agent
 * runtime (whether to offer the plan-authoring tools), the client bootstrap
 * (whether to render the Canvas tab), and the canvas and screenshot-plan
 * routes (whether to do the work at all).
 */
export function isCanvasEnabled(ctx: DormantSurfaceConfig): boolean {
  return enabled(ctx.editor?.canvas, CANVAS_ENV)
}

/**
 * Is "Open in VS Code" turned back on for this project?
 *
 * **This one has no dispatch half, and that is a fact about the feature
 * rather than an omission.** The other two gates guard a route: the client
 * stops offering, and the server independently refuses, because a stale
 * client could otherwise still call the API. "Open in VS Code" calls no
 * API. It sets `window.location.href` to a `vscode://` URL it builds from
 * `repoRoot`, which the bootstrap already sends for stylesheet resolution
 * and cannot be withheld for this. So the client gate IS the whole gate,
 * and there is nothing left open behind it.
 */
export function isVscodeLinkEnabled(ctx: DormantSurfaceConfig): boolean {
  return enabled(ctx.editor?.vscodeLink, VSCODE_LINK_ENV)
}

/**
 * Is the neutral chat runtime available for a `neutral` descriptor?
 *
 * The ONE opt-OUT gate in this module, and the exception is deliberate rather
 * than an oversight. Every other surface here is dormant because it is
 * unfinished, so absence means off. This one shipped: with it off, a user who
 * has stored an OpenAI key sees a picker that offers nothing they can run.
 * Absence therefore means on, and only an explicit `false` in the project
 * config or an exact `EDITOR_NEUTRAL_CHAT=0` turns it off, the mirror of the
 * exact-"1" rule the opt-in surfaces use, so that a typo cannot silently take
 * chat away from a provider.
 *
 * It remains gated at both ends: the catalog resolver decides what the client
 * is offered (`chatRuntimeServable` in `model-catalog-source.ts`), the chat
 * handler decides what the server will run (`resolveChatRuntime`'s dispatch-
 * side refusal), and one function answers both.
 */
export function isNeutralChatEnabled(ctx: DormantSurfaceConfig): boolean {
  if (ctx.editor?.neutralChat === false) return false
  if (process.env[NEUTRAL_CHAT_ENV] === "0") return false
  return true
}

/**
 * Dev-only: force the neutral runtime for a provider whose descriptor says
 * otherwise. This is how the neutral loop gets proven against Anthropic, where
 * a behaviour difference is the prompt rather than the provider.
 *
 * A separate switch from `isNeutralChatEnabled` on purpose. That one says the
 * lane may run at all; this one says which lane a given provider takes.
 * Folding them into one boolean would make "prove the loop against Anthropic"
 * indistinguishable from "ship OpenAI chat".
 */
export function chatRuntimeOverride(
  env: NodeJS.ProcessEnv,
): "neutral" | undefined {
  return env.EDITOR_CHAT_RUNTIME_OVERRIDE === "neutral" ? "neutral" : undefined
}

/**
 * The refusal a dormant neutral-chat dispatch returns.
 *
 * It names the config key and the env var rather than 404-ing, for the reason
 * `dormantSurfaceRefusal` gives about its own surfaces: a stale client or a
 * direct caller should learn what to flip instead of guessing the route is
 * gone.
 */
export function neutralChatRefusal(): string {
  return (
    'The neutral chat runtime is dormant. Set "editor": { "neutralChat": true } in ' +
    '.desde/config.json at the repo root, or EDITOR_NEUTRAL_CHAT=1, to turn it on.'
  )
}

/**
 * The refusal a dormant surface's routes return.
 *
 * It names the config key rather than 404-ing, so a stale client or a
 * direct caller learns what to flip instead of guessing the route is gone.
 * The routes stay REGISTERED and refuse inside their handler for the same
 * reason: an unregistered route is indistinguishable from a broken build.
 */
export function dormantSurfaceRefusal(
  surface: "codeView" | "notes" | "canvas",
  what: string,
): string {
  // `vscodeLink` is deliberately not accepted here: it has no route to
  // refuse from. See `isVscodeLinkEnabled`.
  const envVar =
    surface === "codeView" ? CODE_VIEW_ENV : surface === "notes" ? NOTES_ENV : CANVAS_ENV
  return (
    `${what} is dormant. Set "editor": { "${surface}": true } in ` +
    `.desde/config.json at the repo root, or ${envVar}=1, to turn it back on.`
  )
}
