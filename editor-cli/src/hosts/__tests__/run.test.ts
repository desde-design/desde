/**
 * The boot pipeline, driven with a host that never binds a port.
 *
 * `runResolvedHost` exists as a separate export precisely so this is possible:
 * everything the pipeline itself decides — which policy the stampers get, what
 * happens to a probe refusal, what the injected plugin array ends up being,
 * whether a transport it cannot front is allowed to stay up — is testable
 * without a dev server. The real Vite boot is covered next door in
 * `vite-host-boot-shape.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { promises as fs } from "node:fs"
import { createServer as createHttpServer } from "node:http"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"
import { decide } from "../ladder.js"
import { materializeNextLoader } from "../next/loader-cache.js"
import { TURBOPACK_LOADER_ASSET } from "../stampers.js"
import { runResolvedHost, HostBootError, type HostRunOptions } from "../run.js"
import type {
  BridgeTagStrategy,
  DevServerHost,
  HostBoot,
  HostContext,
  HostFailure,
  HostSeam,
  HostTransport,
  ProbeResult,
  StamperInjection,
  StampPolicy,
} from "../types.js"

const REPO = join(sep, "tmp", "fixture-repo")
const REPO_REAL = join(sep, "private", "tmp", "fixture-repo")

/**
 * What the proxy front door would serve, for a host that never gets fronted.
 *
 * The paths deliberately do NOT exist. `startAttachProxy` reads the bundle
 * synchronously at construction, so if the pipeline ever started fronting a
 * `direct` host these tests would fail loudly instead of quietly exercising a
 * path they mean to exclude.
 */
const UNUSED_BRIDGE = {
  bundlePath: join(sep, "nonexistent", "bridge-bundle.js"),
  html2canvasPath: join(sep, "nonexistent", "html2canvas.min.js"),
  shellOrigin: "http://127.0.0.1:4321",
}

/** `<repo>/…`, from `editor-cli/src/hosts/__tests__/` — the same walk `core.ts` does. */
function repoFile(...segments: string[]): string {
  return resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..", ...segments)
}
const resolveBridgeBundlePath = (): string => repoFile("dist", "bridge-bundle.js")
const resolveHtml2canvasPath = (): string =>
  repoFile("public", "vendor", "html2canvas.min.js")

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      const port = typeof address === "object" && address ? address.port : 0
      probe.close(() => resolvePort(port))
    })
  })
}

interface FakeHostSpec {
  buildDirs?: readonly string[]
  bridgeTags?: BridgeTagStrategy
  probe?: ProbeResult
  transport?: HostTransport
  /** The host's designated stamper seam, if it has one. Listed in `seams` too. */
  stamperSeam?: HostSeam
  /** Invoked with the injected plugin array, so a fake can act like Vite. */
  onBoot?: (injection: Extract<StamperInjection, { channel: "vite-plugin" }>) => void
}

interface FakeHost {
  host: DevServerHost<"vite-plugin">
  /** Everything the pipeline handed the host, for assertions. */
  seen: {
    ctx: HostContext | null
    injection: Extract<StamperInjection, { channel: "vite-plugin" }> | null
    bootCalls: number
    closeCalls: number
  }
}

function fakeHost(spec: FakeHostSpec = {}): FakeHost {
  const seen: FakeHost["seen"] = { ctx: null, injection: null, bootCalls: 0, closeCalls: 0 }
  const host: DevServerHost<"vite-plugin"> = {
    id: "vite",
    displayName: "Fake",
    seams: spec.stamperSeam ? [spec.stamperSeam] : [],
    ...(spec.stamperSeam ? { stamperSeam: spec.stamperSeam } : {}),
    versionGate: { packageName: "fake", tested: "*" },
    accepts: "vite-plugin",
    devCommand: "npx fake",
    bridgeTags: spec.bridgeTags ?? "vite-transform-index-html",
    buildDirs: spec.buildDirs ?? [],
    stampLanguages: () => ["vue-sfc"],
    probe: async (ctx) => {
      seen.ctx = ctx
      return spec.probe ?? { ok: true, version: "1.0.0", notices: [] }
    },
    boot: async (ctx, injection): Promise<HostBoot> => {
      seen.bootCalls += 1
      seen.ctx = ctx
      seen.injection = injection
      spec.onBoot?.(injection)
      return {
        transport: spec.transport ?? { kind: "direct", origin: "http://127.0.0.1:4444" },
        base: "/",
        bridgeTags: spec.bridgeTags ?? "vite-transform-index-html",
        hmr: { lanes: [], invalidate: () => undefined, reload: { hot: [], fullReload: [] } },
        security: { narrowedServerConfig: false, overridden: [], gaps: [] },
        stampExpectation: "module-graph",
        sideDoorOrigins: [],
        probeRoutes: [],
        close: async () => {
          seen.closeCalls += 1
        },
      }
    },
  }
  return { host, seen }
}

interface TurbopackFakeHost {
  host: DevServerHost<"turbopack-loader">
  seen: {
    turbopack: Extract<StamperInjection, { channel: "turbopack-loader" }> | null
    bootCalls: number
    closeCalls: number
  }
}

/**
 * A host on the OTHER channel — the shape the Next host has.
 *
 * Separate from {@link fakeHost} rather than parameterised, because the two are
 * genuinely different types: `boot`'s injection parameter is narrowed by
 * `accepts`, and a fake that pretended to accept both would have to cast away
 * the exact property the pipeline's narrowing is there to enforce.
 */
function turbopackHost(spec: {
  files: Record<string, string>
  /**
   * Replaces the default "hand back `files`" materializer — which is how a test
   * drives the REAL `materializeNextLoader` through the pipeline instead of a
   * stub of it.
   */
  materialize?: DevServerHost<"turbopack-loader">["materialize"]
}): TurbopackFakeHost {
  const seen: TurbopackFakeHost["seen"] = { turbopack: null, bootCalls: 0, closeCalls: 0 }
  const host: DevServerHost<"turbopack-loader"> = {
    id: "next",
    displayName: "Fake Next",
    seams: [],
    versionGate: { packageName: "next", tested: "*" },
    accepts: "turbopack-loader",
    devCommand: "npx next dev",
    bridgeTags: "proxy-response-injection",
    buildDirs: [".next"],
    stampLanguages: () => ["jsx"],
    probe: async () => ({ ok: true, version: "16.3.0", notices: [] }),
    materialize: spec.materialize ?? (async () => ({ files: spec.files })),
    boot: async (_ctx, injection): Promise<HostBoot> => {
      seen.bootCalls += 1
      seen.turbopack = injection
      return {
        transport: { kind: "direct", origin: "http://127.0.0.1:4444" },
        base: "/",
        bridgeTags: "proxy-response-injection",
        hmr: { lanes: [], invalidate: () => undefined, reload: { hot: [], fullReload: [] } },
        security: { narrowedServerConfig: false, overridden: [], gaps: [] },
        stampExpectation: "required-in-html",
        sideDoorOrigins: [],
        probeRoutes: [],
        close: async () => {
          seen.closeCalls += 1
        },
      }
    },
  }
  return { host, seen }
}

function options(overrides: Partial<HostRunOptions> = {}): HostRunOptions {
  return {
    hostId: "vite",
    repoRoot: REPO,
    repoRootReal: REPO_REAL,
    prototypeRoot: REPO,
    framework: "vue3",
    frontDoor: { host: "127.0.0.1", port: 4444 },
    bridge: UNUSED_BRIDGE,
    plugins: () => [],
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("runResolvedHost — the stamp policy", () => {
  it("carries the symlink-resolved root, and anchors stamps at it", async () => {
    let policy: StampPolicy | null = null
    const { host } = fakeHost()
    const run = await runResolvedHost(
      host,
      options({
        plugins: (p) => {
          policy = p
          return []
        },
      }),
    )
    await run.close()

    // `repoRootReal` reaching the stampers is the whole bug milestone 1 fixed;
    // the pipeline is now the thing responsible for not dropping it again.
    expect(policy).not.toBeNull()
    expect(policy!.roots).toEqual(expect.arrayContaining([REPO, REPO_REAL]))
    expect(policy!.stampRoot).toBe(REPO_REAL)
  })

  it("denies the host's own build dirs, resolved against the PROTOTYPE root", async () => {
    let policy: StampPolicy | null = null
    // A monorepo-style prototype: the git root is REPO, the framework roots at
    // a subdir, and `.nuxt` is created next to the framework's config — not at
    // the git root.
    const prototypeRoot = join(REPO, "apps", "web")
    const { host } = fakeHost({ buildDirs: [".nuxt", "dist"] })
    const run = await runResolvedHost(
      host,
      options({
        prototypeRoot,
        plugins: (p) => {
          policy = p
          return []
        },
      }),
    )
    await run.close()

    // Both aliases, not just the typed one. This fixture's repo root is
    // symlinked (/tmp -> /private/tmp, i.e. what macOS does), and Vite anchors
    // the ids it hands the stamper at the RESOLVED path. An earlier version of
    // this assertion listed only the two typed paths, which is precisely the
    // state in which `.nuxt` output got stamped: containment admitted it
    // through the resolved root while the denial only knew the typed one.
    const realPrototypeRoot = join(REPO_REAL, "apps", "web")
    expect(policy!.denyDirs).toEqual(
      expect.arrayContaining([
        join(prototypeRoot, ".nuxt"),
        join(prototypeRoot, "dist"),
        join(realPrototypeRoot, ".nuxt"),
        join(realPrototypeRoot, "dist"),
      ]),
    )
  })
})

describe("runResolvedHost — the injection", () => {
  it("appends the capture plugin after the caller's own, and never in front", async () => {
    const caller: Plugin[] = [{ name: "caller-a" }, { name: "caller-b" }]
    const { host, seen } = fakeHost()
    const run = await runResolvedHost(host, options({ plugins: () => caller }))
    await run.close()

    expect(seen.injection?.channel).toBe("vite-plugin")
    expect(seen.injection?.plugins.map((p) => p.name)).toEqual([
      "caller-a",
      "caller-b",
      "@desde/editor-vite-capture",
    ])
  })

  it("keeps the captured server OFF the handle, even when there is one", async () => {
    // The leak-plugging milestone's runtime claim. The handle used to carry
    // `vite: { server }` set to `capture.servers[0]`, and every consumer that
    // wanted anything from the dev server went through it — which on a two-lane
    // host (Nuxt) silently meant "the client lane". Nothing downstream may be
    // able to reach a dev server through the handle at all now.
    //
    // A KEY assertion, not a type assertion: `tsc` already refuses `run.vite`,
    // and a compile error proves nothing about what the object carries at
    // runtime. This fails against the pre-milestone code.
    const server = { moduleGraph: {}, marker: "the-real-one" }
    const { host } = fakeHost({
      onBoot: (injection) => {
        for (const plugin of injection.plugins) {
          const hook = plugin.configureServer
          if (typeof hook === "function") (hook as (s: unknown) => void)(server)
        }
      },
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const run = await runResolvedHost(host, options())

    expect(Object.keys(run)).not.toContain("vite")
    // …and the value did not merely move to a differently-named member.
    expect(JSON.stringify(Object.values(run))).not.toContain("the-real-one")
    // The capture still has ONE consumer in `run.ts` — the warning below — and
    // it must stay silent here, or "nothing was captured" would be reported on
    // every boot and stop meaning anything.
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("no Vite server was captured"))
    await run.close()
  })

  it("warns loudly when nothing was captured rather than degrading in silence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    // The default fake never invokes `configureServer`.
    const { host } = fakeHost()
    const run = await runResolvedHost(host, options())
    await run.close()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no Vite server was captured"))
  })

  it("builds the Turbopack injection from what the host materialized", async () => {
    // The second channel. Nothing about it looks like the Vite one: a file path
    // plus JSON that has to survive Turbopack's forked loader worker, and no
    // plugin array at all — so the caller's `plugins` callback must not even be
    // consulted.
    const loaderPath = join(sep, "tmp", "pt-cache", "next-loader.cjs")
    let pluginsCalled = 0
    const { host, seen } = turbopackHost({ files: { [loaderPath]: "turbopack-loader" } })

    const run = await runResolvedHost(
      host,
      options({
        plugins: () => {
          pluginsCalled += 1
          return []
        },
      }),
    )
    await run.close()

    expect(pluginsCalled).toBe(0)
    expect(seen.turbopack).toEqual({
      channel: "turbopack-loader",
      loaderPath,
      // BOTH extensions: a `*.tsx` rule alone leaves every `.jsx` file
      // unstamped, which is a page that renders fine and refuses every edit.
      globs: ["*.tsx", "*.jsx"],
      options: {
        repoRoot: REPO_REAL,
        policy: expect.objectContaining({ stampRoot: REPO_REAL }),
      },
    })
  })

  it("refuses a turbopack host that materialized no loader, before booting", async () => {
    // The failure this prevents is the silent one: a host with no stamper
    // registered boots a perfectly healthy dev server and stamps nothing.
    const { host, seen } = turbopackHost({ files: {} })
    const err = await runResolvedHost(host, options()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HostBootError)
    // The refusal's own sentence survives verbatim as the cause — it is the
    // only thing in the output that says WHICH invariant broke.
    expect((err as HostBootError).message).toMatch(/nothing to register/)
    expect(seen.bootCalls).toBe(0)
  })

  it("does not warn about an empty Vite capture on a host that has no Vite", async () => {
    // Gated on the CHANNEL rather than the host id. A warning printed on every
    // Next boot for the expected state is how the same warning stops being read
    // on the Vite hosts, where it means something.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const loaderPath = join(sep, "tmp", "pt-cache", "next-loader.cjs")
    const { host } = turbopackHost({ files: { [loaderPath]: "turbopack-loader" } })

    const run = await runResolvedHost(host, options())
    await run.close()

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("no Vite server was captured"))
  })
})

describe("runResolvedHost — refusals", () => {
  it("throws the probe's own failure, and never boots", async () => {
    const failure: HostFailure = {
      code: "seam-missing",
      summary: "The seam is gone.",
      seam: {
        id: "next/dist/server/config",
        stability: "private",
        expression: 'require("next/dist/server/config")',
        buys: "the stamper channel",
      },
      cause: "Cannot find module",
      remediation: ["Re-run with --attach <url>."],
      attachCovers: true,
    }
    const { host, seen } = fakeHost({ probe: { ok: false, failure } })

    const err = await runResolvedHost(host, options()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HostBootError)
    expect((err as HostBootError).failure).toBe(failure)
    // The rendered message has to carry the seam, or the user is told "it
    // broke" with nothing to search for.
    expect((err as HostBootError).message).toContain("next/dist/server/config")
    expect((err as HostBootError).message).toContain("Cannot find module")
    expect(seen.bootCalls).toBe(0)
    // …and the host it came from, so `core.ts` can hand the whole thing to the
    // ladder. Without this the failure renders as a bare "Failed to start
    // editor" and the user never sees their framework's dev command.
    expect((err as HostBootError).host).toEqual({
      id: "vite",
      displayName: "Fake",
      devCommand: "npx fake",
    })
  })

  it("tears the upstream down when the front door itself fails to start", async () => {
    // `UNUSED_BRIDGE` points at a bundle that does not exist, so
    // `startAttachProxy` rejects — standing in for any reason the front door
    // cannot bind. The upstream is already listening by then; leaving it up
    // would leak a dev server on a loopback port with nothing pointing at it.
    const { host, seen } = fakeHost({
      transport: { kind: "http-upstream", origin: "http://127.0.0.1:5555" },
      bridgeTags: "proxy-response-injection",
    })

    await expect(runResolvedHost(host, options())).rejects.toThrow()
    expect(seen.bootCalls).toBe(1)
    expect(seen.closeCalls).toBe(1)
  })
})

/**
 * Everything after the probe has to arrive at `core.ts` as a `HostBootError`,
 * because that is the only type its catch recognises: anything else bypasses
 * the ladder and prints a bare "Failed to start editor" on exit 1, with no dev
 * command and no `--attach` fallback for a condition attach mode covers whole.
 *
 * MEASURED before the wrap existed, with two independent triggers — the real
 * `materializeNextLoader` against an unwritable cache home, and a host whose
 * `boot()` threw `listen EADDRINUSE` — both reaching the caller with
 * `isHostBootError: false` and `name: "Error"`.
 */
describe("runResolvedHost — post-probe failures reach the ladder", () => {
  const tempRoots: string[] = []

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
  })

  /**
   * A cache home that cannot be created, because a path component of it is a
   * regular FILE.
   *
   * That trigger rather than `chmod 0500` on purpose: a suite running as root
   * ignores the mode bit and Windows ignores it entirely, so the permission
   * version is a test that can silently stop testing. ENOTDIR is refused for
   * every user on every platform. MEASURED equivalent to the shipping
   * condition (`XDG_CACHE_HOME` on a read-only mount): both surface out of
   * `writeStamperFiles`'s `mkdir`, and `materializeNextLoader` wraps both in
   * the same "could not write the Next.js source-code stamper to …" error.
   */
  async function uncreatableCacheHome(): Promise<string> {
    const dir = await fs.mkdtemp(join(tmpdir(), "pt-cache-home-"))
    tempRoots.push(dir)
    const file = join(dir, "occupied")
    await fs.writeFile(file, "a file, where a directory would have to be")
    return join(file, "cache")
  }

  it("wraps a materialize failure, with the materializer's own words as the cause", async () => {
    const cacheRoot = await uncreatableCacheHome()
    // The REAL materializer, so this is the shipped failure and not a stub of
    // it: `hosts/next/host.ts` calls exactly this, and § 6's risk register
    // lists "loader cache dir unwritable → materialize throws → attach".
    const { host, seen } = turbopackHost({
      files: {},
      materialize: async () => {
        const m = await materializeNextLoader({ cacheRoot })
        return { files: { [m.loaderPath]: TURBOPACK_LOADER_ASSET } }
      },
    })

    const err = await runResolvedHost(host, options()).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(HostBootError)
    const failure = (err as HostBootError).failure
    expect(failure.code).toBe("boot-failed")
    // Attach mode writes its stamper into the prototype instead of the cache
    // home, so it genuinely is not blocked by this — which is what earns the
    // ladder's "pass --attach" advice.
    expect(failure.attachCovers).toBe(true)
    expect(failure.cause).toContain("could not write the Next.js source-code stamper to")
    expect(seen.bootCalls).toBe(0)

    // The consequence, asserted rather than inferred: the same failure through
    // the ladder now yields the message with the framework's own dev command.
    const decision = decide("auto", failure, (err as HostBootError).host)
    expect(decision.action).toBe("require-attach")
    expect(decision.action === "require-attach" && decision.message).toContain("npx next dev")
  })

  it("wraps a boot failure, and keeps the framework's error text searchable", async () => {
    const { host, seen } = fakeHost({
      onBoot: () => {
        throw new Error("listen EADDRINUSE: address already in use 127.0.0.1:5173")
      },
    })

    const err = await runResolvedHost(host, options()).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(HostBootError)
    const failure = (err as HostBootError).failure
    expect(failure.code).toBe("boot-failed")
    expect(failure.attachCovers).toBe(true)
    // Verbatim, untruncated. Rewording a framework's boot error would throw
    // away the one string in the output the user can search for.
    expect(failure.cause).toBe("listen EADDRINUSE: address already in use 127.0.0.1:5173")
    expect(seen.bootCalls).toBe(1)

    const decision = decide("auto", failure, (err as HostBootError).host)
    expect(decision.action).toBe("require-attach")
    expect(decision.action === "require-attach" && decision.message).toContain("npx fake")
  })
})

describe("runResolvedHost — the proxy front door", () => {
  it("serves a fronted host through the proxy, injecting the bridge and refusing .desde", async () => {
    // A stand-in upstream: the point under test is the pipeline's fronting, not
    // any particular framework's HTML.
    const upstream = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" })
      res.end("<html><head></head><body>upstream</body></html>")
    })
    await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done))
    const upstreamAddress = upstream.address()
    if (upstreamAddress === null || typeof upstreamAddress === "string") {
      throw new Error("upstream did not bind")
    }

    const { host, seen } = fakeHost({
      transport: { kind: "http-upstream", origin: `http://127.0.0.1:${upstreamAddress.port}` },
      bridgeTags: "proxy-response-injection",
    })

    const frontPort = await freePort()
    const run = await runResolvedHost(
      host,
      options({
        frontDoor: { host: "127.0.0.1", port: frontPort },
        // A REAL bundle: the proxy reads it at construction and its version
        // becomes the injected script's cache key.
        bridge: {
          bundlePath: resolveBridgeBundlePath(),
          html2canvasPath: resolveHtml2canvasPath(),
          shellOrigin: "http://127.0.0.1:4321",
        },
      }),
    )

    try {
      // The handle points at the PROXY, not at what the host bound. A handle
      // carrying the upstream origin would serve the prototype with no bridge.
      expect(run.url).toBe(`http://127.0.0.1:${frontPort}`)
      expect(run.url).not.toContain(String(upstreamAddress.port))

      const html = await fetch(`${run.url}/`).then((r) => r.text())
      expect(html).toContain("upstream")
      expect(html).toContain('data-prototype-flow="bridge"')
      expect(html).toContain('data-shell-origin="http://127.0.0.1:4321"')

      // The floor the proxy adds over an upstream we do not control.
      const refused = await fetch(`${run.url}/.desde/chat-sessions/s1.json`)
      expect(refused.status).toBe(403)
    } finally {
      await run.close()
      await new Promise<void>((done) => upstream.close(() => done()))
    }

    // ONE close, reaching both listeners: the proxy's own, then the host's
    // through `onClose`.
    expect(seen.closeCalls).toBe(1)
    await expect(fetch(`http://127.0.0.1:${frontPort}/`)).rejects.toThrow()
  })
})

describe("runResolvedHost — the handle", () => {
  it("projects the boot result onto the shipped handle shape", async () => {
    const { host, seen } = fakeHost()
    const run = await runResolvedHost(host, options())

    expect(run.url).toBe("http://127.0.0.1:4444")
    expect(run.base).toBe("/")
    expect(run.hostId).toBe("vite")
    expect(run.boot.stampExpectation).toBe("module-graph")

    await run.close()
    expect(seen.closeCalls).toBe(1)
  })

  it("aborts the context signal on close, so a host can hang cleanup off it", async () => {
    const { host, seen } = fakeHost()
    const run = await runResolvedHost(host, options())

    expect(seen.ctx?.signal.aborted).toBe(false)
    await run.close()
    expect(seen.ctx?.signal.aborted).toBe(true)
  })

  it("forwards an already-aborted caller signal into the context", async () => {
    const controller = new AbortController()
    controller.abort()
    const { host, seen } = fakeHost()
    const run = await runResolvedHost(host, options({ signal: controller.signal }))

    expect(seen.ctx?.signal.aborted).toBe(true)
    await run.close()
  })

  it("carries the host's designated stamper seam onto the run", async () => {
    // `HostRun.host` is a DESCRIPTOR — three fields, deliberately, so a failure
    // path cannot boot the host a second time — and a descriptor cannot answer
    // "which seam carries your stamper". Without this copy the seam is
    // unreachable from `core.ts`, which is the only place that builds the
    // verification request, and the healthy-but-unstamped refusal renders
    // seam-free (MEASURED: `messageNamesSeamId: false`).
    const seam: HostSeam = {
      id: "fake/dist/server/config",
      stability: "private",
      expression: 'require("fake/dist/server/config")',
      buys: "the only in-memory channel for the source-code stamper",
    }
    const { host } = fakeHost({ stamperSeam: seam })

    const run = await runResolvedHost(host, options())

    // By identity: the run must carry the host's own object, not a copy that
    // could drift from the seam table rendered beside it.
    expect(run.stamperSeam).toBe(seam)
    await run.close()
  })

  it("leaves it undefined for a host that designates none", async () => {
    // Most hosts. `verifyStamping` renders the seam only when one is supplied,
    // so undefined here is what keeps a made-up seam out of a failure whose
    // defining property is that nothing threw.
    const { host } = fakeHost()
    const run = await runResolvedHost(host, options())

    expect(run.stamperSeam).toBeUndefined()
    await run.close()
  })
})
