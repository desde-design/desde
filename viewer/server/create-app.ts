import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express"
import type { AssetStore } from "./assets/types"
import type { ViewerConfig } from "./config"
import { createApiRouter } from "./api/api-router"
import type { ManifestConversion } from "./api/setup-routes"
import type { CommentChangeBus } from "./comments/change-bus"
import type { GithubRuntime } from "./github-runtime"
import type { ReloadableEmailProvider } from "./notify/reloadable-email-provider"
import type { BuildChangeBus } from "./build/build-change-bus"
import { createErrorHandler } from "./error-handler"
import { buildHostAllowlist, createHostAllowlistMiddleware, isAllowedHost } from "./serve/host-allowlist"
import type { LoopbackListenerRegistry } from "./serve/loopback-listeners"
import {
  composePrototypeHostRegistries,
  createPrototypeHostApiFence,
  createPrototypeHostScope,
  createPrototypeHostTerminalFence,
  createPrototypeOriginMark,
  createPrototypeOriginRegistry,
  createServeDomainRegistry,
  type PrototypeHostScopedRequest,
} from "./serve/prototype-host-scope"
import { resolveOrigins } from "./serve/prototype-origin-resolve"
import { createRootAssetFallback } from "./serve/root-asset-fallback"
import { createServeRouter } from "./serve/serve-router"
import { createSubdomainRewrite } from "./serve/subdomain"
import { createApiRateLimit } from "./rate-limit"
import type { StorageAdapter } from "./storage/types"

/**
 * `Content-Security-Policy: frame-ancestors 'none'` on every response that
 * is NOT a `/p/**` prototype response — the dashboard, every API route,
 * every sign-in route.
 *
 * Before this, a shell page carried no framing protection at all: no
 * `X-Frame-Options`, no `frame-ancestors`. A hosted prototype could
 * `<iframe src="http://localhost:PORT/">` the shell as a clickjacking
 * surface inside the reviewer's own review page. `frame-src 'none'` on the
 * PROTOTYPE's own CSP stops the prototype nesting a frame of ITS OWN, which
 * is a different thing — it says nothing about whether the shell can be
 * embedded BY something else. This closes that permanently rather than
 * depending on `frame-src` never being relaxed.
 *
 * Skips a request twice over, redundantly on purpose: `req.url` starting
 * with `/p/` covers subdomain mode, where `createSubdomainRewrite` (mounted
 * just above this) has already rewritten the path; `prototypeHostScoped`
 * covers a prototype-host request that has NOT been rewritten, which no
 * mounting in this file can currently produce and is kept as the belt to the
 * rewrite's braces. Either flag is enough reason to skip: the serve
 * router sets its OWN CSP on every `/p/**` response
 * (`resolvePrototypeCsp/resolveIsolatedOriginCsp`, `frame-ancestors 'self'` or
 * the shell's origin), and that must stay the only CSP on a prototype
 * response.
 *
 * If a CSP is already on the response (nothing sets one this early today,
 * but a future addition might), the directive is APPENDED, never replacing
 * whatever is already there.
 */
function createShellFrameAncestorsGuard(): RequestHandler {
  return function shellFrameAncestorsGuard(req: Request, res: Response, next: NextFunction): void {
    if (req.url.startsWith("/p/")) {
      next()
      return
    }
    if ((req as unknown as PrototypeHostScopedRequest).prototypeHostScoped) {
      next()
      return
    }
    const existing = res.getHeader("Content-Security-Policy")
    // `getHeader` can return `string | string[] | number | undefined` —
    // Node allows a header to be set as an array of values (rare for CSP in
    // this codebase today, but the type is honest about what's possible).
    // Joining with "; " is the same separator `Content-Security-Policy`
    // itself uses between directives, so an array-valued header still
    // appends correctly rather than silently losing the array branch.
    if (typeof existing === "string" && existing.length > 0) {
      res.setHeader("Content-Security-Policy", `${existing}; frame-ancestors 'none'`)
    } else if (Array.isArray(existing) && existing.length > 0) {
      res.setHeader("Content-Security-Policy", `${existing.join("; ")}; frame-ancestors 'none'`)
    } else {
      res.setHeader("Content-Security-Policy", "frame-ancestors 'none'")
    }
    next()
  }
}

export interface AppDeps {
  storage: StorageAdapter
  assets: AssetStore
  config: ViewerConfig
  bridgeScript: string
  /**
   * Bridge bundle version, stamping the external bridge URL served under
   * `/p/{slug}/__desde/bridge-<version>.js` (see `serve-router.ts`).
   * Optional so the many API-route tests that construct `AppDeps` without
   * exercising `/p/**` don't all need updating; `server/index.ts` (the real
   * boot path) always passes the real value from `readBridgeBundle()`.
   */
  bridgeVersion?: string
  /**
   * Optional injection point for the comment SSE fan-out. `createApiRouter`
   * creates its own instance when omitted (normal server boot); tests that
   * need to assert on the bus itself (e.g. that a disconnected SSE client's
   * listener is actually released) construct one and pass it in here.
   */
  changeBus?: CommentChangeBus
  /**
   * The live GitHub clients — auth provider, App client, build queue. See
   * `github-runtime.ts`: the fields are mutable by design, because the App
   * Manifest flow produces credentials mid-process and the routes below must
   * pick them up without a restart.
   *
   * REQUIRED, where the three fields it replaced were each optional. A
   * missing runtime used to be indistinguishable from a configured-but-empty
   * one, and the routes answered both by not registering. Now every route
   * registers unconditionally and reads the runtime at request time, so
   * there has to be a runtime to read — an unconfigured deployment passes one
   * whose three fields are simply undefined. Tests build one with
   * `__tests__/test-github-runtime.ts`.
   */
  github: GithubRuntime
  /**
   * The process's per-deployment loopback listener registry
   * (`serve/loopback-listeners.ts`).
   *
   * REQUIRED, and deliberately so. There must be exactly ONE registry per
   * process: it owns real sockets, and a second one would hand out ports
   * nothing ever reaps and would answer `isPrototypeHost` for listeners the
   * first one does not know about. Making the field required is what forces
   * `server/index.ts` — which already builds the registry — and the test
   * factory to each pass the one they hold, instead of a lazily-constructed
   * default quietly appearing wherever the field was omitted.
   *
   * Nothing opens a listener at boot. `api/prototype-origin-routes.ts` opens
   * one on first review, and the reaper closes it again once nobody is
   * looking.
   */
  prototypeListeners: LoopbackListenerRegistry
  /**
   * The boot-time local sign-in token, when one was generated. Absent means
   * `GET /auth/local` 404s — which is also what it does, at request time,
   * once `github.authProvider` exists (see `auth-routes.ts`).
   */
  localOperatorToken?: string
  /**
   * THE process's one `EmailProvider`, or absent when SMTP is unconfigured.
   *
   * `server/index.ts` builds it from `config.email` and hands the SAME
   * instance to both this and `startOutboxDrain` — there is deliberately no
   * second construction anywhere, so a deployment cannot end up with two
   * transports (two connection pools, two sets of credentials) for one SMTP
   * server.
   *
   * The routes that send mail gate on THIS field rather than on
   * `config.email`, because it is the field that can actually send. Gating on
   * the config would let a deployment answer "accepted" for a message that had
   * nowhere to go, which is the one failure mode a magic-link route (whose
   * response is deliberately identical for every input — see
   * `auth-routes.ts`) can never surface to anybody.
   */
  /**
   * Mail sender. Reloadable, because SMTP is editable from the settings page
   * and a provider captured at boot could never reflect a later save — see
   * `notify/reloadable-email-provider.ts`. Callers ask `isConfigured()`
   * rather than testing for null, which only means "no provider supplied"
   * (tests).
   */
  email?: ReloadableEmailProvider | null
  buildChangeBus?: BuildChangeBus
  /**
   * The GitHub App Manifest code exchange (`api/setup-routes.ts`). Injected
   * so the setup-route tests never touch the network, exactly as
   * `github.overrides.authProvider` exists so the sign-in tests never do.
   *
   * Omitted in production: the route falls back to a real
   * `POST /app-manifests/{code}/conversions` against GitHub.
   */
  exchangeManifestCode?: (code: string) => Promise<ManifestConversion>
  /**
   * TESTS ONLY: relax the Host allowlist to accept any loopback name on any
   * port. Supertest binds an ephemeral port per app, so the Host it sends is
   * `127.0.0.1:<random>` and no allowlist built from config could contain it.
   *
   * Set exclusively by `server/__tests__/test-app.ts`, which is what every
   * suite imports `createApp` from. The real boot path
   * (`server/index.ts`) never sets it and asserts as much via
   * `assertNoTestHostRelaxation`.
   */
  allowAnyLoopbackPort?: boolean
}

/** Carries the unparsed request body for signature verification. */
export interface RawBodyRequest {
  rawBody?: Buffer
}

/**
 * Builds the Express app WITHOUT the Next.js handler, so tests can
 * exercise the API and the serve layer without a Next build. The
 * process entry (server/index.ts) mounts Next after this.
 */
export function createApp(deps: AppDeps): express.Express {
  const app = express()

  // BEFORE anything that reads `req.ip`, which means before the rate limiter
  // and before any handler that logs or keys on an address.
  //
  // Default `false`. Behind a TLS-terminating reverse proxy an operator MUST
  // set VIEWER_TRUST_PROXY, or `req.ip` is the PROXY's address for every
  // request and `rate-limit.ts`'s per-IP buckets collapse into one global
  // bucket that a single abusive visitor can exhaust for everybody. Setting it
  // when there is NO proxy is the opposite failure and worse: the address then
  // comes from a client-supplied header. See `parseTrustProxy` in config.ts,
  // which refuses `true` for exactly that reason.
  app.set("trust proxy", deps.config.trustProxy)

  // Built ONCE, not per request: `resolveShellOriginForRequest` below reuses
  // this SAME object, so the allowlist middleware and the shell-origin
  // resolver can never disagree about what "allowed" means the way two
  // independent constructions eventually would.
  const hostAllowlist = buildHostAllowlist(deps.config, {
    allowAnyLoopbackPort: deps.allowAnyLoopbackPort,
  })

  // FIRST of all, ahead of the subdomain rewrite: no request reaches routing
  // until its `Host` has been matched against a closed set of literal strings
  // built from config. Everything downstream that derives a value from `Host`
  // — the subdomain rewrite here, and shortly the bridge's
  // `data-shell-origin` and the prototype CSP's `frame-ancestors` — is then
  // choosing among a handful of fixed strings rather than echoing a request.
  // See `serve/host-allowlist.ts`.
  app.use(
    createHostAllowlistMiddleware(
      hostAllowlist,
      // Read off the SAME config object the allowlist was built from: the
      // predicate and the enumerated set must agree on what the serve domain
      // is, or subdomain hosts are judged by one and routed by the other.
      deps.config.serveDomain,
    ),
  )

  /**
   * The serve router's `resolveShellOrigin` for this app — the per-request
   * replacement for the single static `deps.config.publicUrl` this used to
   * pass unconditionally. See `ServeRouterDeps.resolveShellOrigin`'s doc
   * comment for why a fixed value broke a reviewer on the loopback twin
   * spelling (research R2).
   *
   * The output is always one of a closed, config-derived set (never an
   * echoed request Host) — the loopback spellings on the ports
   * `portSuffixesFor` accepts, or `publicUrl` itself (`resolveOrigins`'s own
   * contract). That set is not literally "four fixed strings": a loopback
   * `publicUrl` with no explicit port accepts more than one port suffix (see
   * `host-allowlist.ts`'s `portSuffixesFor`), so more than four combinations
   * can be admitted. What stays true regardless of the count is the shape —
   * the request's `Host` only ever SELECTS among that closed set; it is
   * never emitted verbatim. Contrast this with `app/review/[slug]/page.tsx`'s
   * `internalApiBaseUrl` comment, which explains a case where trusting the
   * request Host for a DIFFERENT purpose (an internal fetch target) would
   * have been a mistake — the two do not generalize to the same rule, and
   * that comment spells out why.
   *
   * `hostIsPrototype` reads `prototypeHostScoped`, which `createPrototypeHostScope`
   * (mounted below) has already set by the time the serve router calls this —
   * both run on the same request object, and the router itself is mounted
   * after both. On a subdomain request that makes the answer `publicUrl`
   * regardless of the slug host's spelling (Task 4b): the reviewer's own
   * shell spelling can never be read off a PROTOTYPE host's `Host` header, so
   * it is not trusted for one.
   */
  function resolveShellOriginForRequest(req: Request): string {
    const host = typeof req.headers.host === "string" ? req.headers.host.toLowerCase() : undefined
    return resolveOrigins({
      requestHost: host,
      hostAllowed: isAllowedHost(hostAllowlist, host, deps.config.serveDomain),
      hostIsPrototype: Boolean((req as PrototypeHostScopedRequest).prototypeHostScoped),
      publicUrl: deps.config.publicUrl,
      serveDomain: deps.config.serveDomain,
      loopbackAvailable: deps.config.loopbackAvailable,
      prototypeOrigin: deps.config.prototypeOrigin,
    }).shellOrigin
  }

  // SECOND, and before the rewrite below: decide whether this request
  // arrived on a PROTOTYPE origin, and if it did, scope it to prototype
  // routes only. See `serve/prototype-host-scope.ts` — this is spec hard
  // requirement 1, and it is what guarantees no session cookie can ever be
  // issued on a prototype origin.
  //
  // The composite is the seam, and on THIS app it holds two members: the
  // `{slug}.{serveDomain}` rule, and the single `VIEWER_PROTOTYPE_ORIGIN`
  // host. Registering the prototype-origin host here is what makes the two
  // fences below mark it and guarantees no session cookie is ever issued on
  // it — the same property subdomain mode gets. A loopback listener's ports
  // never belong here — a listener is a separate `http.Server` with its own
  // app and its own one-host predicate, so a listener's Host never reaches
  // this middleware at all (the allowlist above refuses it first).
  app.use(
    createPrototypeHostScope({
      // Read off the SAME config object as the allowlist and the rewrites —
      // several readers of one value, for the reason spelled out above.
      registry: composePrototypeHostRegistries(
        createServeDomainRegistry(deps.config.serveDomain),
        createPrototypeOriginRegistry(deps.config.prototypeOrigin),
      ),
    }),
  )

  // Before the API mount: on a prototype subdomain every path is
  // rewritten into `/p/{slug}/...`, so `acme.{serveDomain}/api/v1/projects`
  // resolves as a prototype ASSET (almost always a 404), not as the API.
  // The API is therefore not merely CSP-blocked on a prototype origin — it
  // is not routed there at all, which is the property that makes subdomain
  // mode a real boundary rather than a policy we emit.
  app.use(createSubdomainRewrite(deps.config.serveDomain))

  // Beside the subdomain rewrite: mark a request on the single
  // `VIEWER_PROTOTYPE_ORIGIN` host so the serve router picks the isolated CSP
  // and withholds ACAO for it (`isIsolatedOrigin`), WITHOUT rewriting the path
  // — a request already arrives as `/p/{slug}/...` on this origin (the client
  // builds that URL), and the shared prototype origin is path-namespaced, so
  // the base href / rewrite / prefixed bridge path all still apply. A no-op
  // when `VIEWER_PROTOTYPE_ORIGIN` is unset.
  app.use(createPrototypeOriginMark(deps.config.prototypeOrigin))

  // After the rewrite (so a prototype-host request already starts with
  // `/p/`) and before every shell router below: refuse to let the shell's
  // own responses be framed. See `createShellFrameAncestorsGuard`'s doc
  // comment for what this closes and why it is safe on a `/p/**` response.
  app.use(createShellFrameAncestorsGuard())

  // Immediately before the API mount: a prototype-host request whose path is
  // not under `/p/` never reaches a shell router. On a subdomain the rewrite
  // above has already made every such path `/p/{slug}/…`, so this is inert
  // here — it is the invariant stated as itself, so it survives a rewrite
  // being changed or dropped. The loopback listener app mounts the same fence
  // for the same reason.
  app.use(createPrototypeHostApiFence())

  app.use(
    "/api/v1",
    // BEFORE the JSON parser: a refused request should cost the process a
    // map lookup, not a 1 MB body parse. The limiter selects its own lanes —
    // resolve / participant-invite / comment writes / auth (which now also
    // covers the admin invite + sign-in-link routes, M1) — and every lane
    // OTHER than `auth` requires a non-GET method, so neither the comment
    // SSE stream nor the build-log stream can ever be swept into it. `auth`
    // itself DOES match a GET on purpose (the OAuth callback and every
    // sign-in-link redemption are top-level navigations), which is why "by
    // construction never matches a GET" was the wrong claim to make here —
    // see `rate-limit.ts`'s own doc comment for the invariant this actually
    // relies on.
    createApiRateLimit(),
    express.json({
      limit: "1mb",
      type: ["application/json", "application/*+json"],
      // Stash the EXACT bytes for the GitHub webhook's HMAC. The signature
      // covers what GitHub sent; re-serializing the parsed object produces
      // different bytes (key order, whitespace, unicode escaping) and would
      // never match. A `raw()` parser on the webhook route itself cannot
      // work either — this parser runs first and has already consumed the
      // stream, so the route would see a parsed object and 401 every
      // delivery. `verify` is the one hook that sees the buffer before
      // parsing.
      verify: (req, _res, buf) => {
        ;(req as RawBodyRequest).rawBody = Buffer.from(buf)
      },
    }),
    createApiRouter(deps),
  )
  app.use(
    createServeRouter({
      storage: deps.storage,
      assets: deps.assets,
      config: deps.config,
      resolveShellOrigin: resolveShellOriginForRequest,
      bridgeScript: deps.bridgeScript,
      bridgeVersion: deps.bridgeVersion ?? "dev",
      prototypeCsp: deps.config.prototypeCsp,
    }),
  )
  app.use(createRootAssetFallback({ storage: deps.storage, assets: deps.assets, config: deps.config }))

  // LAST, because the Next.js catch-all handler is mounted OUTSIDE this
  // function (`server/index.ts` mounts it after `createApp` returns) and a
  // prototype-host request must not reach a shell page — the sign-in page
  // above all — on an origin that must never have one.
  //
  // A different rule from the fence above, not a repeat of it. That one is a
  // path prefix; this one is positional: everything above this line is the
  // prototype's own content, so a marked request that got this far has not
  // been answered with prototype content and there is nothing correct left to
  // do with it. That closes what a prefix rule structurally cannot — `GET /p/`
  // exactly passes the prefix test, matches no serve route, and would
  // otherwise be answered by Next.
  app.use(createPrototypeHostTerminalFence())

  // Shared with each per-deployment loopback listener's app, which needs the
  // same "never fall through to Express's stack-trace default" guarantee.
  // See `error-handler.ts`.
  app.use(createErrorHandler())

  return app
}
