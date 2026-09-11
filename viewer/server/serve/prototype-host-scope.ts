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
 * The two headers `writeOriginAllowed` reads, pulled out of a request so the
 * decision itself stays a plain function with no `Request` in its signature.
 * Both are `undefined` when the header was absent, never an array: Express
 * only produces an array for a header that is allowed to repeat, and neither
 * of these is.
 */
export interface WriteOriginHeaders {
  secFetchSite?: string
  origin?: string
}

function writeOriginHeadersOf(req: Request): WriteOriginHeaders {
  const secFetchSite = req.headers["sec-fetch-site"]
  const origin = req.headers.origin
  return {
    secFetchSite: typeof secFetchSite === "string" ? secFetchSite : undefined,
    origin: typeof origin === "string" ? origin : undefined,
  }
}

/**
 * `scheme://host`, lowercased and stripped of an explicit scheme-default
 * port, or `null` for a value that does not parse as a URL. Origin headers
 * and the `ownOrigin` this module builds are both run through this before
 * comparison, so `http://x:80` and `http://x` agree without a second rule
 * for the default-port spelling `prototypeOriginHostSpellings` already has to
 * carry elsewhere.
 */
function normalizedOrigin(origin: string): string | null {
  try {
    const url = new URL(origin)
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

/**
 * Whether a WRITE method reaching a prototype origin came from somewhere this
 * origin should trust, decided from fetch metadata alone — never from the
 * body, the path, or which deployment is behind the origin. Pure, so the
 * table below is the whole spec and is testable with no Express, no request,
 * no server.
 *
 * ## Why this exists
 *
 * A prototype origin's Host is pinned by an allowlist (`host-allowlist.ts`),
 * but the allowlist only checks what Host a request CLAIMS to be for — a
 * browser sends the right Host for any request it makes, cross-site or not.
 * `writeReachesPrototypeRoute` (the other half of the fence this function
 * feeds into) then decides whether a write is headed for the serve router at
 * all. Neither asks WHO sent the request. A page on any other origin can
 * still submit a form, or fire a `no-cors` POST, at
 * `http://localhost:<port>/…` — the fixed container port range makes the
 * port guessable even without a form on the actual origin — and the browser
 * attaches the matching Host on its own. Without this check that request
 * reaches a `serve: "server"` deployment's own process unauthenticated: a
 * classic CSRF against the prototype's server actions and API routes, one
 * level below whatever CSRF defenses the prototype's OWN framework might
 * apply, because from the prototype's point of view this looks like any other
 * same-origin form post.
 *
 * ## The three cases, in the order they are checked
 *
 * 1. **`Sec-Fetch-Site` present** — the strongest signal, sent by every
 *    fetch-metadata browser (everything but very old Safari) on every
 *    request, including a plain form post. Admit only `"same-origin"` (a
 *    fetch/form/link FROM this exact origin) and `"none"` (the user typed the
 *    URL, followed a bookmark, or the browser itself navigated here — there
 *    is no initiating document to be hostile). Refuse `"cross-site"` and
 *    `"same-site"` — the latter matters because two prototypes on sibling
 *    subdomains (`a.proto.test`, `b.proto.test`) are same-site with each
 *    other, and one must not be able to forge a write against another's
 *    server process.
 * 2. **No `Sec-Fetch-Site`, but `Origin` present** — the fallback every
 *    browser has sent on a cross-origin-shaped write for over a decade, still
 *    sent even by the old-Safari case `Sec-Fetch-Site` cannot reach. Admit
 *    only when it names the exact same origin as `ownOrigin`, compared
 *    through `normalizedOrigin` so a default port spelled out explicitly does
 *    not read as a mismatch.
 * 3. **Neither header** — no browser omits both on a real cross-origin write,
 *    so a request with neither is not a browser page acting cross-origin. It
 *    is `curl`, a webhook, or any other script — the documented machine-access
 *    path (`dsv_` tokens, CI, the editor's `viewer-proxy.ts`), which sends
 *    neither header and must keep working. Admitting here is not a gap this
 *    check could close anyway: a non-browser client can set any header it
 *    likes, including a fabricated `Sec-Fetch-Site: same-origin` — what stops
 *    IT is authentication inside the prototype's own process, the same as any
 *    request that reaches that process by other means.
 *
 * `ownOrigin` is never read off the request — see `createPrototypeHostScope`,
 * which builds it from a fixed per-app scheme and the SAME validated `host`
 * the registry already confirmed is a prototype host.
 */
export function writeOriginAllowed(headers: WriteOriginHeaders, ownOrigin: string): boolean {
  if (headers.secFetchSite !== undefined) {
    const site = headers.secFetchSite.toLowerCase()
    return site === "same-origin" || site === "none"
  }
  if (headers.origin !== undefined) {
    const origin = normalizedOrigin(headers.origin)
    return origin !== null && origin === normalizedOrigin(ownOrigin)
  }
  return true
}

/**
 * Whether a non-GET on a prototype host is headed for the SERVE ROUTER's
 * prototype route, and may therefore be passed to it instead of refused here.
 *
 * The rule is ONE host shape: a `{slug}.{serveDomain}` subdomain.
 * `createSubdomainRewrite` — mounted just after the fence, and reading this
 * same `serveDomain` through this same `slugFromHost` — turns EVERY path on
 * that host into `/p/{slug}/…`. So on a slug host every path is the prototype
 * route, including one spelled `/api/v1/auth/logout`: after the rewrite it
 * names a file inside the prototype, and the shell's API is not mounted
 * anywhere it could reach. Sharing the one function with the rewrite is what
 * makes "the rewrite will fire" a fact rather than an assumption.
 *
 * The single `VIEWER_PROTOTYPE_ORIGIN` host is deliberately NOT included, even
 * though a request there already arrives as `/p/{slug}/…`. That host is
 * path-namespaced, so no prototype owns `/` on it and the serve router refuses
 * a server deployment there outright (409) — nothing on it could ever accept a
 * write, so letting one through buys nothing. It also costs something: an
 * earlier draft of this rule passed any `/p/`-prefixed path, and
 * `OPTIONS /p/{slug}` (the bare-slug redirect route) then reached the router,
 * which answered Express's automatic `200 Allow: GET, HEAD` from INSIDE itself
 * — before `createPrototypeHostTerminalFence` could refuse it. The handler
 * cannot close that, because on that path the handler never runs. Refusing
 * here does.
 *
 * A loopback listener never reaches this rule — it is a separate server with
 * its own app, and its fence asks a different question (see
 * `loopback-listener-app.ts`: a listener is pinned to one deployment, so what
 * it asks is whether THAT deployment is a server).
 *
 * Passing the request on is not the same as allowing the write. It hands the
 * decision to the serve router, which refuses everything but a
 * `serve: "server"` deployment on an origin of its own — and a refusal there
 * falls through to `createPrototypeHostTerminalFence`, which answers with the
 * same body this module would have.
 *
 * **What a passed write costs before it is refused.** On a slug host a write
 * against an ordinary static prototype now runs `getProjectBySlug`,
 * `resolveReadContextLenient`, `canReadProject`, `loadProjectReadPolicy` and
 * `getDeployment` before the serve router hands it back — where this fence
 * used to refuse it for the price of one string comparison. The requests are
 * unauthenticated, and a rewritten subdomain path never matches the `/api/v1`
 * mount, so the API rate limiter does not see them. This is the same work an
 * unauthenticated GET to the same host already does, so it is not a new class
 * of exposure — but it is a second way to reach that cost, and it is the price
 * of the fence not knowing which deployment it fronts. A loopback listener
 * pays none of it: its fence reads `serve` off the pinned context.
 */
export function createPrototypeRouteWriteRule(
  serveDomain: string | null,
): (req: Request) => boolean {
  return function writeReachesPrototypeRoute(req: Request): boolean {
    const host = typeof req.headers.host === "string" ? req.headers.host : undefined
    return slugFromHost(host, serveDomain) !== null
  }
}

/**
 * Mounted immediately after the Host allowlist and BEFORE the subdomain
 * rewrite: on a prototype host, refuse every method that could write unless
 * it is headed for the prototype route, and mark the request for the fence
 * below.
 *
 * The rule this enforces is "a write on a prototype origin can never be
 * answered by a SHELL router". Until server prototypes (task 8b) that was
 * stated as "GET and HEAD only", which was exact while prototype content was
 * always a built static bundle — read-only by construction, so any other
 * method was a method aimed at the shell. A `serve: "server"` deployment is a
 * process, and a process takes form posts, server actions and API writes of
 * its own, so the rule had to be stated as itself: `writeReachesPrototypeRoute`
 * decides whether a write is going to the prototype, and the serve router then
 * decides whether that particular prototype accepts one. Omit the predicate
 * and the old blanket refusal is what you get.
 *
 * What did NOT change: a write whose path is not the prototype route is
 * refused right here, before the shell's routers, its rate limiter or its body
 * parser ever run — which is what keeps `POST /api/v1/auth/logout`, and every
 * other mutating route in the app, unreachable on a prototype origin without
 * naming a single one of them.
 *
 * OPTIONS travels with the other write methods, and for a server prototype
 * that is the point: it is the app's own CORS preflight, which only its
 * process can answer. Who answers it otherwise is worth stating exactly,
 * because it moved during task 8b and moved back:
 *
 * | host | who answers OPTIONS | what it says |
 * | --- | --- | --- |
 * | `VIEWER_PROTOTYPE_ORIGIN` | this fence | `404 Not found` |
 * | `{slug}.{serveDomain}`, static deployment | `createPrototypeHostTerminalFence`, after the serve router hands it back | `404 Not found` |
 * | `{slug}.{serveDomain}`, `serve: "server"` | the prototype's own process, proxied | whatever the app says |
 * | a loopback listener | its own fence, unless it fronts a server deployment | `404 Not found`, or the app's answer |
 * | the shell host (path mode) | `serve-router.ts`'s own OPTIONS branch | `200 Allow: GET, HEAD` |
 *
 * Every row is the answer that host gave before server prototypes existed,
 * except the server-deployment rows, which had no prototype to ask. The last
 * row used to come from Express's automatic OPTIONS response and is now
 * written out by hand, byte for byte — see that branch's comment for why it
 * could not stay automatic.
 *
 * On the shell host this middleware is a no-op: no marking, no behaviour
 * change.
 */
export function createPrototypeHostScope(deps: {
  registry: PrototypeHostRegistry
  /**
   * Whether a non-GET/HEAD request on a prototype host should be passed to
   * the serve router rather than refused here. Omitted means "never", which
   * is the pre-task-8b behaviour. See `createPrototypeRouteWriteRule`.
   */
  writeReachesPrototypeRoute?: (req: Request) => boolean
  /**
   * The scheme this app's prototype origins are reached over — `"http:"` or
   * `"https:"`, fixed for the life of the app and NEVER derived from the
   * request (there is no reliable per-request scheme behind a proxy, and
   * trusting one would let a spoofed scheme defeat `writeOriginAllowed`'s
   * Origin comparison). A loopback listener always passes `"http:"`: it
   * binds a raw ephemeral port with no certificate
   * (`loopback-listener-app.ts`). The main app passes
   * `deps.config.publicUrl`'s own scheme — subdomain mode and
   * `VIEWER_PROTOTYPE_ORIGIN` both inherit it by construction
   * (`resolveOrigins`, `assertPrototypeOriginConfig`), so one value serves
   * both registries `create-app.ts` composes.
   */
  originScheme: string
}): RequestHandler {
  return function prototypeHostScope(req: Request, res: Response, next: NextFunction): void {
    const host = typeof req.headers.host === "string" ? req.headers.host.toLowerCase() : ""
    if (!host || !deps.registry.isPrototypeHost(host)) {
      next()
      return
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      // Who sent this, before where it's headed: a forged write must be
      // refused the same way whether or not it happens to name the
      // prototype route, and checking this first means the two refusals
      // never have to be told apart by the caller.
      if (!writeOriginAllowed(writeOriginHeadersOf(req), `${deps.originScheme}//${host}`)) {
        sendPrototypeNotFound(res)
        return
      }
      if (deps.writeReachesPrototypeRoute?.(req) !== true) {
        sendPrototypeNotFound(res)
        return
      }
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
