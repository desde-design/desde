/**
 * Pure, side-effect-free logic for the connect-repo panel
 * (`project-repo-panel.tsx`) — kept out of the component so it's directly
 * unit-testable without React or a DOM, same convention as
 * `settings/token-utils.ts`.
 *
 * Wire shapes mirror the server's `viewer/server/github/types.ts`
 * (`Installation`, `Repo`) and `viewer/server/storage/types.ts`
 * (`ProjectRepoConfig`) field-by-field, declared locally rather than
 * imported: server-only code isn't reachable from app code via the `@/*`
 * alias (that alias points at the repo-root `src/`) — same reasoning as
 * `project-access.tsx`'s `ProjectMemberView` and `use-current-user.ts`'s
 * `ViewerUser`.
 */

export interface GithubInstallationView {
  id: number
  accountLogin: string
  /**
   * GitHub's settings page for this installation, where repository access is
   * granted. `null` when GitHub did not supply one.
   *
   * Taken from GitHub rather than assembled here: a personal installation
   * lives at `/settings/installations/<id>` and an organization's at
   * `/organizations/<login>/settings/installations/<id>`, and this payload
   * says which login but not which kind. Any URL built from the login alone
   * would be a 404 for half of them.
   */
  htmlUrl: string | null
}

export interface GithubRepoView {
  id: number
  owner: string
  name: string
  fullName: string
  private: boolean
  defaultBranch: string
}

export interface ProjectRepoConfigView {
  installationId: number
  owner: string
  name: string
  defaultBranch: string
  branch: string
  installCommand: string
  buildCommand: string
  outputDir: string
  autoDeploy: boolean
}

export function isGithubInstallationView(v: unknown): v is GithubInstallationView {
  if (typeof v !== "object" || v === null) return false
  const i = v as Record<string, unknown>
  return typeof i.id === "number" && typeof i.accountLogin === "string"
}

export function isGithubRepoView(v: unknown): v is GithubRepoView {
  if (typeof v !== "object" || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.id === "number" &&
    typeof r.owner === "string" &&
    typeof r.name === "string" &&
    typeof r.fullName === "string" &&
    typeof r.private === "boolean" &&
    typeof r.defaultBranch === "string"
  )
}

export function isProjectRepoConfigView(v: unknown): v is ProjectRepoConfigView {
  if (typeof v !== "object" || v === null) return false
  const c = v as Record<string, unknown>
  return (
    typeof c.installationId === "number" &&
    typeof c.owner === "string" &&
    typeof c.name === "string" &&
    typeof c.defaultBranch === "string" &&
    typeof c.branch === "string" &&
    typeof c.installCommand === "string" &&
    typeof c.buildCommand === "string" &&
    typeof c.outputDir === "string" &&
    typeof c.autoDeploy === "boolean"
  )
}

/**
 * `GET /api/v1/github/installations` never fails its own shape (always
 * `{configured, installations}` — see `github-routes.ts`), but a malformed
 * or unreachable response (network error, non-JSON body) still needs a
 * safe fallback so a transient hiccup degrades to "nothing found" rather
 * than throwing through the component. Degrading to `configured: false`
 * (not `true` with an empty list) is deliberate: a caller that can't even
 * parse the response has no basis to claim the App IS configured.
 */
export function parseInstallationsResponse(v: unknown): {
  configured: boolean
  /**
   * The configured App's public slug (`github.com/apps/{slug}`), so the UI
   * can link at THIS App rather than sending an operator hunting by name.
   * `null` when unconfigured, or on an older server that doesn't send it.
   */
  appSlug: string | null
  installations: GithubInstallationView[]
  /**
   * Phase 3c-1b. The list is now filtered to the caller, and it is a
   * SNAPSHOT captured at sign-in — `installationsStale` means "we don't
   * have a usable snapshot for you", which needs different advice ("sign in
   * again") than a genuinely empty one ("install the App"). Defaults to
   * `false` on an older/garbled body, so a missing flag never invents a
   * "sign in again" prompt out of nothing.
   */
  stale: boolean
  /**
   * When that snapshot was taken, or `null` if unknown. Surfaced because
   * the snapshot model produces one specific confusion — "I just installed
   * the App on my org and it isn't listed" — that only a visible timestamp
   * explains.
   */
  syncedAt: string | null
} {
  const empty = { configured: false, appSlug: null, installations: [], stale: false, syncedAt: null }
  if (typeof v !== "object" || v === null) return empty
  const body = v as Record<string, unknown>
  // Normalized, not just filtered: an older server sends no `htmlUrl` at all,
  // and a caller branching on it should see one absent value rather than two.
  const installations = Array.isArray(body.installations)
    ? body.installations.filter(isGithubInstallationView).map((i) => ({
        id: i.id,
        accountLogin: i.accountLogin,
        htmlUrl: typeof i.htmlUrl === "string" ? i.htmlUrl : null,
      }))
    : []
  return {
    configured: body.configured === true,
    appSlug: typeof body.appSlug === "string" ? body.appSlug : null,
    installations,
    stale: body.installationsStale === true,
    syncedAt: typeof body.installationsSyncedAt === "string" ? body.installationsSyncedAt : null,
  }
}

/**
 * "Checked 3 minutes ago" for the installation snapshot, or `null` when
 * there's no usable timestamp. Coarse on purpose — the question it answers
 * is "is this from before or after I changed something on GitHub", which
 * needs a rough age, not a precise clock.
 */
export function formatSnapshotAge(syncedAt: string | null, nowMs: number = Date.now()): string | null {
  if (syncedAt === null) return null
  const thenMs = Date.parse(syncedAt)
  if (!Number.isFinite(thenMs)) return null
  const minutes = Math.floor((nowMs - thenMs) / 60_000)
  // A clock-skewed future stamp reads as "just now" rather than a negative
  // duration — wrong in a harmless direction, and the alternative (hiding
  // it) removes the signal exactly when something is already off.
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? "" : "s"} ago`
}

export function parseReposResponse(v: unknown): { configured: boolean; repos: GithubRepoView[] } {
  if (typeof v !== "object" || v === null) return { configured: false, repos: [] }
  const body = v as Record<string, unknown>
  const repos = Array.isArray(body.repos) ? body.repos.filter(isGithubRepoView) : []
  return { configured: body.configured === true, repos }
}

/**
 * Narrow `GET /github/installations/:id/repos/:owner/:name/branches`.
 *
 * Degrades to an empty list rather than throwing, matching
 * `parseReposResponse`: the branch picker falls back to a plain text input
 * when it has no names, so a malformed body costs the picker and not the
 * form.
 */
export function parseBranchesResponse(v: unknown): { configured: boolean; branches: string[] } {
  if (typeof v !== "object" || v === null) return { configured: false, branches: [] }
  const body = v as Record<string, unknown>
  const branches = Array.isArray(body.branches)
    ? body.branches.filter((b): b is string => typeof b === "string")
    : []
  return { configured: body.configured === true, branches }
}

/**
 * Who may see mutating controls on the panel, in priority order (loading
 * beats signed-out beats read-only — mirrors `TokensPanel`'s own gating
 * order). Kept separate from `ConnectFlowStage` below: this answers "can
 * the viewer act at all", the flow stage answers "what does the connect
 * wizard show next" — combining them would make either impossible to
 * reason about (a caller who can't manage never reaches a flow stage
 * regardless of what the flow input says).
 *
 * The authorized branch is `"can-manage"`. It was `"owner"` until the M2
 * review fix — a holdover from when the panel derived authority from whether
 * the caller's id appeared on the project's member list. There is no owner
 * concept left anywhere in this product: authority is the caller's INSTANCE
 * role (`admin`/`editor`), mirroring the server's `hasProjectManageAuthority`
 * (`server/auth/authorize.ts`), and a `ProjectMember` row is an access-LIST
 * entry that decides readability of an `invited` project, never a grant of
 * authority. A label that still said "owner" was the last thing telling a
 * reader otherwise. See `derivePanelAccess`'s `canManage` param.
 */
export type PanelAccess = "loading" | "signed-out" | "read-only" | "can-manage"

export function derivePanelAccess(input: {
  currentUserLoading: boolean
  signedIn: boolean
  /** The caller's INSTANCE role permits managing this project — `admin` or `editor`. */
  canManage: boolean
}): PanelAccess {
  if (input.currentUserLoading) return "loading"
  if (!input.signedIn) return "signed-out"
  if (!input.canManage) return "read-only"
  return "can-manage"
}

/** The subset of a repo (picked, or an existing connection) the build-fields form needs to submit. */
export interface RepoRef {
  installationId: number
  owner: string
  name: string
  defaultBranch: string
}

export function repoRefFromConfig(config: ProjectRepoConfigView): RepoRef {
  return {
    installationId: config.installationId,
    owner: config.owner,
    name: config.name,
    defaultBranch: config.defaultBranch,
  }
}

export function repoRefFromPicked(installationId: number, repo: GithubRepoView): RepoRef {
  return { installationId, owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch }
}

/**
 * The connect wizard's current step, derived purely from what's been
 * loaded/selected so far — no component state machine needed beyond
 * holding these inputs. Each variant is a DISTINCT rendered state (per the
 * phase plan's "don't collapse states" rule): `no-installations` and
 * `no-repos` look nothing alike even though both are technically "empty",
 * because the fix is different (install the App vs. grant it more repos).
 *
 * `initialRepoRef` short-circuits straight to `build-form` — used when
 * editing an ALREADY-connected repo's build settings without re-running
 * the installation/repo picker (the "Edit" action on a connected repo).
 * `null` is the normal "connect a new repo" path, which always starts at
 * the installation step.
 */
export type ConnectFlowStage =
  | { kind: "not-configured" }
  | { kind: "loading-installations" }
  | { kind: "no-installations" }
  /**
   * Phase 3c-1b: the caller's installation snapshot is missing or expired,
   * so the server can't authorize them for anything yet. Deliberately its
   * own stage rather than folded into `no-installations`: the fix is "sign
   * in again" (which re-captures the snapshot), not "install the App", and
   * showing the wrong one sends the user to GitHub to fix a problem that
   * isn't there.
   */
  | { kind: "installations-stale" }
  | { kind: "installation-picker"; installations: GithubInstallationView[] }
  | { kind: "loading-repos" }
  | { kind: "no-repos"; installationId: number }
  | { kind: "repo-picker"; repos: GithubRepoView[] }
  | { kind: "build-form"; repo: RepoRef }

export function deriveConnectFlowStage(input: {
  configured: boolean
  initialRepoRef: RepoRef | null
  installations: GithubInstallationView[] | null
  /** Optional so callers predating Phase 3c-1b (and tests) keep the old behavior. */
  installationsStale?: boolean
  selectedInstallationId: number | null
  repos: GithubRepoView[] | null
  selectedRepo: GithubRepoView | null
}): ConnectFlowStage {
  if (!input.configured) return { kind: "not-configured" }
  if (input.initialRepoRef !== null) return { kind: "build-form", repo: input.initialRepoRef }

  if (input.installations === null) return { kind: "loading-installations" }
  // Checked BEFORE the empty-list branch: a stale snapshot always presents
  // as an empty list, so testing emptiness first would swallow it.
  if (input.installationsStale === true) return { kind: "installations-stale" }
  if (input.installations.length === 0) return { kind: "no-installations" }

  if (input.selectedInstallationId === null) {
    return { kind: "installation-picker", installations: input.installations }
  }

  if (input.repos === null) return { kind: "loading-repos" }
  if (input.repos.length === 0) return { kind: "no-repos", installationId: input.selectedInstallationId }

  if (input.selectedRepo === null) return { kind: "repo-picker", repos: input.repos }

  return { kind: "build-form", repo: repoRefFromPicked(input.selectedInstallationId, input.selectedRepo) }
}

// ---------------------------------------------------------------------------
// Build-field validation — mirrors `viewer/server/api/project-repo-routes.ts`
// exactly (field limits and the outputDir traversal rule). The server is the
// sole authority; this is a client-side pre-check only, same posture
// `settings/token-utils.ts` documents for its own mirrored constants.
// ---------------------------------------------------------------------------

export const MAX_SHORT_STRING_CHARS = 255
export const MAX_COMMAND_CHARS = 2000
export const MAX_PATH_CHARS = 1024

export const DEFAULT_INSTALL_COMMAND = "npm ci"
export const DEFAULT_BUILD_COMMAND = "npm run build"
export const DEFAULT_OUTPUT_DIR = "dist"

export interface BuildFieldsDraft {
  branch: string
  installCommand: string
  buildCommand: string
  outputDir: string
  autoDeploy: boolean
}

/** Defaults for a freshly picked repo — `branch` follows the repo's default branch. */
export function defaultBuildFields(repo: { defaultBranch: string }): BuildFieldsDraft {
  return {
    branch: repo.defaultBranch,
    installCommand: DEFAULT_INSTALL_COMMAND,
    buildCommand: DEFAULT_BUILD_COMMAND,
    outputDir: DEFAULT_OUTPUT_DIR,
    // On by default (Mo, 2026-08-29): rebuilding on push is the point of
    // connecting a repository, and the switch is right there for the
    // exception. Editing an existing connection keeps its stored value
    // (`buildFieldsFromConfig`), so this only decides fresh connects.
    autoDeploy: true,
  }
}

/** Pre-fill for editing an existing connection — the stored values, not the repo's defaults. */
export function buildFieldsFromConfig(config: ProjectRepoConfigView): BuildFieldsDraft {
  return {
    branch: config.branch,
    installCommand: config.installCommand,
    buildCommand: config.buildCommand,
    outputDir: config.outputDir,
    autoDeploy: config.autoDeploy,
  }
}

/**
 * Whether a draft still matches what is saved.
 *
 * Drives the Save button's disabled state (Mo, 2026-08-21: "Save should be
 * disabled until something changes"). A Save that is live on an untouched
 * form invites a write that changes nothing, and worse, gives no signal about
 * whether the thing you just typed actually registered.
 *
 * A field-by-field comparison rather than `JSON.stringify`, which would depend
 * on key order and would compare `undefined` and a missing key as different
 * things. Every field of `BuildFieldsDraft` is a primitive, so this is the
 * whole comparison, and a new field added to the draft that is not added here
 * is a Save button that stays dead after editing it — hence the explicit list
 * rather than a loop over `Object.keys`, which would silently accept one.
 */
export function buildFieldsEqual(a: BuildFieldsDraft, b: BuildFieldsDraft): boolean {
  return (
    a.branch === b.branch &&
    a.installCommand === b.installCommand &&
    a.buildCommand === b.buildCommand &&
    a.outputDir === b.outputDir &&
    a.autoDeploy === b.autoDeploy
  )
}

/**
 * `null` when valid, otherwise a user-facing message. Verbatim port of
 * `project-repo-routes.ts`'s `validateBranch` — `branch` is destined for a
 * `git clone --branch` / checkout server-side, so beyond the generic
 * length/non-empty check this also rejects a leading `-` (argument
 * injection against the clone command even with an argv array and no
 * shell) and anything outside git's own refname charset, including a `..`
 * segment. A client mirror that only ran the generic check let those
 * through locally, only to bounce back as a 400 from the server anyway.
 */
export function validateBranch(v: string): string | null {
  if (v.trim().length === 0 || v.length > MAX_SHORT_STRING_CHARS) {
    return `Branch must be a non-empty string of at most ${MAX_SHORT_STRING_CHARS} characters`
  }
  const s = v.trim()
  if (!/^[A-Za-z0-9._\/-]+$/.test(s) || s.startsWith("-") || s.includes("..")) {
    return "Branch must be a valid git ref name: letters, digits, '.', '_', '/', '-', not starting with '-' and with no '..'"
  }
  return null
}

/** `null` when valid, otherwise a user-facing message. Mirrors `validateCommand`. */
export function validateCommand(v: string, field: string): string | null {
  if (v.trim().length === 0 || v.length > MAX_COMMAND_CHARS) {
    return `${field} must be a non-empty string of at most ${MAX_COMMAND_CHARS} characters`
  }
  return null
}

/**
 * True iff `v` is safe to later join against a repo checkout root without
 * escaping it — verbatim port of `project-repo-routes.ts`'s
 * `isSafeRepoRelativePath`. Kept as an exact mirror (not a looser
 * client-side approximation) since a value this rejects locally would just
 * bounce back as a 400 anyway; matching the rule means the field-level
 * error appears before the round trip instead of after it. Charset check
 * FIRST, same order as the server: `dist; rm -rf /` and `$(curl evil.sh)`
 * satisfy every traversal rule below (no leading slash, no drive letter, no
 * `..` segment) and would otherwise slip past this mirror. The dot-only
 * check (a bare `.` or `./`) is separate from the `..`-segment check below
 * it — it isn't a traversal OUT of the checkout root, it resolves TO the
 * root itself, which server-side would serve the whole repo.
 */
export function isSafeRepoRelativePath(v: string): boolean {
  if (v.length === 0 || v.length > MAX_PATH_CHARS) return false
  if (!/^[A-Za-z0-9._\/-]+$/.test(v)) return false
  if (v.startsWith("/") || v.startsWith("\\")) return false
  if (/^[A-Za-z]:/.test(v)) return false
  const segments = v.split(/[\\/]+/)
  if (segments.every((seg) => seg === "." || seg === "")) return false
  return !segments.some((seg) => seg === "..")
}

/** `null` when valid, otherwise a user-facing message. Mirrors `validateOutputDir`. */
export function validateOutputDir(v: string): string | null {
  if (!isSafeRepoRelativePath(v)) {
    return "Output dir must be a repo-relative path: no leading '/' or '\\', no drive letter, and no '..' segment"
  }
  return null
}

export interface BuildFieldsErrors {
  branch: string | null
  installCommand: string | null
  buildCommand: string | null
  outputDir: string | null
}

export function validateBuildFields(fields: BuildFieldsDraft): BuildFieldsErrors {
  return {
    branch: validateBranch(fields.branch),
    installCommand: validateCommand(fields.installCommand, "Install command"),
    buildCommand: validateCommand(fields.buildCommand, "Build command"),
    outputDir: validateOutputDir(fields.outputDir),
  }
}

export function buildFieldsAreValid(errors: BuildFieldsErrors): boolean {
  return errors.branch === null && errors.installCommand === null && errors.buildCommand === null && errors.outputDir === null
}

/** The exact `PUT /api/v1/projects/:id/repo` request body — trimmed, field-by-field, never a spread. */
export function buildRepoConnectRequestBody(repo: RepoRef, fields: BuildFieldsDraft): Record<string, unknown> {
  return {
    installationId: repo.installationId,
    owner: repo.owner,
    name: repo.name,
    branch: fields.branch.trim(),
    installCommand: fields.installCommand.trim(),
    buildCommand: fields.buildCommand.trim(),
    outputDir: fields.outputDir,
    autoDeploy: fields.autoDeploy,
  }
}
