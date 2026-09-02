/**
 * The launcher's "we cannot open this project" wire contract.
 *
 * Shared by BOTH ends on purpose, and it lives here rather than in
 * `editor-cli/` because the direction of dependency is fixed: `editor-cli/`
 * imports from `src/`, never the reverse. The server
 * (`editor-cli/src/server/launcher-open-check.ts`) builds it; the launcher UI
 * (`src/components/editor/launcher/open-block-notice.tsx`) renders it.
 *
 * **Why a structured object and not a string.** The CLI already produces
 * exactly this content — `HostFailure` in `editor-cli/src/hosts/types.ts` has
 * carried `summary` / `cause` / `remediation[]` / `attachCovers` since the host
 * seam was written. It was just trapped in a CHILD PROCESS: the launcher
 * spawned `desde <path>`, the child printed the good failure to a
 * terminal nobody was looking at and exited 4, and the parent's only reaction
 * was `new Error("editor exited before it was ready (code 4)")` — which is what
 * the user read. Flattening the failure to a string at the HTTP boundary would
 * re-create that loss one layer up, so the boundary carries the shape.
 */

/** Why the launcher will not open this project. */
export type LauncherOpenBlockCode =
  /** Not a repo Editor can edit at all: no package.json, no Vue/React, Vue 2. */
  | "framework-unsupported"
  /** Two frameworks both own the dev server. The remedy is `--host <id>`. */
  | "ambiguous-host"
  /** No in-process host matched. Attach mode covers it. */
  | "no-in-process-host"
  /**
   * The framework is fine; the folder is not a git repository. Editor edits
   * the working tree in place, so git is the undo and the commit boundary.
   */
  | "not-a-git-repo"
  /** A merge / rebase / cherry-pick is in progress. Editing over it is unsafe. */
  | "repo-busy"
  /**
   * The pre-check passed and the BOOT failed — with an explanation.
   *
   * The only code here that is not decided before spawning, and the only one
   * whose `cause` is the child process's own stderr rather than a `HostFailure`
   * field. It exists because the pre-check can only see what a static read of
   * the repo reveals, and the commonest boot failure of all is invisible to
   * that: dependencies declared but never installed. See
   * `editor-cli/src/server/editor-boot-failure.ts`.
   *
   * A child that dies saying NOTHING does not get this code — it keeps the bare
   * `editor exited before it was ready (code N)`, which is honest when the
   * failure is genuinely unexplained.
   */
  | "boot-failed"

/**
 * One supported framework, as the UI lists it.
 *
 * Only the ones that ARE supported reach here (2026-08-17). There used to be
 * an `enabled` flag and a `note` explaining why a built-but-dormant host was
 * off, rendered as a second list under the badges. Mo cut it: a refusal screen
 * exists to say what you CAN do, and a list of things that nearly work is the
 * opposite of that. Astro was the only entry it ever described, and Astro is
 * simply not supported today.
 */
export interface LauncherSupportedHost {
  /** The `HostId`. Also the key a project writes under `hosts` in its config. */
  id: string
  /** The host's own `displayName` (e.g. "React Router"). Never hand-written. */
  label: string
}

export interface LauncherOpenBlock {
  code: LauncherOpenBlockCode
  /**
   * One sentence, in the user's terms. Rendered as the notice's headline.
   *
   * Never names the product. "This project is neither Vue 3 nor React, and
   * Editor edits only those" became "This prototype's framework isn't
   * supported": the reader is looking at the tool, and at this point they have
   * a folder, not a project. See docs/design.md § "The product is not a
   * character in its own copy".
   */
  summary: string
  /** The evidence behind it, verbatim. May contain newlines. */
  cause?: string
  /**
   * Ordered, imperative, and MAY be empty (changed 2026-08-17).
   *
   * It used to be "never empty", which is what produced steps that restated
   * the summary or editorialised ("Svelte, Solid and Angular have no source
   * stamper, so their elements would be selectable but never editable"). When
   * the honest answer is "your framework is not on the list", the list below
   * IS the answer and a numbered step adds nothing.
   */
  remediation: string[]
  /** True when starting your own dev server and passing `--attach` would work. */
  attachCovers: boolean
  /**
   * The frameworks that ARE supported for this project — derived from the host
   * registry plus the resolved `hosts` config, never a literal in the UI. The
   * default set moves; a hardcoded list would rot.
   *
   * Supported only. Dormant hosts are not listed at all, so a refusal screen
   * answers "what can I do" without also cataloguing what nearly works.
   */
  supported: LauncherSupportedHost[]
}

/**
 * What deleting the bundled demo would cost, as reported by
 * `GET /api/launcher/demo`.
 *
 * The demo starts byte-identical to the bundle, so an untouched one can be
 * deleted freely. These counts are what lets the confirmation say something
 * true instead of one generic warning. See `demo-delete-message.ts`.
 */
export interface DemoChangeSummary {
  present: boolean
  /** Working-tree entries `git status --porcelain` reports. */
  dirtyFiles: number
  /** Commits beyond the single seed commit. */
  extraCommits: number
}

/** `GET /api/launcher/demo`. `triedAt` survives deletion, and only demotes. */
export interface LauncherDemoState extends DemoChangeSummary {
  /** Absolute path, so the launcher can identify the demo's recents row. */
  path: string
  triedAt: string | null
}
