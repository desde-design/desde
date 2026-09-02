import type { IncomingMessage } from "node:http"

/**
 * DNS-rebinding guard for the CLI's localhost listeners.
 *
 * `checkAuth` (auth.ts) validates `Origin`, which is the CSRF boundary — but
 * `Origin` alone cannot see a rebinding attack, because under one the browser
 * believes the attacker's page and this server share an origin:
 *
 *   1. The developer visits `http://evil.test:4321` while Editor is running.
 *      `evil.test` resolves, briefly, to the attacker's box; its DNS record
 *      then flips to `127.0.0.1` with a 1s TTL.
 *   2. The page's next fetch to `http://evil.test:4321/...` lands on THIS
 *      server, and the browser considers it SAME-ORIGIN. So
 *      `Cross-Origin-Resource-Policy: same-origin` on the bootstrap response
 *      does not apply (CORP is only evaluated cross-origin), and the page can
 *      read the per-boot bearer token straight out of the body.
 *   3. Browsers omit `Origin` on same-origin GETs — a fact the
 *      `bearer-origin-if-present` policy relies on by design — so with that
 *      stolen bearer every `if-present` GET answers: `/api/editor/file`
 *      (any source file under the repo), the chat-session transcripts, the
 *      grounding routes, and the viewer proxy.
 *
 * The one header that does distinguish the two cases is `Host`: the browser
 * sends the name the developer's page actually used, and the attacker cannot
 * forge it (`Host` is a forbidden header for page JS). So the fix is to
 * reject any `Host` that is not a loopback name on the port this server is
 * really listening on.
 *
 * **Scope, stated precisely: this closes a DISCLOSURE hole, not code
 * execution.** Writes were never reachable this way — a non-GET always
 * carries `Origin`, which then mismatches `shellOrigin` and 403s in
 * `checkAuth`. What rebinding reached was reads.
 *
 * The guard must therefore run BEFORE routing, not inside `checkAuth`: the
 * first thing the attack fetches is `authPolicy: "none"` (the bootstrap
 * script that carries the token, and the static bundle), and those never
 * reach `checkAuth` at all.
 */

/**
 * Loopback names a browser can legitimately use to reach this listener.
 *
 * `localhost` is here because users do type it and the static bundle has
 * always answered on it; the strict `Origin` check downstream is what decides
 * whether such a request may also *act* (a page loaded from
 * `http://localhost:4321` sends `Origin: http://localhost:4321`, which does
 * not match a `shellOrigin` of `http://127.0.0.1:4321` and is refused there).
 * This guard's job is narrower: keep out names that are not loopback at all.
 */
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"] as const

export type HostCheck =
  | { ok: true }
  | { ok: false; status: number; reason: string }

/**
 * `http://<host>:<port>` for the address a server is really bound to, with an
 * IPv6 literal bracketed so the result parses as a URL. Call it with what
 * `server.address()` reports, not with the requested port — `listen(0, …)`
 * binds an OS-picked one and the two disagree.
 */
export function listenOriginFor(host: string, port: number): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
  return `http://${h}:${port}`
}

/**
 * The exact `Host` header values this listener accepts: each loopback name
 * (plus the configured bind host, so a deliberately non-default `--host` is
 * not locked out of its own server) paired with the listener's port.
 *
 * `listenOrigin` is built from what `server.address()` reports AFTER `listen`
 * resolves — deliberately not from `SecurityContext.shellOrigin`. The two are
 * the same string in production, but they answer different questions:
 * `shellOrigin` is the origin the UI page is served from (what `Origin` must
 * equal), while `Host` describes the socket the client actually reached. Only
 * the second is the right yardstick here, and binding with `port: 0` makes
 * even the *requested* port the wrong answer.
 *
 * Port matching is strict. A port-less `Host` is accepted only when the
 * listener really is on the scheme-default port, because that is the only
 * case where a browser would legitimately omit it.
 */
export function allowedHostValues(listenOrigin: string): Set<string> {
  const url = new URL(listenOrigin)
  // `URL.hostname` already returns an IPv6 literal in its bracketed form
  // (measured: `new URL("http://[::1]:4321").hostname === "[::1]"`), which is
  // also the `Host`-header form — but be defensive about a bare literal
  // reaching here from a hand-built origin string.
  const bindHost =
    url.hostname.includes(":") && !url.hostname.startsWith("[")
      ? `[${url.hostname}]`
      : url.hostname
  const names = new Set<string>([...LOOPBACK_HOSTS, bindHost.toLowerCase()])
  const allowed = new Set<string>()
  for (const name of names) {
    if (url.port === "") {
      // Scheme-default port: browsers send the bare name, but a client that
      // spells the default out explicitly is equally legitimate.
      allowed.add(name)
      allowed.add(`${name}:${url.protocol === "https:" ? "443" : "80"}`)
    } else {
      allowed.add(`${name}:${url.port}`)
    }
  }
  return allowed
}

/**
 * Reject any request whose `Host` is not a loopback name on this listener's
 * own port. Call before routing — see this module's header for why.
 *
 * A MISSING `Host` is also refused — an allowlist is only worth having if the
 * unrecognised shape loses. In practice this branch is a backstop rather than
 * the live path: MEASURED on node v25, `node:http`'s own parser answers a
 * Host-less HTTP/1.1 request with a bare 400 and never invokes the request
 * handler, so nothing reaches here. It costs one comparison and means the
 * function is correct on its own terms, independent of what the runtime in
 * front of it happens to do.
 */
export function checkHost(
  req: IncomingMessage,
  listenOrigin: string,
): HostCheck {
  const raw = req.headers.host
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {
      ok: false,
      status: 403,
      reason: "Missing Host header",
    }
  }
  const allowed = allowedHostValues(listenOrigin)
  if (!allowed.has(raw.trim().toLowerCase())) {
    return {
      ok: false,
      status: 403,
      reason: `Invalid Host (expected one of ${[...allowed].join(", ")})`,
    }
  }
  return { ok: true }
}

/**
 * Defense in depth for the token-bearing bootstrap route: refuse a fetch the
 * browser itself labels cross-site.
 *
 * Honest about what this does and does not buy. It does NOT stop rebinding —
 * under one the browser labels the request `same-origin`, which is the whole
 * problem `checkHost` exists to solve. What it adds is a second, independent
 * refusal for the ordinary cross-site read attempt, so token disclosure does
 * not rest solely on the browser honouring `Cross-Origin-Resource-Policy`.
 * Absent header (non-browser client, or an older browser) is allowed through
 * — it is not evidence of anything, and the bearer is useless without a
 * matching `Origin` on every write anyway.
 */
export function isCrossSiteFetch(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"]
  return typeof site === "string" && site.trim().toLowerCase() === "cross-site"
}
