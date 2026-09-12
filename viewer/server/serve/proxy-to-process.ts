import type { Request, Response } from "express"
import { request as httpRequest, type IncomingHttpHeaders } from "node:http"
import { injectBridge } from "./html-inject"
import { capabilityCookieName } from "./prototype-capability-path"

/**
 * Forwards one request to a server prototype's process and relays the
 * answer, rewriting HTML on the way back so the bridge loads. `node:http`
 * only. See the server-prototypes spec, "Proxy".
 */
export interface ProxyOptions {
  port: number
  /** The path the child sees: the browser's own `originalUrl`, with only the `~c` capability query parameter removed. See `childPathFor` in `serve-router.ts`. */
  path: string
  shellOrigin: string
  /**
   * The scheme the BROWSER used to reach the prototype origin, stated to the
   * child as `X-Forwarded-Proto`.
   *
   * Not derived from `shellOrigin`: the two can differ. A loopback listener
   * is always `http`, whatever the shell is, and it is the caller — the serve
   * router, which knows whether this request arrived on a pinned listener —
   * that can tell them apart.
   */
  forwardedProto: "http" | "https"
  bridgeSrc: string
  csp: string | null
  /** Overrides {@link MAX_REWRITTEN_HTML_BYTES}. Test-only escape hatch. */
  maxRewriteBytes?: number
  /**
   * One serialized `Set-Cookie` the VIEWER owns, placed on the response after
   * the child's own — today the `dsv_cap` read capability the serve router
   * promotes on a subdomain document load.
   *
   * It is passed here rather than appended to `res` by the caller because
   * ORDER decides the winner. A browser keeps the LAST value for a given
   * cookie name, so a caller that appended first would be silently overridden
   * by a child that happened to set the same name. Owning the merge here is
   * what makes "the viewer's cookie is the viewer's" true rather than
   * dependent on what the prototype does. See {@link mergeSetCookies}.
   */
  setCookie?: string
  /**
   * Called when the child gave no response at all — the connection to its
   * port could not be made or failed before any status line came back — so
   * the process manager can mark it down. NOT called when a response started
   * and then failed partway through; that case only destroys the client
   * response, because the manager already knows the child was up.
   */
  onUnreachable?: () => void
  /**
   * Overrides {@link UPSTREAM_TIMEOUT_MS}. Test-only escape hatch, so a test
   * can prove the bound without an actual 60s wait.
   */
  upstreamTimeoutMs?: number
}

export const MAX_REWRITTEN_HTML_BYTES = 5 * 1024 * 1024

/**
 * How long to wait for the child to say anything before giving up.
 *
 * This bounds the wait for HEADERS only, not the whole exchange — see where
 * it is used below. `timeout` on `httpRequest` is a socket inactivity
 * timeout that, left alone, covers the whole request/response lifetime, so an
 * SSE stream (or any response merely quiet for a while after its headers)
 * would be destroyed by this same timer even though the child answered
 * promptly (codex round 7, Fix 2).
 */
const UPSTREAM_TIMEOUT_MS = 60_000

/**
 * RFC 7230 hop-by-hop headers, plus the ones this proxy owns or strips.
 *
 * `cookie` is NOT here: the prototype's own cookies are forwarded, minus the
 * viewer's (see {@link forwardedCookieHeader}). The `x-forwarded-*` names are
 * dropped so the values this proxy sets below cannot end up alongside a
 * client-supplied copy under a different letter case, which Node would send as
 * two headers.
 *
 * `forwarded` and `x-real-ip` are dropped outright, and nothing is put back in
 * their place. Together with `x-forwarded-for` they are how a proxy states WHO
 * the client is, and this proxy is the only thing here entitled to say it: an
 * app running with `trust proxy` on believes these headers for rate limiting,
 * geo, audit logs and allowlists, so passing a caller's own values through
 * would let anyone who can reach a prototype origin choose their address.
 */
const DROP_REQUEST = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "authorization",
  "accept-encoding",
  "host",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-for",
  "forwarded",
  "x-real-ip",
])
const DROP_RESPONSE = new Set([
  // The fixed hop-by-hop set, the same as on the request side (codex round
  // 26): a trailer this proxy never relays, an upgrade it never performs,
  // a proxy challenge that is not its own.
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
  "transfer-encoding",
  "content-security-policy",
  "content-security-policy-report-only",
  "content-length",
  // Framing policy is the viewer's, not the prototype's. Browsers ignore
  // this header when a `frame-ancestors` CSP is present, but with
  // `VIEWER_PROTOTYPE_CSP=off` there is no such directive, and an app that
  // sets `X-Frame-Options: DENY` (a common template default) would then
  // refuse to load in the review iframe.
  "x-frame-options",
  // In subdomain mode the prototypes share a registrable domain with the
  // shell, and `Clear-Site-Data: "cookies"` clears that whole domain: the
  // viewer's session and every sibling prototype's cookies with it (codex
  // round 22). The Set-Cookie rules keep a child from PLANTING cookies on
  // the shell; this keeps it from erasing them.
  "clear-site-data",
])

/** The two names the viewer's read capability can have, http and https. */
const VIEWER_COOKIE_NAMES = new Set([capabilityCookieName(false), capabilityCookieName(true)])

/**
 * The inbound `cookie` header minus the viewer's own capability cookie, or
 * `undefined` when nothing is left to send.
 *
 * The prototype's own cookies are the point — a theme, a mock session, a
 * locale — so everything else is passed through untouched, in order. The
 * viewer's SESSION cookie needs no case here: it is host-only on the shell
 * origin, so a browser never sends it to a prototype origin in the first
 * place. The capability cookie IS sent (it is set on the prototype origin),
 * and it is ours, so it stops here.
 */
function forwardedCookieHeader(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const kept = raw
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => {
      if (pair === "") return false
      const eq = pair.indexOf("=")
      const name = eq === -1 ? pair : pair.slice(0, eq)
      return !VIEWER_COOKIE_NAMES.has(name)
    })
  return kept.length > 0 ? kept.join("; ") : undefined
}

/** A `Set-Cookie` value's cookie NAME — everything before the first `=`. */
function cookieNameOf(entry: string): string {
  const eq = entry.indexOf("=")
  return (eq === -1 ? entry : entry.slice(0, eq)).trim()
}

/**
 * The `Set-Cookie` values for a proxied response: the child's, minus any whose
 * NAME is one of the viewer's own capability cookie names, with the viewer's
 * OWN value (if it is setting one on this response) last.
 *
 * The drop happens UNCONDITIONALLY, whether or not `ours` is present. `ours`
 * is only ever set on the first response after a `?~c=` capability grant —
 * every later response on that origin proxies with `ours` undefined. Before
 * this fix, an undefined `ours` skipped the drop entirely, so a child
 * `Set-Cookie: dsv_cap=…` (or `__Host-dsv_cap=…`) on any of those later
 * responses passed straight through and could replace or expire the read
 * capability the viewer had already granted. Putting `ours` LAST when it IS
 * present is what makes it the value the browser keeps, since a jar stores
 * one value per name and the last `Set-Cookie` wins.
 *
 * Names are compared exactly, which is why the `__Host-` form needs no special
 * case: the prefix is part of the name on both sides.
 */
export function mergeSetCookies(
  fromChild: string | string[] | undefined,
  ours: string | undefined,
): string[] {
  const child = fromChild === undefined ? [] : Array.isArray(fromChild) ? fromChild : [fromChild]
  // `ours`, when present, always carries one of these same two names (see
  // `capabilityCookieName`), so one name-based filter closes both holes: a
  // child cookie sharing the viewer's name is always dropped, `ours` is
  // always appended last when it exists.
  // Host-only, always: a `Domain` attribute is stripped from every child
  // cookie. In subdomain mode the shell and the prototypes are deliberately
  // same-site, so a child that set `Domain=example.com` would have its
  // cookie sent to the shell and to every sibling prototype (codex round
  // 17). Without the attribute the browser scopes the cookie to the
  // prototype's own host, which is the boundary the origin design rests on.
  const withoutOurNames = child
    .filter((entry) => !VIEWER_COOKIE_NAMES.has(cookieNameOf(entry)))
    // Whitespace around the `=` is legal in the attribute grammar and a
    // browser trims it, so the strip must too (codex round 18).
    .map((entry) => entry.replace(/;\s*domain\s*=[^;]*/gi, ""))
  return ours === undefined ? withoutOurNames : [...withoutOurNames, ours]
}

/** The header names a `Connection` value nominates as hop-by-hop, lowercased. */
function hopByHopNamedBy(connection: string | string[] | undefined): Set<string> {
  const value = Array.isArray(connection) ? connection.join(",") : (connection ?? "")
  return new Set(
    value
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ""),
  )
}

function isHtml(contentType: string | undefined): boolean {
  return typeof contentType === "string" && /^text\/html\b/i.test(contentType)
}

/** The `charset` parameter of a Content-Type, lower-cased, or `null` when it names none. */
export function htmlCharset(contentType: string | undefined): string | null {
  const match = typeof contentType === "string" ? /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType) : null
  return match?.[1]?.toLowerCase() ?? null
}

/** Labels that already mean UTF-8: the body is read as it is and the header stays. */
const UTF8_LABELS = new Set(["utf-8", "utf8", "unicode-1-1-utf-8"])

/**
 * The HTML body as text, plus whether the response has to be re-labelled
 * UTF-8 because the bytes were something else (codex round 38). The
 * injected body is always written back as UTF-8, and a child that declared
 * `iso-8859-1` or `utf-16` used to have its bytes read as UTF-8 anyway and
 * sent on under the original label: every non-ASCII character came out
 * wrong, and a UTF-16 page came out as noise. `null` means the label is one
 * this runtime cannot decode; the caller passes the bytes through untouched
 * rather than guess.
 */
export function decodeHtml(raw: Buffer, contentType: string | undefined): { text: string; relabel: boolean } | null {
  const charset = htmlCharset(contentType)
  if (charset === null || UTF8_LABELS.has(charset)) return { text: raw.toString("utf8"), relabel: false }
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(charset)
  } catch {
    return null
  }
  return { text: decoder.decode(raw), relabel: true }
}

/** The two headers this proxy always owns, plus the CSP it decides (not the child's). */
function setOwnHeaders(res: Response, csp: string | null): void {
  res.setHeader("Cache-Control", "no-store")
  res.setHeader("X-Content-Type-Options", "nosniff")
  if (csp !== null) res.setHeader("Content-Security-Policy", csp)
}

const NOT_ANSWERING_PAGE =
  "<!doctype html><title>Prototype unavailable</title><p>The prototype's server is not answering. Reload in a moment; if this keeps happening, rebuild the prototype.</p>"

/**
 * Forwards `req` to the child on `opts.port` and relays its answer onto
 * `res`. The returned promise resolves once `res` closes — normal
 * completion, a client abort, or an upstream failure all count — and never
 * rejects; every failure this function can hit is already turned into a
 * response (a 502 page) or a destroyed connection. A caller that holds a
 * resource for the lifetime of the response (the serve router's process
 * lease, see `prototype-processes.ts`'s `withLease`) awaits this promise
 * to know when it is safe to let go.
 */
export function proxyToProcess(req: Request, res: Response, opts: ProxyOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    // Settles the promise the caller awaits, so a lease scope built on
    // this function outlives the whole response, not just the call that
    // started it. Registered first, before any of the body below, so it
    // catches a close from any path (normal completion, client abort,
    // upstream failure).
    res.once("close", () => resolve())
    const headers: IncomingHttpHeaders = {}
    // Hop-by-hop headers are the static list plus whatever `Connection`
    // names for this one hop (`Connection: foo` means `foo` too), in both
    // directions (codex round 24).
    const requestHopByHop = hopByHopNamedBy(req.headers.connection)
    for (const [k, v] of Object.entries(req.headers)) {
      const name = k.toLowerCase()
      if (!DROP_REQUEST.has(name) && !requestHopByHop.has(name) && v !== undefined) headers[k] = v
    }
    headers["accept-encoding"] = "identity"
    const cookie = forwardedCookieHeader(req.headers.cookie)
    if (cookie !== undefined) headers.cookie = cookie
    else delete headers.cookie
    // Set here, after the copy loop, and never merged with whatever the client
    // claimed (all three names are in `DROP_REQUEST`).
    //
    // The child is told the browser's OWN host, both as `Host` and as
    // `X-Forwarded-Host` (codex round 20, item 1). `Host` used to be rewritten
    // to the child's `127.0.0.1:<port>`, which left the forwarding header as
    // the only statement of where the browser went — and a server that does
    // not read forwarding headers then builds every request URL from a private
    // loopback address. The stock `@react-router/serve` is exactly that: plain
    // Express with no `trust proxy`, so its loaders and actions saw
    // `http://127.0.0.1:<port>/…` and decided origin-based redirects, absolute
    // URLs and secure-cookie behaviour against the wrong origin. Sending the
    // real host is safe here because the child listens on loopback only and
    // none of the three supported servers validates `Host`.
    //
    // `X-Forwarded-Host` is still sent alongside it, because a framework that
    // checks a write's `Origin` against its own host reads that name FIRST —
    // Next's server-action handler does.
    //
    // The SCHEME cannot be restored the same way: there is no equivalent of
    // `Host` for it, so a server that ignores `X-Forwarded-Proto` sees `http`
    // however the browser arrived. On an https deployment a React Router app
    // reads `http://…` in its loaders until the app itself enables
    // `trust proxy`.
    //
    // A `Host` the request did not carry is impossible in practice (HTTP/1.1
    // requires it), but an empty string here would be worse than no header at
    // all, so it is simply left off: `node:http` then addresses the child by
    // the loopback port it is dialling.
    const browserHost = req.headers.host
    if (typeof browserHost === "string" && browserHost !== "") {
      headers.host = browserHost
      headers["x-forwarded-host"] = browserHost
    }
    headers["x-forwarded-proto"] = opts.forwardedProto
    // The one address the viewer actually knows. Express resolves `req.ip`
    // through `VIEWER_TRUST_PROXY`, so it is the real client as far as this
    // deployment is configured to be able to tell. When there is none to
    // state, none is sent: an app is better off seeing no forwarding header
    // at all than a value neither it nor the viewer can stand behind.
    if (typeof req.ip === "string" && req.ip !== "") headers["x-forwarded-for"] = req.ip

    const maxRewriteBytes = opts.maxRewriteBytes ?? MAX_REWRITTEN_HTML_BYTES
    const upstreamTimeoutMs = opts.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS
    // Whether the child sent a status line at all. Gates onUnreachable: once a
    // response has started, a later failure is not "the child is unreachable" —
    // it already answered.
    let responded = false

    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: opts.port,
        method: req.method,
        path: opts.path,
        headers,
        timeout: upstreamTimeoutMs,
      },
      (up) => {
        responded = true
        // The timeout above bounds the WAIT FOR HEADERS only. Once the child
        // has answered, `setTimeout(0)` clears the socket's inactivity timer
        // so a quiet stream (SSE, a slow download) is never destroyed on its
        // account — a quiet body is the child's own business, and the in-flight
        // request lease (`withLease` in `prototype-processes.ts`) is already
        // what keeps the process itself alive for as long as this response is
        // open. Deliberately no SEPARATE body-phase timeout is added in its
        // place (codex round 7, Fix 2).
        upstream.setTimeout(0)
        // Attached FIRST, before the rewrite/stream branch below, so both
        // paths have it. `pipe()` (the non-rewrite path, right below) does not
        // forward errors — before this was hoisted here, a child that started
        // a non-HTML response and then reset the connection mid-stream emitted
        // "error" on `up` with no listener at all, which Node turns into an
        // uncaught exception that ends the whole Viewer process (codex round
        // 7, Fix 1).
        up.on("error", () => res.destroy())
        // A child that ignores `accept-encoding: identity` and answers encoded
        // anyway cannot be safely rewritten — decoding it is out of scope, and
        // treating the compressed bytes as UTF-8 HTML would corrupt them. Fall
        // back to a byte-for-byte stream instead of guessing.
        const encoding = up.headers["content-encoding"]
        const childEncoded = typeof encoding === "string" && encoding.toLowerCase() !== "identity"
        // HEAD answers, and 204/304, carry no body by definition — rewriting
        // (or even claiming a Content-Length for) a body that must not exist
        // would violate HTTP, so those always take the streaming path.
        const bodiless = req.method === "HEAD" || up.statusCode === 204 || up.statusCode === 304
        // A 206 is a slice of a document, not a document: injecting into it
        // would put a script tag inside an arbitrary byte range and leave
        // `Content-Range` describing bytes the body no longer holds (codex
        // round 22). It streams through untouched.
        const partial = up.statusCode === 206
        const rewrite = isHtml(up.headers["content-type"]) && !childEncoded && !bodiless && !partial

        res.status(up.statusCode ?? 502)
        const responseHopByHop = hopByHopNamedBy(up.headers.connection)
        for (const [k, v] of Object.entries(up.headers)) {
          // `set-cookie` is held back and merged below — see `mergeSetCookies`
          // for why the viewer's own value has to go last, and why a child value
          // sharing its name is dropped.
          if (DROP_RESPONSE.has(k.toLowerCase()) || responseHopByHop.has(k.toLowerCase()) || v === undefined) continue
          // No CORS grant from the child survives (codex round 27). On a
          // pinned loopback origin a GET needs no capability, and the
          // container's port range is enumerable, so a child that reflects
          // `Access-Control-Allow-Origin` (a common middleware default) would
          // let a hostile page read a private prototype. The static path
          // withholds these for the same reason.
          if (k.toLowerCase().startsWith("access-control-")) continue
          if (k.toLowerCase() === "set-cookie") continue
          res.setHeader(k, v)
        }
        // Before the rewrite/stream split below, so both answer shapes carry the
        // same cookies. (The 502 path never gets here and sets none.)
        const cookies = mergeSetCookies(up.headers["set-cookie"], opts.setCookie)
        if (cookies.length > 0) res.setHeader("Set-Cookie", cookies)
        setOwnHeaders(res, opts.csp)

        if (!rewrite) {
          // The general header filter above dropped `Content-Length`
          // (`DROP_RESPONSE`) so it can be recomputed for a rewritten body —
          // this branch has no rewritten body to recompute one FROM, so it is
          // restored from upstream instead where that is still meaningful
          // (codex round 11, Fix 4). A HEAD answer legitimately carries the
          // length of the GET representation, and clients use it; a 304 may
          // carry one for the same reason. A 204 must never carry one at all,
          // so it is left dropped even when upstream sent it.
          if (!bodiless || req.method === "HEAD" || up.statusCode === 304) {
            if (up.headers["content-length"]) res.setHeader("Content-Length", up.headers["content-length"])
          }
          up.pipe(res)
          return
        }

        const chunks: Buffer[] = []
        let bytes = 0

        // Named so the over-cap branch can unhook both before handing the rest
        // of the stream to `up.pipe(res)` — piping ends `res` itself, so `onEnd`
        // must never run after that handoff, or `res.end()` would be called twice.
        function onData(chunk: Buffer): void {
          chunks.push(chunk)
          bytes += chunk.length
          if (bytes > maxRewriteBytes) {
            // Too big to rewrite: flush what we have unmodified, then let a
            // real pipe take over so backpressure is respected for the rest.
            up.off("data", onData)
            up.off("end", onEnd)
            for (const c of chunks) res.write(c)
            chunks.length = 0
            up.pipe(res)
          }
        }
        function onEnd(): void {
          if (bytes === 0) {
            // Nothing to inject into — an empty body stays empty.
            res.end()
            return
          }
          const raw = Buffer.concat(chunks)
          const decoded = decodeHtml(raw, up.headers["content-type"])
          if (decoded === null) {
            // A charset this runtime cannot decode: the page keeps its bytes
            // and loses the bridge, rather than the other way round.
            res.setHeader("Content-Length", raw.length)
            res.end(raw)
            return
          }
          // The body below is UTF-8 whatever the child sent, so the label
          // says so; a browser reads the header's charset over a `<meta>`.
          if (decoded.relabel) res.setHeader("Content-Type", "text/html; charset=utf-8")
          const body = injectBridge(decoded.text, opts.shellOrigin, opts.bridgeSrc)
          res.setHeader("Content-Length", Buffer.byteLength(body))
          res.end(body)
        }
        up.on("data", onData)
        up.on("end", onEnd)
      },
    )

    // The client walked away before the child answered: nothing left to relay
    // to, so stop asking the child for it.
    // Remembered so the error handler below can tell OUR abort from the
    // child's failure (live run, 2026-09-11): when the review page remounts
    // the frame while its previous request is still waiting on a cold
    // start, this abort destroys the upstream request before any headers
    // came back, and reading that as "the child is unreachable" killed a
    // healthy child and charged its restart budget.
    let clientAborted = false
    res.on("close", () => {
      if (!res.writableFinished) {
        clientAborted = true
        upstream.destroy()
      }
    })
    res.on("error", () => upstream.destroy())
    // `destroy()` with no argument does not itself raise `upstream`'s "error"
    // event, so an explicit Error is passed to route a timeout through the
    // same handler as every other upstream failure.
    upstream.on("timeout", () => upstream.destroy(new Error("proxy upstream timeout")))

    upstream.on("error", () => {
      if (responded) {
        // The child answered and then the connection failed mid-response. It
        // was reachable; only the in-flight response is lost.
        res.destroy()
        return
      }
      // Our own abort is not the child's failure: nothing was learned about
      // the child, so nothing is reported and nothing is killed.
      if (clientAborted) return
      opts.onUnreachable?.()
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.status(502)
      setOwnHeaders(res, opts.csp)
      res.type("text/html").send(NOT_ANSWERING_PAGE)
    })
    req.pipe(upstream)
  })
}
