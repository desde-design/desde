import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { bridgePlugin, readBridgeVersion } from "./bridge-plugin"

// A fake bridge bundle the plugin reads at init (needs a BRIDGE_VERSION literal
// for the cache-buster) and a fake html2canvas file to serve.
const FAKE_BUNDLE = 'const BRIDGE_VERSION = "test-1";\nconsole.log(BRIDGE_VERSION)\n'
const FAKE_H2C = '/* html2canvas */ window.html2canvas = function () {}\n'

interface MockRes {
  statusCode: number
  headers: Record<string, string>
  body: string | null
  ended: boolean
  setHeader: (k: string, v: string) => void
  end: (chunk?: string) => void
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v
    },
    end(chunk) {
      if (chunk !== undefined) this.body = chunk
      this.ended = true
    },
  }
  return res
}

/** Build the plugin, capture the middleware it registers, return both. */
function setup(bundlePath: string, html2canvasPath?: string) {
  const plugin = bridgePlugin({
    bridgeBundlePath: bundlePath,
    shellOrigin: "http://localhost:4321",
    html2canvasPath,
  })
  let middleware: ((req: unknown, res: unknown, next: () => void) => void) | null = null
  const server = {
    middlewares: {
      use(fn: (req: unknown, res: unknown, next: () => void) => void) {
        middleware = fn
      },
    },
    ws: { send: vi.fn() },
  }
  // configureServer is a plain method on the plugin object here.
  ;(plugin.configureServer as unknown as (s: unknown) => void)(server)
  return { plugin, middleware: middleware! }
}

describe("bridgePlugin html2canvas serving", () => {
  let dir: string
  let bundlePath: string
  let h2cPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridge-plugin-"))
    bundlePath = join(dir, "bridge-bundle.js")
    h2cPath = join(dir, "html2canvas.min.js")
    await writeFile(bundlePath, FAKE_BUNDLE)
    await writeFile(h2cPath, FAKE_H2C)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("serves html2canvas at the prototype origin with a JS content-type", () => {
    const { plugin, middleware } = setup(bundlePath, h2cPath)
    const res = mockRes()
    const next = vi.fn()
    middleware({ url: "/vendor/html2canvas.min.js", method: "GET" }, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.headers["content-type"]).toMatch(/application\/javascript/)
    expect(res.headers["x-content-type-options"]).toBe("nosniff")
    expect(res.body).toBe(FAKE_H2C)
    ;(plugin as { closeBundle?: () => void }).closeBundle?.()
  })

  it("answers HEAD without a body", () => {
    const { plugin, middleware } = setup(bundlePath, h2cPath)
    const res = mockRes()
    middleware({ url: "/vendor/html2canvas.min.js", method: "HEAD" }, res, vi.fn())
    expect(res.ended).toBe(true)
    expect(res.body).toBeNull()
    ;(plugin as { closeBundle?: () => void }).closeBundle?.()
  })

  it("405s a non-GET/HEAD method", () => {
    const { plugin, middleware } = setup(bundlePath, h2cPath)
    const res = mockRes()
    middleware({ url: "/vendor/html2canvas.min.js", method: "POST" }, res, vi.fn())
    expect(res.statusCode).toBe(405)
    ;(plugin as { closeBundle?: () => void }).closeBundle?.()
  })

  it("falls through (next) for the vendor path when no html2canvasPath is configured", () => {
    const { plugin, middleware } = setup(bundlePath, undefined)
    const res = mockRes()
    const next = vi.fn()
    middleware({ url: "/vendor/html2canvas.min.js", method: "GET" }, res, next)
    expect(next).toHaveBeenCalledOnce()
    ;(plugin as { closeBundle?: () => void }).closeBundle?.()
  })

  it("injects the shell origin ahead of the bundle tag", () => {
    const { plugin } = setup(bundlePath, h2cPath)
    const transform = plugin.transformIndexHtml as unknown as (h: string) => string
    const out = transform("<html><body><div id=app></div></body></html>")

    expect(out).toContain(
      `<script data-prototype-flow="config">window.__DESDE_SHELL_ORIGIN__="http://localhost:4321";</script>`,
    )
    // The bridge reads the global, so the config tag must come first.
    expect(out.indexOf("__DESDE_SHELL_ORIGIN__")).toBeLessThan(
      out.indexOf('data-prototype-flow="bridge"'),
    )
    expect(out).toContain("</body>")
    ;(plugin as { closeBundle?: () => void }).closeBundle?.()
  })

  it("escapes the injected origin so it cannot break out of the inline script", () => {
    const plugin = bridgePlugin({
      bridgeBundlePath: bundlePath,
      shellOrigin: 'http://evil"</script><script>alert(1)</script>',
    })
    const transform = plugin.transformIndexHtml as unknown as (h: string) => string
    const out = transform("<html><body></body></html>")

    expect(out).not.toContain("</script><script>alert(1)")
    expect(out).toContain("\\u003c/script>")
  })

  // The bundle tag's `data-shell-origin` is the AUTHORITATIVE origin channel:
  // the inline config tag above is dropped by any prototype serving
  // `script-src 'self'` without `'unsafe-inline'`, and the bridge fails CLOSED
  // on an unresolvable origin. Lose the attribute and a strict-CSP prototype
  // loses its bridge (previously it silently gained an accept-all one — see
  // src/bridge/origin-discipline.test.ts).
  it("puts the shell origin on the bundle tag as a CSP-proof attribute", () => {
    const { plugin } = setup(bundlePath, h2cPath)
    const transform = plugin.transformIndexHtml as unknown as (h: string) => string
    const out = transform("<html><body><div id=app></div></body></html>")

    const bridgeTag = out.match(/<script data-prototype-flow="bridge"[^>]*>/)?.[0] ?? ""
    expect(bridgeTag).toContain(`data-shell-origin="http://localhost:4321"`)
    // Attribute and inline global must never disagree — the bridge prefers the
    // attribute, so a drifted pair would be silently resolved the user can't see.
    expect(bridgeTag).toContain("/@desde-bridge.js?v=test-1")
    ;(plugin as { closeBundle?: () => void }).closeBundle?.()
  })

  it("HTML-escapes the attribute so an origin cannot inject markup or extra attributes", () => {
    const plugin = bridgePlugin({
      bridgeBundlePath: bundlePath,
      shellOrigin: 'http://evil" onload="alert(1)" data-x="',
    })
    const transform = plugin.transformIndexHtml as unknown as (h: string) => string
    const out = transform("<html><body></body></html>")

    const bridgeTag = out.match(/<script data-prototype-flow="bridge"[^>]*>/)?.[0] ?? ""
    // The invariant is not "the value looks harmless" — `onload=` legitimately
    // appears INSIDE the escaped value. It is that the value cannot close its
    // own quote and start a new attribute, so the parsed attribute NAME set is
    // exactly the three we wrote (plus the bare `defer`).
    const names = [...bridgeTag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => m[1])
    expect(names).toEqual(["data-prototype-flow", "data-shell-origin", "src"])
    expect(bridgeTag).toContain(
      `data-shell-origin="http://evil&quot; onload=&quot;alert(1)&quot; data-x=&quot;"`,
    )
  })

  it("reads the version from a minified bundle (const binding is inlined away)", async () => {
    // What esbuild --minify emits: the `const BRIDGE_VERSION` declaration is
    // gone and only the global assignment carries the literal.
    const minifiedPath = join(dir, "minified-bundle.js")
    await writeFile(
      minifiedPath,
      '(function(){"use strict";window.__DESDE_BRIDGE_VERSION__="2026-08-04d-origin-validation";})();',
    )
    expect(readBridgeVersion(minifiedPath)).toBe("2026-08-04d-origin-validation")
    // …and the unminified declaration form still resolves.
    expect(readBridgeVersion(bundlePath)).toBe("test-1")
  })

  it("still serves the bridge bundle, and passes unknown paths through", () => {
    const { plugin, middleware } = setup(bundlePath, h2cPath)
    const bridgeRes = mockRes()
    middleware({ url: "/@desde-bridge.js", method: "GET" }, bridgeRes, vi.fn())
    expect(bridgeRes.body).toBe(FAKE_BUNDLE)

    const nextFor = vi.fn()
    middleware({ url: "/src/main.ts", method: "GET" }, mockRes(), nextFor)
    expect(nextFor).toHaveBeenCalledOnce()
    ;(plugin as { closeBundle?: () => void }).closeBundle?.()
  })
})
