/**
 * The Astro host: what it declares, every reason it refuses before spending a
 * boot, and the shape of the boot it performs.
 *
 * **Why `boot()` IS exercised here, when the React Router host's is not.** That
 * host's boot is a `createServer` call whose only interesting properties are
 * observable over HTTP, so a stub would have been asserting the stub. Astro's
 * boot is different: the load-bearing facts are what it PASSES to `dev()` — the
 * hardening plugin last in the array, `.desde` out of the watcher, the
 * bound port read back rather than assumed — and each of those is a silent
 * failure if it regresses. A stub `astro` package makes all four testable
 * without an Astro install, and the live proof covers what the stub cannot
 * (that the pins actually hold over HTTP, and which extensions hot-update).
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "vite"
import { createAstroHost } from "../host.js"
import { buildStampPolicy } from "../../stamp-policy.js"
import type { HostContext, StamperInjection } from "../../types.js"

const dirs: string[] = []

/** What the stub `dev()` records, so the test can assert on the inline config. */
interface RecordedDevCall {
  root: string
  logLevel: string
  server: { host: string; port: number }
  vite: { plugins: Plugin[]; server: { watch: { ignored: string[] } } }
}
interface StubState {
  calls: RecordedDevCall[]
  stopped: number
}
function stubState(): StubState {
  const globals = globalThis as unknown as { __PT_ASTRO_STUB?: StubState }
  globals.__PT_ASTRO_STUB ??= { calls: [], stopped: 0 }
  return globals.__PT_ASTRO_STUB
}

/**
 * A prototype root with a stub `astro` in `node_modules`.
 *
 * The stub is a REAL file on disk, imported through the same
 * `createRequire(...).resolve` + dynamic-import path the host uses — so
 * resolution, ESM loading and the `typeof dev` assertion are all genuinely
 * exercised. Each project gets a fresh temp dir, which also keeps Node's ESM
 * module cache from serving one test's stub to another.
 */
function project(opts: { astro?: string | false; devExport?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "pt-astro-probe-"))
  dirs.push(root)
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }))

  if (opts.astro !== false) {
    const pkg = join(root, "node_modules", "astro")
    mkdirSync(pkg, { recursive: true })
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "astro",
        version: opts.astro ?? "7.2.0",
        type: "module",
        main: "./index.js",
        exports: { ".": "./index.js", "./package.json": "./package.json" },
      }),
    )
    writeFileSync(
      join(pkg, "index.js"),
      opts.devExport ??
        `export async function dev(config) {
           const g = globalThis
           g.__PT_ASTRO_STUB ??= { calls: [], stopped: 0 }
           g.__PT_ASTRO_STUB.calls.push(config)
           // A port DIFFERENT from the one requested, so a host that assumed
           // its own request rather than reading the address back fails here.
           return {
             address: { address: "127.0.0.1", port: 45999 },
             stop: async () => { g.__PT_ASTRO_STUB.stopped++ },
           }
         }\n`,
    )
  }
  return root
}

function context(prototypeRoot: string, overrides: Partial<HostContext> = {}): HostContext {
  return {
    repoRoot: prototypeRoot,
    prototypeRoot,
    framework: "react",
    languages: ["jsx"],
    policy: buildStampPolicy({ repoRoot: prototypeRoot, buildDirs: [".astro"] }),
    frontDoor: { host: "127.0.0.1", port: 5173 },
    internal: { host: "127.0.0.1", port: 45123 },
    artifactDir: join(tmpdir(), "pt-astro-artifacts"),
    strictVersions: false,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function injection(plugins: Plugin[] = []): Extract<StamperInjection, { channel: "vite-plugin" }> {
  return { channel: "vite-plugin", plugins }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  const globals = globalThis as unknown as { __PT_ASTRO_STUB?: StubState }
  delete globals.__PT_ASTRO_STUB
  vi.restoreAllMocks()
})

describe("the astro host declares", () => {
  const host = createAstroHost()

  it("the proxy as its bridge-tag channel, before and after boot alike", () => {
    // MEASURED: `transformIndexHtml` fires ZERO times on Astro — the served
    // document is Astro's own render. The pre-boot declaration is what stops the
    // plugin-assembly site installing the composed `bridgePlugin`, which would
    // name an injection it never performs and would double-inject the day Vite
    // changed that.
    expect(host.bridgeTags).toBe("proxy-response-injection")
  })

  it("`astro/dev` as an EXPERIMENTAL seam, quoting the expression", () => {
    // Astro's own `dev.d.ts` carries `@experimental The JavaScript API is
    // experimental`. Recording that verbatim is what makes the failure message
    // able to say "nothing is wrong with your project".
    const seam = host.seams.find((s) => s.id === "astro/dev")
    expect(seam?.stability).toBe("experimental")
    expect(seam?.expression).toContain("dev(")
    // The config key is a separate, PUBLIC seam: the two break differently.
    expect(host.seams.find((s) => s.id === "AstroInlineConfig.vite.plugins")?.stability).toBe(
      "public",
    )
  })

  it("Astro's generated directory as build output, and NOT `dist/`", () => {
    expect(host.buildDirs).toEqual([".astro"])
  })
})

describe("stampLanguages — the dual-island answer", () => {
  const host = createAstroHost()

  it("always reports `.astro`, precisely because nothing stamps it", () => {
    // This is the whole mechanism by which the gap is DECLARED rather than
    // silent: `.astro` has no provider, so reporting it here is what puts it in
    // `StampingCoverage.uncovered` and prints it at boot. Omitting it would make
    // the coverage report claim full coverage of a host where the page markup
    // demonstrably has none.
    expect(host.stampLanguages(context("/repo", { languages: [] }), new Set())).toEqual(["astro"])
  })

  it("adds the island dialect single-valued detection found", () => {
    expect(host.stampLanguages(context("/repo", { languages: ["jsx"] }), new Set())).toEqual([
      "astro",
      "jsx",
    ])
    expect(host.stampLanguages(context("/repo", { languages: ["vue-sfc"] }), new Set())).toEqual([
      "astro",
      "vue-sfc",
    ])
  })

  it("widens to BOTH islands when the renderer integrations say so", () => {
    // The genuinely dual-island case, which single-valued detection cannot
    // express. `installed` is empty until the detection rewrite, which is why
    // the assertions above must pass without it.
    expect(
      host.stampLanguages(
        context("/repo", { languages: ["jsx"] }),
        new Set(["astro", "@astrojs/react", "@astrojs/vue"]),
      ),
    ).toEqual(["astro", "jsx", "vue-sfc"])
    // Preact rides the same JSX stamper.
    expect(
      host.stampLanguages(context("/repo", { languages: [] }), new Set(["@astrojs/preact"])),
    ).toEqual(["astro", "jsx"])
  })

  it("never repeats a language, whichever source found it", () => {
    expect(
      host.stampLanguages(
        context("/repo", { languages: ["astro", "jsx", "jsx"] }),
        new Set(["@astrojs/react"]),
      ),
    ).toEqual(["astro", "jsx"])
  })
})

describe("probe refuses before spending a boot", () => {
  const host = createAstroHost()

  it("when astro is declared but not installed", async () => {
    const result = await host.probe(context(project({ astro: false })))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.failure.code).toBe("host-package-missing")
    // Every seam/boot failure is one attach flag away, and the message has to
    // say so — that is the whole point of the ladder underneath it.
    expect(result.failure.attachCovers).toBe(true)
    expect(result.failure.remediation.join("\n")).toContain("--attach")
  })

  it("when `dev` is no longer a function — the experimental-API break", async () => {
    const result = await host.probe(
      context(project({ devExport: "export const dev = 42\n" })),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.failure.code).toBe("seam-shape-changed")
    // The message must NAME the seam and its stability, so the fix is greppable
    // and the user is told their project is fine.
    expect(result.failure.seam?.id).toBe("astro/dev")
    expect(result.failure.seam?.stability).toBe("experimental")
    expect(result.failure.cause).toContain("number")
  })

  it("when the module cannot be loaded at all", async () => {
    const result = await host.probe(
      context(project({ devExport: "this is not valid javascript ((\n" })),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.failure.code).toBe("seam-missing")
    expect(result.failure.seam?.id).toBe("astro/dev")
  })
})

describe("probe accepts, with notices", () => {
  const host = createAstroHost()

  it("always saying the seam is experimental — measured version or not", async () => {
    const result = await host.probe(context(project({ astro: "7.2.0" })))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.version).toBe("7.2.0")
    expect(result.notices.join("\n")).toContain("@experimental")
    // One notice for a measured version: the experimental one, and nothing else.
    expect(result.notices).toHaveLength(1)
  })

  it("adding a version notice outside the measured major, without refusing", async () => {
    const result = await host.probe(context(project({ astro: "9.0.0" })))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.notices.join("\n")).toContain("9.0.0")
    // A notice, not a refusal: `verifyStamping` is the real gate.
    expect(result.notices).toHaveLength(2)
  })

  it("escalating that notice to a refusal only under --strict-versions", async () => {
    const result = await host.probe(
      context(project({ astro: "9.0.0" }), { strictVersions: true }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.failure.code).toBe("host-version-unsupported")
    expect(result.failure.detected).toEqual({
      package: "astro",
      installed: "9.0.0",
      tested: "^7.0.0",
    })
  })
})

describe("boot hands Astro an inline config that", () => {
  const host = createAstroHost()

  async function boot(ctx: HostContext, plugins: Plugin[] = []) {
    // The capture-count warning is expected here: a stub `dev()` runs no plugin
    // hooks, so no Vite server is ever captured.
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const result = await host.boot(ctx, injection(plugins), null)
    return { result, call: stubState().calls[0] as RecordedDevCall }
  }

  it("puts the hardening plugin LAST, after everything the pipeline injected", async () => {
    const stamper: Plugin = { name: "@desde/editor-jsx-source-tag-plugin" }
    const bridge: Plugin = { name: "@desde/editor-bridge-assets" }
    const { call } = await boot(context(project()), [stamper, bridge])

    const names = call.vite.plugins.map((p) => p.name)
    expect(names.slice(0, 2)).toEqual([
      "@desde/editor-jsx-source-tag-plugin",
      "@desde/editor-bridge-assets",
    ])
    // Last in the array AND `enforce: 'post'` internally, so it is last in the
    // post bucket by both orderings. A repo plugin that re-widens `fs.strict` or
    // `allowedHosts` in its own hook is what this ordering is for.
    expect(names[names.length - 1]).toBe("@desde/editor-harden")
  })

  it("keeps Editor's own `.desde` bookkeeping out of the watcher", async () => {
    // On this host a stray watcher event is worse than an HMR round: Astro
    // restarts its whole container on some file changes.
    const { call } = await boot(context(project()))
    expect(call.vite.server.watch.ignored).toEqual(["**/.desde/**"])
  })

  it("roots Astro at the prototype and asks for the internal loopback port", async () => {
    const root = project()
    const { call } = await boot(context(root, { internal: { host: "127.0.0.1", port: 45123 } }))
    expect(call.root).toBe(root)
    expect(call.logLevel).toBe("warn")
    expect(call.server).toEqual({ host: "127.0.0.1", port: 45123 })
  })

  it("never passes the literal port 0 through to the framework", async () => {
    // `HostContext.internal.port` is `0` meaning "you pick". Forwarding that
    // literal is MEASURED wrong on Vite 8.0.8, which reads it as UNSET and binds
    // 5173 — the front door's own port. `pickLoopbackPort` resolves it to a
    // concrete number first.
    const { call } = await boot(context(project(), { internal: { host: "127.0.0.1", port: 0 } }))
    expect(call.server.port).not.toBe(0)
    expect(call.server.port).toBeGreaterThan(0)
  })
})

describe("boot reports", () => {
  const host = createAstroHost()

  async function bootResult(ctx: HostContext = context(project())) {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    return host.boot(ctx, injection(), null)
  }

  it("the port Astro ACTUALLY bound, not the one we asked for", async () => {
    // MEASURED and load-bearing: with a squatter on the requested port, Astro
    // does not fail — it binds the next one and reports it. The stub returns a
    // deliberately different port for exactly this assertion.
    const boot = await bootResult(context(project(), { internal: { host: "127.0.0.1", port: 45123 } }))
    expect(boot.transport).toEqual({ kind: "http-upstream", origin: "http://127.0.0.1:45999" })
  })

  it("`/` as its base — the FRONT DOOR's, never an inner Vite's", async () => {
    const boot = await bootResult()
    expect(boot.base).toBe("/")
  })

  it("Astro's own listener as a disclosed side door", async () => {
    // Astro binds its own port and offers no way not to. Loopback + ephemeral is
    // the mitigation; this field is the disclosure.
    const boot = await bootResult()
    expect(boot.sideDoorOrigins).toEqual(["http://127.0.0.1:45999"])
  })

  it("`partial` stamping — the verdict that can never tear a session down", async () => {
    // Astro server-renders its document, which would normally make zero stamps
    // conclusive. It is not, because the half of the page with no stamper
    // (`.astro` markup) is the half that is always present. MEASURED on a
    // no-island fixture: a fully working Astro page serves ZERO stamps. § 6's
    // conjunction requires `required-in-html`, so `partial` can only ever warn.
    const boot = await bootResult()
    expect(boot.stampExpectation).toBe("partial")
  })

  it("the ONE-lane HMR shape, with `.astro` on the full-reload side", async () => {
    const boot = await bootResult()
    // ONE, not Nuxt's two: MEASURED, `configureServer` fires exactly once.
    expect(boot.hmr.lanes).toEqual(["client"])
    // MEASURED by reading the HMR websocket frames: a `.tsx` edit produced
    // `update(js-update)` and an `.astro` edit produced `full-reload`. This is
    // the one place the "client state survives an edit" assumption breaks.
    expect(boot.hmr.reload.hot).toEqual([".tsx", ".jsx"])
    expect(boot.hmr.reload.fullReload).toEqual([".astro"])
  })

  it("no security gap — the pins hold here, and the proxy is a second floor", async () => {
    const boot = await bootResult()
    expect(boot.security.narrowedServerConfig).toBe(true)
    expect(boot.security.gaps).toEqual([])
  })

  it("degraded-but-safe evidence and invalidation when no Vite server was captured", async () => {
    // The stub runs no plugin hooks, so this is the "a hook we rely on did not
    // run" path. `invalidate` is best-effort by contract and must never throw
    // into an edit response; `moduleGraphEvidence` may only ever PROMOTE a
    // verdict, so answering `false` is the correct absence of evidence.
    const boot = await bootResult()
    expect(() => boot.hmr.invalidate(["/repo/src/App.tsx"])).not.toThrow()
    await expect(boot.moduleGraphEvidence?.()).resolves.toBe(false)
  })

  it("a close that reaches Astro's own stop()", async () => {
    const boot = await bootResult()
    await boot.close()
    expect(stubState().stopped).toBe(1)
  })
})

describe("boot refuses a DevServer of the wrong shape", () => {
  const host = createAstroHost()

  it("naming the experimental seam, and taking the listener down with it", async () => {
    // The failure an experimental API earns: everything downstream reads
    // `address.port`, so a shape change must produce one sentence rather than a
    // TypeError three frames deeper — and the server it just started must not be
    // left bound to a port nothing points at.
    const root = project({
      devExport: `export async function dev() {
         const g = globalThis
         g.__PT_ASTRO_STUB ??= { calls: [], stopped: 0 }
         return { address: null, stop: async () => { g.__PT_ASTRO_STUB.stopped++ } }
       }\n`,
    })
    await expect(host.boot(context(root), injection(), null)).rejects.toThrow(
      /without a bound TCP address/,
    )
    expect(stubState().stopped).toBe(1)
  })
})
