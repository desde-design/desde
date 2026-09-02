import { readFileSync, statSync } from "node:fs"
import {
  Agent,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http"
import type { Socket } from "node:net"
import type { Duplex } from "node:stream"
import { readBridgeVersion } from "../plugins/bridge-plugin.js"
import { checkHost, listenOriginFor } from "../server/host-guard.js"
import type { PrototypeServerHandle } from "../hosts/handle.js"
import {
  buildBridgeTags,
  isBridgeScriptPath,
  VENDOR_HTML2CANVAS_PATH,
} from "./bridge-tags.js"
import { createHtmlInjector } from "./inject-stream.js"

/**
 * The attach-mode proxy: a listener in front of a dev server the Editor does
 * **not** own (Next.js, or any framework whose HTML the Vite supervisor cannot
 * produce). The browser loads the prototype from here; every byte comes from
 * upstream except the two files named below.
 *
 * Four behaviours, each because a measurement demanded it
 * (`tasks/attach-mode.md` § "The proxy"):
 *
 * 1. **Streaming injection** (`inject-stream.ts`) — buffering cost 27x TTFB.
 * 2. **Host preservation** — rewriting `Host` to upstream 500'd every Next
 *    Server Action. See {@link forwardHeaders}.
 * 3. **Websocket upgrade tunnelling**, guarded by `checkHost` in the upgrade
 *    handler, because Node's `'upgrade'` event never reaches the request
 *    listener and so inherits nothing from the guard there.
 * 4. **Exactly two local files**, then forward. Anything else Editor-controlled
 *    stays on the shell origin: `checkAuth` compares against a single
 *    `shellOrigin` string, so putting a control surface on the proxy origin
 *    would mean trusting that origin too.
 *
 * Plus one refusal upstream cannot make for us: `/.desde/**`. We do not
 * control the foreign server's `fs.deny`, and for a root-serving upstream
 * (Vite, webpack-dev-server) that directory holds chat transcripts and config.
 */
export interface AttachProxyOptions {
  /** The user's already-running dev server, e.g. `http://127.0.0.1:3000`. */
  upstreamUrl: string
  /** Bind host for the proxy listener. */
  host: string
  /** Bind port. `0` lets the OS pick; the handle reports the real one. */
  port: number
  /** Absolute path to the built bridge bundle. */
  bridgeBundlePath: string
  /** Absolute path to `html2canvas.min.js`. */
  html2canvasPath: string
  /** Origin the shell posts from. Rides on `data-shell-origin`. */
  shellOrigin: string
  /**
   * Tear-down for an upstream the CALLER owns, awaited after this proxy has
   * stopped accepting.
   *
   * Attach mode never passes it: the upstream is the user's own process and we
   * do not get to stop something we did not start. An in-process fronted host
   * (React Router, Astro, Nuxt, Next) is the opposite case — it booted the
   * upstream, and the two listeners have to die together or a refused boot
   * leaves a dev server running on a loopback port nobody is pointing at.
   *
   * Ordering is deliberate: front door first, upstream second. Closing the
   * upstream while the proxy still accepts would answer in-flight requests with
   * a 502 instead of a closed connection.
   */
  onClose?: () => Promise<void>
}

/** Headers that describe THIS hop and must not be forwarded to the next one. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
])

/** Statuses defined to carry no body, whatever headers say. */
const BODILESS_STATUSES = new Set([204, 205, 304])

export async function startAttachProxy(
  opts: AttachProxyOptions,
): Promise<PrototypeServerHandle> {
  // `async` so a bad upstream URL or an unreadable bridge bundle REJECTS
  // rather than throwing synchronously out of a call the caller is awaiting.
  const upstream = parseUpstream(opts.upstreamUrl)
  const bridge = createBundleCache(opts.bridgeBundlePath)
  const html2canvas = createFileCache(opts.html2canvasPath)

  // Seeded with the requested address, corrected below from what `listen`
  // actually bound: `port: 0` binds an OS-picked port and the two disagree.
  // Read per request from inside the handler closures, so the correction lands
  // before any request can arrive.
  let listenOrigin = listenOriginFor(opts.host, opts.port)

  /** Upgraded sockets, so `close()` can tear down live websockets. */
  const tunnels = new Set<Duplex>()

  // Our own pool rather than `http.globalAgent`, so `close()` can drop every
  // keep-alive socket we hold open against the user's dev server instead of
  // leaving them to an idle timeout.
  const agent = new Agent({ keepAlive: true })

  const server = createServer((req, res) => {
    try {
      handleRequest(req, res, {
        upstream,
        bridge,
        html2canvas,
        agent,
        shellOrigin: opts.shellOrigin,
        listenOrigin,
      })
    } catch (err) {
      console.error("[editor-cli] attach proxy request error:", err)
      if (!res.headersSent) {
        res.statusCode = 500
        res.end("attach proxy error")
      } else {
        res.destroy()
      }
    }
  })

  // Nagle would coalesce the first small chunk of a streamed document with the
  // next one, which is the exact property this proxy exists to preserve.
  server.on("connection", (socket) => socket.setNoDelay(true))

  server.on("upgrade", (req, socket, head) => {
    tunnels.add(socket)
    socket.once("close", () => tunnels.delete(socket))
    handleUpgrade(req, socket, head, { upstream, listenOrigin })
  })

  return new Promise<PrototypeServerHandle>((resolve, reject) => {
    server.once("error", reject)
    server.listen(opts.port, opts.host, () => {
      server.removeListener("error", reject)
      const addr = server.address()
      const boundPort =
        addr && typeof addr === "object" ? addr.port : opts.port
      listenOrigin = listenOriginFor(opts.host, boundPort)
      resolve({
        url: listenOrigin,
        // The proxy mirrors upstream's own path space one-to-one, so the
        // prototype's base is upstream's base. We cannot read a foreign
        // server's configured base without probing it, so: root.
        base: "/",
        close: async () => {
          for (const socket of tunnels) socket.destroy()
          tunnels.clear()
          agent.destroy()
          server.closeAllConnections()
          try {
            await new Promise<void>((done, fail) => {
              server.close((err) => (err ? fail(err) : done()))
            })
          } finally {
            // `finally`, so a front door that failed to close still takes the
            // upstream with it. The alternative leaks the dev server we booted.
            await opts.onClose?.()
          }
        },
      })
    })
  })
}

interface ProxyContext {
  upstream: UpstreamTarget
  bridge: BundleCache
  html2canvas: FileCache
  agent: Agent
  shellOrigin: string
  listenOrigin: string
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ProxyContext,
): void {
  // DNS-rebinding guard, same yardstick as the CLI's own listeners. A third
  // listener gets this from nowhere; it has to be called. See `host-guard.ts`.
  const hostCheck = checkHost(req, ctx.listenOrigin)
  if (!hostCheck.ok) {
    sendText(res, hostCheck.status, hostCheck.reason)
    return
  }

  const pathname = readPathname(req.url)
  if (pathname === null || isRefusedPath(pathname)) {
    // The upstream cannot be relied on to refuse this: a root-serving dev
    // server would happily hand over `.desde/chat-sessions/*.json`.
    sendText(res, 403, "Refused by the Desde attach proxy")
    return
  }

  if (isBridgeScriptPath(pathname)) {
    serveScript(req, res, ctx.bridge.read(), "no-store")
    return
  }

  if (pathname === VENDOR_HTML2CANVAS_PATH) {
    const body = ctx.html2canvas.read()
    // Unreadable/missing: fall through to upstream rather than serving a
    // broken script, exactly as `bridgePlugin` calls `next()`.
    if (body !== null) {
      serveScript(req, res, body, "public, max-age=86400")
      return
    }
  }

  forwardRequest(req, res, ctx)
}

function forwardRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ProxyContext,
): void {
  const proxyReq = httpRequest({
    hostname: ctx.upstream.hostname,
    port: ctx.upstream.port,
    method: req.method,
    path: req.url,
    headers: forwardHeaders(req, { stripAcceptEncoding: true }),
    agent: ctx.agent,
  })

  proxyReq.on("socket", (socket) => socket.setNoDelay(true))

  proxyReq.on("response", (proxyRes) => {
    const headers = stripHopByHop(proxyRes.headers)
    const status = proxyRes.statusCode ?? 502

    if (shouldInject(req, status, proxyRes.headers)) {
      // The body grows by the injection, and the injector emits chunk-by-chunk:
      // both make a forwarded `content-length` a lie. Dropping it puts the
      // response on chunked transfer-encoding, which is what streaming needs.
      delete headers["content-length"]
      res.writeHead(status, headers)
      // Headers are what a TTFB measurement sees. Send them now instead of
      // waiting for the first body chunk.
      res.flushHeaders()
      const injector = createHtmlInjector(
        buildBridgeTags(ctx.shellOrigin, ctx.bridge.version()),
      )
      injector.on("error", () => res.destroy())
      proxyRes.pipe(injector).pipe(res)
      return
    }

    res.writeHead(status, headers)
    proxyRes.pipe(res)
  })

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      sendText(res, 502, `Attach proxy could not reach ${ctx.upstream.origin}: ${err.message}`)
    } else {
      res.destroy()
    }
  })

  // A client that hangs up mid-flight must not leave the upstream request
  // open. `close` also fires on a clean finish, where destroying would throw
  // away a reusable keep-alive socket for nothing.
  res.on("close", () => {
    if (!res.writableEnded) proxyReq.destroy()
  })

  req.pipe(proxyReq)
}

/**
 * Only `text/html` is rewritten.
 *
 * MEASURED: RSC payloads and fetch-lane Server Actions are `text/x-component`,
 * so a content-type test does not capture them. It does capture the no-JS
 * progressive-enhancement form POST, which is genuinely `text/html` and
 * genuinely wants the bridge.
 *
 * Two further gates. A `content-encoding` other than identity means the bytes
 * are not the HTML we would be searching (we strip `accept-encoding` on the way
 * out, so this should not arise; if it does, pass through untouched rather than
 * corrupt the body). And a `HEAD` or a bodiless status has no body to inject
 * into, so injecting would desynchronise the framing.
 */
function shouldInject(
  req: IncomingMessage,
  status: number,
  headers: IncomingHttpHeaders,
): boolean {
  if (req.method === "HEAD") return false
  if (BODILESS_STATUSES.has(status)) return false
  const encoding = headerValue(headers["content-encoding"])
  if (encoding && encoding.toLowerCase() !== "identity") return false
  const type = headerValue(headers["content-type"])
  if (!type) return false
  return type.toLowerCase().trimStart().startsWith("text/html")
}

/**
 * Headers for the upstream request.
 *
 * **`Host` is passed through verbatim** — the single most consequential line in
 * this file. MEASURED: rewriting it to the upstream's own host made *every*
 * Next Server Action abort with "`x-forwarded-host` … does not match `origin`",
 * because the browser's `Origin` is the proxy and Next compares the two.
 * Preserving the client's `Host` and setting `x-forwarded-host` to match fixes
 * them with no user config change. It also stops us laundering away the
 * upstream's own DNS-rebinding guard, which only ever sees the `Host` we send.
 *
 * `accept-encoding` is dropped on the HTML lane's behalf: a gzipped response is
 * not searchable for `</head>`, and negotiating that per-request is impossible
 * before we know the content type. The cost is compression on a loopback hop.
 *
 * **`x-forwarded-proto` is deliberately NOT set, and that is a fix.** It used to
 * be sent as `"http"` — factually true, and it broke a real app. MEASURED
 * against the reactrouter.com repo booted through this proxy: its
 * `ensureSecure` middleware (`app/modules/http-utils/ensure-secure.ts`) reads
 * the header and, on `"http"`, throws `redirect(secureUrl)` — so every document
 * request 302'd to `https://127.0.0.1:<proxy port>` and the browser's TLS
 * handshake died against our plaintext listener with
 * `ERR_SSL_WRONG_VERSION_NUMBER`. That app's own comment says the check
 * "indirectly allows `http://localhost` because there is no
 * `x-forwarded-proto` in the local server headers" — the header's ABSENCE is
 * what apps are written against in local dev, and manufacturing it turned a
 * working dev server into an unreachable one.
 *
 * Nothing needed it. `Host` / `x-forwarded-host` carry the measured Server-Action
 * requirement; a framework building an absolute URL falls back to the request's
 * own scheme, which is `http` either way. The proxy's job is to be invisible,
 * and a header the upstream would not otherwise see is not invisible.
 */
function forwardHeaders(
  req: IncomingMessage,
  opts: { stripAcceptEncoding: boolean },
): OutgoingHttpHeaders {
  const headers = stripHopByHop(req.headers)
  const clientHost = headerValue(req.headers.host)
  if (clientHost) {
    headers.host = clientHost
    headers["x-forwarded-host"] = clientHost
  }
  const priorFor = headerValue(req.headers["x-forwarded-for"])
  const remote = req.socket.remoteAddress
  if (remote) {
    headers["x-forwarded-for"] = priorFor ? `${priorFor}, ${remote}` : remote
  }
  if (opts.stripAcceptEncoding) delete headers["accept-encoding"]
  return headers
}

/**
 * Tunnel a websocket (or any other) upgrade to upstream.
 *
 * **Every gate `handleRequest` applies has to be repeated here, by hand.** Node
 * dispatches `'upgrade'` on the server and never through the request listener,
 * so this path inherits nothing: not `checkHost`, and not the `/.desde`
 * refusal. Missing the second one was a real hole — MEASURED, an upgrade to
 * `/.desde/chat-sessions/x.json` reached the upstream, and what a foreign
 * dev server chooses to do with it is precisely the thing we cannot decide,
 * since we do not control its `fs.deny`. HMR is a websocket, so this is the
 * live path, not a corner.
 */
function handleUpgrade(
  req: IncomingMessage,
  duplex: Duplex,
  head: Buffer,
  ctx: { upstream: UpstreamTarget; listenOrigin: string },
): void {
  const hostCheck = checkHost(req, ctx.listenOrigin)
  if (!hostCheck.ok) {
    refuseUpgrade(duplex, hostCheck.status, hostCheck.reason)
    return
  }

  // Same decoding as the request lane, so a percent-encoded `%2E desde`
  // cannot walk past a refusal that only the raw form would catch.
  const pathname = readPathname(req.url)
  if (pathname === null || isRefusedPath(pathname)) {
    refuseUpgrade(duplex, 403, "Refused by the Desde attach proxy")
    return
  }

  // Node types the `'upgrade'` socket as a bare `Duplex`; it is always a
  // `net.Socket`, and the two tunings below only exist there. A long-lived
  // websocket must not be closed by an idle timeout, and HMR frames are small
  // enough for Nagle to delay them visibly.
  const socket = duplex as Socket
  socket.setTimeout(0)
  socket.setNoDelay(true)
  // Bytes already read past the request head belong to the client -> upstream
  // direction; put them back so the pipe below carries them.
  if (head.length > 0) socket.unshift(head)

  const proxyReq = httpRequest({
    hostname: ctx.upstream.hostname,
    port: ctx.upstream.port,
    method: req.method,
    path: req.url,
    // `connection` / `upgrade` are hop-by-hop in general but ARE the handshake
    // here, so they are re-added after the strip.
    headers: {
      ...forwardHeaders(req, { stripAcceptEncoding: false }),
      connection: "Upgrade",
      upgrade: headerValue(req.headers.upgrade) ?? "websocket",
    },
    // A dedicated socket, not one from the keep-alive pool: this connection is
    // about to be taken over wholesale and must never be handed back.
    agent: false,
  })

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    proxySocket.setTimeout(0)
    proxySocket.setNoDelay(true)
    // Either half dying takes the other with it. `pipe` does not propagate a
    // destroy, so without this pair a closed browser tab would strand the
    // socket held against the user's dev server.
    proxySocket.on("error", () => socket.destroy())
    socket.on("error", () => proxySocket.destroy())
    proxySocket.on("close", () => socket.destroy())
    socket.on("close", () => proxySocket.destroy())
    if (proxyHead.length > 0) proxySocket.unshift(proxyHead)
    socket.write(statusLine(proxyRes.statusCode, proxyRes.statusMessage, proxyRes.headers))
    proxySocket.pipe(socket)
    socket.pipe(proxySocket)
  })

  // Upstream declined the upgrade: relay its plain response and hang up.
  proxyReq.on("response", (proxyRes) => {
    socket.write(
      statusLine(proxyRes.statusCode, proxyRes.statusMessage, stripHopByHop(proxyRes.headers)),
    )
    proxyRes.pipe(socket)
  })

  proxyReq.on("error", () => socket.destroy())
  proxyReq.end()
}

/**
 * Refuse an upgrade: a bare status line, then tear the socket down.
 *
 * There is no `ServerResponse` on this path — Node hands the `'upgrade'` event
 * a raw socket — so `sendText` cannot be reused and a response body would have
 * to be framed by hand. It is not worth it: the client here is a websocket
 * client, which reads the status line and discards anything after it. The
 * reason travels as the status line's reason-phrase (sanitised: a CR or LF in
 * it would be response splitting) so `curl`/`nc` still show why.
 *
 * `write` then `destroy` rather than `end`: `end` half-closes and leaves the
 * socket waiting on the peer's FIN, which a refused client has no obligation to
 * send. The status line is small enough to reach the kernel buffer
 * synchronously — asserted by the upgrade tests, which read the 403 back.
 */
function refuseUpgrade(duplex: Duplex, status: number, reason: string): void {
  const phrase = reason.replace(/[\r\n]+/g, " ").trim() || "Forbidden"
  duplex.write(`HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\n\r\n`)
  duplex.destroy()
}

/** Raw HTTP status line + headers, for a socket we are writing by hand. */
function statusLine(
  status: number | undefined,
  message: string | undefined,
  headers: IncomingHttpHeaders | OutgoingHttpHeaders,
): string {
  const lines = [`HTTP/1.1 ${status ?? 502} ${message ?? ""}`.trimEnd()]
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`)
    } else {
      lines.push(`${name}: ${value}`)
    }
  }
  return `${lines.join("\r\n")}\r\n\r\n`
}

function serveScript(
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  cacheControl: string,
): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405
    res.setHeader("Allow", "GET, HEAD")
    res.end()
    return
  }
  res.setHeader("Content-Type", "application/javascript; charset=utf-8")
  res.setHeader("Cache-Control", cacheControl)
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin")
  if (req.method === "HEAD") {
    res.end()
    return
  }
  res.end(body)
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status
  res.setHeader("Content-Type", "text/plain; charset=utf-8")
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.end(body)
}

/**
 * `pathname` for a proxied request, percent-decoded, or `null` when the URL is
 * unparseable. A `null` is treated as a refusal by the caller: an allowlist is
 * only worth having if the unrecognised shape loses.
 */
export function readPathname(rawUrl: string | undefined): string | null {
  try {
    const url = new URL(rawUrl ?? "/", "http://attach-proxy.invalid")
    return decodeURIComponent(url.pathname)
  } catch {
    return null
  }
}

/**
 * True for anything under `.desde/`, at any depth.
 *
 * Segment-wise (not `includes(".desde")`) so a legitimate
 * `/my.desde-notes.txt` is not caught, and case-insensitive because the
 * dev machine's filesystem usually is.
 */
export function isRefusedPath(pathname: string): boolean {
  return pathname
    .split("/")
    .some((segment) => segment.toLowerCase() === ".desde")
}

function stripHopByHop(
  headers: IncomingHttpHeaders,
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  // `Connection: x, y` nominates further headers as hop-by-hop.
  const nominated = new Set(
    (headerValue(headers.connection) ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower) || nominated.has(lower)) continue
    if (value === undefined) continue
    out[name] = value
  }
  return out
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

interface UpstreamTarget {
  hostname: string
  port: number
  origin: string
}

function parseUpstream(raw: string): UpstreamTarget {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Attach proxy: "${raw}" is not a valid URL.`)
  }
  if (url.protocol !== "http:") {
    // An https upstream needs `node:https` plus a decision about self-signed
    // dev certs. Refusing loudly beats a silent TLS policy nobody reviewed.
    throw new Error(
      `Attach proxy: only http:// upstreams are supported, got "${url.protocol}//".`,
    )
  }
  return {
    hostname: url.hostname,
    port: url.port ? Number(url.port) : 80,
    origin: url.origin,
  }
}

interface FileCache {
  /** File contents, or `null` when missing/unreadable. */
  read(): string | null
}

interface BundleCache {
  read(): string
  version(): string
}

/**
 * The bridge bundle, re-read when it changes on disk.
 *
 * `bridgePlugin` watches the file and pushes a Vite full-reload; attach mode
 * has no such channel, so the cheaper equivalent is to stat on each bridge
 * request (one per page load) and re-read on a size/mtime change. A rebuild
 * then reaches the running prototype on the user's next reload instead of
 * requiring an Editor restart.
 */
function createBundleCache(path: string): BundleCache {
  let content = readFileSync(path, "utf-8")
  let version = readBridgeVersion(path)
  let stamp = fileStamp(path)

  const refresh = (): void => {
    const next = fileStamp(path)
    if (next === stamp) return
    try {
      content = readFileSync(path, "utf-8")
      version = readBridgeVersion(path)
      stamp = next
    } catch {
      // Raced with an atomic rewrite, or the file went away. Keep last-good;
      // the next request re-checks.
    }
  }

  return {
    read: () => {
      refresh()
      return content
    },
    version: () => {
      refresh()
      return version
    },
  }
}

function createFileCache(path: string): FileCache {
  let content: string | null | undefined
  return {
    read: () => {
      if (content === undefined) {
        try {
          content = readFileSync(path, "utf-8")
        } catch {
          content = null
        }
      }
      return content
    },
  }
}

function fileStamp(path: string): string {
  try {
    const st = statSync(path)
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return "missing"
  }
}
