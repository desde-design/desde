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
import express from "express"
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http"
import { Server as NetServer, type AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AssetStore, StoredAsset } from "../assets/types"
import { loadConfig } from "../config"
import { InMemoryStorage } from "../storage/in-memory-storage"
import { nullPrototypeProcesses } from "../__tests__/test-app"
import type { PrototypeProcesses } from "./prototype-processes"
import { tmpViewerDataDir } from "../__tests__/test-config"
import { contentTypeFor } from "./mime"
import { createLoopbackListenerApp } from "./loopback-listener-app"
import { loopbackBindHostFor, pairedLoopbackHost } from "./prototype-origin-resolve"
import {
  createLoopbackListenerRegistry,
  LoopbackPortsExhaustedError,
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
  /** Request body, sent as-is. `contentType` names it for the child. */
  body?: string
  contentType?: string
  /** Extra request headers — `Sec-Fetch-Site` / `Origin` for the write-origin suite. */
  extraHeaders?: Record<string, string>
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...options.extraHeaders }
    if (options.hostHeader !== undefined) headers.Host = options.hostHeader
    if (options.body !== undefined) {
      headers["Content-Type"] = options.contentType ?? "application/json"
      headers["Content-Length"] = String(Buffer.byteLength(options.body))
    }
    const req = httpRequest(
      {
        host: options.host,
        port: options.port,
        path: options.path,
        method: options.method ?? "GET",
        headers,
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
    req.end(options.body)
  })
}

const openRegistries: LoopbackListenerRegistry[] = []
const stopReapers: (() => void)[] = []
/** Stand-ins for a server prototype's own process. Closed with the listeners. */
const childServers: Server[] = []

afterEach(async () => {
  for (const stop of stopReapers.splice(0)) stop()
  for (const registry of openRegistries.splice(0)) await registry.closeAll()
  for (const child of childServers.splice(0)) child.close()
})

function makeRegistry(
  files: Files,
  options: {
    now?: () => number
    idleMs?: number
    /**
     * A pre-seeded storage. Every other test here serves from the asset store
     * and never needs a deployment ROW; a `serve: "server"` deployment is the
     * one shape the router reads out of storage, so that test seeds its own.
     */
    storage?: InMemoryStorage
    prototypeProcesses?: PrototypeProcesses
    /** The container case: fixed ports, and a wildcard bind. See `open()`. */
    portRange?: { from: number; to: number } | null
    /** Whether the socket binds every interface instead of a loopback one. See `open()`. */
    bindAllInterfaces?: boolean
  } = {},
) {
  const { storage: seeded, prototypeProcesses, ...registryOptions } = options
  const storage = seeded ?? new InMemoryStorage()
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
        prototypeProcesses: prototypeProcesses ?? nullPrototypeProcesses(),
      }),
    ...registryOptions,
  })
  openRegistries.push(registry)
  return registry
}

const V4 = { bindHost: "127.0.0.1", shellOrigin: SHELL_ORIGIN } as const

function deployment(id: string, slug = "acme") {
  return { id, slug, projectId: `project-${id}`, serve: "static" as const }
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

    /**
     * The container pairing, end to end against a real socket.
     *
     * With a port range configured the bind widens to `0.0.0.0`, which is
     * IPv4 only, so an origin naming `[::1]` would be one the socket cannot
     * answer on — `pairedLoopbackHost` therefore hands back `localhost` for
     * a shell on `127.0.0.1` once it is told a range is set. This drives the
     * full derivation and then actually fetches the origin, because the
     * defect this closes was exactly an origin that parsed fine and refused
     * the connection.
     *
     * The request carries the origin's own `Host` (`localhost:<port>`, which
     * is the only value the listener's one-entry allowlist admits) and
     * connects over IPv4, which is the path a browser takes once its
     * resolver maps `localhost` to `127.0.0.1`. No `::1` anywhere.
     */
    it("a shell on 127.0.0.1 pairs to a localhost listener that answers, when a range is configured", async () => {
      const paired = pairedLoopbackHost("127.0.0.1", { bindAllInterfaces: true })
      expect(paired).toBe("localhost")
      const bindHost = loopbackBindHostFor(paired as "127.0.0.1" | "[::1]" | "localhost")
      expect(bindHost).toBe("localhost")

      // A free port to start the range at, found and released the same way
      // the container test below does it.
      const probe = createServer((_req, res) => res.end())
      await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()))
      const free = (probe.address() as AddressInfo).port
      await new Promise<void>((r) => probe.close(() => r()))

      const registry = makeRegistry(
        { d1: { "index.html": "<html><body>range</body></html>" } },
        { portRange: { from: free, to: free + 3 }, bindAllInterfaces: true },
      )
      const listener = await registry.ensure(deployment("d1"), {
        bindHost,
        shellOrigin: "http://127.0.0.1:3100",
      })
      expect(listener.host).toBe("localhost")
      expect(listener.origin).toBe(`http://localhost:${listener.port}`)
      expect(listener.boundAddress).toBe("0.0.0.0")

      const res = await httpCall({ host: "127.0.0.1", port: listener.port, path: "/", hostHeader: `localhost:${listener.port}` })
      expect(res.status).toBe(200)
      expect(res.body).toContain("range")
    })

    /**
     * The inverse, stated as a refusal rather than trusted: `localhost` is a
     * name a browser may resolve to either family, so it is only ever a
     * legitimate listener host when the socket is on the wildcard — which is
     * exactly when a range is configured. With no range it would have to be
     * passed to `listen()`, and a listener reachable under a name whose
     * family the OS picks is not one origin.
     */
    it("refuses a localhost bind host when no range is configured", async () => {
      const registry = makeRegistry({ d1: {} })
      await expect(
        registry.ensure(deployment("d1"), {
          bindHost: "localhost",
          shellOrigin: "http://127.0.0.1:3100",
        }),
      ).rejects.toThrow(/localhost/i)
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

    /**
     * Codex round 24. A delete closed the listeners it could see; an open
     * still in flight finished afterwards and inserted one nothing would ever
     * close, serving the deleted deployment to anyone who knew the port.
     */
    it("touchOrigin keeps exactly the listener whose origin it names (codex round 27)", async () => {
      let clock = 1_000
      const registry = makeRegistry(
        { d1: { "index.html": "<html></html>" }, d2: { "index.html": "<html></html>" } },
        { now: () => clock },
      )
      const one = await registry.ensure(deployment("d1"), V4)
      const two = await registry.ensure(deployment("d2"), V4)
      clock += 25_000
      registry.touchOrigin(two.origin)
      clock += 10_000
      // d1 is 35s idle and d2 is 10s idle: only d1 is past a 30s bound.
      expect(await registry.reapIdle(clock, 30_000)).toBe(1)
      await expect(
        httpCall({ host: "127.0.0.1", port: one.port, path: "/" }),
      ).rejects.toMatchObject({ code: "ECONNREFUSED" })
      expect((await httpCall({ host: "127.0.0.1", port: two.port, path: "/" })).status).toBe(200)
    })

    it("closeForDeployment waits for an open in flight, closes it, and refuses the deployment from then on", async () => {
      const registry = makeRegistry({ d1: { "index.html": "<html></html>" } })
      const pending = registry.ensure(deployment("d1"), V4)
      await registry.closeForDeployment("d1")
      const settled = await pending.then(
        (listener) => ({ port: listener.port }),
        () => null,
      )
      if (settled) {
        await expect(
          httpCall({ host: "127.0.0.1", port: settled.port, path: "/" }),
        ).rejects.toMatchObject({ code: "ECONNREFUSED" })
      }
      await expect(registry.ensure(deployment("d1"), V4)).rejects.toThrow(/deleted/)
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

  describe("binding from a configured port range", () => {
    /**
     * Two REAL listening servers occupy `takenPort` and `takenPort + 1`, so
     * the only way `ensure` can land on `takenPort + 2` is by trying both
     * taken ports, getting `EADDRINUSE` twice, and moving on — it cannot
     * happen by OS ephemeral-port-allocation coincidence the way a single
     * taken port could (measured: `listen(0, ...)` right after closing one
     * bound port tends to hand back the very next port on this machine, which
     * would make a one-port version of this test pass against the OLD
     * `listen(0, ...)` code with no range logic at all).
     *
     * Both occupy `0.0.0.0`, which is what a registry WITH a range binds (see
     * the container test below). MEASURED on macOS: a wildcard bind succeeds
     * over a port already held on `127.0.0.1` alone, because BSD's
     * `SO_REUSEADDR` treats the two addresses as different — so occupying the
     * loopback address would not produce the `EADDRINUSE` this test is about.
     * The real occupants in a container are this same registry's own
     * listeners, which bind the wildcard too.
     */
    it("binds the first free port in the range and skips two taken ones", async () => {
      const taken1 = createServer((_req, res) => res.end())
      await new Promise<void>((r) => taken1.listen(0, "0.0.0.0", () => r()))
      const takenPort = (taken1.address() as AddressInfo).port

      const taken2 = createServer((_req, res) => res.end())
      await new Promise<void>((r) => taken2.listen(takenPort + 1, "0.0.0.0", () => r()))

      // Spied only AFTER both taken servers are already listening, so their
      // own `.listen()` calls are not recorded — only the registry's own
      // attempts. `listen` lives on `net.Server.prototype` (not
      // `http.Server.prototype`, which inherits it), so that is what has to
      // be spied on to see every attempt the registry's http.Server makes.
      const listenSpy = vi.spyOn(NetServer.prototype, "listen")

      const registry = createLoopbackListenerRegistry({
        // desde-allow-own-server: this Express app is never handed to
        // supertest — the registry wraps it in its own real http.Server, which
        // is the thing under test here (see the module doc comment above).
        makeApp: () => express(),
        portRange: { from: takenPort, to: takenPort + 3 },
        // This test is about the retry/skip loop, not about which interface
        // the bind lands on — the two taken servers below occupy `0.0.0.0`,
        // so the registry's own attempts have to match that address to
        // reliably collide with them (measured on macOS: a specific-address
        // bind does not always conflict with an already-bound wildcard, the
        // asymmetric case of the note above).
        bindAllInterfaces: true,
      })
      try {
        const listener = await registry.ensure(
          { id: "dep-1", slug: "one", projectId: "p", serve: "static" },
          { bindHost: "127.0.0.1", shellOrigin: "http://localhost:3100" },
        )
        expect(listener.port).toBe(takenPort + 2)

        // The landing port alone is not proof of the retry loop: measured on
        // this machine, `listen(0, ...)` right after two explicit binds tends
        // to hand back the very next port regardless, by OS ephemeral-port
        // sequencing — so even a build with NO range/retry logic at all lands
        // on `takenPort + 2` here too. This is the assertion that actually
        // distinguishes them: it fails unless the registry tried
        // `takenPort` and `takenPort + 1` first, got `EADDRINUSE` both times,
        // and only then tried `takenPort + 2`.
        const attemptedPorts = listenSpy.mock.calls
          .map((call) => call[0])
          .filter((port): port is number => typeof port === "number")
        expect(attemptedPorts).toEqual([takenPort, takenPort + 1, takenPort + 2])
      } finally {
        listenSpy.mockRestore()
        await registry.closeAll()
        taken1.close()
        taken2.close()
      }
    })

    /**
     * The container case, measured on Docker Desktop 2026-09-11 (Task 14).
     * A published port DNATs to the container's EXTERNAL interface, never to
     * the container's own loopback, so a listener bound to `127.0.0.1` inside
     * a container answers nothing from the host however the range is
     * published. A configured range is the container signal, so that is when
     * the bind widens.
     *
     * The counterpart — no range, so a loopback bind as before — is "binds
     * 127.0.0.1 only, never 0.0.0.0" above, which asserts the same
     * `boundAddress` field for a registry with no `portRange`.
     */
    it("binds every interface when a range is configured AND bindAllInterfaces is true, and still names the loopback host", async () => {
      const probe = createServer((_req, res) => res.end())
      await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()))
      const free = (probe.address() as AddressInfo).port
      await new Promise<void>((r) => probe.close(() => r()))

      const registry = createLoopbackListenerRegistry({
        // desde-allow-own-server: same as above — wrapped in a real
        // http.Server, never requested through supertest.
        makeApp: () => express(),
        portRange: { from: free, to: free + 3 },
        bindAllInterfaces: true,
      })
      try {
        const listener = await registry.ensure(
          { id: "dep-1", slug: "one", projectId: "p", serve: "static" },
          { bindHost: "127.0.0.1", shellOrigin: "http://localhost:3100" },
        )
        expect(listener.boundAddress).toBe("0.0.0.0")
        // The origin the browser is told to use is unchanged: the loopback
        // spelling paired with the shell, never the bind address.
        expect(listener.host).toBe("127.0.0.1")
        expect(listener.origin).toBe(`http://127.0.0.1:${listener.port}`)
      } finally {
        await registry.closeAll()
      }
    })

    /**
     * Codex round 2, item 1. Before `bindAllInterfaces` existed, ANY
     * configured port range widened the bind to `0.0.0.0` — but an operator
     * can set `VIEWER_LOOPBACK_PORT_RANGE` on a laptop that is not a
     * container, and Docker's port-forwarding NAT is the only reason the
     * container case needs a wildcard bind at all. With `bindAllInterfaces:
     * false`, an explicit range binds the loopback host exactly like the
     * ephemeral-port case ("binds 127.0.0.1 only, never 0.0.0.0" above) —
     * the range only changes WHICH port, never WHICH interface.
     */
    it("binds the loopback host, not 0.0.0.0, for an explicit range when bindAllInterfaces is false", async () => {
      const probe = createServer((_req, res) => res.end())
      await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()))
      const free = (probe.address() as AddressInfo).port
      await new Promise<void>((r) => probe.close(() => r()))

      const registry = createLoopbackListenerRegistry({
        // desde-allow-own-server: same as above — wrapped in a real
        // http.Server, never requested through supertest.
        makeApp: () => express(),
        portRange: { from: free, to: free + 3 },
        // Deliberately omitted, to prove the DEFAULT is also safe: a caller
        // who forgets to pass `bindAllInterfaces` must not get a wildcard
        // bind for free just because a range is configured.
      })
      try {
        const listener = await registry.ensure(
          { id: "dep-1", slug: "one", projectId: "p", serve: "static" },
          { bindHost: "127.0.0.1", shellOrigin: "http://localhost:3100" },
        )
        expect(listener.boundAddress).toBe("127.0.0.1")
        expect(listener.host).toBe("127.0.0.1")
        expect(listener.origin).toBe(`http://127.0.0.1:${listener.port}`)
      } finally {
        await registry.closeAll()
      }
    })

    it("throws LoopbackPortsExhaustedError when every port in the range is taken", async () => {
      const registry = createLoopbackListenerRegistry({
        // desde-allow-own-server: same as above — wrapped in a real
        // http.Server, never requested through supertest.
        makeApp: () => express(),
        portRange: { from: 0, to: -1 }, // empty range: nothing to try
      })
      await expect(
        registry.ensure(
          { id: "dep-1", slug: "one", projectId: "p", serve: "static" },
          { bindHost: "127.0.0.1", shellOrigin: "http://localhost:3100" },
        ),
      ).rejects.toBeInstanceOf(LoopbackPortsExhaustedError)
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

    /**
     * A `serve: "server"` deployment, through a REAL listener socket.
     *
     * The router's own suite drives the fork with the rewritten `/p/{slug}/…`
     * form. This is the shape that actually ships, and it is the one that
     * proves the path handed to the child is right: the listener rewrites
     * `req.url`, but `req.originalUrl` stays the path the caller asked for,
     * which is exactly what the child should see.
     */
    it("proxies a server deployment to its process, at the path the caller asked for", async () => {
      let seen: string | undefined
      const child = createServer((req, res) => {
        seen = req.url
        res.setHeader("content-type", "text/html")
        res.end("<html><body>from the child</body></html>")
      })
      childServers.push(child)
      await new Promise<void>((r) => child.listen(0, "127.0.0.1", () => r()))
      const childPort = (child.address() as AddressInfo).port

      const storage = new InMemoryStorage()
      const project = await storage.createProject({ slug: "one", name: "One" })
      const dep = await storage.createDeployment({ projectId: project.id, status: "deployed" })
      await storage.updateDeployment(dep.id, { serve: "server", serverStart: ["node", "x.js"] })
      const registry = makeRegistry(
        {},
        {
          storage,
          prototypeProcesses: {
            ...nullPrototypeProcesses(),
            ensure: () => Promise.resolve({ port: childPort }),
          },
        },
      )
      const listener = await registry.ensure(
        { id: dep.id, slug: "one", projectId: project.id, serve: "server" },
        V4,
      )

      const res = await httpCall({ host: "127.0.0.1", port: listener.port, path: "/orders?page=2" })
      expect(res.status).toBe(200)
      expect(res.body).toContain("from the child")
      expect(res.body).toContain(`data-shell-origin="${SHELL_ORIGIN}"`)
      expect(res.body).toContain(`src="/__desde/bridge-${BRIDGE_VERSION}.js"`)
      expect(seen).toBe("/orders?page=2")
    })

    /**
     * A form post through a REAL listener socket (task 8b).
     *
     * The write-method fence on a listener runs BEFORE the path is rewritten,
     * so it cannot ask "is this the prototype route?" of the path — every path
     * on this origin is. What it asks instead is what the listener was OPENED
     * for: a listener pinned to a `serve: "server"` deployment fronts a
     * process that legitimately takes writes, and one pinned to a folder of
     * files does not (the test in "what a listener refuses" below is that
     * half). This is the shape that actually ships, through a socket, with a
     * body on the wire.
     */
    it("carries a POST body through to a server deployment's process", async () => {
      let seen: { method?: string; url?: string; contentType?: string; body: string } | null = null
      const child = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on("data", (chunk: Buffer) => chunks.push(chunk))
        req.on("end", () => {
          seen = {
            method: req.method,
            url: req.url,
            contentType: req.headers["content-type"],
            body: Buffer.concat(chunks).toString("utf-8"),
          }
          res.statusCode = 201
          res.setHeader("content-type", "application/json")
          res.end('{"ok":true}')
        })
      })
      childServers.push(child)
      await new Promise<void>((r) => child.listen(0, "127.0.0.1", () => r()))
      const childPort = (child.address() as AddressInfo).port

      const storage = new InMemoryStorage()
      const project = await storage.createProject({ slug: "one", name: "One" })
      const dep = await storage.createDeployment({ projectId: project.id, status: "deployed" })
      await storage.updateDeployment(dep.id, { serve: "server", serverStart: ["node", "x.js"] })
      const registry = makeRegistry(
        {},
        {
          storage,
          prototypeProcesses: {
            ...nullPrototypeProcesses(),
            ensure: () => Promise.resolve({ port: childPort }),
          },
        },
      )
      const listener = await registry.ensure(
        { id: dep.id, slug: "one", projectId: project.id, serve: "server" },
        V4,
      )

      const res = await httpCall({
        host: "127.0.0.1",
        port: listener.port,
        path: "/submit",
        method: "POST",
        body: '{"name":"ada"}',
      })
      expect(res.status).toBe(201)
      expect(res.body).toBe('{"ok":true}')
      expect(seen).toEqual({
        method: "POST",
        url: "/submit",
        contentType: "application/json",
        body: '{"name":"ada"}',
      })
    })

    /**
     * Codex round 10, Fix 1, on the listener's own socket. A listener is
     * always `http:` (`loopback-listener-app.ts`'s `originScheme`), never
     * derived from the request — this is the test that would catch a
     * regression to trusting a request-supplied scheme, since a real socket
     * has no scheme of its own to hand the fence at all.
     */
    it("refuses a POST with Sec-Fetch-Site: cross-site, on a server deployment's own listener", async () => {
      const child = createServer((_req, res) => {
        res.statusCode = 201
        res.end("{}")
      })
      childServers.push(child)
      await new Promise<void>((r) => child.listen(0, "127.0.0.1", () => r()))
      const childPort = (child.address() as AddressInfo).port

      const storage = new InMemoryStorage()
      const project = await storage.createProject({ slug: "one", name: "One" })
      const dep = await storage.createDeployment({ projectId: project.id, status: "deployed" })
      await storage.updateDeployment(dep.id, { serve: "server", serverStart: ["node", "x.js"] })
      const registry = makeRegistry(
        {},
        {
          storage,
          prototypeProcesses: {
            ...nullPrototypeProcesses(),
            ensure: () => Promise.resolve({ port: childPort }),
          },
        },
      )
      const listener = await registry.ensure(
        { id: dep.id, slug: "one", projectId: project.id, serve: "server" },
        V4,
      )

      const res = await httpCall({
        host: "127.0.0.1",
        port: listener.port,
        path: "/submit",
        method: "POST",
        body: "{}",
        extraHeaders: { "Sec-Fetch-Site": "cross-site" },
      })
      expect(res.status).toBe(404)
      expect(res.body).toBe("Not found")
    })

    /**
     * The matching-Origin case, over the SAME real socket: `http://127.0.0.1:
     * <port>` is this listener's own origin, built from the fixed `http:`
     * scheme and the exact `Host` the allowlist already admitted — so a
     * write whose `Origin` names that same origin is let through to the
     * child, same as one with no fetch metadata at all (the earlier test in
     * this block).
     */
    it("admits a POST whose Origin names this listener's own http origin", async () => {
      const child = createServer((_req, res) => {
        res.statusCode = 201
        res.setHeader("content-type", "application/json")
        res.end('{"ok":true}')
      })
      childServers.push(child)
      await new Promise<void>((r) => child.listen(0, "127.0.0.1", () => r()))
      const childPort = (child.address() as AddressInfo).port

      const storage = new InMemoryStorage()
      const project = await storage.createProject({ slug: "one", name: "One" })
      const dep = await storage.createDeployment({ projectId: project.id, status: "deployed" })
      await storage.updateDeployment(dep.id, { serve: "server", serverStart: ["node", "x.js"] })
      const registry = makeRegistry(
        {},
        {
          storage,
          prototypeProcesses: {
            ...nullPrototypeProcesses(),
            ensure: () => Promise.resolve({ port: childPort }),
          },
        },
      )
      const listener = await registry.ensure(
        { id: dep.id, slug: "one", projectId: project.id, serve: "server" },
        V4,
      )

      const res = await httpCall({
        host: "127.0.0.1",
        port: listener.port,
        path: "/submit",
        method: "POST",
        body: "{}",
        extraHeaders: { Origin: `http://127.0.0.1:${listener.port}` },
      })
      expect(res.status).toBe(201)
      expect(res.body).toBe('{"ok":true}')
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

    /**
     * The static half of the write-method rule (task 8b). A listener fronting
     * a folder of files has nothing that could accept a write, so its fence
     * refuses one before the request is even rewritten — the same answer it
     * gave before server prototypes existed. `deployment()` builds a
     * `serve: "static"` deployment, which is what pins this listener.
     */
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
    it("closeForDeployment closes that deployment's listener and leaves the others (codex round 23)", async () => {
      const registry = makeRegistry({ d1: { "index.html": "<html></html>" }, d2: { "index.html": "<html></html>" } })
      const one = await registry.ensure(deployment("d1"), V4)
      const two = await registry.ensure(deployment("d2"), V4)

      await registry.closeForDeployment("d1")

      await expect(
        httpCall({ host: "127.0.0.1", port: one.port, path: "/" }),
      ).rejects.toMatchObject({ code: "ECONNREFUSED" })
      const res = await httpCall({ host: "127.0.0.1", port: two.port, path: "/" })
      expect(res.status).toBe(200)
    })

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
     * Codex round 7, Fix 3. `touch()` at request-start alone was not enough
     * for a response that outlives the idle bound while it is still being
     * answered — an SSE stream, say. The listener now tracks in-flight
     * requests the way `prototype-processes.ts` tracks them for the process
     * itself: a listener with an open response is never reaped, whatever
     * `lastUsedAt` says, and closing the response touches the listener again
     * so the idle clock restarts from the moment it actually went idle.
     *
     * The open response comes from a `serve: "server"` deployment proxied to
     * a real child that writes a first chunk and then holds the connection
     * open — the same shape "proxies a server deployment to its process"
     * above uses, but never ending the response until the test says so.
     */
    it("does not reap a listener with a response still open, and reaps it once the response closes", async () => {
      // An object, not a bare `let`: TypeScript's control-flow narrowing does
      // not track a reassignment that happens only inside a nested callback,
      // so a bare `let endResponse: (() => void) | null = null` reassigned
      // only inside `createServer`'s handler stays narrowed to the literal
      // `null` at every later read, and `endResponse?.()` then fails to
      // typecheck ("Type 'never' has no call signatures") even though the
      // runtime value is set. A property on an object is not narrowed the
      // same way.
      const held: { endResponse: (() => void) | null } = { endResponse: null }
      // Only `/stream` hangs open — the "still answering other requests"
      // probe below hits `/` on the SAME listener and must get an ordinary,
      // immediate reply, not overwrite `held.endResponse` with its own.
      const child = createServer((req, res) => {
        if (req.url === "/stream") {
          res.setHeader("content-type", "text/event-stream")
          res.write("data: hello\n\n")
          held.endResponse = () => res.end()
          return
        }
        res.end("ok")
      })
      childServers.push(child)
      await new Promise<void>((r) => child.listen(0, "127.0.0.1", () => r()))
      const childPort = (child.address() as AddressInfo).port

      const storage = new InMemoryStorage()
      const project = await storage.createProject({ slug: "one", name: "One" })
      const dep = await storage.createDeployment({ projectId: project.id, status: "deployed" })
      await storage.updateDeployment(dep.id, { serve: "server", serverStart: ["node", "x.js"] })

      let clock = 1_000
      const registry = makeRegistry(
        {},
        {
          now: () => clock,
          storage,
          prototypeProcesses: {
            ...nullPrototypeProcesses(),
            ensure: () => Promise.resolve({ port: childPort }),
          },
        },
      )
      const listener = await registry.ensure(
        { id: dep.id, slug: "one", projectId: project.id, serve: "server" },
        V4,
      )

      // Opened, not awaited to completion: the request stays in flight until
      // `endResponse()` is called below.
      const openResponse = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port: listener.port, path: "/stream" })
        req.on("response", resolve)
        req.on("error", reject)
        req.end()
      })
      // Wait for the first chunk, so the request has genuinely reached the
      // listener (and touched it) before the clock moves.
      await new Promise<void>((resolve) => openResponse.once("data", () => resolve()))

      clock += 60_000 // well past any idle bound this test uses below
      expect(await registry.reapIdle(clock, 30_000)).toBe(0)
      // Still answering: the listener's own socket was not closed either.
      const stillUp = await httpCall({ host: "127.0.0.1", port: listener.port, path: "/" })
      expect(stillUp.status).toBe(200)

      held.endResponse?.()
      await new Promise<void>((resolve) => openResponse.once("close", () => resolve()))

      // The release touched the listener, so it is not stale YET…
      expect(await registry.reapIdle(clock, 30_000)).toBe(0)
      // …but it is once the idle bound passes from that touch.
      clock += 60_000
      expect(await registry.reapIdle(clock, 30_000)).toBe(1)
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
