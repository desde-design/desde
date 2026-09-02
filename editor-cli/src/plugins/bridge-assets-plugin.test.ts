import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * `fs.watch` is stubbed so the "bundle rebuilt under a running server" case is
 * deterministic: the test invokes the change callback itself rather than racing
 * a real filesystem event (which the plugin itself documents as unreliable on
 * NFS and in some containers). `readFileSync` stays REAL — re-reading the
 * rewritten bundle from disk is precisely the behaviour under test.
 */
const fsMock = vi.hoisted(() => ({
  watched: [] as { path: string; onChange: () => void; close: () => void }[],
}))

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    watch: (path: string, onChange: () => void) => {
      const handle = { close: vi.fn() }
      fsMock.watched.push({ path, onChange, close: handle.close })
      return handle
    },
  }
})

import { bridgeAssetsPlugin, bridgePlugin } from "./bridge-plugin"

const BUNDLE_V1 = 'const BRIDGE_VERSION = "test-1";\nconsole.log(BRIDGE_VERSION)\n'
const BUNDLE_V2 = 'const BRIDGE_VERSION = "test-2";\nconsole.log(BRIDGE_VERSION)\n'
const FAKE_H2C = "/* html2canvas */ window.html2canvas = function () {}\n"
const SHELL = "http://localhost:4321"

interface MockRes {
  statusCode: number
  headers: Record<string, string>
  body: string | null
  ended: boolean
  setHeader: (k: string, v: string) => void
  end: (chunk?: string) => void
}

// Deliberately duplicated from the sibling `bridge-plugin.test.ts` rather than
// shared: that file passing BYTE-UNCHANGED is this milestone's gate, so it
// cannot grow exports.
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

type Middleware = (req: unknown, res: unknown, next: () => void) => void

/** Drive `configureServer` on a fake Vite server and hand back what it registered. */
function install(plugin: { configureServer?: unknown }) {
  let middleware: Middleware | null = null
  const server = {
    middlewares: {
      use(fn: Middleware) {
        middleware = fn
      },
    },
    ws: { send: vi.fn() },
  }
  ;(plugin.configureServer as unknown as (s: unknown) => void)(server)
  return { middleware: middleware!, server }
}

function transformOf(plugin: { transformIndexHtml?: unknown }): (html: string) => string {
  return plugin.transformIndexHtml as unknown as (html: string) => string
}

/** The `src` the injected bundle tag actually points the browser at. */
function injectedBridgeSrc(plugin: { transformIndexHtml?: unknown }): string {
  const out = transformOf(plugin)("<html><body></body></html>")
  const tag = out.match(/<script data-prototype-flow="bridge"[^>]*>/)?.[0] ?? ""
  return tag.match(/src="([^"]+)"/)?.[1] ?? ""
}

describe("bridgeAssetsPlugin", () => {
  let dir: string
  let bundlePath: string
  let h2cPath: string

  beforeEach(async () => {
    fsMock.watched.length = 0
    dir = await mkdtemp(join(tmpdir(), "bridge-assets-"))
    bundlePath = join(dir, "bridge-bundle.js")
    h2cPath = join(dir, "html2canvas.min.js")
    await writeFile(bundlePath, BUNDLE_V1)
    await writeFile(h2cPath, FAKE_H2C)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /**
   * The reason the split exists. MEASURED (`tasks/dev-server-hosts.md` § 0a):
   * `transformIndexHtml` never fires on Astro, Nuxt or React Router, so those
   * hosts install this half alone and take their `<script>` tags from the attach
   * proxy's streaming injector. A `transformIndexHtml` reappearing here would be
   * dead weight on three hosts and a second, divergent injector on one.
   */
  it("serves the bridge bundle and declares no HTML transform", () => {
    const plugin = bridgeAssetsPlugin({ bridgeBundlePath: bundlePath })
    expect(plugin.transformIndexHtml).toBeUndefined()

    const { middleware } = install(plugin)
    const res = mockRes()
    middleware({ url: "/@desde-bridge.js", method: "GET" }, res, vi.fn())
    expect(res.body).toBe(BUNDLE_V1)
    expect(res.headers["content-type"]).toMatch(/application\/javascript/)
  })

  it("serves html2canvas and passes unknown paths through", () => {
    const plugin = bridgeAssetsPlugin({
      bridgeBundlePath: bundlePath,
      html2canvasPath: h2cPath,
    })
    const { middleware } = install(plugin)

    const h2c = mockRes()
    middleware({ url: "/vendor/html2canvas.min.js", method: "GET" }, h2c, vi.fn())
    expect(h2c.body).toBe(FAKE_H2C)

    const next = vi.fn()
    middleware({ url: "/src/main.ts", method: "GET" }, mockRes(), next)
    expect(next).toHaveBeenCalledOnce()
  })

  // S8 (`tasks/dev-server-hosts.md` § 4): bridge assets are GET/HEAD only, on
  // the plugin as well as the proxy. The sibling suite asserts this for the
  // vendor path; the bundle path is the one a host actually installs this for.
  it("405s a non-GET/HEAD request for the bundle", () => {
    const plugin = bridgeAssetsPlugin({ bridgeBundlePath: bundlePath })
    const { middleware } = install(plugin)
    const res = mockRes()
    const next = vi.fn()
    middleware({ url: "/@desde-bridge.js", method: "POST" }, res, next)
    expect(res.statusCode).toBe(405)
    expect(res.headers["allow"]).toBe("GET, HEAD")
    expect(next).not.toHaveBeenCalled()
  })

  it("names itself distinctly from the composed plugin", () => {
    // A host installing only this half should not see a plugin list claiming
    // the tag-injecting one is present.
    expect(bridgeAssetsPlugin({ bridgeBundlePath: bundlePath }).name).toBe(
      "@desde/editor-bridge-assets",
    )
    expect(bridgePlugin({ bridgeBundlePath: bundlePath, shellOrigin: SHELL }).name).toBe(
      "@desde/editor-bridge-plugin",
    )
  })

  /**
   * The invariant the spread exists to hold: the URL the tag hands the browser
   * is one THIS server answers, cache-buster and all. Two halves reading two
   * copies of the version would still produce a plausible-looking tag and a
   * 404 (or worse, a stale 200) at load time.
   */
  it("composes into bridgePlugin — the injected src round-trips through the middleware", () => {
    const plugin = bridgePlugin({
      bridgeBundlePath: bundlePath,
      shellOrigin: SHELL,
      html2canvasPath: h2cPath,
    })
    const { middleware } = install(plugin)

    const src = injectedBridgeSrc(plugin)
    expect(src).toBe("/@desde-bridge.js?v=test-1")
    const res = mockRes()
    middleware({ url: src, method: "GET" }, res, vi.fn())
    expect(res.body).toBe(BUNDLE_V1)

    // The teardown half came across the spread too. Re-implementing the hooks
    // instead of spreading them is exactly how a plugin keeps an fs watcher
    // alive past shutdown, and nothing else in the suite would notice.
    ;(plugin as { closeBundle?: () => void }).closeBundle?.()
    expect(fsMock.watched[0].close).toHaveBeenCalledOnce()
  })

  /**
   * The regression this split could introduce: hoisting the bundle URL out of
   * `transformIndexHtml` (it is now reached through a call, not a closure
   * variable) would pin every response to the version read at construction —
   * the browser would keep the stale cache key that the full-reload we push
   * exists to break, and the bug would only show after a `build:bridge`.
   */
  it("follows a bundle rebuild in both halves — new cache key, new bytes", async () => {
    const plugin = bridgePlugin({ bridgeBundlePath: bundlePath, shellOrigin: SHELL })
    const { middleware, server } = install(plugin)
    expect(injectedBridgeSrc(plugin)).toBe("/@desde-bridge.js?v=test-1")

    // The watcher is registered on the bundle itself, and firing it is what a
    // `npm run build:bridge` in the parent repo amounts to.
    expect(fsMock.watched.map((w) => w.path)).toEqual([bundlePath])
    await writeFile(bundlePath, BUNDLE_V2)
    fsMock.watched[0].onChange()

    const src = injectedBridgeSrc(plugin)
    expect(src).toBe("/@desde-bridge.js?v=test-2")
    const res = mockRes()
    middleware({ url: src, method: "GET" }, res, vi.fn())
    expect(res.body).toBe(BUNDLE_V2)
    // Without the reload the tag's `src` is never re-evaluated: it is only read
    // at page load, so a hot update would not get there.
    expect(server.ws.send).toHaveBeenCalledWith({ type: "full-reload", path: "*" })
  })
})
