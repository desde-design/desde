/**
 * Phase 3c-1b — the one place that answers "which GitHub App installations
 * may THIS caller see".
 *
 * Before 3c-1b there was no such answer. `GET /github/installations` and the
 * connect-repo route both verified the client-supplied installation id
 * against `listInstallations()` — the App's ENTIRE inventory — which
 * confirms that *the App* has the installation, not that *the caller* does.
 * Any GitHub account that could sign in could therefore enumerate every
 * installation and every private repo name the App could reach, and attach
 * any of them to a project it owned. Unifying sign-in onto the App
 * (`auth/github-auth-provider.ts`) is what makes a real answer possible:
 * `GET /user/installations` needs a USER access token, which only the App's
 * own user-OAuth flow yields.
 *
 * Two properties this module exists to guarantee:
 *
 * 1. **The authorization input is server-derived.** The caller's set comes
 *    from `storage.getUserInstallations`, written by the OAuth callback and
 *    by nothing else. No request body, query param or header contributes.
 * 2. **A refusal is indistinguishable from a miss.** Callers get a plain
 *    "is it in your set" boolean, so a route cannot accidentally answer
 *    "that exists but isn't yours" — see `github-routes.ts`, where both
 *    outcomes flow through one 404.
 *
 * **Security audit B4 added the second question this module answers:**
 * "which REPOS inside that installation may this caller see". Installation
 * visibility is coarser than repo access — GitHub grants an installation a
 * set of repos, and an ordinary org member is routinely denied most of them
 * — so `filterReposForCaller` intersects the installation's repo list with
 * the caller's own, captured at sign-in from
 * `GET /user/installations/{id}/repositories`.
 */

import type { StorageAdapter, User } from "../storage/types"
import type { GitHubAppClient, Installation, Repo } from "./types"

/**
 * How old a captured installation set may be before it stops authorizing
 * anything. Equal to the session lifetime in `auth-routes.ts`, and for the
 * same reason: the set is refreshed on every sign-in, so for a cookie
 * caller this bound is already implied by the cookie's own expiry. It
 * BITES for a caller authenticating with a long-lived machine token, who
 * could otherwise keep acting on an installation set captured years ago —
 * long after being removed from the org that granted it.
 *
 * Expiry fails CLOSED (the set authorizes nothing) and is reported as
 * `stale: true` so the UI can say "sign in again" rather than "you have no
 * installations".
 */
export const INSTALLATION_SET_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export interface CallerInstallations {
  /**
   * The App installations this caller may see: the intersection of the
   * caller's captured id set with the App's current inventory (which
   * supplies `accountLogin` for display, and drops installations the App
   * itself has since lost).
   */
  installations: Installation[]
  /** When the caller's set was captured, or `null` if it never was. */
  syncedAt: string | null
  /**
   * True when the set is missing or past `INSTALLATION_SET_MAX_AGE_MS`. In
   * both cases `installations` is empty — the caller is authorized for
   * nothing until they sign in again, which is the only refresh there is
   * (no provider credential is stored to re-query with).
   */
  stale: boolean
}

export interface CallerInstallationDeps {
  storage: StorageAdapter
  githubApp: GitHubAppClient
}

export async function resolveCallerInstallations(
  deps: CallerInstallationDeps,
  user: User,
  nowMs: number = Date.now(),
): Promise<CallerInstallations> {
  const record = await deps.storage.getUserInstallations(user.id)
  if (!record) return { installations: [], syncedAt: null, stale: true }

  const syncedAtMs = Date.parse(record.syncedAt)
  // An unparseable stamp is treated as expired rather than as "fresh
  // enough" — an unreadable age must never be the permissive branch.
  if (!Number.isFinite(syncedAtMs) || nowMs - syncedAtMs > INSTALLATION_SET_MAX_AGE_MS) {
    return { installations: [], syncedAt: record.syncedAt, stale: true }
  }

  // Only reached for a fresh record, so a stale or absent set costs no
  // GitHub call at all.
  const appInstallations = await deps.githubApp.listInstallations()
  const allowed = new Set(record.installations.map((e) => e.installationId))
  return {
    installations: appInstallations.filter((i) => allowed.has(i.id)),
    syncedAt: record.syncedAt,
    stale: false,
  }
}

/**
 * The repos in `installationId` that BOTH the installation grants AND this
 * caller can personally reach — security audit B4.
 *
 * Installation membership was the only check before this, and it is not an
 * access decision: GitHub grants an *installation* a set of repos, while an
 * individual org member may be denied most of them. An ordinary member of an
 * org whose App is installed on "All repositories" could therefore attach a
 * private repo to a project they own, and the build runner would then clone
 * it with an INSTALLATION token — reading source GitHub itself would have
 * refused them.
 *
 * Deliberately shaped as a FILTER rather than as "give me the caller's repo
 * set", so the fail-closed behaviour cannot be got wrong at a call site: a
 * user whose per-installation repo set was never captured (`null`), or whose
 * whole record is stale/absent, gets `[]` — nothing to match against —
 * instead of a `null` a caller might read as "unrestricted". That is the
 * same posture `resolveCallerInstallations` already takes on staleness, and
 * it is the state every user who last signed in before this change is in
 * until they sign in again.
 *
 * Comparison is on lowercased `owner/name`, because GitHub owner/repo names
 * are case-insensitive and a case-sensitive miss here would read as a
 * refusal.
 */
export async function filterReposForCaller(
  deps: Pick<CallerInstallationDeps, "storage">,
  user: User,
  installationId: number,
  repos: Repo[],
  nowMs: number = Date.now(),
): Promise<Repo[]> {
  const record = await deps.storage.getUserInstallations(user.id)
  if (!record) return []
  const syncedAtMs = Date.parse(record.syncedAt)
  if (!Number.isFinite(syncedAtMs) || nowMs - syncedAtMs > INSTALLATION_SET_MAX_AGE_MS) return []

  const entry = record.installations.find((e) => e.installationId === installationId)
  if (!entry || entry.repoFullNames === null) return []

  const allowed = new Set(entry.repoFullNames.map((n) => n.toLowerCase()))
  return repos.filter((r) => allowed.has(`${r.owner}/${r.name}`.toLowerCase()))
}

/**
 * Whether `installationId` is one this caller may act on. Deliberately a
 * boolean, not a lookup result: a route that could tell "unknown to the
 * App" from "known but not yours" would leak the App's inventory one probe
 * at a time, which is the exact finding this phase closes.
 */
export async function callerCanSeeInstallation(
  deps: CallerInstallationDeps,
  user: User,
  installationId: number,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const { installations } = await resolveCallerInstallations(deps, user, nowMs)
  return installations.some((i) => i.id === installationId)
}
