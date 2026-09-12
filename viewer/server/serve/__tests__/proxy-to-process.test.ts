/**
 * `proxyToProcess` relays one Express request to a server prototype's own
 * process, listening on a loopback port, and relays the answer back.
 *
 * See the server-prototypes spec, "Proxy". Task 6's process manager decides
 * WHEN a process runs; this module only knows how to forward ONE request to
 * a port that is (believed to be) already listening.
 */
import express from "express"
import { createServer, request as nodeHttpRequest, type Server } from "node:http"
import { connect, type AddressInfo } from "node:net"
import { gzipSync } from "node:zlib"
import request from "supertest"
import { afterEach, describe, expect, it, vi } from "vitest"
import { proxyToProcess, type ProxyOptions } from "../proxy-to-process"

/** A promise this test controls the settlement of, standing in for a real, slow event. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

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
      forwardedProto: "http",
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
      forwardedProto: "http",
      bridgeSrc: "/__desde/bridge-test.js",
      csp: null,
      ...extra,
    }),
  )
  return app
}

describe("proxyToProcess", () => {
  it("forwards the path minus the prefix, and strips authorization", async () => {
    let seen: { url?: string; authorization?: string } = {}
    const port = await child((req, res) => {
      seen = { url: req.url, authorization: req.headers.authorization }
      res.setHeader("content-type", "text/plain")
      res.end("ok")
    })
    const res = await request(appFor(port))
      .get("/p/acme/dashboard?x=1")
      .set("Authorization", "Bearer dsv_x")
    expect(res.status).toBe(200)
    expect(res.text).toBe("ok")
    expect(seen.url).toBe("/dashboard?x=1")
    expect(seen.authorization).toBeUndefined()
  })

  /**
   * The prototype's own cookies are the point: the feature exists for apps
   * that read a theme, a mock session or a locale off the jar. Only the
   * Viewer's own capability cookie is removed, under both names it can have
   * (`dsv_cap` on http, `__Host-dsv_cap` on https). The Viewer's SESSION
   * cookie needs no case here: it is host-only on the shell, so a browser
   * never sends it to a prototype origin at all.
   */
  it("forwards the prototype's own cookies and removes the viewer's capability cookie", async () => {
    let cookie: string | undefined
    const port = await child((req, res) => {
      cookie = req.headers.cookie
      res.end("ok")
    })
    await request(appFor(port))
      .get("/p/acme/")
      .set("Cookie", "dsv_cap=tok1; theme=dark; __Host-dsv_cap=tok2; locale=en-GB")
    expect(cookie).toBe("theme=dark; locale=en-GB")
  })

  it("sends no cookie header at all when the viewer's was the only one", async () => {
    let had = true
    const port = await child((req, res) => {
      had = "cookie" in req.headers
      res.end("ok")
    })
    await request(appFor(port)).get("/p/acme/").set("Cookie", "dsv_cap=tok1")
    expect(had).toBe(false)
  })

  /**
   * Next's server-action handler compares the request's `Origin` against
   * `x-forwarded-host` first and `host` second, and refuses the action on a
   * mismatch. The client's own values are overwritten rather than merged:
   * they are whatever the browser or an intermediary claimed, and this proxy
   * knows the truth.
   */
  it("states the browser's host and scheme in X-Forwarded-Host and X-Forwarded-Proto", async () => {
    let seen: { fwdHost?: string; fwdProto?: string } = {}
    const port = await child((req, res) => {
      seen = {
        fwdHost: req.headers["x-forwarded-host"] as string | undefined,
        fwdProto: req.headers["x-forwarded-proto"] as string | undefined,
      }
      res.end("ok")
    })
    await request(appFor(port, { forwardedProto: "https" }))
      .get("/p/acme/")
      .set("Host", "acme.desde.test")
      .set("X-Forwarded-Host", "attacker.example.com")
      .set("X-Forwarded-Proto", "gopher")
    expect(seen.fwdHost).toBe("acme.desde.test")
    expect(seen.fwdProto).toBe("https")
  })

  /**
   * Codex round 20, item 1. `host` used to be rewritten to the child's own
   * `127.0.0.1:<port>`, leaving `X-Forwarded-Host` as the only statement of
   * where the browser actually went. A server that does not read forwarding
   * headers then builds every request URL from that private address:
   * `@react-router/serve` runs Express without `trust proxy`, so its loaders
   * and actions saw `http://127.0.0.1:<port>/...` and every origin-based
   * redirect, absolute URL and secure-cookie decision was made against the
   * wrong origin.
   */
  it("forwards the browser's own Host to the child unchanged", async () => {
    let seen: string | undefined
    const port = await child((req, res) => {
      seen = req.headers.host
      res.end("ok")
    })
    await request(appFor(port)).get("/p/acme/").set("Host", "acme.desde.test")
    expect(seen).toBe("acme.desde.test")
  })

  /**
   * HTTP/1.1 requires a `Host`, so an empty one is not something a browser
   * produces (`node:http` refuses to send a request with no `Host` line at
   * all, which is why this one is written onto the socket by hand). It is
   * still worth pinning: an empty `Host` on the child's request would be
   * worse than none, so the header is left off entirely and `node:http`
   * addresses the child by the port it is dialling.
   */
  it("falls back to the child's own address when the request carried an empty Host", async () => {
    let seen: string | undefined
    const port = await child((req, res) => {
      seen = req.headers.host
      res.end("ok")
    })
    const proxy = appFor(port).listen(0, "127.0.0.1")
    servers.push(proxy)
    await new Promise<void>((r) => proxy.once("listening", () => r()))
    const proxyPort = (proxy.address() as AddressInfo).port
    await new Promise<void>((resolve, reject) => {
      const socket = connect(proxyPort, "127.0.0.1", () => {
        socket.write("GET /p/acme/ HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n")
      })
      socket.resume()
      socket.on("end", () => resolve())
      socket.on("error", reject)
    })
    expect(seen).toBe(`127.0.0.1:${port}`)
  })

  /**
   * The client does not get to name the client.
   *
   * `X-Forwarded-For`, `Forwarded` and `X-Real-IP` used to pass straight
   * through, so anyone who could reach a prototype origin could hand the
   * child any address they liked — and an app running with `trust proxy` on
   * (every Express template that expects to sit behind one) would believe it,
   * for rate limiting, geo, audit logs, allowlists. The viewer states the one
   * value it actually knows: `req.ip`, which Express resolves through
   * `VIEWER_TRUST_PROXY`.
   */
  it("replaces the client's own forwarding headers with the address the viewer sees", async () => {
    let seen: { forwardedFor?: string; forwarded?: string; realIp?: string } = {}
    const port = await child((req, res) => {
      seen = {
        forwardedFor: req.headers["x-forwarded-for"] as string | undefined,
        forwarded: req.headers["forwarded"] as string | undefined,
        realIp: req.headers["x-real-ip"] as string | undefined,
      }
      res.end("ok")
    })

    await request(appFor(port))
      .get("/p/acme/")
      .set("X-Forwarded-For", "1.2.3.4")
      .set("Forwarded", "for=1.2.3.4;proto=https")
      .set("X-Real-IP", "1.2.3.4")

    expect(seen.forwarded, "the client's Forwarded reached the child").toBeUndefined()
    expect(seen.realIp, "the client's X-Real-IP reached the child").toBeUndefined()
    expect(seen.forwardedFor, "the client chose its own X-Forwarded-For").not.toBe("1.2.3.4")
    // Supertest connects over loopback, so this is what the viewer sees.
    expect(seen.forwardedFor).toMatch(/127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/)
  })

  /**
   * Framing policy is the viewer's. A Next template that sets
   * `X-Frame-Options: DENY` would otherwise refuse to load in the review
   * iframe wherever the prototype CSP is off (`VIEWER_PROTOTYPE_CSP=off`),
   * where no `frame-ancestors` directive is there to supersede it.
   */
  it("drops every CORS grant the child sends, so a hostile page cannot read a private prototype (codex round 27)", async () => {
    const port = await child((req, res) => {
      res.setHeader("access-control-allow-origin", req.headers.origin ?? "*")
      res.setHeader("access-control-allow-credentials", "true")
      res.setHeader("access-control-expose-headers", "x-secret")
      res.setHeader("x-kept", "1")
      res.end("private")
    })
    const res = await request(appFor(port)).get("/p/acme/").set("Origin", "https://evil.example")
    expect(res.headers["access-control-allow-origin"]).toBeUndefined()
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined()
    expect(res.headers["access-control-expose-headers"]).toBeUndefined()
    expect(res.headers["x-kept"]).toBe("1")
  })

  it("strips the fixed hop-by-hop response headers even when Connection does not name them (codex round 26)", async () => {
    const port = await child((_req, res) => {
      res.setHeader("trailer", "x-checksum")
      res.setHeader("upgrade", "h2c")
      res.setHeader("proxy-authenticate", "Basic")
      res.setHeader("x-kept", "1")
      res.end("x")
    })
    const res = await request(appFor(port)).get("/p/acme/")
    expect(res.headers.trailer).toBeUndefined()
    expect(res.headers.upgrade).toBeUndefined()
    expect(res.headers["proxy-authenticate"]).toBeUndefined()
    expect(res.headers["x-kept"]).toBe("1")
  })

  it("strips the headers a Connection header nominates, in both directions (codex round 24)", async () => {
    let seen: Record<string, unknown> = {}
    const port = await child((req, res) => {
      seen = { ...req.headers }
      res.setHeader("connection", "bar")
      res.setHeader("bar", "1")
      res.setHeader("x-kept", "1")
      res.end("x")
    })
    const res = await request(appFor(port)).get("/p/acme/").set("Connection", "foo").set("foo", "1").set("x-also-kept", "1")
    expect(seen.foo).toBeUndefined()
    expect(seen["x-also-kept"]).toBe("1")
    expect(res.headers.bar).toBeUndefined()
    expect(res.headers["x-kept"]).toBe("1")
  })

  it("drops the child's Clear-Site-Data, which would clear the shell's cookies on a shared domain", async () => {
    const port = await child((_req, res) => {
      res.setHeader("clear-site-data", '"cookies", "storage"')
      res.end("x")
    })
    const res = await request(appFor(port)).get("/p/acme/")
    expect(res.status).toBe(200)
    expect(res.headers["clear-site-data"]).toBeUndefined()
  })

  it("streams a 206 HTML slice through untouched, with its Content-Range", async () => {
    const port = await child((_req, res) => {
      res.statusCode = 206
      res.setHeader("content-type", "text/html")
      res.setHeader("content-range", "bytes 0-4/100")
      res.end("<html")
    })
    const res = await request(appFor(port)).get("/p/acme/")
    expect(res.status).toBe(206)
    expect(res.headers["content-range"]).toBe("bytes 0-4/100")
    expect(res.text).toBe("<html")
  })

  it("drops the child's X-Frame-Options", async () => {
    const port = await child((_req, res) => {
      res.setHeader("x-frame-options", "DENY")
      res.setHeader("content-type", "text/html; charset=utf-8")
      res.end("<html><body>Hi</body></html>")
    })
    const res = await request(appFor(port)).get("/p/acme/")
    expect(res.headers["x-frame-options"]).toBeUndefined()
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
   * Codex round 17. In subdomain mode the shell and every prototype are
   * same-site on purpose, so a child cookie carrying `Domain=example.com`
   * would reach the shell and every sibling prototype. Child cookies are
   * host-only: the attribute is stripped, whatever its case or position.
   */
  it("strips a Domain attribute from a child cookie so it stays host-only", async () => {
    const port = await child((_req, res) => {
      res.setHeader("set-cookie", [
        "a=1; Domain=example.com; Path=/",
        "b=2; Path=/; domain=.example.com; HttpOnly",
        // Whitespace around the `=` is legal and a browser trims it (codex round 18).
        "c=3; Domain = example.com; Path=/",
      ])
      res.end("x")
    })
    const res = await request(appFor(port)).get("/p/acme/")
    expect(res.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/; HttpOnly", "c=3; Path=/"])
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

  /**
   * Codex round 3, item 2. `opts.setCookie` is only present on the first
   * response after a `?~c=` capability grant — every later response on that
   * origin proxies with no `setCookie` at all. The old merge only dropped a
   * same-named child cookie when `ours` was defined, so on every one of
   * those later responses a child `Set-Cookie: dsv_cap=…` (or
   * `__Host-dsv_cap=…`) passed straight through and could replace or expire
   * the viewer's own read capability. The child's own, differently-named
   * cookies still pass through untouched either way.
   */
  it("drops a child's own capability cookie even when the viewer is not setting one", async () => {
    const port = await child((_req, res) => {
      res.setHeader("set-cookie", ["__Host-dsv_cap=evil; Path=/; Secure", "other=1"])
      res.end("x")
    })
    const res = await request(appFor(port)).get("/p/acme/")
    expect(res.headers["set-cookie"]).toEqual(["other=1"])
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

  /**
   * Codex round 11, Fix 4. The general header filter drops `Content-Length`
   * from every response (`DROP_RESPONSE`) so it can be recomputed for a
   * rewritten HTML body. The `bodiless` branch (HEAD, 204, 304) never sends
   * a body to recompute a length FROM, so it never restored the upstream
   * value either — but a HEAD answer legitimately carries the length of the
   * GET representation, and clients use it. A 204 is the opposite case: it
   * must never carry a Content-Length at all, so an upstream one is dropped
   * there even though it IS restored for HEAD and 304.
   */
  describe("Content-Length on a bodiless response", () => {
    it("restores the upstream Content-Length on a HEAD response, with an empty body", async () => {
      const port = await child((_req, res) => {
        res.setHeader("content-type", "text/html; charset=utf-8")
        res.setHeader("content-length", "1234")
        res.end()
      })
      const res = await request(appFor(port)).head("/p/acme/")
      expect(res.status).toBe(200)
      expect(res.headers["content-length"]).toBe("1234")
      // A HEAD response carries no body at all — supertest leaves `res.text`
      // `undefined` rather than `""` here, unlike a GET with an empty body.
      expect(res.text).toBeFalsy()
    })

    it("restores the upstream Content-Length on a 304", async () => {
      const port = await child((_req, res) => {
        res.statusCode = 304
        res.setHeader("content-length", "1234")
        res.end()
      })
      const res = await request(appFor(port)).get("/p/acme/")
      expect(res.status).toBe(304)
      expect(res.headers["content-length"]).toBe("1234")
      expect(res.text).toBe("")
    })

    it("drops an upstream Content-Length on a 204", async () => {
      const port = await child((_req, res) => {
        res.statusCode = 204
        res.setHeader("content-length", "1234")
        res.end()
      })
      const res = await request(appFor(port)).get("/p/acme/")
      expect(res.status).toBe(204)
      expect(res.headers["content-length"]).toBeUndefined()
      expect(res.text).toBe("")
    })
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

  /**
   * Codex round 7, Fix 1. The non-rewrite branch called `up.pipe(res)` and
   * returned before `up.on("error", …)` was attached — that listener only
   * existed on the rewrite path, further down. `pipe()` does not forward
   * errors, so a child that starts a non-HTML response and then resets the
   * connection mid-stream emitted `error` on `up` with no listener at all,
   * which Node turns into an uncaught exception that ends the whole Viewer
   * process. The fix attaches the error listener as the first thing in the
   * response callback, before the rewrite/stream branch, so both paths have
   * it.
   */
  it("does not crash the process when a non-HTML upstream resets mid-response, and destroys the client response", async () => {
    const port = await child((_req, res) => {
      res.setHeader("content-type", "application/octet-stream")
      res.write("partial")
      // A mid-response reset, not a graceful end — the shape that used to
      // reach `up` as an unhandled "error" event.
      setImmediate(() => res.socket?.destroy())
    })
    let uncaught: unknown
    const onUncaught = (error: unknown): void => {
      uncaught = error
    }
    process.once("uncaughtException", onUncaught)
    try {
      // The reset means the client side never sees a clean response either —
      // it is the OTHER half of "the client response is destroyed".
      await expect(request(appFor(port)).get("/p/acme/data.bin")).rejects.toThrow()
    } finally {
      process.removeListener("uncaughtException", onUncaught)
    }
    // A tick for anything that WOULD have crashed the process to have done so.
    await new Promise((r) => setTimeout(r, 20))
    expect(uncaught).toBeUndefined()
  })

  /**
   * Codex round 7, Fix 2. `timeout` on `httpRequest` is a socket inactivity
   * timeout for the WHOLE exchange unless something clears it once headers
   * arrive — so a response merely quiet for a while (an SSE stream between
   * events) used to be destroyed by the same timer meant only to bound the
   * wait for headers. `upstreamTimeoutMs` is a test-only override of the
   * real 60s bound, so this can be proven without an actual 60s wait.
   */
  describe("the upstream timeout bounds only the wait for headers", () => {
    it("answers 502 within the timeout when the child never sends headers", async () => {
      const port = await child(() => {
        // Never responds at all.
      })
      const started = Date.now()
      const res = await request(appFor(port, { upstreamTimeoutMs: 100 })).get("/p/acme/")
      expect(res.status).toBe(502)
      expect(Date.now() - started).toBeLessThan(2000)
    })

    it("does not destroy a response that is quiet after its headers, past where the timeout would have fired", async () => {
      const port = await child((_req, res) => {
        res.setHeader("content-type", "text/event-stream")
        res.write("data: first\n\n")
        // The second chunk lands well after the (tiny, injected) timeout
        // would have fired had it still covered the body.
        setTimeout(() => {
          res.write("data: second\n\n")
          res.end()
        }, 300)
      })
      const res = await request(appFor(port, { upstreamTimeoutMs: 100 })).get("/p/acme/stream")
      expect(res.status).toBe(200)
      expect(res.text).toContain("data: first")
      expect(res.text).toContain("data: second")
    })
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

  /**
   * Live run, 2026-09-11. The review page remounts its frame while the
   * previous frame's request may still be waiting on a cold start. That
   * abort destroyed the upstream request before any headers came back, and
   * the error handler read it as "the child is unreachable": a healthy child
   * was killed and charged a restart. Our own abort says nothing about the
   * child, so it must not be reported.
   */
  it("does not report the child unreachable when the client aborts before it answered", async () => {
    let reported = false
    let sawClose!: () => void
    const childSawClose = new Promise<void>((r) => {
      sawClose = r
    })
    let arrived!: () => void
    const childSawRequest = new Promise<void>((r) => {
      arrived = r
    })
    const port = await child((req) => {
      // Never answers: the client gives up first. The child records the
      // abort reaching it, so the assertion below is not a timing guess.
      arrived()
      req.on("close", () => sawClose())
    })
    // A raw client, not supertest: the abort has to be a real socket
    // teardown the proxy's `res` sees as `close`, which superagent's
    // `abort()` does not reliably produce once `end()` has run.
    const proxy = appFor(port, {
      upstreamTimeoutMs: 5000,
      onUnreachable: () => {
        reported = true
      },
    }).listen(0, "127.0.0.1")
    servers.push(proxy)
    await new Promise<void>((r) => proxy.once("listening", () => r()))
    const proxyPort = (proxy.address() as AddressInfo).port
    const clientReq = nodeHttpRequest({ host: "127.0.0.1", port: proxyPort, path: "/p/acme/", method: "GET" })
    clientReq.on("error", () => {})
    clientReq.end()
    await childSawRequest
    clientReq.destroy()
    await childSawClose
    await new Promise((r) => setTimeout(r, 20))
    expect(reported).toBe(false)
  })

  it("carries the configured CSP on the 502 page too", async () => {
    const res = await request(unreachableApp({ csp: "default-src 'self'" })).get("/p/acme/")
    expect(res.status).toBe(502)
    expect(res.headers["content-security-policy"]).toBe("default-src 'self'")
  })

  /**
   * Task 4: `proxyToProcess` returns a promise that settles once `res`
   * closes, so a caller that holds a resource for the response's whole
   * lifetime (the serve router's process lease) can await it instead of
   * registering its own `res.once("close", ...)`. The child here holds its
   * body open on `bodyGate` so the test can observe the promise mid-response
   * — still pending after headers and a first chunk are through — before
   * letting the body finish and checking it settles.
   */
  it("stays pending while the upstream is mid-body, and settles once the response closes", async () => {
    const bodyGate = deferred<void>()
    const port = await child((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.write("start")
      void bodyGate.promise.then(() => res.end("end"))
    })

    let settled = false
    // desde-allow-own-server: this test drives a raw node:http client so it
    // can observe the response mid-body, before supertest would ever hand
    // control back — see the comment on the client below.
    const app = express()
    app.use("/p/acme", (req, res) => {
      void proxyToProcess(req, res, {
        port,
        path: req.url,
        shellOrigin: "http://localhost:3100",
        forwardedProto: "http",
        bridgeSrc: "/__desde/bridge-test.js",
        csp: null,
      }).then(() => {
        settled = true
      })
    })

    // A real listening server and a raw node:http client, not supertest —
    // supertest's request only resolves once the WHOLE response has been
    // read, which is exactly the moment this test needs to look past (the
    // mid-body window) before it happens.
    const server = createServer(app)
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
    const serverPort = (server.address() as AddressInfo).port

    let firstChunkSeen = false
    const completion = new Promise<void>((resolve) => {
      const clientReq = nodeHttpRequest({ host: "127.0.0.1", port: serverPort, path: "/p/acme/x", method: "GET" }, (up) => {
        up.on("data", () => {
          firstChunkSeen = true
        })
        up.on("end", () => resolve())
      })
      clientReq.end()
    })

    await vi.waitFor(() => expect(firstChunkSeen).toBe(true))
    // Headers and the first chunk are through, but the child is still
    // holding the body open — the promise must not have settled yet.
    expect(settled).toBe(false)

    bodyGate.resolve()
    await completion
    await vi.waitFor(() => expect(settled).toBe(true))
  })
})
