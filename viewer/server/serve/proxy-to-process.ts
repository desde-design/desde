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
  /** Called when the child cannot be reached, so the manager can mark it. */
  onUnreachable?: () => void
}

export const MAX_REWRITTEN_HTML_BYTES = 5 * 1024 * 1024

/** RFC 7230 hop-by-hop headers, plus the two this proxy owns. */
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

function isHtml(contentType: string | undefined): boolean {
  return typeof contentType === "string" && /^text\/html\b/i.test(contentType)
}

export function proxyToProcess(req: Request, res: Response, opts: ProxyOptions): void {
  const headers: IncomingHttpHeaders = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (!DROP_REQUEST.has(k.toLowerCase()) && v !== undefined) headers[k] = v
  }
  headers["accept-encoding"] = "identity"
  headers.host = `127.0.0.1:${opts.port}`

  const upstream = httpRequest(
    { host: "127.0.0.1", port: opts.port, method: req.method, path: opts.path, headers },
    (up) => {
      const html = isHtml(up.headers["content-type"])
      res.status(up.statusCode ?? 502)
      for (const [k, v] of Object.entries(up.headers)) {
        if (DROP_RESPONSE.has(k.toLowerCase()) || v === undefined) continue
        res.setHeader(k, v)
      }
      res.setHeader("Cache-Control", "no-store")
      res.setHeader("X-Content-Type-Options", "nosniff")
      if (opts.csp !== null) res.setHeader("Content-Security-Policy", opts.csp)

      if (!html) {
        if (up.headers["content-length"]) res.setHeader("Content-Length", up.headers["content-length"])
        up.pipe(res)
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      let passthrough = false
      up.on("data", (chunk: Buffer) => {
        if (passthrough) {
          res.write(chunk)
          return
        }
        chunks.push(chunk)
        bytes += chunk.length
        if (bytes > MAX_REWRITTEN_HTML_BYTES) {
          // Too big to rewrite: send what we have, unmodified, and stream the rest.
          passthrough = true
          for (const c of chunks) res.write(c)
          chunks.length = 0
        }
      })
      up.on("end", () => {
        if (passthrough) {
          res.end()
          return
        }
        const body = injectBridge(Buffer.concat(chunks).toString("utf8"), opts.shellOrigin, opts.bridgeSrc)
        res.setHeader("Content-Length", Buffer.byteLength(body))
        res.end(body)
      })
      up.on("error", () => res.destroy())
    },
  )
  upstream.on("error", () => {
    opts.onUnreachable?.()
    if (res.headersSent) {
      res.destroy()
      return
    }
    res
      .status(502)
      .type("text/html")
      .send(
        "<!doctype html><title>Prototype unavailable</title><p>The prototype's server is not answering. Reload in a moment; if this keeps happening, rebuild the prototype.</p>",
      )
  })
  req.pipe(upstream)
}
