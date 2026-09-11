/**
 * `proxyToProcess` relays one Express request to a server prototype's own
 * process, listening on a loopback port, and relays the answer back.
 *
 * See the server-prototypes spec, "Proxy". Task 6's process manager decides
 * WHEN a process runs; this module only knows how to forward ONE request to
 * a port that is (believed to be) already listening.
 */
import express from "express"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { gzipSync } from "node:zlib"
import request from "supertest"
import { afterEach, describe, expect, it } from "vitest"
import { proxyToProcess, type ProxyOptions } from "../proxy-to-process"

const servers: Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})
async function child(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const s = createServer(handler)
  servers.push(s)
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()))
  return (s.address() as AddressInfo).port
}
function appFor(port: number, extra: Partial<Omit<ProxyOptions, "port" | "path">> = {}) {
  // desde-allow-own-server: this app IS the proxy under test — it has to be a
  // real listening server so `proxyToProcess`'s node:http client has a real
  // socket (to a real child, also a real server) to relay through. Each test
  // needs its own child port, so the app is parameterized per call rather
  // than built once for the file.
  const app = express()
  app.use("/p/acme", (req, res) =>
    proxyToProcess(req, res, {
      port,
      path: req.url,
      shellOrigin: "http://localhost:3100",
      bridgeSrc: "/__desde/bridge-test.js",
      csp: "default-src 'self'",
      ...extra,
    }),
  )
  return app
}
/** appFor, but for a port nothing listens on (the 502 family of tests). */
function unreachableApp(extra: Partial<Omit<ProxyOptions, "port" | "path">> = {}) {
  // desde-allow-own-server: same reason as appFor above — the app under test
  // proxies to a port that is deliberately nothing.
  const app = express()
  app.use("/p/acme", (req, res) =>
    proxyToProcess(req, res, {
      port: 1, // nothing listens here
      path: req.url,
      shellOrigin: "http://localhost:3100",
      bridgeSrc: "/__desde/bridge-test.js",
      csp: null,
      ...extra,
    }),
  )
  return app
}

describe("proxyToProcess", () => {
  it("forwards the path minus the prefix, and strips cookie and authorization", async () => {
    let seen: { url?: string; cookie?: string; authorization?: string; host?: string } = {}
    const port = await child((req, res) => {
      seen = { url: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization, host: req.headers.host }
      res.setHeader("content-type", "text/plain")
      res.end("ok")
    })
    const res = await request(appFor(port))
      .get("/p/acme/dashboard?x=1")
      .set("Cookie", "viewer_session=secret")
      .set("Authorization", "Bearer dsv_x")
    expect(res.status).toBe(200)
    expect(res.text).toBe("ok")
    expect(seen.url).toBe("/dashboard?x=1")
    expect(seen.cookie).toBeUndefined()
    expect(seen.authorization).toBeUndefined()
    expect(seen.host).toBe(`127.0.0.1:${port}`)
  })

  it("injects the bridge into HTML, fixes content-length, and replaces the CSP", async () => {
    const port = await child((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8")
      res.setHeader("content-security-policy", "default-src 'none'")
      res.end("<html><body><h1>Hi</h1></body></html>")
    })
    const res = await request(appFor(port)).get("/p/acme/")
    expect(res.status).toBe(200)
    expect(res.text).toContain('src="/__desde/bridge-test.js"')
    expect(res.text).toContain("__DESDE_SHELL_ORIGIN__")
    expect(Number(res.headers["content-length"])).toBe(Buffer.byteLength(res.text))
    expect(res.headers["content-security-policy"]).toBe("default-src 'self'")
    expect(res.headers["cache-control"]).toBe("no-store")
    expect(res.headers["x-content-type-options"]).toBe("nosniff")
  })

  it("drops the CSP entirely on a successful response when csp is null", async () => {
    const port = await child((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8")
      res.setHeader("content-security-policy", "default-src 'none'")
      res.end("<html><body>Hi</body></html>")
    })
    const res = await request(appFor(port, { csp: null })).get("/p/acme/")
    expect(res.status).toBe(200)
    expect(res.headers["content-security-policy"]).toBeUndefined()
  })

  it("streams non-HTML byte for byte with its own headers", async () => {
    const body = Buffer.from([0, 1, 2, 3, 250, 251])
    const port = await child((_req, res) => {
      res.setHeader("content-type", "application/octet-stream")
      res.setHeader("x-child", "yes")
      res.end(body)
    })
    const res = await request(appFor(port)).get("/p/acme/_next/static/x.bin").buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = []
      r.on("data", (c: Buffer) => chunks.push(c))
      r.on("end", () => cb(null, Buffer.concat(chunks)))
    })
    expect(Buffer.compare(res.body as Buffer, body)).toBe(0)
    expect(res.headers["x-child"]).toBe("yes")
  })

  it("asks the child for identity encoding, so HTML can be rewritten", async () => {
    let encoding: string | undefined
    const port = await child((req, res) => {
      encoding = req.headers["accept-encoding"] as string | undefined
      res.end("x")
    })
    await request(appFor(port)).get("/p/acme/").set("Accept-Encoding", "gzip, br")
    expect(encoding).toBe("identity")
  })

  it("streams unrewritten when the child answers HTML but encoded anyway", async () => {
    // No bridge tag anywhere in here, so an accidental rewrite attempt would
    // be easy to miss — the real proof is bytewise below.
    const original = "<html><body>" + "y".repeat(2000) + "</body></html>"
    const gzipped = gzipSync(Buffer.from(original, "utf8"))
    const port = await child((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8")
      res.setHeader("content-encoding", "gzip")
      res.end(gzipped)
    })
    // supertest (via superagent) transparently gunzips a `content-encoding:
    // gzip` body for us, so what reaches `res.body` here is the DECOMPRESSED
    // text — which is exactly the point: the proxy relayed the gzip bytes
    // untouched (never decoded, never rewritten, never treated as UTF-8), and
    // the client's own decompression recovers the original unmodified.
    const res = await request(appFor(port))
      .get("/p/acme/")
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = []
        r.on("data", (c: Buffer) => chunks.push(c))
        r.on("end", () => cb(null, Buffer.concat(chunks)))
      })
    expect(Buffer.compare(res.body as Buffer, Buffer.from(original, "utf8"))).toBe(0)
    expect((res.body as Buffer).toString("utf8")).not.toContain("bridge-test.js")
    expect(res.headers["content-encoding"]).toBe("gzip")
  })

  it("passes set-cookie through", async () => {
    const port = await child((_req, res) => {
      res.setHeader("set-cookie", "proto=1; Path=/")
      res.end("x")
    })
    const res = await request(appFor(port)).get("/p/acme/")
    expect(res.headers["set-cookie"]).toEqual(["proto=1; Path=/"])
  })

  /**
   * The viewer's own cookie must be the one the browser keeps, and a prototype
   * must not be able to take its name.
   *
   * A jar stores one value per cookie name and the LAST `Set-Cookie` wins, so
   * order is the whole mechanism here: ours goes after everything the child
   * sent, and a child value sharing our name is dropped rather than merely
   * out-ordered (leaving it would put an attacker-chosen `dsv_cap` on the
   * origin for anything that reads the header list rather than the jar).
   */
  it("puts the viewer's own Set-Cookie last and drops a child cookie of the same name", async () => {
    const port = await child((_req, res) => {
      res.setHeader("set-cookie", ["other=1", "__Host-dsv_cap=evil; Path=/; Secure"])
      res.end("x")
    })
    const ours = "__Host-dsv_cap=ours; Path=/; Secure; HttpOnly; SameSite=Lax"
    const res = await request(appFor(port, { setCookie: ours })).get("/p/acme/")
    expect(res.headers["set-cookie"]).toEqual(["other=1", ours])
  })

  it("sets the viewer's cookie even when the child sends none", async () => {
    const port = await child((_req, res) => res.end("x"))
    const ours = "dsv_cap=ours; Path=/"
    const res = await request(appFor(port, { setCookie: ours })).get("/p/acme/")
    expect(res.headers["set-cookie"]).toEqual([ours])
  })

  /** The streaming branch takes the merged cookies too, not just the rewrite one. */
  it("carries the merged cookies on a streamed (non-HTML) response", async () => {
    const port = await child((_req, res) => {
      res.setHeader("content-type", "application/json")
      res.setHeader("set-cookie", "app=1")
      res.end('{"a":1}')
    })
    const ours = "dsv_cap=ours; Path=/"
    const res = await request(appFor(port, { setCookie: ours })).get("/p/acme/data.json")
    expect(res.headers["set-cookie"]).toEqual(["app=1", ours])
  })

  it("passes a HEAD response through with no injected Content-Length", async () => {
    const port = await child((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8")
      res.end()
    })
    const res = await request(appFor(port)).head("/p/acme/")
    expect(res.status).toBe(200)
    expect(res.headers["content-length"]).toBeUndefined()
  })

  it("passes a 204 through with no body and no Content-Length, even for HTML", async () => {
    const port = await child((_req, res) => {
      res.statusCode = 204
      res.setHeader("content-type", "text/html; charset=utf-8")
      res.end()
    })
    const res = await request(appFor(port)).get("/p/acme/")
    expect(res.status).toBe(204)
    expect(res.text).toBe("")
    expect(res.headers["content-length"]).toBeUndefined()
  })

  it("does not inject into a genuinely empty HTML body", async () => {
    const port = await child((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8")
      res.end()
    })
    const res = await request(appFor(port)).get("/p/acme/")
    expect(res.status).toBe(200)
    expect(res.text).toBe("")
    expect(res.text).not.toContain("bridge-test.js")
  })

  it("passes an HTML body through unmodified once it exceeds the rewrite cap", async () => {
    const body = "<html><body>" + "z".repeat(1024) + "</body></html>"
    const port = await child((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8")
      res.end(body)
    })
    const res = await request(appFor(port, { maxRewriteBytes: 64 })).get("/p/acme/")
    expect(res.status).toBe(200)
    expect(res.text).toBe(body)
    expect(res.text).not.toContain("bridge-test.js")
  })

  it("answers 502 with an HTML page, its own headers, and reports it when the child is unreachable", async () => {
    let reported = false
    const res = await request(
      unreachableApp({
        onUnreachable: () => {
          reported = true
        },
      }),
    ).get("/p/acme/")
    expect(res.status).toBe(502)
    expect(res.headers["content-type"]).toMatch(/text\/html/)
    expect(res.text).toContain("not answering")
    expect(res.headers["cache-control"]).toBe("no-store")
    expect(res.headers["x-content-type-options"]).toBe("nosniff")
    expect(res.headers["content-security-policy"]).toBeUndefined()
    expect(reported).toBe(true)
  })

  it("carries the configured CSP on the 502 page too", async () => {
    const res = await request(unreachableApp({ csp: "default-src 'self'" })).get("/p/acme/")
    expect(res.status).toBe(502)
    expect(res.headers["content-security-policy"]).toBe("default-src 'self'")
  })
})
