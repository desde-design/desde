import type { NextFunction, Request, RequestHandler, Response } from "express"
import { slugFromHost } from "./subdomain"

/**
 * A request that arrived on a PROTOTYPE origin serves prototype routes only.
 *
 * ## The boundary this makes explicit
 *
 * The Host allowlist (`host-allowlist.ts`) guarantees that by the time
 * anything reads `Host`, it is one of a closed set. This module is the next
 * question: given that the Host is known-good, is it the SHELL's host or a
 * PROTOTYPE's host — and if it is a prototype's, the shell's routers
 * (`/api/**`, the Next shell pages, every sign-in route) must be unreachable,
 * so no session cookie can ever be issued on a prototype origin.
 *
 * Subdomain mode already had that property, but only as a side effect:
 * `createSubdomainRewrite` rewrites every path on a `{slug}.{serveDomain}`
 * host into `/p/{slug}/…`, so `/api/v1/**` was never routed there. That is a
 * real boundary and it is why subdomain mode is safe today — but it is
 * implicit, and it holds only where a rewrite is mounted. Per-deployment
 * loopback listeners have a rewrite of their own now
 * (`loopback-listener-app.ts`), so the property holds there too — by the same
 * accident, in a second place, which is exactly the shape that rots. So the
 * invariant is stated here, in two pieces, and tested as itself.
 *
 * ## Why the rule is not a path blacklist
 *
 * In the isolated modes the prototype OWNS `/` on its origin:
 *
 * - `/_next/static/…` is a Next static export's own asset path.
 * - `/api/data.json` may be the prototype's own mock file.
 * - `/settings` may be the prototype's SPA route (serve-router.ts's
 *   extensionless fallback serves `index.html` for it).
 *
 * Refusing those paths because they LOOK like the shell's would break the
 * prototypes this whole design exists to serve. So the rule is stated the
 * other way round: on a prototype host, prototype content is served and the
 * shell's routers are unreachable — enforced by method and by prefix, not by
 * a list of paths that are considered shell-ish.
 *
 * ## Why there is no redirect for a human who lands here
 *
 * An earlier draft answered a document request on a prototype host with a
 * 302 to `${publicUrl}${originalUrl}`. That came from the
 * single-alternate-host design, where the whole app answered on the alternate
 * host and a mistyped host could mint a second session. It does not fit the
 * per-deployment design: the main app's other loopback spelling
 * (`127.0.0.1:3100`) is a SHELL host, not a prototype host — the shell keeps
 * whichever spelling the user opened — and a prototype host owns `/`, so
 * there is no non-prototype path left to redirect. A human who types a
 * listener port into the address bar sees the prototype, which is the honest
 * answer, and never a sign-in page on an origin that must not have one.
 */

/**
 * The serve router's generic not-found body, as a constant so the two 404s
 * this module emits are byte-identical to it (`serve-router.ts` imports this
 * and sends it). Byte-identity is the point: a caller must not be able to
 * tell "this method is refused on a prototype origin" from "this prototype
 * has no such file", because the first answer is a statement about the
 * viewer's topology and the second is not.
 */
export const PROTOTYPE_NOT_FOUND_BODY = "Not found"

/**
 * Answers whether a `Host` names a prototype origin.
 *
 * Three implementations: the serve-domain rule below; the loopback listener
 * registry (`loopback-listeners.ts`), which answers for every live listener's
 * ephemeral port and so cannot be built at boot; and the one-host predicate a
 * listener's own app builds for itself. `composePrototypeHostRegistries` is
 * how any of them are used together.
 *
 * `hostHeader` is expected LOWERCASED — the allowlist upstream compares
 * lowercased but deliberately does not mutate `req.headers.host`, so the
 * caller lowercases. `createPrototypeHostScope` does exactly that.
 */
export interface PrototypeHostRegistry {
  isPrototypeHost(hostHeader: string): boolean
}

/**
 * The `{slug}.{serveDomain}` rule, delegated whole to `slugFromHost` so the
 * "exactly one label, and it must satisfy the slug rule" discipline has one
 * definition shared with the rewrite that routes these hosts and with the
 * allowlist that admits them.
 *
 * Note what is NOT asked here: whether the slug names a project that exists,
 * or one the caller may read. Both are the serve router's questions, and
 * answering either here would turn this middleware into an existence oracle
 * — the refusals below would differ by project. A syntactically valid
 * prototype host is a prototype host.
 */
export function createServeDomainRegistry(serveDomain: string | null): PrototypeHostRegistry {
  return {
    isPrototypeHost(hostHeader: string): boolean {
      return slugFromHost(hostHeader, serveDomain) !== null
    },
  }
}

/**
 * The `Host` header spellings a browser may legitimately use to reach a
 * single configured origin, lowercased.
 *
 * Always the canonical `URL.host` (which drops a scheme-default port), and —
 * when the origin carries no explicit port — also the explicit scheme-default
 * spelling (`host:443` / `host:80`), because a client that spells the default
 * port out is equally legitimate. This is the SAME set of spellings
 * `host-allowlist.ts` admits for the prototype origin, so the allowlist and
 * this registry can never disagree about which `Host` is the prototype host.
 *
 * IPv6 needs no special handling: `URL.host`/`URL.hostname` already bracket it
 * (`[::1]`), the only form a `Host` header uses.
 */
export function prototypeOriginHostSpellings(origin: string): Set<string> {
  const url = new URL(origin)
  const spellings = new Set<string>([url.host.toLowerCase()])
  if (url.port === "") {
    const defaultPort = url.protocol === "https:" ? "443" : "80"
    spellings.add(`${url.hostname.toLowerCase()}:${defaultPort}`)
  }
  return spellings
}

/**
 * The `VIEWER_PROTOTYPE_ORIGIN` rule: a `Host` naming the single configured
 * prototype origin is a prototype host.
 *
 * Registered as a `PrototypeHostRegistry` member in `create-app.ts` so the two
 * fences mark this host and no session cookie is ever issued on it — the same
 * guarantee subdomain mode gets from `createServeDomainRegistry`. Returns a
 * registry that matches nothing when `prototypeOrigin` is null.
 */
export function createPrototypeOriginRegistry(prototypeOrigin: string | null): PrototypeHostRegistry {
  const spellings = prototypeOrigin ? prototypeOriginHostSpellings(prototypeOrigin) : new Set<string>()
  return {
    isPrototypeHost(hostHeader: string): boolean {
      return spellings.has(hostHeader.toLowerCase())
    },
  }
}

/** The union of its members. With no members, nothing is a prototype host. */
export function composePrototypeHostRegistries(
  ...registries: PrototypeHostRegistry[]
): PrototypeHostRegistry {
  return {
    isPrototypeHost(hostHeader: string): boolean {
      return registries.some((registry) => registry.isPrototypeHost(hostHeader))
    },
  }
}

/**
 * Marks a request that arrived on a prototype origin.
 *
 * Distinct from `SubdomainRequest.prototypeSubdomain`, which answers a
 * different question: that one says WHICH SLUG this host routes to, and only
 * subdomain mode can set it. This one says THIS ORIGIN IS NOT THE SHELL'S,
 * which is a policy fact every isolated mode shares.
 */
export interface PrototypeHostScopedRequest {
  prototypeHostScoped?: true
}

/**
 * Marks a request that arrived on the single `VIEWER_PROTOTYPE_ORIGIN` host.
 *
 * Distinct from BOTH other markers, and the distinction is exactly what the
 * serve router's `isIsolatedOrigin` split needs:
 *
 * - `prototypeHostScoped` says THIS ORIGIN IS NOT THE SHELL'S — true for a
 *   subdomain host too, so it cannot single out the prototype-origin host.
 * - `SubdomainRequest.prototypeSubdomain` says which SLUG a `{slug}.{domain}`
 *   host routes to, and only subdomain mode sets it — so `!prototypeSubdomain`
 *   does not identify the prototype-origin host either.
 *
 * This one says THIS REQUEST IS ON THE SINGLE SHARED PROTOTYPE ORIGIN, which
 * is path-namespaced: it takes the isolated CSP and withholds ACAO like the
 * `servesAtRoot` modes, but still rewrites root-absolute assets and uses the
 * prefixed bridge path, because no prototype owns `/` on the shared host.
 */
export interface PrototypeOriginHostRequest {
  onPrototypeOrigin?: true
}

/**
 * Marks a request whose `Host` names the single `VIEWER_PROTOTYPE_ORIGIN`
 * host, WITHOUT rewriting its path — requests already arrive as
 * `/p/{slug}/...` on this origin (the client builds that URL directly), so
 * there is nothing to rewrite. Mounted next to `createSubdomainRewrite` in
 * `create-app.ts`.
 *
 * A no-op when `prototypeOrigin` is null. Reuses the SAME host-spelling set as
 * `createPrototypeOriginRegistry`, so the marker and the fence-marking
 * registry can never disagree about which `Host` is the prototype origin.
 */
export function createPrototypeOriginMark(prototypeOrigin: string | null): RequestHandler {
  const spellings = prototypeOrigin ? prototypeOriginHostSpellings(prototypeOrigin) : new Set<string>()
  return function prototypeOriginMark(req: Request, _res: Response, next: NextFunction): void {
    if (spellings.size === 0) {
      next()
      return
    }
    const host = typeof req.headers.host === "string" ? req.headers.host.toLowerCase() : ""
    if (host && spellings.has(host)) {
      ;(req as unknown as PrototypeOriginHostRequest).onPrototypeOrigin = true
    }
    next()
  }
}

function sendPrototypeNotFound(res: Response): void {
  res.status(404).type("text/plain").send(PROTOTYPE_NOT_FOUND_BODY)
}

/**
 * Mounted immediately after the Host allowlist and BEFORE the subdomain
 * rewrite: on a prototype host, refuse every method that could write, and
 * mark the request for the fence below.
 *
 * GET and HEAD only. Prototype content is a built static bundle — read-only
 * by construction — so a method that could mutate anything is a method aimed
 * at the shell. Refusing them here is what makes `POST /api/v1/auth/logout`,
 * and every other mutating route in the app, unreachable on a prototype
 * origin without naming a single one of them.
 *
 * OPTIONS is refused with the rest, deliberately. Nothing in the serve layer
 * handles it — neither `serve-router.ts` (GET routes only) nor
 * `prototype-cors.ts` (which sets a response header and has no preflight
 * handler) — and nothing needs it to: the cross-origin reads this design
 * produces are `<script crossorigin>`/`<link>` fetches, which are simple GETs
 * and are never preflighted. Add it here if a real preflight ever appears,
 * not before.
 *
 * On the shell host this is a no-op: no marking, no behaviour change.
 */
export function createPrototypeHostScope(deps: {
  registry: PrototypeHostRegistry
}): RequestHandler {
  return function prototypeHostScope(req: Request, res: Response, next: NextFunction): void {
    const host = typeof req.headers.host === "string" ? req.headers.host.toLowerCase() : ""
    if (!host || !deps.registry.isPrototypeHost(host)) {
      next()
      return
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendPrototypeNotFound(res)
      return
    }
    ;(req as unknown as PrototypeHostScopedRequest).prototypeHostScoped = true
    next()
  }
}

/**
 * The API fence: a marked request whose path is not under `/p/` is refused.
 *
 * Mounted in `create-app.ts` immediately before the API router, so a
 * prototype-host request never enters the shell's routers at all — it does
 * not take a rate-limit slot, it does not get its body parsed, and no route
 * handler runs before anybody notices where it came from.
 *
 * Reads `req.url`, not `req.originalUrl`: the subdomain rewrite mutates
 * `req.url` and that is what routing consults, so `req.url` is the only value
 * that answers "where is this request actually going?". `originalUrl` still
 * says `/api/v1/…` on a correctly rewritten request.
 *
 * Both isolated modes rewrite every path to `/p/…` before this runs, so in
 * neither of them does this ever fire. That is the intended shape — it is the
 * explicit, testable statement that a prototype-host request cannot reach the
 * shell's routers, held by something other than "a rewrite happened to be
 * mounted above me".
 *
 * This fence is a PREFIX rule, which is why it is not the whole story: a
 * `/p/`-prefixed path that no serve route matches passes it. See
 * `createPrototypeHostTerminalFence` for the other half.
 */
export function createPrototypeHostApiFence(): RequestHandler {
  return function prototypeHostApiFence(req: Request, res: Response, next: NextFunction): void {
    if (!(req as unknown as PrototypeHostScopedRequest).prototypeHostScoped) {
      next()
      return
    }
    if (req.url.startsWith("/p/")) {
      next()
      return
    }
    sendPrototypeNotFound(res)
  }
}

/**
 * The terminal fence: a marked request that reached the END of `createApp` is
 * refused, whatever its path.
 *
 * Mounted last, after the serve router and the root-asset fallback. The rule
 * is positional rather than path-shaped, and that is the point: on a
 * prototype host, **nothing past the serve router is prototype content**. The
 * serve router is what serves prototypes; the root-asset fallback only
 * redirects into it. A request that got past both has, by definition, not
 * been answered with prototype content — so falling through to the Next shell
 * handler (mounted outside `createApp`, see `server/index.ts`) is never the
 * right answer on this origin.
 *
 * It is not a duplicate of the API fence, and it catches a case the prefix
 * rule structurally cannot. `GET /p/` exactly, on a prototype host with no
 * rewrite mounted, starts with `/p/` and so passes the API fence; it then
 * matches neither `/p/:slug` nor `/p/:slug/{*rest}` (both need a non-empty
 * slug), is skipped by the root-asset fallback (`/p/` is a reserved prefix),
 * and would land on Next's 404 page — shell HTML served from a prototype
 * origin. Here it is a plain prototype 404 instead.
 *
 * Both are kept because they refuse at different costs: the API fence stops a
 * request BEFORE the shell's routers run, and this one stops whatever the
 * prefix rule was never able to describe.
 */
export function createPrototypeHostTerminalFence(): RequestHandler {
  return function prototypeHostTerminalFence(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (!(req as unknown as PrototypeHostScopedRequest).prototypeHostScoped) {
      next()
      return
    }
    sendPrototypeNotFound(res)
  }
}
