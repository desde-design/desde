/**
 * Per-deployment loopback listeners.
 *
 * These tests open REAL `http.Server`s on port 0 and drive them with
 * `node:http`, not supertest. Two reasons, both deliberate:
 *
 * - The thing under test IS the socket. "Bound to loopback only", "the other
 *   loopback spelling is refused", "a reaped listener's port stops answering"
 *   are all statements about a real listening server; a supertest harness
 *   would be testing a handler and asserting nothing about the bind.
 * - `node:http` lets a request carry an arbitrary `Host` header, which is
 *   exactly what the allowlist test needs. A browser cannot send a Host that
 *   disagrees with the URL, and `fetch` is not obliged to let us either.
 *
 * Every registry created here is closed in `afterEach`. A listener left open
 * keeps a handle alive and hangs the run.
 */
import { request as httpRequest, type IncomingHttpHeaders } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import type { AssetStore, StoredAsset } from "../assets/types"
import { loadConfig } from "../config"
import { InMemoryStorage } from "../storage/in-memory-storage"
import { tmpViewerDataDir } from "../__tests__/test-config"
import { contentTypeFor } from "./mime"
import { createLoopbackListenerApp } from "./loopback-listener-app"
import { loopbackBindHostFor, pairedLoopbackHost } from "./prototype-origin-resolve"
import {
  createLoopbackListenerRegistry,
  type LoopbackListenerRegistry,
} from "./loopback-listeners"

const config = loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() })
const BRIDGE = "console.log('bridge')"
const BRIDGE_VERSION = "test-version"
const SHELL_ORIGIN = "http://localhost:3100"

/** deploymentId → relPath → bytes. */
type Files = Record<string, Record<string, string>>

function assetsFor(files: Files): AssetStore {
  return {
    async put() {},
    async get(deploymentId: string, relPath: string): Promise<StoredAsset | null> {
      const body = files[deploymentId]?.[relPath]
      return body === undefined
        ? null
        : { body: Buffer.from(body), contentType: contentTypeFor(relPath) }
    },
    async deleteDeployment() {},
  }
}

interface HttpResult {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

/**
 * One request against a live listener.
 *
 * `host` is the address to CONNECT to; `hostHeader` is what goes in the
 * `Host` header. They are separate parameters on purpose — the allowlist test
 * needs them to disagree.
 */
function httpCall(options: {
  host: string
  port: number
  path: string
  method?: string
  hostHeader?: string
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: options.host,
        port: options.port,
        path: options.path,
        method: options.method ?? "GET",
        headers: options.hostHeader === undefined ? {} : { Host: options.hostHeader },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          })
        })
      },
    )
    req.on("error", reject)
    req.end()
  })
}

const openRegistries: LoopbackListenerRegistry[] = []
const stopReapers: (() => void)[] = []

afterEach(async () => {
  for (const stop of stopReapers.splice(0)) stop()
  for (const registry of openRegistries.splice(0)) await registry.closeAll()
})

function makeRegistry(files: Files, options: { now?: () => number; idleMs?: number } = {}) {
  const storage = new InMemoryStorage()
  const registry = createLoopbackListenerRegistry({
    makeApp: (context) =>
      createLoopbackListenerApp({
        ...context,
        storage,
        assets: assetsFor(files),
        config,
        bridgeScript: BRIDGE,
        bridgeVersion: BRIDGE_VERSION,
        prototypeCsp: null,
      }),
    ...options,
  })
  openRegistries.push(registry)
  return registry
}

const V4 = { bindHost: "127.0.0.1", shellOrigin: SHELL_ORIGIN } as const

function deployment(id: string, slug = "acme") {
  return { id, slug, projectId: `project-${id}` }
}

describe("createLoopbackListenerRegistry", () => {
  /**
   * Task 4b reconciled `pairedLoopbackHost` (`prototype-origin-resolve.ts`)
   * and this module's own bind-host handling into ONE mapping: the caller
   * derives `bindHost` from `pairedLoopbackHost` + `loopbackBindHostFor`,
   * and the registry only ever formats whatever it is given
   * (`hostSpellingFor`, not exported). This drives that full derivation
   * end to end and checks the listener's own `host` field agrees with it,
   * so the two modules cannot quietly drift apart.
   */
  describe("bindHost derivation agrees with pairedLoopbackHost (task 4b)", () => {
    it("a shell on localhost pairs to a listener bound to 127.0.0.1", async () => {
      const paired = pairedLoopbackHost("localhost")
      expect(paired).toBe("127.0.0.1")
      const bindHost = loopbackBindHostFor(paired as "127.0.0.1" | "[::1]")
      expect(bindHost).toBe("127.0.0.1")

      const registry = makeRegistry({ d1: {} })
      const listener = await registry.ensure(deployment("d1"), {
        bindHost,
        shellOrigin: "http://localhost:3100",
      })
      expect(listener.host).toBe("127.0.0.1")
    })

    it("a shell on 127.0.0.1 pairs to a listener bound to [::1]", async () => {
      const paired = pairedLoopbackHost("127.0.0.1")
      expect(paired).toBe("[::1]")
      const bindHost = loopbackBindHostFor(paired as "127.0.0.1" | "[::1]")
      expect(bindHost).toBe("::1")

      const registry = makeRegistry({ d1: {} })
      let listener
      try {
        listener = await registry.ensure(deployment("d1"), {
          bindHost,
          shellOrigin: "http://127.0.0.1:3100",
        })
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") {
          console.warn(`[test] skipped: this machine has no IPv6 loopback (${code})`)
          return
        }
        throw error
      }
      expect(listener.host).toBe("[::1]")
    })
  })

  describe("identity and keying", () => {
    it("returns the same listener for the same deployment and shell origin", async () => {
      const registry = makeRegistry({ d1: { "index.html": "<html></html>" } })
      const first = await registry.ensure(deployment("d1"), V4)
      const second = await registry.ensure(deployment("d1"), V4)
      expect(second.port).toBe(first.port)
      expect(second).toBe(first)
    })

    it("gives two deployments two ports", async () => {
      const registry = makeRegistry({ d1: {}, d2: {} })
      const one = await registry.ensure(deployment("d1"), V4)
      const two = await registry.ensure(deployment("d2"), V4)
      expect(one.port).not.toBe(two.port)
    })

    /**
     * The registry key is (deploymentId, shellOrigin), not deploymentId
     * alone. Each listener's `frame-ancestors` and `data-shell-origin` are
     * fixed at construction, so a second shell spelling needs its own
     * listener rather than one whose CSP names the wrong shell.
     */
    it("gives one deployment two listeners for two shell origins", async () => {
      const registry = makeRegistry({ d1: {} })
      const forLocalhost = await registry.ensure(deployment("d1"), V4)
      const forV6Shell = await registry.ensure(deployment("d1"), {
        bindHost: "127.0.0.1",
        shellOrigin: "http://[::1]:3100",
      })
      expect(forV6Shell.port).not.toBe(forLocalhost.port)
    })

    it("serves the same in-flight open to concurrent callers", async () => {
      const registry = makeRegistry({ d1: {} })
      const [a, b] = await Promise.all([
        registry.ensure(deployment("d1"), V4),
        registry.ensure(deployment("d1"), V4),
      ])
      expect(a).toBe(b)
    })
  })

  describe("the bind", () => {
    it("binds 127.0.0.1 only, never 0.0.0.0", async () => {
      const registry = makeRegistry({ d1: {} })
      const listener = await registry.ensure(deployment("d1"), V4)
      expect(listener.boundAddress).toBe("127.0.0.1")
      expect(listener.host).toBe("127.0.0.1")
      expect(listener.origin).toBe(`http://127.0.0.1:${listener.port}`)
    })

    /**
     * The bracketing is not cosmetic. A browser sends `Host: [::1]:<port>`,
     * and the listener's one-entry allowlist only matches that spelling —
     * `normalizeHostPort` does NOT repair a bare `::1:<port>` (it is not a
     * legal Host and cannot be split unambiguously), so the registry has to
     * bracket BEFORE joining the port. Asserting the fields alone would not
     * have caught getting that wrong, so this also serves a real request.
     */
    it("binds ::1, spells it bracketed, and serves on that spelling", async () => {
      const registry = makeRegistry({ d1: { "index.html": "<html><body>v6</body></html>" } })
      let listener
      try {
        listener = await registry.ensure(deployment("d1"), {
          bindHost: "::1",
          shellOrigin: SHELL_ORIGIN,
        })
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") {
          console.warn(`[test] skipped: this machine has no IPv6 loopback (${code})`)
          return
        }
        throw error
      }
      expect(listener.boundAddress).toBe("::1")
      expect(listener.host).toBe("[::1]")
      expect(listener.origin).toBe(`http://[::1]:${listener.port}`)
      expect(registry.isPrototypeHost(`[::1]:${listener.port}`)).toBe(true)

      const res = await httpCall({ host: "::1", port: listener.port, path: "/" })
      expect(res.status).toBe(200)
      expect(res.body).toContain("v6")
    })

    /**
     * Cookies are not isolated by port (RFC 6265 §8.5, measured in the
     * research doc): a listener on the shell's OWN hostname would receive
     * the reviewer's `viewer_session` cookie however different the port is.
     * The host flip is the isolation; the port is only what gives the
     * prototype the root of its origin.
     */
    it("refuses a bind host that is the shell's own hostname", async () => {
      const registry = makeRegistry({ d1: {} })
      await expect(
        registry.ensure(deployment("d1"), {
          bindHost: "127.0.0.1",
          shellOrigin: "http://127.0.0.1:3100",
        }),
      ).rejects.toThrow(/same host/i)
    })

    /**
     * The bind host is derived from the shell origin, so it cannot differ for
     * one key. Checked rather than assumed: handing back a listener on a host
     * the caller did not ask for would quietly undo the host flip.
     */
    it("refuses a second bind host for a key it already has", async () => {
      const registry = makeRegistry({ d1: {} })
      await registry.ensure(deployment("d1"), V4)
      await expect(
        registry.ensure(deployment("d1"), { bindHost: "::1", shellOrigin: SHELL_ORIGIN }),
      ).rejects.toThrow(/already bound/i)
    })

    it("refuses an https shell origin", async () => {
      const registry = makeRegistry({ d1: {} })
      await expect(
        registry.ensure(deployment("d1"), {
          bindHost: "127.0.0.1",
          shellOrigin: "https://viewer.example.com",
        }),
      ).rejects.toThrow(/scheme|https/i)
    })
  })

  describe("what a listener serves", () => {
    const html = "<html><head></head><body><h1>one</h1></body></html>"

    it("serves the pinned deployment's index.html at /", async () => {
      const registry = makeRegistry({ d1: { "index.html": html } })
      const listener = await registry.ensure(deployment("d1"), V4)
      const res = await httpCall({ host: "127.0.0.1", port: listener.port, path: "/" })

      expect(res.status).toBe(200)
      expect(res.headers["content-type"]).toMatch(/text\/html/)
      expect(res.body).toContain("<h1>one</h1>")
    })

    /** The rewrite always yields a trailing slash, so the bare-slug 301 never fires. */
    it("never answers / with the bare-slug 301", async () => {
      const registry = makeRegistry({ d1: { "index.html": html } })
      const listener = await registry.ensure(deployment("d1"), V4)
      const res = await httpCall({ host: "127.0.0.1", port: listener.port, path: "/" })
      expect(res.status).not.toBe(301)
      expect(res.headers.location).toBeUndefined()
    })

    it("injects the bridge with this listener's shell origin and the root bridge path", async () => {
      const registry = makeRegistry({ d1: { "index.html": html } })
      const listener = await registry.ensure(deployment("d1"), V4)
      const res = await httpCall({ host: "127.0.0.1", port: listener.port, path: "/" })

      expect(res.body).toContain(`data-shell-origin="${SHELL_ORIGIN}"`)
      expect(res.body).toContain(`src="/__desde/bridge-${BRIDGE_VERSION}.js"`)
      expect(res.body).not.toContain("<base href")
    })

    it("serves the bridge bundle at the origin root", async () => {
      const registry = makeRegistry({ d1: { "index.html": html } })
      const listener = await registry.ensure(deployment("d1"), V4)
      const res = await httpCall({
        host: "127.0.0.1",
        port: listener.port,
        path: `/__desde/bridge-${BRIDGE_VERSION}.js`,
      })
      expect(res.status).toBe(200)
      expect(res.body).toBe(BRIDGE)
    })

    it("carries the isolated-origin CSP on the HTML", async () => {
      const registry = makeRegistry({ d1: { "index.html": html } })
      const listener = await registry.ensure(deployment("d1"), V4)
      const res = await httpCall({ host: "127.0.0.1", port: listener.port, path: "/" })

      const csp = res.headers["content-security-policy"]
      expect(csp).toContain(`frame-ancestors ${SHELL_ORIGIN}`)
      expect(csp).toContain("connect-src 'self'")
      expect(csp).toContain("worker-src 'none'")
    })

    /**
     * `Access-Control-Allow-Origin: *` is a PATH-MODE affordance for the
     * opaque-origin sandboxed frame (`prototype-cors.ts`). Here the document
     * has its real origin and its assets are on that same origin, so CORS
     * never runs — and sending `*` anyway would be a hole, not dead weight: a
     * pinned request skips `canReadProject` entirely, so it would let any page
     * the reviewer visits read a private prototype's bytes once it guessed the
     * port.
     */
    it("sends no Access-Control-Allow-Origin on anything it serves", async () => {
      const registry = makeRegistry({
        d1: { "index.html": html, "assets/app.css": "body{}", "assets/app.js": "export const a=1" },
      })
      const listener = await registry.ensure(deployment("d1"), V4)
      for (const path of [
        "/",
        "/assets/app.css",
        "/assets/app.js",
        `/__desde/bridge-${BRIDGE_VERSION}.js`,
      ]) {
        const res = await httpCall({ host: "127.0.0.1", port: listener.port, path })
        expect(res.status, path).toBe(200)
        expect(res.headers["access-control-allow-origin"], path).toBeUndefined()
      }
    })

    it("serves a root-absolute asset at its own path", async () => {
      const registry = makeRegistry({
        d1: { "index.html": html, "assets/app.css": "body{color:red}" },
      })
      const listener = await registry.ensure(deployment("d1"), V4)
      const res = await httpCall({
        host: "127.0.0.1",
        port: listener.port,
        path: "/assets/app.css",
      })
      expect(res.status).toBe(200)
      expect(res.headers["content-type"]).toMatch(/text\/css/)
      expect(res.body).toBe("body{color:red}")
      expect(res.headers["content-security-policy"]).toContain("worker-src 'none'")
    })

    /** Two ports, two deployments, no leakage between them. */
    it("keeps two deployments' bodies apart", async () => {
      const registry = makeRegistry({
        d1: { "index.html": "<html><body>one</body></html>" },
        d2: { "index.html": "<html><body>two</body></html>" },
      })
      const one = await registry.ensure(deployment("d1", "one"), V4)
      const two = await registry.ensure(deployment("d2", "two"), V4)

      const resOne = await httpCall({ host: "127.0.0.1", port: one.port, path: "/" })
      const resTwo = await httpCall({ host: "127.0.0.1", port: two.port, path: "/" })
      expect(resOne.body).toContain("one")
      expect(resOne.body).not.toContain("two")
      expect(resTwo.body).toContain("two")
      expect(resTwo.body).not.toContain("one")
    })
  })

  describe("what a listener refuses", () => {
    const html = "<html><head></head><body>app</body></html>"

    /**
     * The shell's API is not merely CSP-blocked here — no API router is
     * mounted on a listener at all, so this path can only ever be answered as
     * prototype content.
     *
     * It resolves to the prototype's own SPA fallback rather than a 404,
     * because it is extensionless and every extensionless miss is a
     * client-side route (the Task 2 ruling: on a prototype origin the
     * prototype owns `/`, so a path is never refused for LOOKING shell-ish).
     * The claim under test is therefore "this is the prototype's document,
     * never the viewer's JSON", not a status code.
     */
    it("answers the shell's API path with prototype content, never the API", async () => {
      const registry = makeRegistry({ d1: { "index.html": html } })
      const listener = await registry.ensure(deployment("d1"), V4)
      const res = await httpCall({
        host: "127.0.0.1",
        port: listener.port,
        path: "/api/v1/projects",
      })
      expect(res.headers["content-type"]).toMatch(/text\/html/)
      expect(res.body).toContain("app")
      expect(res.body).not.toContain("{")
    })

    /** With an extension there is no SPA fallback, so a miss is a plain 404. */
    it("404s a missing file with the shared not-found body", async () => {
      const registry = makeRegistry({ d1: { "index.html": html } })
      const listener = await registry.ensure(deployment("d1"), V4)
      const res = await httpCall({
        host: "127.0.0.1",
        port: listener.port,
        path: "/api/v1/projects.json",
      })
      expect(res.status).toBe(404)
      expect(res.headers["content-type"]).toMatch(/text\/plain/)
      expect(res.body).toBe("Not found")
    })

    /**
     * An extensionless miss is the prototype's own client-side route, so it
     * gets the SPA fallback. This supersedes the brief's "302 to publicUrl":
     * on a prototype origin there is no shell path left to redirect to.
     */
    it("serves the SPA fallback for an extensionless path", async () => {
      const registry = makeRegistry({ d1: { "index.html": html } })
      const listener = await registry.ensure(deployment("d1"), V4)
      const res = await httpCall({ host: "127.0.0.1", port: listener.port, path: "/settings" })
      expect(res.status).toBe(200)
      expect(res.body).toContain("app")
    })

    it("refuses a write method", async () => {
      const registry = makeRegistry({ d1: { "index.html": html } })
      const listener = await registry.ensure(deployment("d1"), V4)
      const res = await httpCall({
        host: "127.0.0.1",
        port: listener.port,
        path: "/",
        method: "POST",
      })
      expect(res.status).toBe(404)
      expect(res.body).toBe("Not found")
    })

    /**
     * The listener answers on exactly one `Host`. `localhost:<port>` reaches
     * the same socket but is a different origin, so it must not be served —
     * otherwise the isolation the host flip buys would depend on which
     * spelling the browser happened to use.
     */
    it("400s the other loopback spelling", async () => {
      const registry = makeRegistry({ d1: { "index.html": html } })
      const listener = await registry.ensure(deployment("d1"), V4)
      const res = await httpCall({
        host: "127.0.0.1",
        port: listener.port,
        path: "/",
        hostHeader: `localhost:${listener.port}`,
      })
      expect(res.status).toBe(400)
    })

    /**
     * The DNS-rebinding shape: a name an attacker controls, resolved to
     * 127.0.0.1, so the browser believes it is same-origin with their page
     * while the packets arrive here. The allowlist refuses it on the Host
     * alone, before routing.
     *
     * There is no companion test for an ABSENT Host: Node's own http client
     * always writes one, so a test cannot produce that request without
     * hand-rolling the socket. `host-allowlist.test.ts` covers the empty and
     * undefined cases directly.
     */
    it("400s an attacker-chosen Host that resolves here", async () => {
      const registry = makeRegistry({ d1: { "index.html": html } })
      const listener = await registry.ensure(deployment("d1"), V4)
      const res = await httpCall({
        host: "127.0.0.1",
        port: listener.port,
        path: "/",
        hostHeader: `rebind.evil.example:${listener.port}`,
      })
      expect(res.status).toBe(400)
    })
  })

  describe("idle reaping", () => {
    it("closes a listener idle past idleMs and reopens on a later ensure", async () => {
      let clock = 1_000
      const registry = makeRegistry({ d1: { "index.html": "<html></html>" } }, { now: () => clock })
      const first = await registry.ensure(deployment("d1"), V4)

      clock += 60_000
      expect(await registry.reapIdle(clock, 30_000)).toBe(1)

      await expect(
        httpCall({ host: "127.0.0.1", port: first.port, path: "/" }),
      ).rejects.toMatchObject({ code: "ECONNREFUSED" })

      const reopened = await registry.ensure(deployment("d1"), V4)
      const res = await httpCall({ host: "127.0.0.1", port: reopened.port, path: "/" })
      expect(res.status).toBe(200)
    })

    it("does not close a listener inside its idle window", async () => {
      let clock = 1_000
      const registry = makeRegistry({ d1: {} }, { now: () => clock })
      await registry.ensure(deployment("d1"), V4)
      clock += 10_000
      expect(await registry.reapIdle(clock, 30_000)).toBe(0)
    })

    it("touch extends a listener's life", async () => {
      let clock = 1_000
      const registry = makeRegistry({ d1: {} }, { now: () => clock })
      const listener = await registry.ensure(deployment("d1"), V4)

      clock += 20_000
      registry.touch(listener.port)
      clock += 20_000
      // 40s since the open, but only 20s since the touch.
      expect(await registry.reapIdle(clock, 30_000)).toBe(0)
    })

    /** A served request is a touch, so an actively reviewed prototype survives. */
    it("counts a served request as use", async () => {
      let clock = 1_000
      const registry = makeRegistry(
        { d1: { "index.html": "<html></html>" } },
        { now: () => clock },
      )
      const listener = await registry.ensure(deployment("d1"), V4)

      clock += 20_000
      await httpCall({ host: "127.0.0.1", port: listener.port, path: "/" })
      clock += 20_000
      expect(await registry.reapIdle(clock, 30_000)).toBe(0)
    })

    /**
     * Task 13 fix wave: `reapIdle` used to snapshot the stale set once, then
     * `await` each `close()` in turn. A listener in that snapshot can be
     * touched (a real request lands, or `touch()` is called directly)
     * DURING the `await` for an earlier listener's close, before its own
     * turn comes up — and the old code closed it anyway, interrupting a
     * review already in progress.
     *
     * This exploits the single-threaded execution guarantee rather than real
     * wall-clock timing: `reapIdle` runs synchronously up to its first
     * `await listener.close()`, so calling `registry.touch()` right after
     * (not awaiting) `reapIdle`'s own promise lands the touch while the
     * first listener is still mid-close and before the loop has reached the
     * second listener's re-check. That makes the race deterministic instead
     * of timing-dependent.
     */
    it("does not close a listener touched after the reap snapshot but before its own turn", async () => {
      let clock = 1_000
      const registry = makeRegistry(
        { d1: { "index.html": "<html></html>" }, d2: { "index.html": "<html></html>" } },
        { now: () => clock },
      )
      const first = await registry.ensure(deployment("d1"), V4)
      const second = await registry.ensure(deployment("d2", "beta"), V4)

      clock += 60_000 // both idle past the 30s bound

      const reapPromise = registry.reapIdle(clock, 30_000)
      // Runs synchronously, before `reapIdle`'s loop has reached `second`:
      // the loop is still awaiting `first.close()` at this point.
      registry.touch(second.port)
      const closedCount = await reapPromise

      expect(closedCount).toBe(1)

      await expect(
        httpCall({ host: "127.0.0.1", port: first.port, path: "/" }),
      ).rejects.toMatchObject({ code: "ECONNREFUSED" })

      const res = await httpCall({ host: "127.0.0.1", port: second.port, path: "/" })
      expect(res.status).toBe(200)
      expect(registry.isPrototypeHost(`127.0.0.1:${second.port}`)).toBe(true)
    })

    /**
     * The reaper is the registry's own timer, not a piggyback on the session
     * sweep: that tick runs every 6 hours, which cannot implement a 30-minute
     * idle bound. The timer is `unref`'d in the source so it never holds the
     * process open; that part is not assertable from out here.
     */
    it("reaps on its own timer", async () => {
      let clock = 1_000
      const registry = makeRegistry({ d1: {} }, { now: () => clock })
      const listener = await registry.ensure(deployment("d1"), V4)
      const hostPort = `127.0.0.1:${listener.port}`
      const stop = registry.startReaper({ intervalMs: 5, idleMs: 10 })
      stopReapers.push(stop)

      clock += 1_000
      await expect.poll(() => registry.isPrototypeHost(hostPort), { timeout: 2_000 }).toBe(false)
    })
  })

  describe("lifecycle", () => {
    it("closeAll is idempotent", async () => {
      const registry = makeRegistry({ d1: {} })
      const listener = await registry.ensure(deployment("d1"), V4)
      await registry.closeAll()
      await registry.closeAll()
      await expect(
        httpCall({ host: "127.0.0.1", port: listener.port, path: "/" }),
      ).rejects.toMatchObject({ code: "ECONNREFUSED" })
    })

    it("close() on a listener drops it from the registry", async () => {
      const registry = makeRegistry({ d1: {} })
      const listener = await registry.ensure(deployment("d1"), V4)
      expect(registry.isPrototypeHost(`127.0.0.1:${listener.port}`)).toBe(true)
      await listener.close()
      expect(registry.isPrototypeHost(`127.0.0.1:${listener.port}`)).toBe(false)
      const reopened = await registry.ensure(deployment("d1"), V4)
      expect(reopened).not.toBe(listener)
    })
  })

  describe("isPrototypeHost", () => {
    it("answers for a live listener's host:port and nothing else", async () => {
      const registry = makeRegistry({ d1: {} })
      const listener = await registry.ensure(deployment("d1"), V4)
      expect(registry.isPrototypeHost(`127.0.0.1:${listener.port}`)).toBe(true)
      expect(registry.isPrototypeHost(`localhost:${listener.port}`)).toBe(false)
      expect(registry.isPrototypeHost("127.0.0.1:3100")).toBe(false)
    })
  })
})
