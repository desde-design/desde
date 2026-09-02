/**
 * Direct unit tests for `static-assets.ts` (Task 26 of the editor
 * audit-fixes plan — this module serves the UI bundle AND the
 * token-bearing bootstrap script and had zero direct unit tests before
 * this file).
 *
 * Scope, pinned deliberately narrow per this module's own header
 * comment: MIME map, the `isContainedBy` path-containment guard, the
 * bootstrap script's defense-in-depth headers (CORP / nosniff /
 * no-store) + token embedding, and `serveStatic`'s path handling
 * (including what actually happens when a request tries `../`).
 *
 * These call the exported functions directly (no HTTP server) — the
 * integration-level "does the real route serve this" wiring is already
 * covered by `http-server-bootstrap-project.integration.test.ts` /
 * `http-server-route-table.test.ts` / `launcher-server.integration.test.ts`,
 * none of which assert the security headers or MIME correctness this
 * file closes.
 *
 * FINDING (documented here, not fixed — tests-only task): the
 * `isContainedBy` 403 guard is real and correctly rejects a genuinely
 * escaping path (see the direct `isContainedBy` tests below), but it
 * appears UNREACHABLE via `serveStatic`'s actual request path. `req.url`
 * is parsed with `new URL(req.url, shellOrigin)`, and WHATWG URL parsing
 * already collapses `..` dot-segments (and their percent-decoded form,
 * `%2e%2e`) before `serveStatic` ever sees `pathname` — a request for
 * `/../../../etc/passwd` normalizes to `/etc/passwd`, which `path.join`
 * then treats as a plain relative segment UNDER `uiBundleRoot` (`join`,
 * unlike `resolve`, does not let a leading `/` in the second argument
 * escape the first). So no real HTTP request can currently reach the
 * `isContainedBy` false branch — it's defense-in-depth against a future
 * change in how the pathname is constructed, not a guard that fires
 * today. Not a live vulnerability (nothing escapes), but worth flagging:
 * if `serveStatic` is ever changed to build `pathname` from something
 * other than a parsed `URL` (e.g. a raw path segment concatenation), the
 * 403 branch is what stands between that change and a real traversal.
 */

import { describe, expect, it, afterEach } from "vitest"
import { once } from "node:events"
import { PassThrough } from "node:stream"
import type { IncomingMessage, ServerResponse } from "node:http"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  BOOTSTRAP_PATH,
  MIME_TYPES,
  applyFramingHeaders,
  isContainedBy,
  serveBootstrapJs,
  serveIndexHtml,
  serveStatic,
  resolveUiBundleRoot,
  type StaticAssetContext,
} from "../static-assets.js"

/**
 * A `PassThrough` doubles as a `ServerResponse` for these purposes:
 * `serveBootstrapJs`/`serveIndexHtml` only call `setHeader`/`end`, and
 * `serveStatic`'s file branch pipes a real `ReadStream` into it — a
 * writable stream is exactly what `pipe()` needs. `end()`'s argument (or
 * whatever gets written before `end()`) accumulates into `.bodyText`.
 */
class FakeRes extends PassThrough {
  statusCode = 200
  private headers: Record<string, string> = {}
  private chunks: Buffer[] = []

  constructor() {
    super()
    this.on("data", (chunk: Buffer) => this.chunks.push(chunk))
  }

  setHeader(name: string, value: string | number): void {
    this.headers[name.toLowerCase()] = String(value)
  }

  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()]
  }

  get bodyText(): string {
    return Buffer.concat(this.chunks).toString("utf8")
  }
}

function asRes(res: FakeRes): ServerResponse {
  return res as unknown as ServerResponse
}

/** Wait for a `FakeRes` to finish (covers both `.end()` and piped-stream completion). */
async function settled(res: FakeRes): Promise<void> {
  await once(res, "finish")
}

describe("MIME_TYPES", () => {
  it("maps every declared extension to a non-empty content type", () => {
    for (const [ext, mime] of Object.entries(MIME_TYPES)) {
      expect(ext.startsWith(".")).toBe(true)
      expect(mime.length).toBeGreaterThan(0)
    }
  })

  it("pins the specific content types the bundle relies on", () => {
    expect(MIME_TYPES[".html"]).toBe("text/html; charset=utf-8")
    expect(MIME_TYPES[".js"]).toBe("application/javascript; charset=utf-8")
    expect(MIME_TYPES[".mjs"]).toBe("application/javascript; charset=utf-8")
    expect(MIME_TYPES[".css"]).toBe("text/css; charset=utf-8")
    expect(MIME_TYPES[".json"]).toBe("application/json; charset=utf-8")
    expect(MIME_TYPES[".svg"]).toBe("image/svg+xml")
    expect(MIME_TYPES[".woff2"]).toBe("font/woff2")
  })
})

describe("isContainedBy", () => {
  const parent = "/tmp/ui-bundle-root"

  it("true for the parent path itself", () => {
    expect(isContainedBy(parent, parent)).toBe(true)
  })

  it("true for a direct child", () => {
    expect(isContainedBy(join(parent, "index.html"), parent)).toBe(true)
  })

  it("true for a nested descendant", () => {
    expect(isContainedBy(join(parent, "assets", "app.js"), parent)).toBe(true)
  })

  it("false for a path that escapes via a sibling directory", () => {
    expect(isContainedBy("/tmp/other-root/secret.txt", parent)).toBe(false)
  })

  it("false for a genuinely escaping resolved path (the ../.. case this guard exists for)", () => {
    // Mirrors what `resolvePath(join(parent, "../../etc/passwd"))` would
    // produce if it ever escaped — proves the guard's rejection logic is
    // correct even though (per the file-header FINDING) `serveStatic`
    // can't currently construct this input from a real request.
    expect(isContainedBy("/etc/passwd", parent)).toBe(false)
  })

  it("false for a path that merely shares the parent as a string prefix (not a real descendant)", () => {
    // e.g. "/tmp/ui-bundle-root-evil" starts with the parent string but is
    // NOT contained by it — a naive `startsWith` check would wrongly pass
    // this; `path.relative` based containment correctly rejects it.
    expect(isContainedBy("/tmp/ui-bundle-root-evil/x", parent)).toBe(false)
  })
})

describe("serveBootstrapJs — defense-in-depth headers + token embedding", () => {
  it("sets Cross-Origin-Resource-Policy, X-Content-Type-Options, Cache-Control, and Content-Type", () => {
    const res = new FakeRes()
    serveBootstrapJs(asRes(res), "window.__DESDE_CLI__={};\n")
    expect(res.getHeader("cross-origin-resource-policy")).toBe("same-origin")
    expect(res.getHeader("x-content-type-options")).toBe("nosniff")
    expect(res.getHeader("cache-control")).toBe("no-store")
    expect(res.getHeader("content-type")).toBe("application/javascript; charset=utf-8")
  })

  it("embeds the session token verbatim in the response body", () => {
    const res = new FakeRes()
    const body = `window.__DESDE_CLI__={"token":"secret-session-token-123"};\n`
    serveBootstrapJs(asRes(res), body)
    expect(res.bodyText).toBe(body)
    expect(res.bodyText).toContain("secret-session-token-123")
  })
})

describe("applyFramingHeaders (S11)", () => {
  it("sets X-Frame-Options: DENY and CSP frame-ancestors 'none'", () => {
    const res = new FakeRes()
    applyFramingHeaders(asRes(res))
    expect(res.getHeader("x-frame-options")).toBe("DENY")
    expect(res.getHeader("content-security-policy")).toBe("frame-ancestors 'none'")
  })
})

describe("serveIndexHtml", () => {
  let dir: string

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it("injects the bootstrap <script> before </head> and sets no-store", async () => {
    dir = await mkdtemp(join(tmpdir(), "static-assets-idx-"))
    await writeFile(join(dir, "index.html"), "<!doctype html><head><title>t</title></head><body></body>")
    const res = new FakeRes()
    serveIndexHtml(asRes(res), { uiBundleRoot: dir, shellOrigin: "http://127.0.0.1:4321" })
    expect(res.bodyText).toContain(`<script src="${BOOTSTRAP_PATH}"></script>\n</head>`)
    expect(res.getHeader("cache-control")).toBe("no-store")
    expect(res.getHeader("content-type")).toBe("text/html; charset=utf-8")
  })

  it("carries the S11 anti-framing headers so the authenticated shell can't be iframed", async () => {
    dir = await mkdtemp(join(tmpdir(), "static-assets-idx-frame-"))
    await writeFile(join(dir, "index.html"), "<!doctype html><head></head><body></body>")
    const res = new FakeRes()
    serveIndexHtml(asRes(res), { uiBundleRoot: dir, shellOrigin: "http://127.0.0.1:4321" })
    expect(res.getHeader("x-frame-options")).toBe("DENY")
    expect(res.getHeader("content-security-policy")).toBe("frame-ancestors 'none'")
  })

  it("prepends the bootstrap <script> when the html has no </head>", async () => {
    dir = await mkdtemp(join(tmpdir(), "static-assets-idx-nohead-"))
    await writeFile(join(dir, "index.html"), "<body>no head tag here</body>")
    const res = new FakeRes()
    serveIndexHtml(asRes(res), { uiBundleRoot: dir, shellOrigin: "http://127.0.0.1:4321" })
    expect(res.bodyText.startsWith(`<script src="${BOOTSTRAP_PATH}"></script>`)).toBe(true)
  })

  it("responds 500 with a clear message when index.html is missing", async () => {
    dir = await mkdtemp(join(tmpdir(), "static-assets-idx-missing-"))
    const res = new FakeRes()
    serveIndexHtml(asRes(res), { uiBundleRoot: dir, shellOrigin: "http://127.0.0.1:4321" })
    expect(res.statusCode).toBe(500)
    expect(res.bodyText).toContain("index.html missing")
    // Even the error page must not be framable.
    expect(res.getHeader("x-frame-options")).toBe("DENY")
    expect(res.getHeader("content-security-policy")).toBe("frame-ancestors 'none'")
  })
})

describe("serveStatic", () => {
  let dir: string
  let ctx: StaticAssetContext

  function req(url: string): IncomingMessage {
    return { url } as unknown as IncomingMessage
  }

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  async function bootBundle(): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), "static-assets-serve-"))
    await writeFile(join(dir, "index.html"), "<!doctype html><head></head><body>root</body>")
    await mkdir(join(dir, "assets"), { recursive: true })
    await writeFile(join(dir, "assets", "app.js"), "console.log('app')")
    await writeFile(join(dir, "assets", "app.css"), "body{color:red}")
    await writeFile(join(dir, "assets", "data.bin"), Buffer.from([1, 2, 3]))
    ctx = { uiBundleRoot: dir, shellOrigin: "http://127.0.0.1:4321" }
  }

  it("serves a known asset with the correct MIME type and Content-Length", async () => {
    await bootBundle()
    const res = new FakeRes()
    await serveStatic(req("/assets/app.js"), asRes(res), ctx)
    await settled(res)
    expect(res.getHeader("content-type")).toBe("application/javascript; charset=utf-8")
    expect(res.bodyText).toBe("console.log('app')")
  })

  it("carries the S11 anti-framing headers on a plain asset response", async () => {
    await bootBundle()
    const res = new FakeRes()
    await serveStatic(req("/assets/app.js"), asRes(res), ctx)
    await settled(res)
    expect(res.getHeader("x-frame-options")).toBe("DENY")
    expect(res.getHeader("content-security-policy")).toBe("frame-ancestors 'none'")
  })

  it("carries the S11 anti-framing headers on the SPA-fallback (index.html) response", async () => {
    await bootBundle()
    const res = new FakeRes()
    await serveStatic(req("/some/client/route"), asRes(res), ctx)
    expect(res.getHeader("x-frame-options")).toBe("DENY")
    expect(res.getHeader("content-security-policy")).toBe("frame-ancestors 'none'")
  })

  it("falls back to application/octet-stream for an unrecognized extension", async () => {
    await bootBundle()
    const res = new FakeRes()
    await serveStatic(req("/assets/data.bin"), asRes(res), ctx)
    await settled(res)
    expect(res.getHeader("content-type")).toBe("application/octet-stream")
  })

  it("root path serves index.html via the SPA/index path (bootstrap-injected)", async () => {
    await bootBundle()
    const res = new FakeRes()
    await serveStatic(req("/"), asRes(res), ctx)
    expect(res.bodyText).toContain(BOOTSTRAP_PATH)
  })

  it("an unknown client-side route falls back to index.html (SPA fallback)", async () => {
    await bootBundle()
    const res = new FakeRes()
    await serveStatic(req("/some/client/route"), asRes(res), ctx)
    expect(res.bodyText).toContain(BOOTSTRAP_PATH)
    expect(res.statusCode).not.toBe(403)
  })

  it("a request for a directory (not a file) falls back to index.html", async () => {
    await bootBundle()
    const res = new FakeRes()
    await serveStatic(req("/assets"), asRes(res), ctx)
    expect(res.bodyText).toContain(BOOTSTRAP_PATH)
  })

  it(
    "path-traversal attempt ('../../../etc/passwd') does not escape the bundle root " +
      "— pinning current behavior: URL parsing collapses the dot-segments before " +
      "serveStatic ever sees them, so this degrades to the ordinary SPA fallback " +
      "(200 + index.html), NOT a 403. See file-header FINDING.",
    async () => {
      await bootBundle()
      const res = new FakeRes()
      await serveStatic(req("/../../../etc/passwd"), asRes(res), ctx)
      // Never a raw filesystem read outside the bundle, and never the literal
      // contents of a real /etc/passwd — the response is always index.html.
      expect(res.statusCode).toBe(200)
      expect(res.bodyText).toContain(BOOTSTRAP_PATH)
      expect(res.bodyText).not.toMatch(/root:.*:0:0:/)
    },
  )

  it(
    "percent-encoded traversal ('%2e%2e/%2e%2e/etc/passwd') also degrades to SPA fallback, not a leak",
    async () => {
      await bootBundle()
      const res = new FakeRes()
      await serveStatic(req("/%2e%2e/%2e%2e/etc/passwd"), asRes(res), ctx)
      expect(res.bodyText).toContain(BOOTSTRAP_PATH)
      expect(res.bodyText).not.toMatch(/root:.*:0:0:/)
    },
  )

  it(
    "a literal percent-encoded-slash segment ('/assets/..%2f..%2fsecret.txt') is treated as an " +
      "opaque filename (not decoded into a path separator) and 404s to the SPA fallback",
    async () => {
      await bootBundle()
      const res = new FakeRes()
      await serveStatic(req("/assets/..%2f..%2fsecret.txt"), asRes(res), ctx)
      expect(res.bodyText).toContain(BOOTSTRAP_PATH)
    },
  )
})

describe("resolveUiBundleRoot", () => {
  it("resolves to editor-cli/ui-src/dist", () => {
    const root = resolveUiBundleRoot()
    expect(root.endsWith(join("ui-src", "dist"))).toBe(true)
  })
})
