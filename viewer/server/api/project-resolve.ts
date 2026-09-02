import type { Project } from "../storage/types"

/**
 * The reconcile protocol between the Viewer and the Editor.
 *
 * The Editor asks "is there already a project for this embedded id / this
 * repo?" and renders whatever comes back. It never computes the answer
 * itself: the two are independently deployed artifacts on unrelated release
 * schedules, so shared reconcile code would give compile-time agreement in
 * one checkout and nothing at all between an Editor and a Viewer that shipped
 * months apart. The side holding the projects-by-repo index and the comments
 * at risk makes the call, and version skew becomes an ordinary API-contract
 * problem instead of an invisible assumption.
 *
 * The decision function is pure and lives apart from the route so the whole
 * collision matrix is testable without HTTP.
 */

export interface ResolveRequest {
  /** Id from the repo's `.desde/config.json`, when it has one. */
  embeddedId?: string
  /** Git remote of the checkout the Editor is open on. */
  remoteUrl?: string
  /** Display name, used only to suggest a slug when minting. */
  name?: string
}

/**
 * The ONLY project fields this route may put on the wire — the three the
 * Editor needs to link a checkout to a project and render the link.
 *
 * Hand-built field by field, never spread from the storage entity, for the
 * same reason `toTokenView` (tokens-routes.ts) is: this route is deliberately
 * UNAUTHENTICATED, so anything reachable from `Project` is reachable by
 * anyone who can guess an `owner/name` pair. It used to embed the entity
 * whole, which handed an anonymous caller the GitHub App `installationId`,
 * the private repo owner/name, the built branch and the raw install/build
 * command line of a `members` project that answers 404 to that same caller on
 * every other route (security audit S1). A projection also means a field
 * added to `Project` later cannot start round-tripping here by accident —
 * the leak would have to be written on purpose.
 */
export interface ResolveProjectView {
  id: string
  slug: string
  name: string
}

export type ResolveDecision =
  | { decision: "adopt"; project: ResolveProjectView }
  | { decision: "mint"; suggestedSlug: string }
  /**
   * No `conflictWith` project, and no project NAME inside `reason`. The
   * caller does not need either to act — the only useful next step is "mint
   * a new id" or "ask the viewer's owner" — and both would disclose a
   * project the caller has not been shown to be entitled to.
   */
  | { decision: "conflict"; reason: string }

/** The projection itself. One place, so both decision branches agree. */
function toResolveProjectView(project: Project): ResolveProjectView {
  return { id: project.id, slug: project.slug, name: project.name }
}

export interface ResolveLookups {
  /** Project claiming `embeddedId`, if any. */
  byEmbeddedId: Project | null
  /** Project connected to `remoteUrl`'s repo, if any. */
  byRepo: Project | null
}

/**
 * Normalise a git remote to `owner/name`, or null when it isn't recognisable.
 *
 * Handles the three forms a real checkout produces — HTTPS, SSH scp-style, and
 * `ssh://` — with or without a trailing `.git`. Anything else returns null and
 * the caller simply skips the by-repo lookup: failing to RECOGNISE a remote
 * must degrade to "no match found", never to an error, because a project with
 * an exotic remote is still a perfectly valid project.
 */
export function parseRepoRemote(
  remoteUrl: string,
): { owner: string; name: string } | null {
  const trimmed = remoteUrl.trim()
  if (trimmed === "") return null
  // git@host:owner/name(.git) | ssh://…/owner/name(.git) | https://…/owner/name(.git)
  const match = trimmed.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/)
  if (!match) return null
  const [, owner, name] = match
  if (!owner || !name) return null
  return { owner, name }
}

/**
 * Decide how a checkout maps onto this viewer's projects.
 *
 * The table below IS the collision matrix (C1–C6 in the design spec). The one
 * rule underneath all of it: **an ambiguous answer never auto-resolves.** A
 * wrong adopt silently re-points a project's comments, which is far worse than
 * asking.
 */
export function decideResolution(
  req: ResolveRequest,
  found: ResolveLookups,
): ResolveDecision {
  const { byEmbeddedId, byRepo } = found

  if (byEmbeddedId) {
    // C5 — the same embedded id arriving from a DIFFERENT repo than the one
    // already hosting it. That is a fork or a copied config, not a move: one
    // id cannot be served from two repos, so refuse rather than silently
    // re-pointing the existing project at the new checkout.
    const claimed = byEmbeddedId.repoConfig
    const incoming = req.remoteUrl ? parseRepoRemote(req.remoteUrl) : null
    if (claimed && incoming) {
      const sameRepo =
        claimed.owner.toLowerCase() === incoming.owner.toLowerCase() &&
        claimed.name.toLowerCase() === incoming.name.toLowerCase()
      if (!sameRepo) {
        // The claimed repo's owner/name is deliberately NOT named here: the
        // caller proved they hold the embedded id, which says nothing about
        // being entitled to know which private repo currently serves it.
        return {
          decision: "conflict",
          reason:
            "This project id is already hosted from a different repo. This looks like a fork. Mint a new id for it.",
        }
      }
    }
    // The id is the join key, so a hit on it wins over anything else.
    return { decision: "adopt", project: toResolveProjectView(byEmbeddedId) }
  }

  if (byRepo) {
    // C3 — the viewer connected this repo first and has no embedded id yet,
    // so it adopts whatever the repo carries. This is the "created in the
    // Editor, then connected in the Viewer" path working as intended.
    if (byRepo.embeddedId === null) {
      return { decision: "adopt", project: toResolveProjectView(byRepo) }
    }
    // C1/C4 — the repo is already hosted under a DIFFERENT embedded id.
    // Two ids claim one repo; the user has to say which survives, because
    // each may already have comments against it. The existing project's NAME
    // is omitted from the message for the same reason as the fork branch
    // above — this lane is reachable by anyone who can guess `owner/name`.
    return {
      decision: "conflict",
      reason: "This repo is already hosted under a different project id.",
    }
  }

  // Nothing known about either the id or the repo → a genuinely new project.
  return { decision: "mint", suggestedSlug: suggestSlug(req.name) }
}

/**
 * Slug suggestion for the mint case. Intentionally duplicated from the shared
 * module's `deriveSlug` rather than imported: this is a *routing* concern the
 * viewer owns, and the viewer must not depend on the Editor's format module
 * for how its own URLs read.
 */
function suggestSlug(name: string | undefined): string {
  const slug = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "")
  return slug.length > 0 ? slug : "project"
}
