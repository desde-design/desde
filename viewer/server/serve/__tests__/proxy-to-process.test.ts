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
import request from "supertest"
import { afterEach, describe, expect, it } from "vitest"
import { proxyToProcess } from "../proxy-to-process"

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
function appFor(port: number, extra: { csp?: string | null } = {}) {
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
      csp: extra.csp === undefined ? "default-src 'self'" : extra.csp,
    }),
  )
  return app
}

describe("proxyToProcess", () => {
  it("forwards the path minus the prefix, and strips the cookie header", async () => {
    let seen: { url?: string; cookie?: string } = {}
    const port = await child((req, res) => {
      seen = { url: req.url, cookie: req.headers.cookie }
      res.setHeader("content-type", "text/plain")
      res.end("ok")
    })
    const res = await request(appFor(port)).get("/p/acme/dashboard?x=1").set("Cookie", "viewer_session=secret")
    expect(res.status).toBe(200)
    expect(res.text).toBe("ok")
    expect(seen.url).toBe("/dashboard?x=1")
    expect(seen.cookie).toBeUndefined()
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

  it("passes set-cookie through", async () => {
    const port = await child((_req, res) => {
      res.setHeader("set-cookie", "proto=1; Path=/")
      res.end("x")
    })
    const res = await request(appFor(port)).get("/p/acme/")
    expect(res.headers["set-cookie"]).toEqual(["proto=1; Path=/"])
  })

  it("answers 502 with an HTML page and reports it when the child is unreachable", async () => {
    let reported = false
    // desde-allow-own-server: same reason as appFor above — the app under
    // test proxies to a port, and this test's port (1) is deliberately
    // nothing.
    const app = express()
    app.use("/p/acme", (req, res) =>
      proxyToProcess(req, res, {
        port: 1, // nothing listens here
        path: req.url,
        shellOrigin: "http://localhost:3100",
        bridgeSrc: "/__desde/bridge-test.js",
        csp: null,
        onUnreachable: () => {
          reported = true
        },
      }),
    )
    const res = await request(app).get("/p/acme/")
    expect(res.status).toBe(502)
    expect(res.headers["content-type"]).toMatch(/text\/html/)
    expect(res.text).toContain("not answering")
    expect(reported).toBe(true)
  })
})
