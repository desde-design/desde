import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express"
import type { AssetStore } from "../assets/types"
import type { ViewerConfig } from "../config"
import { createErrorHandler } from "../error-handler"
import type { StorageAdapter } from "../storage/types"
import {
  buildSingleHostAllowlist,
  createHostAllowlistMiddleware,
  normalizeHostPort,
} from "./host-allowlist"
import {
  createPrototypeHostApiFence,
  createPrototypeHostScope,
  createPrototypeHostTerminalFence,
  type PrototypeHostRegistry,
} from "./prototype-host-scope"
import { createServeRouter, type PinnedDeploymentRequest } from "./serve-router"
import type { LoopbackListenerAppContext } from "./loopback-listeners"

/**
 * The Express app one per-deployment loopback listener runs.
 *
 * ## What it is
 *
 * A whole viewer in miniature, containing only the parts a prototype origin
 * is allowed to have. One deployment, served at `/` on one loopback port. No
 * API router, no JSON body parser, no rate limiter, no root-asset fallback,
 * no Next handler: the prototype owns `/` on this origin, so there is nothing
 * for any of them to do here, and each one omitted is a shell surface that
 * provably cannot answer on a prototype origin.
 *
 * ## Why it rewrites instead of calling a second handler
 *
 * `req.url` is rewritten from `/foo` to `/p/{slug}/foo` and handed to the
 * SHARED `createServeRouter`, exactly as `createSubdomainRewrite` does. The
 * serve router carries the byte-identical 404s, the SPA fallback, the bridge
 * route, the CSP and the nosniff/cache headers; a second copy of that for
 * loopback mode would drift from all of it. The router branches on the pinned
 * marker only where the modes genuinely differ.
 *
 * ## What the marker buys, and why it is not a credential
 *
 * `pinnedDeployment` tells the router two things: read assets by THIS
 * deployment id, and skip the project lookup entirely. Skipping is safe
 * because reaching this socket is the credential — the listener is bound to
 * loopback only, its port is ephemeral, and the API route that opened it
 * already required project read. See the spec's "Loopback mode, in detail"
 * and the comment at the `pinned` read in `serve-router.ts`.
 */
export interface LoopbackListenerAppDeps extends LoopbackListenerAppContext {
  storage: StorageAdapter
  assets: AssetStore
  config: ViewerConfig
  bridgeScript: string
  bridgeVersion: string
  prototypeCsp: string | null
}

/**
 * Marks every request with the deployment this listener is pinned to and
 * rewrites its path into the serve router's `/p/{slug}/…` form.
 *
 * The slug is the listener's own, never the caller's: it comes from the
 * deployment the registry was asked to open, so a request cannot name a
 * different prototype by asking for one. Only the ORIGINAL path is taken from
 * the request, and it keeps its query string.
 *
 * `encodeURIComponent` on the slug is a no-op for every slug storage will
 * produce (the rule is `[a-z0-9][a-z0-9-]{1,62}`) and is here for the slug
 * that rule stops enforcing one day: a `/`, `?` or `#` spliced into a URL
 * unencoded would change which route matches and where the path ends. The
 * bare-slug redirect in `serve-router.ts` encodes for the same reason.
 */
function createPinnedDeploymentRewrite(pinned: { deploymentId: string; slug: string }): RequestHandler {
  const prefix = `/p/${encodeURIComponent(pinned.slug)}`
  return function pinnedDeploymentRewrite(req: Request, _res: Response, next: NextFunction): void {
    ;(req as unknown as PinnedDeploymentRequest).pinnedDeployment = pinned
    req.url = `${prefix}${req.url.startsWith("/") ? req.url : `/${req.url}`}`
    next()
  }
}

export function createLoopbackListenerApp(deps: LoopbackListenerAppDeps): express.Express {
  const app = express()

  // Express's `trust proxy` stays at its default (off). A listener is
  // reachable from this machine only, so there is no proxy in front of it
  // whose forwarded headers could be believed.

  // Normalized ONCE, and both rules below are fed from this one string. They
  // are two comparisons of the same `Host` against the same value, so they
  // must not each do their own lowercasing and IPv6 bracketing — that is how
  // two rules quietly stop agreeing, and a disagreement here would either
  // admit a Host the scope does not mark (a prototype-origin request that
  // skips the write refusal) or mark one the allowlist has already refused.
  const hostPort = normalizeHostPort(deps.hostPort)

  // FIRST, as in `create-app.ts`: exactly one acceptable `Host`. The socket
  // is reachable under every loopback spelling that resolves to this address,
  // and each of those is a DIFFERENT origin — serving them all would make the
  // isolation depend on which name the browser happened to use.
  app.use(createHostAllowlistMiddleware(buildSingleHostAllowlist(hostPort), null))

  // SECOND: this origin is a prototype origin, so refuse every method that
  // could write and mark the request for the fences below. The predicate
  // answers for this listener's own host only, comparing the same normalized
  // string the allowlist admits. `createPrototypeHostScope` lowercases the
  // inbound `Host` before asking, which is the form `normalizeHostPort`
  // produces.
  const registry: PrototypeHostRegistry = {
    isPrototypeHost: (hostHeader: string) => hostHeader === hostPort,
  }
  app.use(createPrototypeHostScope({ registry }))

  // Every request is use, which is what keeps an actively reviewed prototype
  // from being reaped mid-review. Placed after the two refusals above so a
  // rejected Host cannot keep a listener alive.
  app.use((_req, _res, next) => {
    deps.touch()
    next()
  })

  app.use(createPinnedDeploymentRewrite({ deploymentId: deps.deploymentId, slug: deps.slug }))

  // Inert after the rewrite, exactly as it is in subdomain mode: every path
  // now starts with `/p/`. Mounted anyway, because the invariant it states —
  // a prototype-host request never enters a shell router — should be enforced
  // by something other than the rewrite happening to have run.
  app.use(createPrototypeHostApiFence())

  app.use(
    createServeRouter({
      storage: deps.storage,
      assets: deps.assets,
      config: deps.config,
      // Fixed for the life of this listener, not read per request. A listener
      // is keyed on (deployment, shellOrigin) precisely so that this string —
      // which becomes the bridge's `data-shell-origin` and the CSP's
      // `frame-ancestors` — is decided once, by the API that opened the
      // listener, from a Host the allowlist had already accepted. The
      // `(req) => string` shape of `resolveShellOrigin` exists for the main
      // app, where the answer genuinely varies per request
      // (`create-app.ts`); a listener ignores `req` entirely and always
      // returns this one value.
      resolveShellOrigin: () => deps.shellOrigin,
      bridgeScript: deps.bridgeScript,
      bridgeVersion: deps.bridgeVersion,
      prototypeCsp: deps.prototypeCsp,
    }),
  )

  // LAST before the error handler. There is no Next handler on a listener, so
  // nothing here could serve a shell page — which is exactly why the fence is
  // mounted: it makes "nothing past the serve router is prototype content" a
  // rule of this app rather than an accident of what is not mounted.
  app.use(createPrototypeHostTerminalFence())

  // Shared with `create-app.ts`. Without it Express's default handler writes
  // a stack trace into the body in development, on an origin a hostile
  // prototype can read.
  app.use(createErrorHandler())

  return app
}
