import { mkdtemp, rm, writeFile } from "node:fs/promises"
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http"
import type { Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { PrototypeServerHandle } from "../hosts/handle.js"
import { bridgeScriptPath } from "./bridge-tags"
import { isRefusedPath, readPathname, startAttachProxy } from "./proxy"

const FAKE_BUNDLE = 'window.__DESDE_BRIDGE_VERSION__="test-9";\n'
const FAKE_H2C = "/* html2canvas */\n"
const SHELL = "http://127.0.0.1:7499"

const HEAD_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head>'
const TAIL_HTML = '<body><div id="app">hi</div></body></html>'

/** Everything the fake upstream saw, so the proxy's forwarding can be asserted. */
interface SeenRequest {
  url: string
  method: string
  headers: IncomingHttpHeaders
}

let upstream: Server
let upstreamPort: number
const seen: SeenRequest[] = []
/**
 * Every connection the upstream has accepted. Used to prove the proxy releases
 * its upstream sockets on `close()` -- a leak there would pin file descriptors
 * against the user's own dev server.
 */
const openSockets = new Set<Socket>()
let proxy: PrototypeServerHandle
let proxyPort: number
let tmp: string

/**
 * A stand-in for the user's dev server. Deliberately NOT a real framework: the
 * behaviours under test (streaming, content types, Host echo, upgrade) are
 * framework-independent, and the framework-specific claims are verified live
 * against a real `next dev` instead.
 */
function startUpstream(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", method: req.method ?? "", headers: req.headers })
    const path = (req.url ?? "/").split("?")[0]

    if (path === "/rsc") {
      res.writeHead(200, { "content-type": "text/x-component" })
      res.end("0:[\"$\",\"div\",null,{}]\n")
      return
    }
    if (path === "/asset.js") {
      res.writeHead(200, { "content-type": "application/javascript" })
      res.end("export const a = 1\n")
      return
    }
    if (path === "/echo") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ host: req.headers.host, headers: req.headers }))
      return
    }
    if (path === "/action") {
      req.resume()
      // Stand-in for Next's Server Action CSRF check: 500 unless the forwarded
      // host matches the browser's Origin, which is exactly what rewriting
      // Host to upstream broke.
      const origin = req.headers.origin ?? ""
      const fwd = req.headers["x-forwarded-host"] ?? ""
      const ok = origin === `http://${fwd}`
      res.writeHead(ok ? 200 : 500, { "content-type": "text/plain" })
      res.end(ok ? "action ok" : `x-forwarded-host ${String(fwd)} != origin ${String(origin)}`)
      return
    }
    if (path === "/slow") {
      // A streamed document: head now, body after a delay. Buffering shows up
      // as TTFB == total.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      res.write(HEAD_HTML)
      setTimeout(() => res.end(TAIL_HTML), 300)
      return
    }
    if (path === "/nolandmark") {
      res.writeHead(200, { "content-type": "text/html" })
      res.end("<div>fragment</div>")
      return
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(HEAD_HTML + TAIL_HTML)
  })

  server.on("upgrade", (req, socket) => {
    seen.push({ url: req.url ?? "", method: "UPGRADE", headers: req.headers })
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    )
    socket.on("data", (d: Buffer) => socket.write(Buffer.concat([Buffer.from("echo:"), d])))
    // An upgraded socket on a bare `http.Server` has no half-open handling of
    // its own, so without this the fixture would hold a FIN'd socket forever
    // and `close()` below would look like a proxy leak. MEASURED: with it, the
    // proxy's socket count returns to baseline.
    socket.on("end", () => socket.end())
  })

  server.on("connection", (s) => {
    openSockets.add(s)
    s.on("close", () => openSockets.delete(s))
  })

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 })
    })
  })
}

interface Fetched {
  status: number
  headers: IncomingHttpHeaders
  body: string
  /** ms from request start to the first body byte. */
  firstByteMs: number
  /** Body as received in the first chunk, for streaming assertions. */
  firstChunk: string
}

function get(
  path: string,
  opts: { headers?: Record<string, string>; method?: string; body?: string } = {},
): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: proxyPort,
        path,
        method: opts.method ?? "GET",
        headers: opts.headers,
      },
      (res: IncomingMessage) => {
        const chunks: string[] = []
        let firstByteMs = -1
        res.setEncoding("utf-8")
        res.on("data", (c: string) => {
          if (firstByteMs < 0) firstByteMs = Date.now() - started
          chunks.push(c)
        })
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: chunks.join(""),
            firstByteMs,
            firstChunk: chunks[0] ?? "",
          }),
        )
      },
    )
    req.on("error", reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "attach-proxy-"))
  const bundlePath = join(tmp, "bridge-bundle.js")
  const h2cPath = join(tmp, "html2canvas.min.js")
  await writeFile(bundlePath, FAKE_BUNDLE)
  await writeFile(h2cPath, FAKE_H2C)

  const started = await startUpstream()
  upstream = started.server
  upstreamPort = started.port

  proxy = await startAttachProxy({
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    host: "127.0.0.1",
    // Port 0: parallel agents share this machine, and the Host guard is
    // checked against the port `listen` actually bound, so an OS-picked one
    // exercises the same code path a fixed one would.
    port: 0,
    bridgeBundlePath: bundlePath,
    html2canvasPath: h2cPath,
    shellOrigin: SHELL,
  })
  proxyPort = Number(new URL(proxy.url).port)
})

afterAll(async () => {
  await proxy.close()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  await rm(tmp, { recursive: true, force: true })
})

describe("startAttachProxy handle", () => {
  it("reports the bound origin and a root base, and nothing else", () => {
    expect(proxy.url).toBe(`http://127.0.0.1:${proxyPort}`)
    expect(proxy.base).toBe("/")
    // The WHOLE handle, asserted as a closed set rather than as one absent key.
    // `expect(proxy.vite).toBeUndefined()` used to live here and stopped being
    // expressible when the member was deleted from the type — but a key check
    // is the weaker assertion anyway: it says nothing about the NEXT dev-server
    // object someone hangs off this handle. Attach mode owns no dev server at
    // all, so three keys is the claim.
    expect(Object.keys(proxy).sort()).toEqual(["base", "close", "url"])
  })
})

describe("bridge injection", () => {
  it("injects both tags before </head> of an html response", async () => {
    const res = await get("/")
    expect(res.status).toBe(200)
    expect(res.body).toContain(`window.__DESDE_SHELL_ORIGIN__="${SHELL}"`)
    expect(res.body).toContain(`data-shell-origin="${SHELL}"`)
    expect(res.body).toContain(`src="${bridgeScriptPath("test-9")}"`)
    expect(res.body.indexOf("data-prototype-flow=\"bridge\"")).toBeLessThan(
      res.body.indexOf("</head>"),
    )
    // Body content is otherwise untouched.
    expect(res.body).toContain('<div id="app">hi</div>')
  })

  it("drops content-length so the grown body is framed correctly", async () => {
    const res = await get("/")
    expect(res.headers["content-length"]).toBeUndefined()
  })

  it("leaves text/x-component alone (RSC payloads and Server Actions)", async () => {
    const res = await get("/rsc")
    expect(res.body).toBe("0:[\"$\",\"div\",null,{}]\n")
    expect(res.body).not.toContain("prototype-flow")
  })

  it("leaves non-html assets alone", async () => {
    const res = await get("/asset.js")
    expect(res.body).toBe("export const a = 1\n")
  })

  it("appends at EOF when the document has no landmark", async () => {
    const res = await get("/nolandmark")
    expect(res.body.startsWith("<div>fragment</div>")).toBe(true)
    expect(res.body).toContain("data-prototype-flow=\"bridge\"")
  })

  it("does not inject into a HEAD response", async () => {
    const res = await get("/", { method: "HEAD" })
    expect(res.body).toBe("")
  })

  // The regression the streaming injector exists for: with buffering, the
  // first byte would arrive only after the upstream's 300ms tail.
  it("streams: the injected head arrives before the delayed body", async () => {
    const res = await get("/slow")
    expect(res.firstByteMs).toBeGreaterThanOrEqual(0)
    expect(res.firstByteMs).toBeLessThan(200)
    expect(res.firstChunk).toContain("data-prototype-flow=\"bridge\"")
    expect(res.body).toContain('<div id="app">hi</div>')
  })
})

describe("the two local files", () => {
  it("serves the bridge bundle at its version-stamped path", async () => {
    const res = await get(bridgeScriptPath("test-9"))
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toMatch(/application\/javascript/)
    expect(res.headers["x-content-type-options"]).toBe("nosniff")
    expect(res.body).toBe(FAKE_BUNDLE)
    expect(seen.some((r) => r.url.includes("__desde"))).toBe(false)
  })

  it("serves a stale versioned bridge path too, so a rebuild cannot 404", async () => {
    const res = await get(bridgeScriptPath("some-older-version"))
    expect(res.status).toBe(200)
    expect(res.body).toBe(FAKE_BUNDLE)
  })

  it("405s a write to the bridge path", async () => {
    const res = await get(bridgeScriptPath("test-9"), { method: "POST" })
    expect(res.status).toBe(405)
  })

  it("serves html2canvas where the bridge looks for it", async () => {
    const res = await get("/vendor/html2canvas.min.js")
    expect(res.status).toBe(200)
    expect(res.body).toBe(FAKE_H2C)
  })

  it("forwards everything else", async () => {
    const before = seen.length
    await get("/asset.js")
    expect(seen.length).toBe(before + 1)
    expect(seen[seen.length - 1]?.url).toBe("/asset.js")
  })
})

describe("/.desde refusal", () => {
  it("refuses, and does not forward, a .desde path", async () => {
    const before = seen.length
    const res = await get("/.desde/chat-sessions/x.json")
    expect(res.status).toBe(403)
    expect(seen.length).toBe(before)
  })

  it("refuses a percent-encoded .desde path", async () => {
    const res = await get("/%2Edesde/config.json")
    expect(res.status).toBe(403)
  })

  it("refuses it at any depth", () => {
    expect(isRefusedPath("/a/b/.desde/c")).toBe(true)
    expect(isRefusedPath("/.DESDE/c")).toBe(true)
    expect(isRefusedPath("/__desde/bridge-v1.js")).toBe(false)
    // A file whose NAME merely contains the string is not the directory.
    expect(isRefusedPath("/notes.desde.txt")).toBe(false)
  })

  it("treats an unparseable URL as a refusal", () => {
    expect(readPathname("http://[")).toBeNull()
    expect(readPathname("/%E0%A4%A")).toBeNull()
  })
})

describe("host handling", () => {
  it("forwards the CLIENT's Host verbatim and mirrors it to x-forwarded-host", async () => {
    const res = await get("/echo")
    const body = JSON.parse(res.body) as { host: string; headers: IncomingHttpHeaders }
    expect(body.host).toBe(`127.0.0.1:${proxyPort}`)
    expect(body.headers["x-forwarded-host"]).toBe(`127.0.0.1:${proxyPort}`)
    // NOT the upstream's own host: that rewrite is what 500'd Server Actions.
    expect(body.host).not.toBe(`127.0.0.1:${upstreamPort}`)
  })

  it("lets a Server-Action-style CSRF check pass", async () => {
    const res = await get("/action", {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${proxyPort}`, "content-type": "text/plain" },
      body: "x",
    })
    expect(res.status).toBe(200)
    expect(res.body).toBe("action ok")
  })

  it("does NOT manufacture x-forwarded-proto", async () => {
    // MEASURED on the reactrouter.com repo through this proxy: sending
    // `x-forwarded-proto: http` made its `ensureSecure` middleware 302 every
    // document to `https://127.0.0.1:<proxy port>`, and the browser's TLS
    // handshake then died against this plaintext listener
    // (ERR_SSL_WRONG_VERSION_NUMBER). Apps written for local dev key on the
    // header being ABSENT; the proxy must not be the thing that supplies it.
    const res = await get("/echo")
    const body = JSON.parse(res.body) as { headers: IncomingHttpHeaders }
    expect(body.headers["x-forwarded-proto"]).toBeUndefined()
  })

  it("passes a client's own x-forwarded-proto through untouched", async () => {
    // Not-setting is not the same as stripping: a request that genuinely
    // arrived through another proxy keeps what that proxy said.
    const res = await get("/echo", { headers: { "x-forwarded-proto": "https" } })
    const body = JSON.parse(res.body) as { headers: IncomingHttpHeaders }
    expect(body.headers["x-forwarded-proto"]).toBe("https")
  })

  it("strips accept-encoding so the html lane is never handed gzip", async () => {
    const res = await get("/echo", { headers: { "accept-encoding": "gzip, br" } })
    const body = JSON.parse(res.body) as { headers: IncomingHttpHeaders }
    expect(body.headers["accept-encoding"]).toBeUndefined()
  })

  it("403s a forged Host (DNS rebinding), before forwarding", async () => {
    const before = seen.length
    const res = await get("/", { headers: { host: "evil.test:1234" } })
    expect(res.status).toBe(403)
    expect(res.body).toContain("Invalid Host")
    expect(seen.length).toBe(before)
  })
})

describe("websocket upgrade", () => {
  function upgrade(
    headers: Record<string, string>,
    path = "/_next/webpack-hmr",
  ): Promise<{
    status: number
    echo: string
  }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: "127.0.0.1",
        port: proxyPort,
        path,
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          ...headers,
        },
      })
      req.on("upgrade", (res, socket: Socket, head: Buffer) => {
        let acc = head.toString()
        socket.on("data", (d: Buffer) => {
          acc += d.toString()
          if (acc.includes("echo:ping")) {
            socket.destroy()
            resolve({ status: res.statusCode ?? 0, echo: acc })
          }
        })
        socket.write("ping")
      })
      req.on("response", (res) => {
        res.resume()
        resolve({ status: res.statusCode ?? 0, echo: "" })
      })
      req.on("error", reject)
      req.end()
      setTimeout(() => reject(new Error("upgrade timed out")), 5000).unref()
    })
  }

  it("tunnels the handshake and both directions of frames", async () => {
    const result = await upgrade({})
    expect(result.status).toBe(101)
    expect(result.echo).toContain("echo:ping")
    expect(seen.some((r) => r.method === "UPGRADE")).toBe(true)
  })

  // Node dispatches `'upgrade'` on the server, never through the request
  // listener, so the guard there covers nothing here. HMR is a websocket, so
  // this is the live path and not a corner.
  it("applies the Host guard, which the request listener cannot do for it", async () => {
    const before = seen.filter((r) => r.method === "UPGRADE").length
    const result = await upgrade({ host: "evil.test:1234" })
    expect(result.status).toBe(403)
    expect(seen.filter((r) => r.method === "UPGRADE").length).toBe(before)
  })

  // The Host guard was repeated on this path from the start; the `/.desde`
  // refusal was not, so an upgrade request to `/.desde/chat-sessions/x`
  // was forwarded to a dev server we do not control the `fs.deny` of. Both
  // gates are per-path decisions and neither is inherited from `handleRequest`.
  it("refuses a .desde upgrade, and does not forward it", async () => {
    const before = seen.filter((r) => r.method === "UPGRADE").length
    const result = await upgrade({}, "/.desde/chat-sessions/secret.json")
    expect(result.status).toBe(403)
    expect(seen.filter((r) => r.method === "UPGRADE").length).toBe(before)
  })

  it("refuses a percent-encoded .desde upgrade too", async () => {
    // Decoding on this path has to match the request path's, or the raw form
    // is refused while the encoded one walks straight through.
    const before = seen.filter((r) => r.method === "UPGRADE").length
    const result = await upgrade({}, "/%2Edesde/config.json")
    expect(result.status).toBe(403)
    expect(seen.filter((r) => r.method === "UPGRADE").length).toBe(before)
  })
})

describe("close()", () => {
  it("releases the upstream sockets it holds, including a live tunnel", async () => {
    const baseline = openSockets.size
    const second = await startAttachProxy({
      upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
      host: "127.0.0.1",
      port: 0,
      bridgeBundlePath: join(tmp, "bridge-bundle.js"),
      html2canvasPath: join(tmp, "html2canvas.min.js"),
      shellOrigin: SHELL,
    })
    const port = Number(new URL(second.url).port)

    // A live websocket, left OPEN: closing the proxy has to tear it down from
    // this side, since the browser is not going to.
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({
        hostname: "127.0.0.1",
        port,
        path: "/hmr",
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      })
      req.on("upgrade", (_res, socket: Socket) => {
        socket.on("data", (d: Buffer) => {
          if (d.toString().includes("echo:")) resolve()
        })
        socket.on("error", () => {})
        socket.write("ping")
      })
      req.on("error", reject)
      req.end()
    })
    expect(openSockets.size).toBeGreaterThan(baseline)

    await second.close()
    for (let i = 0; i < 40 && openSockets.size > baseline; i += 1) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(openSockets.size).toBe(baseline)
  })
})

describe("upstream failure", () => {
  it("502s with a readable reason when the upstream is unreachable", async () => {
    const dead = await startAttachProxy({
      // Port 1 on loopback: nothing listens, and connecting is refused fast.
      upstreamUrl: "http://127.0.0.1:1",
      host: "127.0.0.1",
      port: 0,
      bridgeBundlePath: join(tmp, "bridge-bundle.js"),
      html2canvasPath: join(tmp, "html2canvas.min.js"),
      shellOrigin: SHELL,
    })
    const port = Number(new URL(dead.url).port)
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port, path: "/" }, (r) => {
        let body = ""
        r.setEncoding("utf-8")
        r.on("data", (c: string) => (body += c))
        r.on("end", () => resolve({ status: r.statusCode ?? 0, body }))
      })
      req.on("error", reject)
      req.end()
    })
    expect(res.status).toBe(502)
    expect(res.body).toContain("http://127.0.0.1:1")
    await dead.close()
  })

  it("refuses a non-http upstream loudly instead of guessing a TLS policy", async () => {
    await expect(
      startAttachProxy({
        upstreamUrl: "https://127.0.0.1:3000",
        host: "127.0.0.1",
        port: 0,
        bridgeBundlePath: join(tmp, "bridge-bundle.js"),
        html2canvasPath: join(tmp, "html2canvas.min.js"),
        shellOrigin: SHELL,
      }),
    ).rejects.toThrow(/only http:\/\/ upstreams/)
  })
})
