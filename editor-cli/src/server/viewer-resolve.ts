import { basename } from "node:path"
import { readOriginRemoteUrl } from "./git-remote.js"
import { readProjectConfig } from "./project-config.js"
import { normalizeOrigin, readDefaultViewerOrigin, readViewerToken } from "./viewer-token-store.js"

/**
 * Ask the machine's default viewer whether it already knows this repo.
 *
 * This is the auto-link path (Mo, 2026-08-26): point the Editor at a viewer
 * once, and every repo you open afterwards finds its own prototype without a
 * dialog. The viewer has done the hard half of this for a while —
 * `POST /api/v1/projects/resolve` matches on the repo's embedded identity id
 * first and falls back to the git remote as a discovery index — and nothing
 * in the Editor ever called it.
 *
 * ## It NEVER writes
 *
 * Not to the repo, not to the config, not even to mint an identity. Two
 * reasons, and both are load-bearing:
 *
 *  - `ensureProjectIdentity` is documented as reachable only from explicit
 *    user actions, precisely so the CLI never rewrites someone's committed
 *    config behind their back. Booting an editor is not an explicit action.
 *  - The link this produces is RUNTIME state. A resolved link is re-derived
 *    every boot from facts that already exist (the repo's identity, its git
 *    remote, the machine's viewer), so persisting it would only create a
 *    second copy to go stale — and a wrong copy committed into a shared repo
 *    re-points everyone's comments.
 *
 * A repo that wants a durable, committed link still has the connect dialog,
 * which writes `platformBaseUrl` + `projectId` as before. This is additive.
 *
 * ## What it can answer
 *
 * `adopt` — the viewer has this prototype; here is its id. Comments flow.
 *   Only reported once the token has been checked as well: `/projects/resolve`
 *   is deliberately PUBLIC-READ (it answers only for an id or repo the caller
 *   already knows, so the Editor can avoid creating a duplicate before anyone
 *   signs in), which means a revoked token still resolves perfectly. Reporting
 *   that as "linked" would hand back a link whose every comment fetch then
 *   401s at the proxy — the "looks connected, nothing works" state the connect
 *   dialog's token-first ordering exists to prevent. MEASURED against a live
 *   viewer 2026-08-26; unit tests with an injected fetch could not have shown
 *   it, because they never asked a real viewer what it authenticates.
 * `mint` — no match. Deliberately NOT acted on: creating a prototype from the
 *   Editor is not built yet, so this reports "not linked" and stops.
 * `conflict` — the embedded id is claimed by a prototype this token cannot
 *   see. Surfaced verbatim; the viewer withholds the other prototype's name
 *   on purpose, so there is nothing more to say than what it returned.
 * `ambiguous` — several prototypes are connected to this repo, so there is no
 *   single right answer. Reported rather than resolved: picking one would put
 *   comments on a prototype nobody chose, which is the behaviour this replaced.
 *   The candidates come from the AUTHENTICATED list route, so what the user is
 *   shown is what they may actually open. Comments stay local until they choose.
 */
export type ViewerLinkState =
  | { status: "no-viewer" }
  | { status: "no-token"; origin: string }
  | { status: "linked"; origin: string; projectId: string; slug: string; name: string }
  | { status: "unlinked"; origin: string }
  | { status: "conflict"; origin: string; reason: string }
  | { status: "ambiguous"; origin: string; candidates: ViewerCandidate[] }
  | { status: "error"; origin: string; reason: string }

/**
 * One prototype the viewer offers for this repo.
 *
 * Built field by field from the list route's response rather than passed
 * through. This reaches the browser, so a widened projection upstream must
 * not start flowing there on its own — the same rule the viewer applies to
 * its own wire types.
 */
export interface ViewerCandidate {
  projectId: string
  slug: string
  name: string
  /** The branch this prototype builds. */
  branch: string
  /** ISO-8601, or null when it has never been built. */
  lastBuiltAt: string | null
}

interface ResolveDeps {
  home?: string
  /** Injected in tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
}

/** How long the viewer gets to answer before boot moves on without it. */
const RESOLVE_TIMEOUT_MS = 5_000

/**
 * Does the viewer accept this token? `/api/v1/me` is the cheapest
 * authenticated endpoint, and the same one `viewer-probe.ts` uses at connect
 * time, so the two paths agree about what a usable credential is.
 */
async function checkCredential(
  origin: string,
  token: string,
  fetchImpl?: typeof fetch,
): Promise<"ok" | "rejected" | "unreachable"> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS)
  try {
    const res = await (fetchImpl ?? fetch)(`${origin}/api/v1/me`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    })
    if (res.status === 401 || res.status === 403) return "rejected"
    return res.ok ? "ok" : "unreachable"
  } catch {
    return "unreachable"
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The prototypes this token can actually open for `remoteUrl`.
 *
 * Separate from `/projects/resolve` on purpose. That route is public-read, so
 * its count includes prototypes this caller may not be able to see; showing
 * those in a chooser would offer rows whose Link then fails. This route is
 * permission-checked, so its answer is the honest one.
 */
async function fetchRepoCandidates(
  origin: string,
  token: string,
  remoteUrl: string,
  fetchImpl?: typeof fetch,
): Promise<ViewerCandidate[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS)
  try {
    const res = await (fetchImpl ?? fetch)(
      `${origin}/api/v1/projects?remoteUrl=${encodeURIComponent(remoteUrl)}`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: controller.signal,
      },
    )
    if (!res.ok) return []
    const body = (await res.json()) as {
      projects?: {
        id?: unknown
        slug?: unknown
        name?: unknown
        repoMatch?: { branch?: unknown }
        activeDeployment?: { createdAt?: unknown } | null
      }[]
    }
    if (!Array.isArray(body.projects)) return []
    const out: ViewerCandidate[] = []
    for (const p of body.projects) {
      if (typeof p.id !== "string" || typeof p.slug !== "string" || typeof p.name !== "string") {
        continue
      }
      out.push({
        projectId: p.id,
        slug: p.slug,
        name: p.name,
        // An older viewer has no `repoMatch`. The chooser degrades to name
        // and slug rather than refusing to render.
        branch: typeof p.repoMatch?.branch === "string" ? p.repoMatch.branch : "",
        lastBuiltAt:
          typeof p.activeDeployment?.createdAt === "string" ? p.activeDeployment.createdAt : null,
      })
    }
    return out
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

export async function resolveViewerLink(
  repoRoot: string,
  deps: ResolveDeps = {},
): Promise<ViewerLinkState> {
  const origin = await readDefaultViewerOrigin(deps.home)
  if (!origin) return { status: "no-viewer" }

  const token = await readViewerToken(origin, deps.home)
  if (!token) return { status: "no-token", origin }

  // Is the credential actually good? See the header: resolve itself will
  // happily answer without one.
  const credential = await checkCredential(normalizeOrigin(origin), token, deps.fetchImpl)
  if (credential !== "ok") {
    return credential === "rejected"
      ? { status: "no-token", origin }
      : { status: "error", origin, reason: "Could not reach the viewer." }
  }

  // Both keys are optional to the endpoint, but sending neither is a 400.
  // Reading the identity is a plain read — see the header on why nothing is
  // minted here.
  const config = await readProjectConfig(repoRoot)
  const embeddedId = config.ok ? (config.config.project?.id ?? "") : ""
  const remoteUrl = (await readOriginRemoteUrl(repoRoot)) ?? ""
  if (!embeddedId && !remoteUrl) return { status: "unlinked", origin }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS)
  try {
    const doFetch = deps.fetchImpl ?? fetch
    const res = await doFetch(`${normalizeOrigin(origin)}/api/v1/projects/resolve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        ...(embeddedId ? { embeddedId } : {}),
        ...(remoteUrl ? { remoteUrl } : {}),
        name: basename(repoRoot),
      }),
      signal: controller.signal,
    })
    if (res.status === 401 || res.status === 403) {
      // The token is stored but the viewer will not accept it — revoked,
      // expired, or minted for a different instance. Distinct from having no
      // token at all, because the remedy is different.
      return { status: "no-token", origin }
    }
    if (!res.ok) {
      return { status: "error", origin, reason: `The viewer answered ${res.status}.` }
    }
    const body = (await res.json()) as
      | { decision: "adopt"; project: { id: string; slug: string; name: string } }
      | { decision: "mint"; suggestedSlug: string }
      | { decision: "conflict"; reason: string }
      | { decision: "ambiguous"; count: number }
    if (body.decision === "adopt") {
      return {
        status: "linked",
        origin,
        projectId: body.project.id,
        slug: body.project.slug,
        name: body.project.name,
      }
    }
    if (body.decision === "conflict") {
      return { status: "conflict", origin, reason: body.reason }
    }
    if (body.decision === "ambiguous") {
      const candidates = await fetchRepoCandidates(
        normalizeOrigin(origin),
        token,
        remoteUrl,
        deps.fetchImpl,
      )
      // The authenticated list is the honest count. Resolve's is public-read
      // and includes prototypes this caller may not be able to open, so one
      // readable candidate is not an ambiguous question for this user.
      const only = candidates[0]
      if (candidates.length === 1 && only) {
        return {
          status: "linked",
          origin,
          projectId: only.projectId,
          slug: only.slug,
          name: only.name,
        }
      }
      if (candidates.length === 0) return { status: "unlinked", origin }
      return { status: "ambiguous", origin, candidates }
    }
    return { status: "unlinked", origin }
  } catch (err) {
    // An unreachable viewer must never fail a boot. The Editor works offline;
    // comments simply stay local until it can be reached.
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? "The viewer did not answer in time."
        : "Could not reach the viewer."
    return { status: "error", origin, reason }
  } finally {
    clearTimeout(timer)
  }
}
