/**
 * Which origin a prototype and the shell reviewing it are on right now,
 * plus boot-time refusals for a config that would put them on the same
 * origin.
 *
 * PURE, NO IMPORTS — same reason as `prototype-capability-path.ts`: a
 * later task reaches this module from `app/prototype-origin.ts`, which is
 * a `"use client"` module, so anything this file imports is bundled for
 * the browser. `node:crypto`, Express types, and `ViewerConfig` itself
 * would all break that, so every type below is written out locally instead
 * of imported. Parse URLs with the global `URL` — it is always available,
 * in Node and in the browser.
 *
 * ## The four modes
 *
 * - **subdomain** — `VIEWER_SERVE_DOMAIN` is set. Every prototype gets its
 *   own `{slug}.{serveDomain}` host. This wins over the other three modes
 *   even when the shell itself happens to be reached over loopback,
 *   because a serve domain is an explicit opt-in to the strongest
 *   isolation this viewer offers.
 * - **prototype-origin** — `VIEWER_PROTOTYPE_ORIGIN` is set (and no serve
 *   domain). ALL prototypes share that ONE alternate origin, cross-origin
 *   from the shell but path-namespaced under `/p/{slug}/`. It is for an
 *   operator who can add one DNS name and one cert SAN but not a wildcard.
 *   The cost, and why subdomain is stronger: every prototype shares one
 *   origin, so they share a cookie jar and storage and can script each
 *   other. It wins over loopback for the same "explicit opt-in" reason
 *   subdomain does, and loses to subdomain for the isolation reason above.
 * - **loopback** — the shell was reached on one of the three names a
 *   browser uses for "this machine": `localhost`, `127.0.0.1`, `[::1]`.
 *   All three reach the same process, so a prototype can be served on a
 *   DIFFERENT one of the three at the same port and get a real origin that
 *   is not the shell's. `pairedLoopbackHost` is the lookup: whichever name
 *   the shell used, the prototype uses the other one.
 * - **fallback** — neither of the above. The shell has one public host and
 *   no configured way to give a prototype a different one, so shell and
 *   prototype share an origin (today's status quo; CSP and sandbox
 *   discipline elsewhere is what keeps that safe).
 *
 * ## Why `shellOrigin` is computed per request, not once at boot
 *
 * On loopback the reviewer's actual host spelling is not knowable at boot
 * — they might type `localhost` or `127.0.0.1`. So `resolveOrigins` takes
 * the REQUEST's Host and the allowlist's verdict on it (`hostAllowed`) as
 * inputs, and only trusts the request when the allowlist already said yes
 * AND `publicUrl` itself is loopback (task 4b — see `resolveOrigins`'s own
 * doc comment for why a deployed instance must not trust its own loopback
 * address). When either of those does not hold, every output here falls
 * back to `publicUrl` instead: nothing about the response is ever derived
 * from a Host this process does not recognise, or from a Host that reached
 * this process on an address that does not describe the shell.
 *
 * ## Why IPv6 needs no separate bracketing helper here
 *
 * `host-allowlist.ts` has its own `bracketIpv6`, for the case where it
 * receives a BARE address (Node's `server.address()` reports `::1`, with
 * no brackets). That case does not arise here: `requestHost` is a `Host`
 * header value, which is only ever well-formed for IPv6 in the bracketed
 * form, so this module never sees a bare address to begin with. Every
 * hostname this module emits is instead read back off the global `URL`
 * parser, which brackets IPv6 automatically —
 * `new URL("http://[::1]:3100").hostname === "[::1]"` (measured in
 * `editor-cli/src/server/host-guard.ts`). Building a candidate origin
 * string and re-parsing it gets the same correct bracketing without
 * importing anything.
 */

/** Loopback names a browser can use to reach this process. */
export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"] as const

/**
 * The header the shell states its OWN origin in when it calls
 * `GET /api/v1/projects/:id/prototype-origin`.
 *
 * It exists because that call is made over an internal HTTP hop to
 * `http://127.0.0.1:<config.port>`, whose `Host` is the loopback address of
 * this process rather than the spelling the reviewer typed. Pairing off that
 * Host would put the prototype on `[::1]` for a reviewer on `localhost` — or,
 * worse, hand back the shell's OWN origin for a reviewer on `127.0.0.1`. See
 * `server/api/prototype-origin-routes.ts` for the closed set of values the
 * route will believe, and `app/review/[slug]/page.tsx` for the sender.
 *
 * Declared HERE rather than in the route module because both ends need it and
 * one of them is a page that must not pull Express, storage and the auth stack
 * into the Next module graph to read a string. This file is the module both
 * ends already share for exactly that reason — it is where
 * `PrototypeOriginResponse` lives, and it has no imports.
 *
 * Spelled in the canonical wire casing. Express's `req.get` is
 * case-insensitive, so the route matches whatever casing arrives.
 */
export const SHELL_ORIGIN_HEADER = "X-Viewer-Shell-Origin"

export type OriginMode = "loopback" | "subdomain" | "fallback" | "prototype-origin"

/**
 * The loopback name paired with `hostname`: whichever spelling the shell
 * used, this is the OTHER one, so a prototype served on it is a genuinely
 * different origin from the same process.
 *
 * NUMERIC pairs (changed 2026-08-22, task 4b). `"localhost"` still pairs
 * with `"127.0.0.1"` — a shell reached by name is safely paired with a
 * concrete address. But the two numeric addresses now pair with EACH
 * OTHER, not both back through `"localhost"`: a per-deployment loopback
 * listener (`loopback-listeners.ts`) has to BIND an address, and
 * `"localhost"` is a NAME a browser is free to resolve to either
 * `127.0.0.1` or `::1`. A listener bound to one of those addresses could be
 * unreachable through the name `localhost` if the browser's resolver picked
 * the other family — so the pairing this function hands a listener must
 * always be something `server.listen()` can bind directly.
 *
 * `"localhost"` → `"127.0.0.1"`; `"127.0.0.1"` → `"[::1]"`; `"[::1]"` →
 * `"127.0.0.1"`. Returns `null` for anything that is not one of the three
 * loopback names.
 *
 * The sibling `loopbackBindHostFor` turns this function's non-null result
 * into the bare address `server.listen()` wants (no brackets). Together
 * they are the ONE place this pairing is decided — `loopback-listeners.ts`
 * takes a `bindHost` from its caller rather than deciding one itself; see
 * its `hostSpellingFor`, which only formats a given bind host for display
 * and does not choose one.
 */
export function pairedLoopbackHost(hostname: string): "127.0.0.1" | "[::1]" | null {
  const lower = hostname.toLowerCase()
  if (lower === "localhost") return "127.0.0.1"
  if (lower === "127.0.0.1") return "[::1]"
  if (lower === "[::1]") return "127.0.0.1"
  return null
}

/**
 * Strips the brackets from a loopback hostname so it can be passed to
 * `server.listen()`, which wants a bare address, not the bracketed
 * Host-header spelling `pairedLoopbackHost` returns.
 *
 * The only two inputs that occur in practice are `pairedLoopbackHost`'s
 * non-null outputs, which is why the parameter type is exactly that union
 * rather than `string`.
 */
export function loopbackBindHostFor(hostname: "127.0.0.1" | "[::1]"): "127.0.0.1" | "::1" {
  return hostname === "[::1]" ? "::1" : "127.0.0.1"
}

export interface ResolvedOrigins {
  mode: OriginMode
  /** The origin the reviewing shell is on for this request. Never a trailing slash. */
  shellOrigin: string
  /**
   * The loopback hostname a prototype should be served on for this
   * request, or `null` outside loopback mode. Hostname only — the PORT
   * comes from wherever the loopback prototype listener is actually bound,
   * which is a separate concern (the listener registry), not this one.
   *
   * Typed as `pairedLoopbackHost`'s own return union rather than `string`,
   * because that is literally where the value comes from and a consumer has
   * to hand it to `loopbackBindHostFor`, whose parameter is that union. A
   * bare `string` here forced every such consumer into a cast, which is a
   * cast past a fact this module already knows.
   */
  prototypeHost: "127.0.0.1" | "[::1]" | null
  /**
   * The single shared origin ALL prototypes are served from in
   * `"prototype-origin"` mode (`VIEWER_PROTOTYPE_ORIGIN`), echoed verbatim
   * from the input. Present ONLY in that mode — the field is absent in every
   * other, the same way `prototypeHost` carries a value only in loopback
   * mode. The client builds `{prototypeOrigin}/p/{slug}/~c/{token}/` from it.
   */
  prototypeOrigin?: string
}

/**
 * Can a prototype's assets be fetched with no credential at all?
 *
 * True for exactly one combination: `access === "public-link"` AND the
 * instance-wide kill switch (`publicLinksEnabled`) is on. With the switch
 * off, a `"public-link"` project behaves exactly like `"all-members"` — it
 * needs a signed-in caller, so its assets need the session cookie (or a
 * minted capability) like any other project.
 *
 * Mirrors the server's read rule (`server/auth/authorize.ts`'s
 * `canReadProject`, rule 1) for that one question. It lives HERE, in the
 * import-free module, rather than in `app/prototype-origin.ts` where it was
 * first written, because both a `"use client"` shell module and a server
 * route need it and a second copy is how two answers to one question start
 * disagreeing. `app/prototype-origin.ts` re-exports it, so every existing
 * caller is unchanged.
 *
 * Passing the wrong `publicLinksEnabled` reproduces the bug this exists to
 * prevent: treating a project as anonymously readable when it isn't
 * sandboxes the iframe (or skips minting a capability) while the assets
 * still gate on the cookie, so a signed-in member's iframe 404s. When in
 * doubt, pass `false` rather than invent a default — that direction is
 * merely overcautious (an unnecessary capability, or the sandbox left off),
 * never broken.
 *
 * The `access` union is written out rather than imported, for the same
 * reason every other type in this file is: this module has no imports.
 */
export function prototypeAnonymouslyReadable(
  access: "all-members" | "invited" | "public-link",
  publicLinksEnabled: boolean,
): boolean {
  return access === "public-link" && publicLinksEnabled
}

/**
 * The body of `GET /api/v1/projects/:id/prototype-origin` — where the shell
 * should point a browser at this prototype right now.
 *
 * Declared in this module because it is the one place both ends can reach:
 * the route builds it (`server/api/prototype-origin-routes.ts`) and the
 * review page consumes it from a `"use client"` module, and this file has
 * no imports to drag into a browser bundle.
 *
 * `origin` is `null` whenever there is no isolated origin to offer, and the
 * three reasons are distinguishable by `mode` plus `reason`:
 *
 * - `mode: "fallback"` — the deployment has no configured way to give a
 *   prototype an origin of its own. Shell and prototype share one.
 * - `mode: "loopback"`, `reason: "no-deployment"` — loopback isolation IS
 *   available, but this project has nothing built to serve.
 *
 * `capabilityRequired` says whether the caller must additionally mint a
 * read capability (`server/serve/prototype-capability.ts`) for the
 * prototype's assets to load. A loopback listener never needs one: reaching
 * its ephemeral loopback socket is itself the credential, and the route
 * only opens one for a project the caller may already read.
 */
export type PrototypeOriginResponse =
  | { mode: "loopback"; origin: string; capabilityRequired: false }
  | { mode: "loopback"; origin: null; capabilityRequired: false; reason: "no-deployment" }
  | { mode: "subdomain"; origin: string; capabilityRequired: boolean }
  | { mode: "prototype-origin"; origin: string; capabilityRequired: boolean }
  | { mode: "fallback"; origin: null; capabilityRequired: true }

/**
 * Decides which origin mode is in play for one request, and the shell
 * origin and candidate prototype host that go with it.
 *
 * `hostAllowed` must be the caller's own `isAllowedHost(...)` verdict on
 * `requestHost` (`host-allowlist.ts`). This function does not repeat that
 * check — it only trusts the request when told the check already passed.
 *
 * `hostIsPrototype` must be the caller's own verdict on whether
 * `requestHost` names a PROTOTYPE, not the shell (a `{slug}.{serveDomain}`
 * host, or a loopback listener's host:port). This module stays import-free,
 * so it cannot call `slugFromHost` itself to work that out — the caller
 * already has whatever registry answers that question. See "Task 4b" below
 * for why this input exists.
 *
 * Mode precedence: a configured `serveDomain` always wins, even on a
 * loopback shell. Otherwise, loopback wins if the shell's hostname is one
 * of the three loopback spellings AND `publicUrl`'s scheme is `http:` — see
 * the mixed-content note at the mode computation below. Otherwise, fallback.
 *
 * ## Task 4b: the request Host is trusted in exactly ONE case
 *
 * Before this task, ANY allowed Host was trusted for `shellOrigin`, and the
 * mode was decided from whatever that Host turned out to be. That broke on
 * a DEPLOYED instance (a public `publicUrl`) whenever it was reached on its
 * own loopback address — which happens on every request, because the
 * review page's internal `GET /api/v1/projects` fetch always targets
 * `http://127.0.0.1:<config.port>` (see `host-allowlist.ts`'s "the
 * process's own loopback address" section, and
 * `app/review/[slug]/page.tsx`'s `internalApiBaseUrl`). Trusting that
 * request's Host would flip mode to "loopback" and set `shellOrigin` to
 * `127.0.0.1:<port>` — but a deployed instance reached on its own loopback
 * address is still the deployed shell. It must not flip into loopback mode
 * (which implies opening a loopback prototype listener), and its
 * bridge/CSP origins must stay the public ones.
 *
 * So the request Host is now used for `shellOrigin` ONLY when THREE things
 * are all true: the allowlist admitted it (`hostAllowed`), it does not name
 * a prototype (`!hostIsPrototype` — the second half of the same defect, on
 * a loopback `publicUrl` with a serve domain configured for local dev), AND
 * `publicUrl`'s own hostname is already a loopback spelling (the
 * zero-config laptop case this whole per-request lookup exists for in the
 * first place — see the module header's "Why `shellOrigin` is computed per
 * request, not once at boot"). Whenever any of those three is false,
 * `shellOrigin` is `publicUrl` itself and the mode is decided from
 * `publicUrl`'s hostname, never from the request.
 */
export function resolveOrigins(input: {
  requestHost: string | undefined
  hostAllowed: boolean
  hostIsPrototype: boolean
  publicUrl: string
  serveDomain: string | null
  /**
   * Whether a loopback prototype listener is allowed to open at all, from
   * `ViewerConfig.loopbackAvailable` (computed at boot in `config.ts` from
   * `VIEWER_LOOPBACK_LISTENERS`). Read ONLY inside the loopback branch — see
   * the mode computation below.
   *
   * This exists for the Docker/remote case: a container reached through a
   * published port (`docker run -p 3100:3100`) with a default loopback
   * `publicUrl` looks, from every other input here, exactly like the
   * zero-config laptop case that loopback mode is FOR. The difference is
   * invisible to this function — it has no way to know it is inside a
   * container — so the caller has to say so. When `false`, a shell that
   * would otherwise get "loopback" downgrades to "fallback" instead: no
   * listener host is offered, and the caller must not open one.
   */
  loopbackAvailable: boolean
  /**
   * `VIEWER_PROTOTYPE_ORIGIN`, or `null`/absent when unset. When set (and no
   * `serveDomain`), the mode is `"prototype-origin"`: ALL prototypes are
   * served from this one alternate origin, cross-origin from the shell but
   * path-namespaced. Its precedence sits below `serveDomain` and ABOVE
   * loopback — an explicit alternate origin is an opt-in to isolation, the
   * same reason `serveDomain` wins over loopback.
   *
   * Optional so the many existing call sites that never configure it need no
   * edit; absent means "not set", which is the safe default — the mode is
   * simply never `"prototype-origin"`. Every real caller passes
   * `config.prototypeOrigin` explicitly. The value is expected already
   * normalized to `scheme://host` (config.ts does this); it is echoed
   * verbatim into `ResolvedOrigins.prototypeOrigin`.
   */
  prototypeOrigin?: string | null
}): ResolvedOrigins {
  const publicUrl = new URL(input.publicUrl)
  const publicUrlIsLoopback = (LOOPBACK_HOSTS as readonly string[]).includes(
    publicUrl.hostname.toLowerCase(),
  )

  let shellOrigin: string
  let shellHostname: string

  if (input.hostAllowed && !input.hostIsPrototype && publicUrlIsLoopback && input.requestHost) {
    // The scheme is never taken from the request: there is no reliable
    // scheme on the request object behind a proxy, and a loopback shell is
    // http in practice. publicUrl's scheme is the one source of truth for
    // it, in both branches of this function.
    const candidate = new URL(`${publicUrl.protocol}//${input.requestHost.toLowerCase()}`)
    shellOrigin = `${candidate.protocol}//${candidate.host}`
    shellHostname = candidate.hostname
  } else {
    // Every other case: the shell origin and the mode both come from
    // config, never from the request. This is not just "no allowed Host to
    // trust" any more (task 4b) — it also covers an allowed Host that names
    // a prototype, and an allowed Host on a publicUrl that is not loopback
    // to begin with (a deployed instance).
    shellOrigin = input.publicUrl.replace(/\/+$/, "")
    shellHostname = publicUrl.hostname
  }

  // Loopback mode additionally requires an `http:` shell (hard requirement 7,
  // the mixed-content rule). A per-deployment loopback listener is ALWAYS
  // http — it binds a raw ephemeral port with no certificate and no name to
  // put one on — so an `https:` shell framing it is mixed content, which a
  // browser blocks SILENTLY. Reporting "loopback" for an https shell would
  // send every review down a path whose only possible outcomes are a blocked
  // frame or, more likely, a permanent 503: `loopback-listeners.ts`'s `ensure`
  // refuses a non-http shell origin outright.
  //
  // `publicUrl`'s scheme is the one checked because it is also the one
  // EMITTED: both branches above build `shellOrigin` from `publicUrl.protocol`
  // and never from the request. Falling back instead of failing is the right
  // direction — fallback is the status quo path (`/p/{slug}/` with its
  // capability and sandbox), which works, rather than an isolation mode that
  // cannot.
  // `loopbackAvailable` is read ONLY here, inside the branch that would
  // otherwise choose "loopback" — it has no bearing on subdomain or
  // fallback, which is why every other branch in this function is
  // unchanged. See the parameter's own doc comment for the Docker/remote
  // case this closes: a container reached through a published port looks
  // loopback by every input above, but a listener bound inside the
  // container is unreachable from the host browser, so the caller (having
  // computed `loopbackAvailable` from `VIEWER_LOOPBACK_LISTENERS` at boot)
  // tells this function not to promise one.
  //
  // Precedence: `serveDomain` (subdomain) > `prototypeOrigin` > loopback >
  // fallback. `prototypeOrigin` is checked BEFORE the loopback branch, so a
  // single alternate origin is chosen even on a loopback shell — it is an
  // explicit opt-in to isolation, exactly like a serve domain, and unlike
  // loopback it works for a container or a remote deployment. Its own boot
  // refusal (`assertPrototypeOriginConfig`) has already guaranteed it is a
  // different origin from `publicUrl` and shares its scheme, so no per-request
  // check is needed here.
  const shellIsHttp = publicUrl.protocol === "http:"
  const mode: OriginMode = input.serveDomain
    ? "subdomain"
    : input.prototypeOrigin
      ? "prototype-origin"
      : shellIsHttp && (LOOPBACK_HOSTS as readonly string[]).includes(shellHostname)
        ? input.loopbackAvailable
          ? "loopback"
          : "fallback"
        : "fallback"

  return {
    mode,
    shellOrigin,
    prototypeHost: mode === "loopback" ? pairedLoopbackHost(shellHostname) : null,
    // Present ONLY in prototype-origin mode — absent (not null) elsewhere, so
    // the field's mere presence answers "is this that mode?" and existing
    // full-object assertions on the other three modes stay unchanged.
    ...(mode === "prototype-origin" && input.prototypeOrigin
      ? { prototypeOrigin: input.prototypeOrigin }
      : {}),
  }
}

/**
 * Boot refusal: throws when the configured `serveDomain` would put a
 * prototype on the shell's own host, in either direction.
 *
 * Two ways that can happen, and this checks both:
 *
 * 1. `serveDomain` is literally the shell's host (`publicUrl`'s hostname).
 *    A prototype would then be served from the shell's own host — no
 *    isolation at all.
 * 2. The shell's own host itself LOOKS like a `{slug}.{serveDomain}` host
 *    (`publicUrl`'s hostname ends with `.` + `serveDomain`). `slugFromHost`
 *    would then classify every request to the shell as a request for some
 *    prototype, and the subdomain rewrite would send the dashboard into
 *    `/p/{slug}/` instead of serving it.
 *
 * A `serveDomain` set alongside a LOOPBACK `publicUrl` is allowed on
 * purpose (a dev setup with `/etc/hosts` entries pointing subdomains at
 * this machine). Neither check above fires for it, because a loopback name
 * never equals and never ends with `.` + a serve domain. Port handling for
 * that combination is a later task's concern, not this one.
 *
 * There is no scheme check in this function. Subdomain mode always
 * inherits `publicUrl`'s scheme (see `resolveOrigins`), so a scheme
 * mismatch between the shell and a subdomain prototype cannot happen by
 * construction — writing a check for it here would be a dead branch.
 * `assertIsolatedOrigins` below is where a scheme check belongs, for the
 * case where a concrete prototype origin exists later and could disagree.
 */
export function assertOriginConfig(config: { publicUrl: string; serveDomain: string | null }): void {
  if (!config.serveDomain) return

  const publicHostname = new URL(config.publicUrl).hostname.toLowerCase()
  const serveDomain = config.serveDomain.toLowerCase()

  if (publicHostname === serveDomain) {
    throw new Error(
      `VIEWER_SERVE_DOMAIN is set to "${config.serveDomain}". That is the same host as ` +
        `VIEWER_PUBLIC_URL. If we allowed this, every prototype would be served from the ` +
        `shell's own host, with no isolation between them. Pick a serve domain that is not ` +
        `the shell's public host.`,
    )
  }

  if (publicHostname.endsWith(`.${serveDomain}`)) {
    throw new Error(
      `VIEWER_PUBLIC_URL's host is "${publicHostname}". That looks like a ` +
        `"{slug}.${config.serveDomain}" prototype host. If we allowed this, every request to ` +
        `the shell would be treated as a request for a prototype. Use a VIEWER_PUBLIC_URL ` +
        `host that does not end in "." + VIEWER_SERVE_DOMAIN, or choose a different serve domain.`,
    )
  }
}

/**
 * Throws unless `prototypeOrigin` is a different origin from `shellOrigin`
 * and shares its scheme.
 *
 * This is the boot/runtime twin of the fail-closed iframe resolver a later
 * task adds: that resolver decides, per request, whether a concrete
 * prototype origin is safe to hand `allow-same-origin`. This function is
 * the same two checks made callable on their own, for any caller that
 * mints a concrete prototype origin and wants to refuse loudly instead of
 * quietly degrading.
 *
 * Equal-origin comparison is scheme- and host-only (query, path and
 * trailing slashes are ignored) and case-insensitive, since `new URL(...)`
 * already lowercases both the scheme and the hostname.
 */
export function assertIsolatedOrigins(shellOrigin: string, prototypeOrigin: string): void {
  const shell = new URL(shellOrigin)
  const prototype = new URL(prototypeOrigin)
  const shellOriginNormalized = `${shell.protocol}//${shell.host}`
  const prototypeOriginNormalized = `${prototype.protocol}//${prototype.host}`

  if (shellOriginNormalized === prototypeOriginNormalized) {
    throw new Error(
      `The prototype origin "${prototypeOrigin}" is the same as the shell origin ` +
        `"${shellOrigin}". A prototype must be served from a different origin than the shell.`,
    )
  }

  if (shell.protocol !== prototype.protocol) {
    throw new Error(
      `The prototype origin "${prototypeOrigin}" uses a different scheme than the shell origin ` +
        `"${shellOrigin}". Mixed http and https origins fail silently in the browser. Use the ` +
        `same scheme for both.`,
    )
  }
}

/**
 * An approximate registrable-domain (eTLD+1) key for a hostname: the last two
 * dot-separated labels, lowercased. `app.example.com` and `proto.example.com`
 * both key to `example.com`; two hosts with the same key are treated as
 * SAME-SITE.
 *
 * This is deliberately a heuristic, not a Public Suffix List lookup — this
 * module is import-free (see the header), so it cannot pull in a PSL library.
 * The trade is stated honestly: it is correct for the common single-label
 * public suffixes (`.com`, `.dev`, `.io`, `.app`, `.net`) and it OVER-refuses
 * for a multi-label public suffix (two genuinely cross-site hosts under
 * different registrable domains that happen to share a `.co.uk`-shaped suffix
 * both key to `co.uk` and would be flagged same-site). Over-refusing a config
 * at boot is the safe direction for a security control: the operator sees a
 * clear error and picks a different domain, versus under-refusing and allowing
 * the cookie-toss the check exists to prevent. A single-label host (e.g.
 * `localhost`) or an IP has no registrable domain to speak of and keys to
 * itself, which only matters for a config `assertIsolatedOrigins` already
 * rejected (equal origins) or that is genuinely distinct.
 */
function registrableSiteKey(hostname: string): string {
  const labels = hostname.toLowerCase().split(".")
  if (labels.length < 2) return hostname.toLowerCase()
  return labels.slice(-2).join(".")
}

/**
 * Boot refusal for `VIEWER_PROTOTYPE_ORIGIN`: throws when the configured
 * prototype origin is unsafe to serve ALL prototypes from, cross-origin from
 * the shell at `publicUrl`.
 *
 * Three ways it can be unsafe, and this checks all three:
 *
 * 1. **Equal origin** to `publicUrl` — a prototype would then share the
 *    shell's origin, and the cross-origin `allow-same-origin` sandbox becomes
 *    a full sandbox escape. (`assertIsolatedOrigins`.)
 * 2. **Different scheme** from `publicUrl` — an http frame in an https page
 *    (or vice versa) is blocked as mixed content, silently.
 *    (`assertIsolatedOrigins`.)
 * 3. **Same-site** with `publicUrl` — a sibling under one registrable domain
 *    can set a `Domain=`-scoped cookie the shell then receives (session
 *    fixation / cookie injection). The `__Host-` prefix guards the shell's
 *    OWN cookies from being overwritten, but the safe answer for a whole
 *    alternate-origin config is to refuse it outright rather than depend on
 *    every cookie being prefixed. See `registrableSiteKey` for the heuristic
 *    and its honest limits.
 *
 * A `null` `prototypeOrigin` is the unconfigured state and passes untouched.
 * Called once at boot from `server/index.ts`, right after `assertOriginConfig`.
 */
export function assertPrototypeOriginConfig(config: {
  publicUrl: string
  prototypeOrigin: string | null
}): void {
  if (!config.prototypeOrigin) return

  // Checks 1 and 2, reused: equal-origin and scheme-mismatch, phrased as
  // shell-vs-prototype (publicUrl is the shell here).
  assertIsolatedOrigins(config.publicUrl, config.prototypeOrigin)

  // Check 3: same registrable domain.
  const shellHost = new URL(config.publicUrl).hostname
  const prototypeHost = new URL(config.prototypeOrigin).hostname
  if (registrableSiteKey(shellHost) === registrableSiteKey(prototypeHost)) {
    throw new Error(
      `VIEWER_PROTOTYPE_ORIGIN is set to "${config.prototypeOrigin}", which is same-site with ` +
        `VIEWER_PUBLIC_URL ("${config.publicUrl}"). They share a registrable domain. A prototype ` +
        `on a sibling host could set a Domain-scoped cookie the shell then receives. Serve ` +
        `prototypes from a host on a genuinely different registrable domain than the shell.`,
    )
  }
}
