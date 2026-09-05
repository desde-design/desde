/**
 * Client-side feature flags for the editor.
 *
 * The CLI editor surface is the only editor surface (the web editor
 * was removed 2026-06-04, and worktree-session edit mode — the per-session
 * git worktree substrate — was fully decommissioned 2026-07-21; see
 * tasks/worktree-mode-decommission.md). Editor now always edits the
 * user's current working tree in place ("branch mode"): every CLI run
 * bootstraps the page with `window.__DESDE_CLI__.editMode === "branch"`
 * and structural edits immediate-dispatch to the server (Vite HMR shows the
 * truthful preview).
 *
 * `window` is undefined on the Next server, so SSR reads the bootstrap-less
 * defaults below; the cloud viewer route no longer mounts the editor, so
 * the only live consumer is the CLI surface.
 */
import type { ProjectIdentity } from "@/core/project-identity"

// Avoid `declare global Window` here — the CLI bundle's main.tsx
// declares the same property with a richer shape (`token`, `viteUrl`,
// etc.) and TypeScript can't merge two different value-types for the
// same key. Read via a narrow inline cast instead; the CLI bundle is
// the only producer of this global.
type CliBootstrap = {
  /**
   * Phase 5 of tasks/editor-detached-sessions.md — CLI-side
   * opt-out for the detached chat sessions UI. Populated by the
   * CLI bootstrap from `desde.config.json`'s
   * `chat.detachedSessions` field (default true). Absent in the
   * web shell — the web surface always treats this as `true`.
   */
  detachedSessions?: boolean
  /**
   * Canvas + screenshot-plan surface gate. DORMANT by product decision
   * 2026-08-04 (deliver editor sooner; the surface is undertested;
   * invest later — see CLAUDE.md § "Screenshot Capture"). Populated by
   * the CLI bootstrap from `editor.canvas` in `.desde/config.json`
   * OR the `EDITOR_CANVAS=1` env var (either enables). Default `false`
   * — the inverse of `detachedSessions`' opt-out default. Absent on the
   * web shell (no CLI) — the web surface always treats this as `false`.
   * See {@link EDITOR_CANVAS}.
   */
  canvas?: boolean
  /**
   * In-app code view gate. DORMANT by product decision 2026-08-14 (Mo:
   * "it needs some visual work and I don't want to ship it half
   * finished"). Populated by the CLI bootstrap from `editor.codeView` in
   * `.desde/config.json` OR the `EDITOR_CODE_VIEW=1` env var
   * (either enables). Default `false`. Absent on the web shell (no CLI)
   * — the web surface always treats this as `false`.
   * See {@link EDITOR_CODE_VIEW}.
   */
  codeView?: boolean
  /**
   * Notes surface gate. DORMANT by product decision 2026-08-14. Populated
   * by the CLI bootstrap from `editor.notes` in `.desde/config.json`
   * OR the `EDITOR_NOTES=1` env var (either enables). Default `false`.
   * Absent on the web shell (no CLI) — always `false` there.
   * See {@link EDITOR_NOTES}.
   */
  notes?: boolean
  /**
   * "Open in VS Code" gate. DORMANT by product decision 2026-08-18.
   * Populated by the CLI bootstrap from `editor.vscodeLink` in
   * `.desde/config.json` OR `EDITOR_VSCODE_LINK=1` (either enables).
   * Default `false`. Absent on the web shell — always `false` there.
   * See {@link EDITOR_VSCODE_LINK}.
   */
  vscodeLink?: boolean
  /**
   * Secret-file read policy for the chat agent. Populated by the CLI
   * bootstrap from `editor.secretReads` in `.desde/config.json` OR the
   * `EDITOR_SECRET_READS=1` env var (either enables). Default `false`.
   * Absent on the web shell — always `false` there.
   * See {@link EDITOR_SECRET_READS}.
   */
  secretReads?: boolean
  /**
   * Dormant edit-lane gates. Populated by the CLI bootstrap from the `lanes`
   * block of `desde.config.json` (the same file `hosts` lives in),
   * and always emitted exhaustively — every dormant lane appears with an
   * explicit boolean, so `absent` and `false` mean the same thing and a
   * missing key can never read as enabled. Default `false` for both. See
   * {@link EDITOR_LANE_DETACH} / {@link EDITOR_LANE_SWAP}.
   */
  lanes?: {
    detach?: boolean
    swap?: boolean
  }
  /**
   * Editor runtime tunables forwarded from
   * `.desde/config.json`'s `editor` section. Currently only
   * `reloadBackstop` — see {@link EDITOR_RELOAD_BACKSTOP}.
   */
  editor?: {
    reloadBackstop?: boolean
  }
  /**
   * Resolved Vite `base` of the supervised dev server (always slash-wrapped,
   * e.g. `/` or `/app/`). Authoritative served-path prefix — used to map a
   * served stylesheet href back to a prototype-root-relative file for
   * token-scope edits (see {@link EDITOR_VITE_BASE}). Absent on the web shell
   * (no CLI) and on older CLI bootstraps → treated as `/`.
   */
  viteBase?: string
  /**
   * Framework the CLI detected for the supervised prototype (`detectFramework`
   * over its package.json). Threaded so the shell's `get_page_info` reports the
   * real framework to the agent instead of assuming Vue — see
   * {@link EDITOR_FRAMEWORK}. Absent on the web shell / older bootstraps →
   * treated as `vue3`.
   */
  framework?: "vue3" | "react"
  /**
   * Styling system the CLI detected for the supervised prototype
   * (`detectStylingSystem` — Tailwind vs inline). Threaded so the shell knows
   * which React inline-style edit to build: `"tailwind"` → splice utility
   * classes into `className`; `"inline"` → merge a `style={{}}` object. Vue
   * ignores this (it always uses the scoped-css-override lane). Absent on the
   * web shell / older bootstraps → treated as `inline` (the universal default).
   * See {@link EDITOR_STYLING_SYSTEM}.
   */
  stylingSystem?: "tailwind" | "css-modules" | "inline"
  /**
   * Substrate STYLE capabilities detected by the CLI at boot
   * (`detectSubstrateStyleCapabilities` — neutral facts about how the
   * prototype's own CSS competes with the rules Editor writes). Today the
   * only field is `importantUtilities`; see
   * {@link EDITOR_ELEMENT_SCOPE_OUTRANKED}. Absent on the web shell / older
   * bootstraps / when detection failed → every capability treated as false,
   * i.e. exactly the pre-detection behavior.
   */
  styleCapabilities?: { importantUtilities?: boolean }
  /**
   * Boot-resolved hints for WHERE a scoped style override is written on a
   * substrate that has no `<style scoped>` block (React). Both are filesystem
   * facts the shell cannot establish for itself: `configured` is
   * `styling.overrideStylesheet` from `desde.config.json`, and
   * `sticky` is the app stylesheet that already holds the editor-managed
   * block. See {@link EDITOR_OVERRIDE_STYLESHEET}.
   */
  overrideStylesheet?: { configured?: string; sticky?: string }
  /**
   * Edit substrate the CLI booted in. Worktree-session mode (per-session
   * git worktree, promote-to-main via Commit) was fully removed
   * 2026-07-21 — see tasks/worktree-mode-decommission.md — so the CLI
   * always sends `"branch"` now: edits land on the user's current working
   * tree in place, no worktree, no promote, no auto-commit. The field is
   * kept (rather than dropped) for bootstrap-shape stability and to
   * distinguish "CLI present (live, immediate dispatch)" from "no CLI at
   * all (web shell, field absent)". See tasks/branches-vs-worktree.md.
   */
  editMode?: "branch"
  /**
   * Absolute repo root on the user's machine. Used by the shell to build
   * editor jump links ("Open in VS Code" → `vscode://file/<abs>:<line>`).
   * Absent on the web shell / older bootstraps (the affordance disables
   * itself).
   */
  repoRoot?: string
  /**
   * The same root with symlinks resolved (the CLI realpath's it at boot). Absent
   * when the realpath call failed or on an older bootstrap.
   */
  repoRootReal?: string
  /**
   * Viewer-project association from `.desde/config.json`, forwarded
   * by the CLI bootstrap. There's no Firestore involved — `projectId` is
   * whatever id the linked viewer (self-hostable, no GCP) uses for the
   * project; comment sync mode is decided separately, by
   * `useEditorCommentStore` polling `/api/editor/viewer-auth` for a
   * configured viewer + a stored access token (see
   * `src/hooks/useEditorCommentStore.ts`), not by this field. Always
   * present on a CLI boot (fields null when the repo is unlinked); absent
   * on the web shell / older bootstraps.
   */
  project?: {
    projectId: string | null
    slug: string | null
    /**
     * Embedded project identity from `.desde/config.json`. Null on an
     * un-migrated repo. Unlike `projectId` this needs no sign-in, no network
     * and no cloud link, so it is what the breadcrumb renders.
     */
    identity: ProjectIdentity | null
    platformBaseUrl: string | null
  }
}
const cliBootstrap: CliBootstrap | undefined =
  typeof window === 'undefined'
    ? undefined
    : (window as Window & { __DESDE_CLI__?: CliBootstrap })
        .__DESDE_CLI__

/**
 * Phase 5 — detached chat sessions UI gate. True unless the CLI
 * bootstrap explicitly opts out via `chat.detachedSessions: false`
 * in `desde.config.json`. The flag is a UI-level gate
 * so users hitting picker-related bugs can fall back to the legacy
 * single-chat experience.
 *
 * Server-side per-sessionId keying is UNAFFECTED — the chat routes
 * always accept `sessionId` in the body. The flag just hides the
 * UI surfaces (picker, toast-on-completion, in-flight tracking).
 *
 * Read at module load. Flipping requires a CLI restart — none of the
 * flags in this file support dynamic subscription in the shell today.
 */
export const EDITOR_DETACHED_SESSIONS: boolean =
  cliBootstrap?.detachedSessions !== false

/**
 * Canvas + screenshot-plan surface gate — the workspace Canvas tab, the
 * "Screenshot → canvas" top-bar button, and (server-side) the agent's
 * `save_screenshot_plan` / `heal_plan_step` tools. DORMANT by product
 * decision 2026-08-04: deliver editor sooner, the surface is
 * undertested, invest later. Default **false** — opt-IN, the inverse of
 * {@link EDITOR_DETACHED_SESSIONS}' opt-out default. Flip
 * `editor.canvas: true` in `.desde/config.json` (or set
 * `EDITOR_CANVAS=1`) to restore — all components, stores, handlers,
 * and the replay/heal plumbing stay intact; only the mounting/
 * registration is gated. This is a UI-level gate read at module load
 * (matches the other CLI-bootstrap flags — flipping requires a CLI
 * restart).
 */
export const EDITOR_CANVAS: boolean = cliBootstrap?.canvas === true

/**
 * In-app code view — the CodeMirror pane reached by right-clicking an
 * element in the prototype and picking "Open in editor". DORMANT by
 * product decision 2026-08-14: it needs visual work and should not ship
 * half finished. Default **false** — opt-IN, same shape as
 * {@link EDITOR_CANVAS}. Flip `editor.codeView: true` in
 * `.desde/config.json` (or set `EDITOR_CODE_VIEW=1`) to restore.
 *
 * Gated at BOTH ends, the same discipline the dormant lanes follow. This
 * flag hides the OFFERING; the CLI independently refuses
 * `GET /api/editor/file` on the same config, so a stale client or a
 * hand-built request gets a reason naming `editor.codeView` rather than
 * read access to arbitrary source while the surface is dormant.
 *
 * A gate, not a deletion: `FileEditorPane`, its read route's pure
 * handler, and every colocated test stay intact and in the default test
 * run. A dormant surface whose tests rot is a surface that cannot be
 * un-dormanted.
 *
 * Note "Open in VS Code" is a SEPARATE item in the same context menu and
 * is deliberately untouched: it launches an external editor and shares
 * none of this machinery.
 */
export const EDITOR_CODE_VIEW: boolean = cliBootstrap?.codeView === true

/**
 * Secret-file reads — whether the chat agent may READ credential-bearing
 * files in this project (`.env` and its variants, private keys, `.npmrc`,
 * cloud credential stores). Default **false** — opt-IN, same shape as
 * {@link EDITOR_CODE_VIEW}. Set `editor.secretReads: true` in
 * `.desde/config.json`, or `EDITOR_SECRET_READS=1`, to allow them.
 *
 * This one does NOT gate a surface, and it is not a dormant feature. It is a
 * POLICY: with it off the agent's Read, Glob and Grep refuse those files,
 * because their content would otherwise land in a transcript sent to a model
 * vendor, and a prototype repository is untrusted input. `.env.example` and
 * the other documentation spellings stay readable either way.
 *
 * Gated at BOTH ends, the same discipline as the flags above. This flag is
 * the REPORTING half — the capabilities panel says the project has allowed
 * it. The CLI enforces independently on the same config, in the shared
 * permission gate and in the SDK lane's `PreToolUse` guard, so a stale client
 * cannot talk the chat route into reading a secret the project never allowed.
 */
export const EDITOR_SECRET_READS: boolean = cliBootstrap?.secretReads === true

/**
 * Notes — the second kind of DOM-anchored annotation, alongside comments.
 * DORMANT by product decision 2026-08-14. Default **false** — opt-IN, same
 * shape as {@link EDITOR_CANVAS} and {@link EDITOR_CODE_VIEW}. Flip
 * `editor.notes: true` in `.desde/config.json` (or set
 * `EDITOR_NOTES=1`) to restore.
 *
 * This is also what makes the rail's **Comments** tab honest. Comments and
 * Notes were merged into one list on the reasoning that they behave
 * identically at the UI layer, which was true and is why the tab ended up
 * named for neither. With notes dormant the list holds one kind of thing
 * and the tab says what it holds.
 *
 * Gated at BOTH ends. This flag hides the offering: the "Note" button, note
 * rows in the merged list, the note thread popup, and the note bridge that
 * paints pins inside the iframe. The CLI independently refuses
 * `/api/editor/notes/*` on the same config, so a stale client cannot read or
 * write notes behind a dormant surface.
 *
 * No bridge change and no version bump: note pins only ever appear because
 * the shell sends them, so a shell that never mounts the note bridge paints
 * nothing. `src/bridge/note-pins.ts` stays exactly as it is.
 *
 * A gate, not a deletion. The stores, hooks, handlers and every colocated
 * test stay intact and in the default run.
 */
export const EDITOR_NOTES: boolean = cliBootstrap?.notes === true

/**
 * "Open in VS Code" — the prototype right-click item that launches
 * `vscode://file/<abs>:<line>:<col>`. DORMANT by product decision
 * 2026-08-18 (Mo).
 *
 * Default **false** — opt-IN, same shape as {@link EDITOR_CODE_VIEW} and
 * {@link EDITOR_NOTES}. Set `editor.vscodeLink: true` in
 * `.desde/config.json`, or `EDITOR_VSCODE_LINK=1`, to restore.
 *
 * **It gates ONE end, and that is the whole feature.** The both-ends rule
 * exists because a client-only gate leaves an API reachable by a stale
 * client. This affordance calls no API: it assigns `window.location.href`
 * to a `vscode://` URL built from `repoRoot`, which the bootstrap sends for
 * stylesheet resolution and cannot be withheld for this. There is no
 * dispatch to refuse, so the offering IS the surface.
 *
 * The handler, its path-traversal guards and their tests all stay — a
 * dormant surface whose tests rot cannot be un-dormanted.
 */
export const EDITOR_VSCODE_LINK: boolean = cliBootstrap?.vscodeLink === true

/**
 * "Detach component" — DORMANT by product decision 2026-08-11
 * (`tasks/dev-server-hosts.md` § 9e). The lane is Vue-only (its applicator
 * mutates SFC AST and there is no JSX sibling) AND has never been used in
 * dogfooding; an inconsistency nobody relies on is closed by removing the
 * offering rather than by writing the missing applicator.
 *
 * Default **false** — opt-IN, like {@link EDITOR_CANVAS}. Set
 * `{ "lanes": { "detach": true } }` in `desde.config.json` to
 * restore. `apply-detach-edit.ts`, its suite and the handler suites that drive
 * it are untouched and stay in the default test run: a dormant lane whose
 * tests rot is a lane that cannot be un-dormanted.
 *
 * Gating this flag alone is NOT sufficient and was never meant to be — the CLI
 * refuses `kind: "detach"` at dispatch on the same config
 * (`editor-cli/src/server/enabled-lanes.ts`), because a UI-only gate leaves the
 * edit API reachable by a stale client or a direct caller.
 */
export const EDITOR_LANE_DETACH: boolean = cliBootstrap?.lanes?.detach === true

/**
 * "Swap component" — DORMANT on the same decision and the same terms as
 * {@link EDITOR_LANE_DETACH}, plus one more reason: swap matches candidates by
 * prop-name overlap only, so it cannot swap Tabs ↔ SegmentedControl
 * (`tasks/_archive/one-shot-tasks/swap-by-role.md`) — it is weak even on the
 * substrate where it works.
 *
 * **This also gates the icon picker**, which is not obvious and is deliberate:
 * `handlePickIcon` builds a `StructuralEdit` with `kind: "swap"` and goes
 * through the very same applicator, so it carries the same Vue-only
 * inconsistency and hits the same dispatch refusal. Leaving it offered would
 * be a control that fails on click. `{ "lanes": { "swap": true } }` restores
 * both.
 */
export const EDITOR_LANE_SWAP: boolean = cliBootstrap?.lanes?.swap === true

/**
 * Whether the scope dialogs offer "Remember my choice for this session".
 *
 * DORMANT by product decision 2026-08-09: the checkbox was judged not useful —
 * a scope choice is per-edit by nature, and a sticky answer is exactly the kind
 * of invisible state that makes a later edit land somewhere surprising.
 *
 * Deliberately a plain constant, NOT a `.desde/config.json` key: nothing
 * in the CLI bootstrap populates one, and a config surface that silently does
 * nothing is worse than no surface. Flip this to `true` to restore — the whole
 * memory path is intact behind it (`rememberedScopeRef` in inspector-panel.tsx,
 * `iterationScopeMemoryRef` in useEditorEditing.ts, and the `remember`
 * parameter on both dialogs' `onConfirm`). With it false the dialogs always
 * submit `remember: false`, so those refs are simply never written.
 */
export const EDITOR_REMEMBER_SCOPE_CHOICE = false

/**
 * Whether the shell should reload the iframe after each successful
 * edit (save / chat turn / conflict reload) as a Vite HMR backstop.
 *
 * Default: true (reload after every edit, the current behavior). Set
 * to false in `.desde/config.json`:
 *
 *   { "editor": { "reloadBackstop": false } }
 *
 * to drop the reload entirely. Panel state, scroll position, and
 * component-local state survive edits — at the cost of needing a
 * manual refresh if HMR misses a write. Telemetry exposed at
 * `window.__EDITOR_HMR_STATS__` (see useEditorEditing) so
 * dogfooders can measure miss rate before committing to either side.
 *
 * Web shell: there's no CLI bootstrap, so this is always true on the
 * web surface (no live editor writes happening there anyway).
 */
export const EDITOR_RELOAD_BACKSTOP: boolean =
  cliBootstrap?.editor?.reloadBackstop !== false

/**
 * Resolved Vite `base` of the supervised prototype dev server (slash-wrapped,
 * e.g. `/` or `/app/`). The CLI bootstrap injects the authoritative value from
 * the resolved Vite config; the supervisor's URL is origin-only so this is the
 * only reliable source of the served-path prefix. Defaults to `/` when absent
 * (web shell, or an older CLI bootstrap). Consumed by the inspector's
 * token-scope edit to strip the prefix off a stylesheet href when resolving the
 * token's source file. Read at module load (matches the other CLI-bootstrap
 * flags — a base change requires a CLI restart anyway).
 */
export const EDITOR_VITE_BASE: string = cliBootstrap?.viteBase ?? "/"

/**
 * Absolute repo root of the supervised prototype, from the CLI bootstrap
 * (`undefined` on the web shell / an older bootstrap).
 *
 * Consumed by token-scope resolution: Vite dev serves first-party CSS as an
 * injected `<style>` whose only source signal is an ABSOLUTE filesystem path
 * (`data-vite-dev-id`, surfaced as `StyleStylesheetRef.sourceHint`), and the edit
 * handler writes prototype-root-relative paths — so the root is what turns one
 * into the other. Absent ⇒ a source hint doesn't resolve and the token scope is
 * simply not offered (the fail-safe direction; token edits can't complete without
 * a CLI anyway).
 */
export const EDITOR_REPO_ROOT: string | undefined = cliBootstrap?.repoRoot

/**
 * {@link EDITOR_REPO_ROOT} with symlinks resolved — realpath'd by the CLI at
 * boot, because this is shell code with no filesystem access.
 *
 * Both roots are needed, not one: for a checkout reached through a symlink the
 * CLI's git root and Vite's filesystem-resolved module ids can be anchored at
 * DIFFERENT absolute paths that name the same repo (Vite defaults to
 * `preserveSymlinks: false`). Matching a source hint against only one of them
 * silently withheld the token scope. `resolveTokenSourceFile` tries both and
 * still refuses anything under neither.
 *
 * Absent (older bootstrap, or the realpath failed) ⇒ only `EDITOR_REPO_ROOT` is
 * tried, i.e. exactly the previous behavior.
 */
export const EDITOR_REPO_ROOT_REAL: string | undefined =
  cliBootstrap?.repoRootReal

/**
 * Boot-resolved hints for the destination of a `scoped-css-override` on a
 * substrate with no `<style scoped>` block — rungs 1 and 2 of the ladder in
 * `src/components/editor/resolve-override-stylesheet.ts`.
 *
 * **Hints, not decisions.** Neither is used unless the page actually LOADS
 * that stylesheet: a rule written into a `.css` the app never imports is
 * inert, and the write would still succeed and report `ok`. That is the same
 * silent failure shape the Vue lane shipped for a different reason
 * (`tasks/dev-server-hosts.md` § 9g.8), so reachability is checked at the
 * point of use, against `document.styleSheets`, every time.
 *
 * Empty on the web shell / an older CLI bootstrap ⇒ the ladder falls through
 * to document order, which is its designed last rung, not a degradation.
 */
export const EDITOR_OVERRIDE_STYLESHEET: {
  configured?: string
  sticky?: string
} = cliBootstrap?.overrideStylesheet ?? {}

/**
 * Framework of the supervised prototype, as detected by the CLI at boot
 * (`detectFramework`). The shell reports this from `get_page_info` so the chat
 * agent knows whether it's editing Vue or React — and on React, follows the
 * system-prompt guidance to use Edit/Write rather than the Vue-only
 * deterministic tools. Defaults to `vue3` (web shell / older CLI bootstraps).
 * Read at module load; a change requires a CLI restart like the other flags.
 */
export const EDITOR_FRAMEWORK: "vue3" | "react" = cliBootstrap?.framework ?? "vue3"

/**
 * Styling system of the supervised prototype, detected by the CLI at boot
 * (`detectStylingSystem`). Drives the React inline-style edit shape: `"tailwind"`
 * splices Tailwind utility classes into `className`; anything else falls back to
 * an inline `style={{}}` object (universal). Defaults to `inline` (web shell /
 * older CLI bootstraps / non-Tailwind substrates). Read at module load; a change
 * requires a CLI restart like the other flags.
 */
export const EDITOR_STYLING_SYSTEM: "tailwind" | "css-modules" | "inline" =
  cliBootstrap?.stylingSystem ?? "inline"

/**
 * Whether this substrate compiles its utility CSS with `!important` (Tailwind
 * global important mode: v4 `@import "tailwindcss" important;` or v3
 * `important: true`). Boot-detected by the CLI
 * (`detectSubstrateStyleCapabilities`); false on the web shell, on older CLI
 * bootstraps, and whenever detection couldn't tell — the fail-safe direction.
 */
export const EDITOR_IMPORTANT_UTILITIES: boolean =
  cliBootstrap?.styleCapabilities?.importantUtilities === true

/**
 * Whether the inspector's ELEMENT style scope is architecturally outranked on
 * this substrate — i.e. a declaration Editor adds there generally cannot win
 * the cascade, so the scope dialog deprioritises it and explains why (see
 * `availableScopes`' `elementScopeOutranked`).
 *
 * True when the substrate's utilities are `!important`
 * ({@link EDITOR_IMPORTANT_UTILITIES}) AND the element-scope edit lane emits a
 * declaration that competes with them:
 *  - **Vue** — a `scoped-css-override` rule, `[data-desde-src="…"] { … !important }`
 *    with NO cascade layer. Under the corrected `!important` layer model that is
 *    the WEAKEST important tier, so a layered important utility always wins
 *    (Tailwind v4); under v3 (no real layers) it is a same-tier coin flip on
 *    source order. Outranked either way.
 *  - **React + non-Tailwind styling** — a plain inline `style={{}}` declaration,
 *    which loses to any `!important` rule. Outranked.
 *  - **React + Tailwind** — the element edit SPLICES/REPLACES utility classes on
 *    the element itself, so it edits the winning declaration rather than layering
 *    a weaker one on top. NOT outranked — carved out here so a working scope is
 *    never deprioritised.
 */
export const EDITOR_ELEMENT_SCOPE_OUTRANKED: boolean =
  EDITOR_IMPORTANT_UTILITIES &&
  !(EDITOR_FRAMEWORK === "react" && EDITOR_STYLING_SYSTEM === "tailwind")

/**
 * Viewer-project association (or null when unlinked / web shell). Read at
 * module load like the other bootstrap flags — a link change comes from a
 * config edit + CLI restart. Comment sync mode is NOT decided from this —
 * see `useEditorCommentStore.ts`, which polls the viewer-auth endpoint for
 * a configured viewer + a stored token instead.
 */
export const EDITOR_PROJECT: {
  projectId: string | null
  slug: string | null
  identity: ProjectIdentity | null
  platformBaseUrl: string | null
} | null = cliBootstrap?.project ?? null

/**
 * Linked project id, or null when the repo isn't linked. Sole reader:
 * `editor-slice.ts` seeds `activeProjectId` from this at store construction.
 */
export const EDITOR_PROJECT_ID: string | null =
  cliBootstrap?.project?.projectId ?? null
