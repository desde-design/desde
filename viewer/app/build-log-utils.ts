/**
 * Pure logic for the build panel. `viewer/app` has no component-test setup
 * (vitest runs `environment: "node"`, no RTL), so anything worth asserting
 * lives here rather than inside the component — the same split
 * `settings/token-utils.ts` established.
 */

export type DeploymentStatus = "building" | "deployed" | "failed"

/** Matches the server's `RootAbsoluteAssetFindingKind` (server/storage/types.ts). */
export type RootAbsoluteAssetFindingKind = "html-attr" | "css-url" | "js-runtime-base"

export interface RootAbsoluteAssetFinding {
  file: string
  kind: RootAbsoluteAssetFindingKind
  sample: string
}

/** Matches the server's `DeploymentWarning` (server/storage/types.ts). */
export interface DeploymentWarning {
  kind: "root-absolute-assets"
  summary: string
  findings: RootAbsoluteAssetFinding[]
}

/** One phase of a build. Mirrors the server's `BuildStep`. */
export interface BuildStepView {
  name: string
  status: "running" | "succeeded" | "failed"
  startedAt: string
  endedAt?: string
}

function isBuildStepView(v: unknown): v is BuildStepView {
  if (typeof v !== "object" || v === null) return false
  const s = v as Record<string, unknown>
  return (
    typeof s.name === "string" &&
    (s.status === "running" || s.status === "succeeded" || s.status === "failed") &&
    typeof s.startedAt === "string" &&
    (s.endedAt === undefined || typeof s.endedAt === "string")
  )
}

/**
 * How long a step took, or has been running, in words.
 *
 * Seconds up to a minute, then `m s`, then `h m` past an hour.
 *
 * The hours tier is not hypothetical. A RUNNING step is measured against now,
 * so a build that hangs — or a deployment row whose start is older than the
 * page thinks — renders whatever the gap is. Without it the gallery's running
 * fixture read "4833m 35s", which is technically true and tells nobody
 * anything. Seconds are dropped at that scale for the same reason.
 *
 * Returns null for an unparseable pair rather than "NaNs", so a caller renders
 * nothing.
 */
export function stepDuration(step: BuildStepView, now: number = Date.now()): string | null {
  const started = Date.parse(step.startedAt)
  if (Number.isNaN(started)) return null
  const ended = step.endedAt ? Date.parse(step.endedAt) : now
  if (Number.isNaN(ended)) return null
  const seconds = Math.max(0, Math.round((ended - started) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export interface DeploymentView {
  id: string
  status: DeploymentStatus
  commitSha: string | null
  /**
   * The built commit's subject line. Optional AND nullable, like `steps`:
   * absent from an older viewer's rows, `null` for an upload or a build
   * from before the field. The card leads with it when present (Mo,
   * 2026-08-30), with the short sha beside it.
   */
  commitMessage?: string | null
  /**
   * The build's phases, when it ran any.
   *
   * Optional AND nullable, because both reach the client: absent on a row
   * from a viewer too old to send it, `null` for an upload or a build that
   * recorded none.
   */
  steps?: BuildStepView[] | null
  /**
   * OPTIONAL, because the server omits it for a caller who is not an owner or
   * admin (S7). Absent means "not shown to you", never "this build logged
   * nothing" — which is why the route omits the key rather than sending "".
   */
  buildLog?: string
  warnings: DeploymentWarning[] | null
  createdAt: string
}

export function isDeploymentView(v: unknown): v is DeploymentView {
  if (typeof v !== "object" || v === null) return false
  const d = v as Record<string, unknown>
  return (
    typeof d.id === "string" &&
    (d.status === "building" || d.status === "deployed" || d.status === "failed") &&
    (d.commitSha === null || typeof d.commitSha === "string") &&
    (d.commitMessage === undefined || d.commitMessage === null || typeof d.commitMessage === "string") &&
    // Optional, NOT required. Requiring it made this guard reject every row
    // the server sends to a non-owner, so a member with read access saw
    // "Never deployed" on a project with a full deployment history. The
    // route's own comment says the opposite is intended: the history "stays
    // visible to every project reader ... only the LOG CONTENT is raised to
    // owner/admin". The client was throwing away rows the server meant them
    // to have. Fixed 2026-08-21.
    (d.buildLog === undefined || typeof d.buildLog === "string") &&
    // Same optionality rule as `buildLog`, for a different reason: absent
    // means an older viewer, `null` means an upload. Neither is an error, and
    // a malformed array drops the whole row rather than rendering half a
    // build.
    (d.steps === undefined ||
      d.steps === null ||
      (Array.isArray(d.steps) && d.steps.every(isBuildStepView))) &&
    (d.warnings === null || Array.isArray(d.warnings)) &&
    typeof d.createdAt === "string"
  )
}

/** Short sha for display. Returns a dash when a build never resolved one. */
export function shortSha(sha: string | null): string {
  if (!sha) return "—"
  return sha.slice(0, 7)
}

export interface StatusPresentation {
  label: string
  /** Theme token class, never a hardcoded colour. */
  tone: "muted" | "success" | "destructive"
  /** Drives the spinner and whether the log stream should stay open. */
  active: boolean
}

export function presentStatus(status: DeploymentStatus): StatusPresentation {
  switch (status) {
    case "building":
      return { label: "Building", tone: "muted", active: true }
    case "deployed":
      return { label: "Deployed", tone: "success", active: false }
    case "failed":
      return { label: "Failed", tone: "destructive", active: false }
  }
}

/**
 * Appends an SSE delta to what is already rendered.
 *
 * Bounded so a runaway build cannot grow the browser's string forever — the
 * server caps the STORED log, but a client that stays open across many
 * emits accumulates independently. Trims from the FRONT: the interesting
 * part of a failing build is always the end.
 */
export const MAX_RENDERED_LOG_CHARS = 200_000

export function appendLogDelta(current: string, delta: string): string {
  const next = current + delta
  if (next.length <= MAX_RENDERED_LOG_CHARS) return next
  return next.slice(next.length - MAX_RENDERED_LOG_CHARS)
}

/**
 * Why a build can't be started right now, or null when it can.
 *
 * Returning the REASON rather than a boolean is deliberate: a disabled
 * button with no explanation is the single most common way this kind of
 * panel becomes unusable — the user cannot tell "you lack permission" from
 * "connect a repo first" from "a build is already running".
 */
export function buildBlockedReason(opts: {
  canManage: boolean
  hasRepo: boolean
  buildsEnabled: boolean
  isBuilding: boolean
}): string | null {
  // No-repo wins over no-App (Mo, 2026-08-30): with nothing attached, the
  // person's next step is the connect flow — which handles the App on its
  // own — so leading with the App would explain a problem they don't have
  // yet. The App reason only stands where a repo WAS attached, i.e. the
  // App-config-lost state; the Deployments tab renders that cause as the
  // shared `GithubAppUnreachableBanner`, keeping this string for the
  // disabled Deploy button's own title.
  if (!opts.hasRepo) return "Connect a GitHub repository first"
  // Names the cause, not a phantom feature toggle: `buildsEnabled` IS "a
  // GitHub App is configured" (`use-build-access.ts`), and "builds are not
  // enabled" read as a switch somebody could flip. Builds clone through the
  // App, so no App means no builds.
  if (!opts.buildsEnabled) return "Building needs a GitHub App, which isn't set up on this viewer"
  if (!opts.canManage) return "Only editors and admins can start a build"
  if (opts.isBuilding) return "A build is already running"
  return null
}

/**
 * Whether a root-absolute-asset warning is worth SHOWING right now.
 *
 * `Deployment.warnings` is always recorded, whether or not it will ever be
 * shown — a project's access can change after the scan ran, so this is
 * computed fresh from the project's CURRENT state, not baked in at scan
 * time. See `Deployment.warnings`'s doc comment on the server.
 *
 * Two things make the failure this warns about not apply:
 *
 * - **Subdomain isolation** (`serveDomain` set) — each prototype gets its
 *   own origin, so a root-absolute URL resolves against that origin's own
 *   root correctly. Only path mode (`serveDomain: null`) rewrites URLs at
 *   serve-time and needs the capability prefix a runtime-built URL escapes.
 * - **A genuinely public-link project** — no credential is needed to reach
 *   it in the first place, so there's nothing for a runtime-built URL to
 *   fail to carry. `publicLinksEnabled` is the instance-wide kill switch: a
 *   `public-link` project behaves like `all-members` (sign-in required)
 *   once that switch is off, so the warning applies then too.
 */
export function shouldShowRootAbsoluteWarning(opts: {
  access: "all-members" | "invited" | "public-link"
  publicLinksEnabled: boolean
  serveDomain: string | null
}): boolean {
  if (opts.serveDomain !== null) return false
  const effectivelyPublic = opts.access === "public-link" && opts.publicLinksEnabled
  return !effectivelyPublic
}
