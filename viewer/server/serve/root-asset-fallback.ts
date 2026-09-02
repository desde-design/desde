import type { RequestHandler } from "express"
import { extname } from "node:path"
import {
  canReadProject,
  loadProjectReadPolicy,
  makeProjectMembership,
  resolveReadContextLenient,
} from "../auth/authorize"
import { UnsafePathError, type AssetStore } from "../assets/types"
import type { ViewerConfig } from "../config"
import type { StorageAdapter } from "../storage/types"
import { allowPrototypeCors } from "./prototype-cors"
import { verifyPrototypeCapability } from "./prototype-capability"
import { CAPABILITY_SEGMENT, splitCapabilityPrefix } from "./prototype-capability-path"

export interface RootAssetFallbackDeps {
  storage: StorageAdapter
  assets: AssetStore
  config: ViewerConfig
}

/** Path prefixes that belong to the viewer itself, never to a prototype. */
const RESERVED_PREFIXES = ["/api/", "/p/", "/_next/", "/__nextjs"]

/**
 * Both lanes below run the SAME visibility check the serve router does
 * (Phase 3b-1 Task 3; see ../auth/authorize.ts) — this middleware is
 * reachable without any `/p/` prefix and would otherwise be a cross-project
 * existence oracle: without the check, an unreadable project's assets would
 * still resolve here even though `/p/{slug}/**` itself now 404s them.
 *
 * Second half of the F-1 fix (design spec § Serving model). HTML attribute
 * rewriting cannot reach root-absolute URLs baked inside JS bundles (e.g.
 * Vite emits `"/assets/ace-BoGNNI9v.png"` strings for imported images).
 * Those requests arrive at the viewer root and would 404. This middleware
 * resolves them deterministically, in order:
 *
 * 1. **Referer** — a same-origin request from a page under `/p/{slug}/`
 *    carries the full referring path by default (the default
 *    `strict-origin-when-cross-origin` policy only trims cross-origin).
 *    If that prototype's active deployment has the file, 302 there.
 *    Per-request scoping — two prototypes open in two tabs cannot
 *    cross-contaminate. When the referer carries a `~c/<token>`
 *    capability prefix (the sandboxed review iframe's own URL — see
 *    `prototype-capability-path.ts`), that capability both AUTHORIZES the
 *    redirect and is carried INTO it: the sandboxed iframe's opaque origin
 *    sends no session cookie on subresource requests, so an `all-members`
 *    or private bundle's root-absolute asset would 404 for a signed-in
 *    member without it. See the lane below for the two-way authorization.
 * 2. **Active-deployment scan** — content-hashed filenames (Vite/CRA
 *    fingerprinting) are location-independent: a name collision implies a
 *    content collision, so redirecting to the first active deployment that
 *    has the exact path is safe. `listProjects()` ordering is documented
 *    (createdAt ASC) so the scan is deterministic. Scoped to NESTED paths
 *    only (a path containing `/`) — a root-level file (e.g. `favicon.ico`)
 *    belongs to the shell or to the Referer lane above; scanning it here
 *    would let an uploaded prototype silently shadow the viewer's own
 *    root-level assets.
 * 3. Neither → `next()`, and the request falls through to Next.js /
 *    the default 404.
 *
 * Only GET/HEAD requests for paths with a file extension are considered —
 * everything else (page navigations, API calls, POSTs) passes straight
 * through untouched.
 */
export function createRootAssetFallback(deps: RootAssetFallbackDeps): RequestHandler {
  return async (req, res, next) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") return next()
      const rawPath = req.path
      if (RESERVED_PREFIXES.some((p) => rawPath.startsWith(p))) return next()
      if (extname(rawPath) === "") return next()

      let relPath: string
      try {
        relPath = decodeURIComponent(rawPath).replace(/^\//, "")
      } catch {
        return next() // malformed escape — not ours to answer
      }

      const redirect = (slug: string, capability: string | null) => {
        res.setHeader("Cache-Control", "no-store")
        // Same opaque-origin readers as `/p/**` itself — see
        // `prototype-cors.ts`. This redirect is how a root-absolute asset
        // URL baked into a prototype's own JS bundle resolves, so the
        // redirected-to response needs the same header the final `/p/**`
        // response already carries.
        allowPrototypeCors(res)
        const encodedPath = relPath.split("/").map(encodeURIComponent).join("/")
        // Carry the capability into the redirect when the request was
        // authorized by one, so the follow-up `/p/{slug}/~c/{token}/…`
        // request re-authorizes the SAME way. The sandboxed review iframe
        // has an opaque origin and sends no session cookie on subresource
        // requests, so a plain `/p/{slug}/…` redirect would 404 in
        // `serve-router.ts` for exactly the prototypes this lane exists to
        // serve. The token is already charset-validated by
        // `splitCapabilityPrefix` (SAFE_TOKEN), so it needs no encoding.
        const capabilityPrefix = capability ? `${CAPABILITY_SEGMENT}/${capability}/` : ""
        res.redirect(302, `/p/${encodeURIComponent(slug)}/${capabilityPrefix}${encodedPath}`)
      }

      // Resolved LAZILY (and memoized) — only once a candidate project is
      // actually found that needs the visibility check, so a plain miss
      // (no referer, no nested path — e.g. a bare `GET /favicon.ico` with
      // nothing to redirect to) never pays a getSession + getUser round
      // trip it doesn't need. Still resolved at most once per request when
      // it IS needed — same "resolve the caller once per request"
      // discipline as the JSON routes, just deferred until first use.
      //
      // LENIENT on the bearer (`resolveReadContextLenient`), matching the
      // serve router: this middleware delivers prototype FILES, and an
      // unrecognized bearer — typically a prototype stubbing auth against
      // its own mocked API — degrades to anonymous rather than 401ing.
      // Nothing is given away: `canReadProject` still runs with the
      // anonymous context at both call sites below, so an unreadable
      // project's assets stay unresolvable. The earlier strict version also
      // had a wrinkle this removes: because the resolution is lazy, a
      // request with NO candidate project match never evaluated the bearer
      // at all, so "an invalid bearer always 401s" was never actually true
      // here.
      let ctxPromise: ReturnType<typeof resolveReadContextLenient> | null = null
      const getCtx = (): ReturnType<typeof resolveReadContextLenient> => {
        if (!ctxPromise) ctxPromise = resolveReadContextLenient(deps, req)
        return ctxPromise
      }
      // Memoized for the same reason and in the same shape as the context
      // above: the hashed-name scan below runs `canReadProject` once per
      // active deployment, and re-reading an instance-wide setting inside
      // that loop would both cost a lookup per project and let a mid-request
      // toggle apply to some candidates and not others.
      let policyPromise: ReturnType<typeof loadProjectReadPolicy> | null = null
      const getPolicy = (): ReturnType<typeof loadProjectReadPolicy> => {
        if (!policyPromise) policyPromise = loadProjectReadPolicy(deps.storage)
        return policyPromise
      }
      const membership = makeProjectMembership(deps.storage)

      // 1. Referer-scoped resolution.
      const referer = req.get("referer")
      if (referer) {
        const { slug, capability } = refererSlugAndCapability(referer)
        if (slug) {
          const project = await deps.storage.getProjectBySlug(slug)
          if (project?.activeDeploymentId) {
            // Two ways to authorize the redirect, and they cover two
            // different clients:
            //
            //  - The ordinary read context (session cookie / PAT) covers a
            //    same-origin, UNSANDBOXED prototype whose subresource
            //    requests still carry the cookie.
            //  - A capability carried in the referer's `~c/<token>` segment
            //    covers the SANDBOXED review iframe. Its opaque origin drops
            //    the `SameSite=Lax` session cookie on subresource requests
            //    (measured — see `app/prototype-origin.ts`), so a
            //    root-absolute asset baked into a private OR `all-members`
            //    bundle would otherwise 404 here even for a signed-in
            //    member. The capability is the SAME credential
            //    `/p/{slug}/~c/{token}/` already accepts, verified against
            //    this slug and the project's CURRENT deployment.
            //
            // Verifying (not merely trusting) the capability here keeps the
            // no-existence-oracle property: a forged/expired token with no
            // cookie falls through to the identical `next()` a plain miss
            // takes. `||` short-circuits, so a valid capability skips the
            // session lookup entirely.
            const capabilityOk =
              capability !== null &&
              verifyPrototypeCapability({
                token: capability,
                secret: deps.config.sessionSecret,
                slug,
                deploymentId: project.activeDeploymentId,
              })
            const authorized =
              capabilityOk ||
              (await canReadProject(await getCtx(), project, membership, await getPolicy()))
            if (authorized && (await safeHas(deps.assets, project.activeDeploymentId, relPath))) {
              return redirect(project.slug, capabilityOk ? capability : null)
            }
          }
        }
      }

      // 2. Hashed-name scan across active deployments (nested paths only —
      //    root-level files belong to the shell or to the Referer lane; a
      //    root-level uploaded file must not shadow the viewer's own
      //    root-level assets, e.g. /favicon.ico).
      if (relPath.includes("/")) {
        for (const project of await deps.storage.listProjects()) {
          if (!project.activeDeploymentId) continue
          const ctx = await getCtx()
          if (!(await canReadProject(ctx, project, membership, await getPolicy()))) continue
          if (await safeHas(deps.assets, project.activeDeploymentId, relPath)) {
            return redirect(project.slug, null)
          }
        }
      }

      return next()
    } catch (error) {
      return next(error)
    }
  }
}

/**
 * Extracts the prototype slug AND any capability token from a referring
 * `/p/{slug}/…` URL. The capability lives in the `~c/<token>` prefix right
 * after the slug (see `prototype-capability-path.ts`); the sandboxed review
 * iframe's document URL carries it, and a same-origin subresource request
 * reflects the whole path as its `Referer`. Both are `null` when the referer
 * is not a prototype URL (a cross-origin referer, or one under a different
 * path), which leaves the caller on the original slug-only behaviour.
 */
function refererSlugAndCapability(referer: string): {
  slug: string | null
  capability: string | null
} {
  try {
    const match = new URL(referer).pathname.match(/^\/p\/([^/]+)\/(.*)$/)
    if (!match) return { slug: null, capability: null }
    const slug = decodeURIComponent(match[1])
    const rest = match[2]
      .split("/")
      .filter((seg) => seg.length > 0)
      .map((seg) => {
        try {
          return decodeURIComponent(seg)
        } catch {
          return seg
        }
      })
    const { token } = splitCapabilityPrefix(rest)
    return { slug, capability: token }
  } catch {
    return { slug: null, capability: null }
  }
}

/** True if the deployment has the file; unsafe paths count as a miss. */
async function safeHas(assets: AssetStore, deploymentId: string, relPath: string): Promise<boolean> {
  try {
    return (await assets.get(deploymentId, relPath)) !== null
  } catch (error) {
    if (error instanceof UnsafePathError) return false
    throw error
  }
}
