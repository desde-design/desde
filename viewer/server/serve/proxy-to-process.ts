import type { Request, Response } from "express"
import { request as httpRequest, type IncomingHttpHeaders } from "node:http"
import { injectBridge } from "./html-inject"

/**
 * Forwards one request to a server prototype's process and relays the
 * answer, rewriting HTML on the way back so the bridge loads. `node:http`
 * only. See the server-prototypes spec, "Proxy".
 */
export interface ProxyOptions {
  port: number
  /** The path the child sees: prefix removed, query kept. */
  path: string
  shellOrigin: string
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
}

export const MAX_REWRITTEN_HTML_BYTES = 5 * 1024 * 1024

/** How long to wait for the child to say anything before giving up. */
const UPSTREAM_TIMEOUT_MS = 60_000

/** RFC 7230 hop-by-hop headers, plus the ones this proxy owns or strips. */
const DROP_REQUEST = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cookie",
  "authorization",
  "accept-encoding",
  "host",
])
const DROP_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-security-policy",
  "content-security-policy-report-only",
  "content-length",
])

/** A `Set-Cookie` value's cookie NAME — everything before the first `=`. */
function cookieNameOf(entry: string): string {
  const eq = entry.indexOf("=")
  return (eq === -1 ? entry : entry.slice(0, eq)).trim()
}

/**
 * The `Set-Cookie` values for a proxied response: the child's, minus any whose
 * NAME is the viewer's own, with the viewer's last.
 *
 * Both halves matter and they close different holes. Dropping the child's
 * same-named value stops a prototype writing its own `dsv_cap` (or
 * `__Host-dsv_cap`) onto the origin — a cookie the viewer reads back as a read
 * capability on every later request. Putting ours LAST is what makes it the
 * value the browser keeps, since a jar stores one value per name and the last
 * `Set-Cookie` wins.
 *
 * Names are compared exactly, which is why the `__Host-` form needs no special
 * case: the prefix is part of the name on both sides.
 */
export function mergeSetCookies(
  fromChild: string | string[] | undefined,
  ours: string | undefined,
): string[] {
  const child = fromChild === undefined ? [] : Array.isArray(fromChild) ? fromChild : [fromChild]
  if (ours === undefined) return child
  const ourName = cookieNameOf(ours)
  return [...child.filter((entry) => cookieNameOf(entry) !== ourName), ours]
}

function isHtml(contentType: string | undefined): boolean {
  return typeof contentType === "string" && /^text\/html\b/i.test(contentType)
}

/** The two headers this proxy always owns, plus the CSP it decides (not the child's). */
function setOwnHeaders(res: Response, csp: string | null): void {
  res.setHeader("Cache-Control", "no-store")
  res.setHeader("X-Content-Type-Options", "nosniff")
  if (csp !== null) res.setHeader("Content-Security-Policy", csp)
}

const NOT_ANSWERING_PAGE =
  "<!doctype html><title>Prototype unavailable</title><p>The prototype's server is not answering. Reload in a moment; if this keeps happening, rebuild the prototype.</p>"

export function proxyToProcess(req: Request, res: Response, opts: ProxyOptions): void {
  const headers: IncomingHttpHeaders = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (!DROP_REQUEST.has(k.toLowerCase()) && v !== undefined) headers[k] = v
  }
  headers["accept-encoding"] = "identity"
  headers.host = `127.0.0.1:${opts.port}`

  const maxRewriteBytes = opts.maxRewriteBytes ?? MAX_REWRITTEN_HTML_BYTES
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
      timeout: UPSTREAM_TIMEOUT_MS,
    },
    (up) => {
      responded = true
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
      const rewrite = isHtml(up.headers["content-type"]) && !childEncoded && !bodiless

      res.status(up.statusCode ?? 502)
      for (const [k, v] of Object.entries(up.headers)) {
        // `set-cookie` is held back and merged below — see `mergeSetCookies`
        // for why the viewer's own value has to go last, and why a child value
        // sharing its name is dropped.
        if (DROP_RESPONSE.has(k.toLowerCase()) || v === undefined) continue
        if (k.toLowerCase() === "set-cookie") continue
        res.setHeader(k, v)
      }
      // Before the rewrite/stream split below, so both answer shapes carry the
      // same cookies. (The 502 path never gets here and sets none.)
      const cookies = mergeSetCookies(up.headers["set-cookie"], opts.setCookie)
      if (cookies.length > 0) res.setHeader("Set-Cookie", cookies)
      setOwnHeaders(res, opts.csp)

      if (!rewrite) {
        if (!bodiless && up.headers["content-length"]) res.setHeader("Content-Length", up.headers["content-length"])
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
        const body = injectBridge(Buffer.concat(chunks).toString("utf8"), opts.shellOrigin, opts.bridgeSrc)
        res.setHeader("Content-Length", Buffer.byteLength(body))
        res.end(body)
      }
      up.on("data", onData)
      up.on("end", onEnd)
      up.on("error", () => res.destroy())
    },
  )

  // The client walked away before the child answered: nothing left to relay
  // to, so stop asking the child for it.
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy()
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
}
