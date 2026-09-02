import type { NextFunction, Request, RequestHandler, Response } from "express"
import type { ViewerConfig } from "../config"
import { prototypeOriginHostSpellings } from "./prototype-host-scope"
import { slugFromHost } from "./subdomain"

/**
 * A closed allowlist of `Host` header values this viewer answers on.
 *
 * ## Why the viewer needs one at all
 *
 * Until now it had none: the only `req.headers.host` read in the whole
 * server was `subdomain.ts`, which no-ops when no serve domain is set. The
 * process binds every interface, so `localhost:3100`, `127.0.0.1:3100`,
 * `[::1]:3100` and any name that resolves to this box all reach it
 * byte-identically.
 *
 * That is fine while `Host` decides nothing. It stops being fine the moment
 * a response is DERIVED from it — which is exactly what prototype-origin
 * isolation does next: the bridge's `data-shell-origin` attribute and the
 * prototype CSP's `frame-ancestors` directive both become per-request values
 * computed from the Host the reviewer actually used. An attacker-chosen Host
 * would then become an attacker-chosen `frame-ancestors`, i.e. permission to
 * frame the prototype from a hostile page.
 *
 * The defence is not to sanitize the Host. It is to compare it against a set
 * of literal strings built from config, and refuse anything else. Whatever
 * downstream code emits is then one of at most a handful of fixed strings,
 * none of which a request can influence.
 *
 * This is the same shape as the CLI's `editor-cli/src/server/host-guard.ts`,
 * including its IPv6 re-bracketing. It is deliberately a separate
 * implementation rather than an import: that module is a DNS-rebinding guard
 * for a loopback-only listener and derives its answer from
 * `server.address()`, while this one must also express a public host and a
 * wildcard serve domain.
 *
 * ## What it is NOT
 *
 * It is not authentication, and it is not the prototype/shell routing split
 * (spec item 1, a later task). It only guarantees that by the time anything
 * else looks at `Host`, that value is one of a closed set.
 */

/**
 * Loopback names a browser can legitimately use to reach this process.
 *
 * All three are accepted together whenever `publicUrl` names any one of
 * them, because the listener genuinely answers on all three and a reviewer
 * types whichever they please. They are only accepted on the port the
 * deployment is actually reachable at — see `portSuffixesFor`.
 */
const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"] as const

export interface HostAllowlist {
  /**
   * Exact acceptable `Host` values — lowercased, IPv6 bracketed, port
   * included (or deliberately absent for a scheme-default deployment).
   *
   * FIXED at construction, and `ReadonlySet` so nothing can reach in and add
   * to it later. An earlier draft had the opposite design — the main
   * allowlist would grow a loopback listener's ephemeral port at runtime — and
   * it is gone: a listener is a separate `http.Server` with an app of its own,
   * so its Host never reaches this allowlist. It gets a one-entry allowlist
   * instead (`buildSingleHostAllowlist`), which is also what stops a listener
   * inheriting the three-loopback-spellings expansion below.
   */
  readonly allowed: ReadonlySet<string>
  /**
   * Port suffixes (`""`, `":3100"`, …) accepted on a `{slug}.{serveDomain}`
   * host. Slugs are dynamic, so subdomain hosts cannot be enumerated into
   * `allowed` and are matched by predicate instead.
   */
  readonly portSuffixes: readonly string[]
  /**
   * TESTS ONLY: also accept any loopback name on any numeric port.
   *
   * Supertest binds an ephemeral port per app, so the Host it sends is
   * `127.0.0.1:<random>` and no allowlist built from config could contain
   * it. Set exclusively by `server/__tests__/test-app.ts`; a real boot is
   * held to `assertNoTestHostRelaxation`.
   */
  readonly allowAnyLoopbackPort: boolean
}

export interface BuildHostAllowlistOptions {
  /** See `HostAllowlist.allowAnyLoopbackPort`. Tests only. */
  allowAnyLoopbackPort?: boolean
}

/** `[::1]` from `::1`; anything already bracketed or not IPv6 is untouched. */
function bracketIpv6(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname
}

/** Is this a loopback name, in the form a `Host` header would spell it? */
function isLoopbackName(name: string): boolean {
  return (LOOPBACK_NAMES as readonly string[]).includes(name)
}

/**
 * Splits `host[:port]` into its two halves without normalizing either.
 *
 * A bracketed IPv6 literal keeps its brackets in `name`, because that is the
 * form both `URL.hostname` and a `Host` header use. An UNBRACKETED IPv6
 * literal is not a legal `Host` value; it splits at its first colon and
 * therefore fails every comparison below, which is the intended outcome.
 */
function splitHostPort(host: string): { name: string; port: string } {
  if (host.startsWith("[")) {
    const close = host.indexOf("]")
    if (close === -1) return { name: host, port: "" }
    const rest = host.slice(close + 1)
    return { name: host.slice(0, close + 1), port: rest.startsWith(":") ? rest.slice(1) : rest }
  }
  const colon = host.indexOf(":")
  if (colon === -1) return { name: host, port: "" }
  return { name: host.slice(0, colon), port: host.slice(colon + 1) }
}

/**
 * The port halves a legitimate `Host` may carry, as suffixes to append to a
 * name.
 *
 * An explicit port in `publicUrl` is the only acceptable one. With no
 * explicit port the deployment is on the scheme default, and a browser omits
 * it — but a client that spells `:443` out is equally legitimate, so both
 * forms are accepted.
 *
 * `config.port` participates ONLY in the loopback, no-explicit-port case.
 * There, `publicUrl` says port 80 while the process is listening on
 * `config.port`; a browser that reached this socket at all used that port.
 * Accepting it costs nothing (it is the port of the very connection being
 * served) and stops a `VIEWER_PUBLIC_URL=http://localhost` typo from making
 * the deployment unreachable. It is deliberately NOT added for a public
 * host, where `desde.acme.test:3100` must stay a rejection.
 */
function portSuffixesFor(url: URL, configPort: number, loopback: boolean): string[] {
  if (url.port !== "") return [`:${url.port}`]
  const suffixes = ["", `:${url.protocol === "https:" ? "443" : "80"}`]
  if (loopback) suffixes.push(`:${configPort}`)
  return [...new Set(suffixes)]
}

/**
 * The closed set of `Host` values derived from configuration.
 *
 * - `publicUrl` host is loopback → all three loopback spellings, on the port.
 * - otherwise → `publicUrl`'s host only, on the port.
 * - a serve domain adds `{slug}.{serveDomain}` hosts, matched by predicate in
 *   `isAllowedHost` rather than enumerated here (slugs are dynamic).
 * - a `VIEWER_PROTOTYPE_ORIGIN` adds that ONE origin's host spellings, using
 *   the SAME set `prototype-host-scope.ts` marks it a prototype host by, so
 *   the allowlist and the fence-marking registry never disagree.
 * - ALWAYS, regardless of the above: all three loopback spellings on
 *   `config.port` — see "the process's own loopback address" below.
 */
export function buildHostAllowlist(
  config: Pick<ViewerConfig, "publicUrl" | "port" | "serveDomain" | "prototypeOrigin">,
  options: BuildHostAllowlistOptions = {},
): HostAllowlist {
  const url = new URL(config.publicUrl)
  const hostname = bracketIpv6(url.hostname).toLowerCase()
  const loopback = isLoopbackName(hostname)
  const names = loopback ? [...LOOPBACK_NAMES] : [hostname]
  const portSuffixes = portSuffixesFor(url, config.port, loopback)

  const allowed = new Set<string>()
  for (const name of names) {
    for (const suffix of portSuffixes) allowed.add(`${name}${suffix}`)
  }

  // The single `VIEWER_PROTOTYPE_ORIGIN` host, when configured. Enumerated
  // (not a predicate) because it is exactly one fixed host, and its acceptable
  // spellings come from the one shared helper so this set matches what
  // `createPrototypeOriginRegistry`/`createPrototypeOriginMark` recognise.
  if (config.prototypeOrigin) {
    for (const spelling of prototypeOriginHostSpellings(config.prototypeOrigin)) allowed.add(spelling)
  }

  // The process's own loopback address, always accepted (task 4b).
  //
  // `viewer/app/review/[slug]/page.tsx` makes an internal fetch to
  // `http://127.0.0.1:<config.port>` to read the project list, forwarding
  // the reviewer's session cookie. That request must succeed on EVERY
  // deployment shape, including a deployed instance whose `publicUrl` is a
  // public hostname — otherwise every review page 404s there.
  //
  // This is safe to accept unconditionally because a loopback `Host` is not
  // something a remote party can produce: a browser only ever sends
  // `localhost`/`127.0.0.1`/`[::1]` as `Host` when the URL bar itself says
  // so, and a DNS-rebinding page sends the ATTACKER'S chosen hostname, not a
  // loopback one, however it resolves. Behind a reverse proxy, the proxy
  // forwards the real public Host to this process, so the public-host rule
  // above still applies to everything that actually arrives from outside;
  // this addition only ever matches a request that originated on this same
  // machine.
  for (const name of LOOPBACK_NAMES) {
    allowed.add(`${name}:${config.port}`)
  }

  return {
    allowed,
    portSuffixes,
    allowAnyLoopbackPort: options.allowAnyLoopbackPort === true,
  }
}

/**
 * An allowlist of exactly one `Host` value, for a per-deployment loopback
 * listener (`loopback-listener-app.ts`).
 *
 * A listener is bound to ONE loopback address on ONE ephemeral port and
 * serves ONE deployment. Every other spelling that reaches the same socket —
 * `localhost:<port>` for a listener bound to `127.0.0.1`, say — is a
 * different origin, and serving it would mean the isolation the host flip
 * buys depended on which name the browser happened to use.
 *
 * Built with its own function rather than by handing `buildHostAllowlist` a
 * synthetic `publicUrl`: that function expands a loopback host into all three
 * spellings on purpose, which is the exact opposite of what a listener wants.
 * There is no serve domain and no test relaxation here either — the two
 * widenings this file has are both deliberately unavailable to a listener.
 */
export function buildSingleHostAllowlist(hostPort: string): HostAllowlist {
  return {
    allowed: new Set([normalizeHostPort(hostPort)]),
    portSuffixes: [],
    allowAnyLoopbackPort: false,
  }
}

/**
 * Puts a configured `host:port` into the exact form `isAllowedHost` compares
 * an inbound `Host` in: trimmed, and lowercased whole.
 *
 * Lowercasing the WHOLE string is the point, and it is why this is not
 * `splitHostPort` plus a rejoin. That shape lowercased only the name half, so
 * an entry whose port half carried any non-digit uppercase could never equal
 * the inbound value, which `isAllowedHost` lowercases entirely. Nothing
 * legitimate has such a port — but a normalizer that disagrees with the
 * comparison it feeds is a defect regardless of whether today's inputs happen
 * to reach it.
 *
 * There is deliberately NO IPv6 bracketing. The earlier version called
 * `bracketIpv6` here and the call could never fire: `splitHostPort` cuts an
 * unbracketed address at its first colon, so the name half it returns either
 * already carries brackets or contains no colon at all. A bare `::1:45001` is
 * therefore left alone and matches nothing — the fail-closed outcome
 * `splitHostPort` documents, since that string is not a legal `Host` value and
 * cannot be split unambiguously. Bracketing is the CALLER's job, before the
 * port is joined on: `loopback-listeners.ts` builds `[::1]:45001` via
 * `hostSpellingFor`, never from a bare `server.address().address`.
 *
 * Exported because a loopback listener needs the normalized string TWICE —
 * once for its one-entry allowlist and once for its prototype-host predicate —
 * and normalizing separately in two places is how two rules quietly stop
 * agreeing. `loopback-listener-app.ts` calls this once and uses the result for
 * both.
 */
export function normalizeHostPort(hostPort: string): string {
  return hostPort.trim().toLowerCase()
}

/**
 * Is this a `{slug}.{serveDomain}` host on an acceptable port?
 *
 * The name half is delegated to `slugFromHost`, so the "exactly one label,
 * and it must satisfy the slug rule" discipline has a single definition
 * shared with the rewrite that routes these hosts.
 *
 * The port half applies EXACTLY the same rule as an enumerated host: the
 * suffix must be one of `portSuffixes`. A port-less Host is therefore
 * acceptable only when `publicUrl` itself carries no explicit port, since
 * that is the only case where `""` is in the set.
 *
 * A first version of this let a port-less prototype Host through
 * unconditionally, because `prototypeOriginFor` (subdomain.ts) builds a
 * prototype origin as `{scheme}://{slug}.{serveDomain}` with no port at all
 * — so on a dev deployment whose `publicUrl` names a port, the product emits
 * an origin this allowlist would refuse. That mismatch is a defect in
 * `prototypeOriginFor`, and it is carried forward as such. Widening the
 * allowlist to absorb it would have put a second, laxer port rule in the one
 * module whose entire job is that there is only one.
 */
function isServeDomainHost(
  allowlist: HostAllowlist,
  host: string,
  serveDomain: string,
): boolean {
  const { port } = splitHostPort(host)
  const suffix = port === "" ? "" : `:${port}`
  if (!allowlist.portSuffixes.includes(suffix)) return false
  return slugFromHost(host, serveDomain) !== null
}

/**
 * The single decision. `hostHeader` is the raw header value.
 *
 * Case-insensitive on the whole string (a port is digits, so lowercasing
 * cannot change one) and otherwise EXACT: no trimming, so a trailing space
 * is a rejection rather than a value that gets quietly repaired. An absent
 * or empty `Host` loses, because an allowlist is only worth having if the
 * unrecognised shape loses.
 *
 * `serveDomain` must be the same value the allowlist was built from —
 * `create-app.ts` reads both off one config object.
 */
export function isAllowedHost(
  allowlist: HostAllowlist,
  hostHeader: string | undefined,
  serveDomain: string | null,
): boolean {
  if (typeof hostHeader !== "string" || hostHeader.length === 0) return false
  const host = hostHeader.toLowerCase()

  if (allowlist.allowed.has(host)) return true

  if (allowlist.allowAnyLoopbackPort) {
    const { name, port } = splitHostPort(host)
    if (isLoopbackName(name) && (port === "" || /^\d+$/.test(port))) return true
  }

  if (serveDomain && isServeDomainHost(allowlist, host, serveDomain)) return true

  return false
}

/**
 * 400 for any `Host` outside the allowlist, before routing.
 *
 * The body is a constant. It never echoes the rejected value, and nothing
 * here logs it either: an unvalidated Host is attacker-controlled text, and
 * the two places it would otherwise land — a JSON response a page can read
 * back, and a log file a human reads — are both places worth keeping it out
 * of. The operator learns what the allowlist contains from their own config,
 * not from a probe.
 *
 * 400 rather than 403: the request is malformed for this server, not
 * forbidden to a caller who could otherwise be authorized.
 */
export function createHostAllowlistMiddleware(
  allowlist: HostAllowlist,
  serveDomain: string | null,
): RequestHandler {
  return function hostAllowlistGuard(req: Request, res: Response, next: NextFunction): void {
    if (isAllowedHost(allowlist, req.headers.host, serveDomain)) {
      next()
      return
    }
    res.status(400).json({ error: "Unexpected host" })
  }
}

/**
 * Refuses a real boot that carries the test-only loopback relaxation.
 *
 * Called from `server/index.ts`. Asserted rather than merely omitted so that
 * a future edit which threads a config value into `createApp` fails loudly at
 * boot instead of silently widening the allowlist to every ephemeral port on
 * every loopback name.
 */
export function assertNoTestHostRelaxation(deps: { allowAnyLoopbackPort?: boolean }): void {
  if (deps.allowAnyLoopbackPort) {
    throw new Error(
      "allowAnyLoopbackPort relaxes the Host allowlist for the test app factory only. " +
        "It must never be set on a real boot",
    )
  }
}
