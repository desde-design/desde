/**
 * The Nuxt host: what it declares, every reason it refuses before spending a
 * boot, and — the part this host exists for — what it does with TWO Vite lanes.
 *
 * **Why `boot()` IS exercised here.** The load-bearing facts are not observable
 * over HTTP: that an edit is replayed into BOTH lanes, that the stamp verdict is
 * computed from the lane count rather than hardcoded, and that the module-graph
 * walk asks every lane rather than the first. Each of those is a SILENT failure
 * if it regresses — a client-only invalidation looks exactly like an edit that
 * did not take, and a client-only graph walk tears down a working session. A
 * stub `@nuxt/cli` that runs the plugin hooks Nuxt runs makes all three testable
 * without a Nuxt install; the live proof covers what the stub cannot (that the
 * pins hold over HTTP, and which extensions hot-update).
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "vite"
import { createNuxtHost } from "../host.js"
import { buildStampPolicy } from "../../stamp-policy.js"
import type { HostContext, StamperInjection } from "../../types.js"

const dirs: string[] = []

/** A lane the stub hands to `configureServer`, plus what the test asserts on. */
interface StubLane {
  config: { build: { ssr: boolean }; base: string; root: string; server: Record<string, unknown> }
  watcher: { emitted: string[]; emit(event: string, file: string): void }
  moduleGraph: { urlToModuleMap: Map<string, { transformResult: { code: string } | null }> }
  transformRequest(url: string): Promise<null>
}

interface RecordedCall {
  name: string
  argv: string[]
  overrides: {
    devServer: { host: string; port: number }
    vite: { plugins: Plugin[]; server: { watch: { ignored: string[] } } }
  }
}

interface StubState {
  calls: RecordedCall[]
  closed: number
  /** `build.ssr` per lane the stub will hand to `configureServer`. */
  laneSsr: boolean[]
  /** Lane indexes whose module graph carries a stamped module. */
  stampedLanes: number[]
  /** What Nuxt's own config says `server.allowedHosts` is, before our pin. */
  allowedHosts: unknown
  /** The port the stub reports bound — deliberately not the one requested. */
  boundPort: number | null
  /** Emulate forked mode / a moved seam: return a result with no listener. */
  noListener?: boolean
  lanes: StubLane[]
}

function stubState(): StubState {
  const globals = globalThis as unknown as { __PT_NUXT_STUB?: StubState }
  globals.__PT_NUXT_STUB ??= {
    calls: [],
    closed: 0,
    laneSsr: [false, true],
    stampedLanes: [],
    allowedHosts: ["127.0.0.1"],
    boundPort: 45999,
    lanes: [],
  }
  return globals.__PT_NUXT_STUB
}

/**
 * The stub `@nuxt/cli`, written to disk and loaded through the same
 * `createRequire(nuxt/package.json).resolve("@nuxt/cli")` + dynamic-import path
 * the host uses — so resolution, ESM loading, and the `typeof runCommand` and
 * `args.fork` assertions are all genuinely exercised.
 *
 * It emulates the three things about Nuxt this host depends on: it runs the
 * injected plugins' `config` hooks in Vite's pre → normal → post order (which is
 * what makes "the snoop reads the value before the hardening pin replaces it" a
 * tested property rather than a hoped-for one), it calls `configureServer` once
 * per lane, and it returns `{ listener, close }`.
 */
const STUB_CLI = `
function orderOf(hook) {
  if (typeof hook === "function") return 1
  return hook?.order === "pre" ? 0 : hook?.order === "post" ? 2 : 1
}
function handlerOf(hook) {
  return typeof hook === "function" ? hook : hook?.handler
}

export const main = {
  meta: { name: "nuxt" },
  subCommands: {
    dev: async () => ({
      default: {
        meta: { name: "dev" },
        args: __FORK_ARGS__,
        run: () => {},
      },
    }),
  },
}

export async function runCommand(name, argv, opts) {
  const g = globalThis
  const state = g.__PT_NUXT_STUB
  state.calls.push({ name, argv, overrides: opts.overrides })

  const plugins = opts.overrides?.vite?.plugins ?? []
  // Vite runs \`config\` hooks pre → normal → post. The hardening plugin asks
  // for \`post\`; the allowed-hosts snoop asks for \`pre\`.
  const config = { server: { allowedHosts: state.allowedHosts } }
  const withConfig = plugins
    .filter((p) => p && p.config)
    .sort((a, b) => orderOf(a.config) - orderOf(b.config))
  for (const p of withConfig) handlerOf(p.config)?.(config, { command: "serve" })

  state.lanes = state.laneSsr.map((ssr, i) => ({
    config: { build: { ssr }, base: "/_nuxt/", root: "/repo", server: {} },
    watcher: {
      emitted: [],
      emit(event, file) {
        this.emitted.push(event + ":" + file)
      },
    },
    moduleGraph: {
      urlToModuleMap: new Map(
        state.stampedLanes.includes(i)
          ? [["/components/Card.vue", { transformResult: { code: 'h("div",{"data-desde-src":"a.vue:1:1"})' } }]]
          : [],
      ),
    },
    transformRequest: async () => null,
  }))
  for (const lane of state.lanes) {
    for (const p of plugins) await p?.configureServer?.(lane)
  }

  if (state.noListener) return { result: { close: async () => { state.closed++ } } }
  return {
    result: {
      listener: {
        url: "http://127.0.0.1:" + state.boundPort + "/",
        address: { address: "127.0.0.1", family: "IPv4", port: state.boundPort },
      },
      close: async () => {
        state.closed++
      },
    },
  }
}
`

const REAL_FORK_ARGS = `{
  cwd: { type: "string" },
  fork: { type: "boolean", description: "Disable forked mode", default: true, alias: ["f"] },
  port: { type: "string" },
}`

function project(
  opts: {
    nuxt?: string | false
    cli?: false
    /** Replaces the stub's whole module body — used for the shape refusals. */
    cliSource?: string
    /** Replaces the `dev` command's args table. */
    forkArgs?: string
  } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "pt-nuxt-probe-"))
  dirs.push(root)
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }))

  if (opts.nuxt !== false) {
    const pkg = join(root, "node_modules", "nuxt")
    mkdirSync(pkg, { recursive: true })
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "nuxt",
        version: opts.nuxt ?? "4.5.2",
        type: "module",
        main: "./index.js",
        exports: { ".": "./index.js", "./package.json": "./package.json" },
      }),
    )
    writeFileSync(join(pkg, "index.js"), "export default {}\n")
  }

  if (opts.cli !== false) {
    // `<root>/node_modules/@nuxt/cli` IS on the resolution chain from
    // `<root>/node_modules/nuxt/package.json` (Node skips `node_modules`
    // segments when building candidate paths), which is the same chain the host
    // walks: @nuxt/cli is a dependency of nuxt, not of the app.
    const pkg = join(root, "node_modules", "@nuxt", "cli")
    mkdirSync(pkg, { recursive: true })
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "@nuxt/cli",
        version: "3.37.0",
        type: "module",
        main: "./index.js",
        // MEASURED: the real package does NOT export "./package.json"
        // (ERR_PACKAGE_PATH_NOT_EXPORTED), which is why the version gate reads
        // `nuxt`. The stub reproduces that.
        exports: { ".": "./index.js" },
      }),
    )
    writeFileSync(
      join(pkg, "index.js"),
      opts.cliSource ?? STUB_CLI.replace("__FORK_ARGS__", opts.forkArgs ?? REAL_FORK_ARGS),
    )
  }
  return root
}

function context(prototypeRoot: string, overrides: Partial<HostContext> = {}): HostContext {
  return {
    repoRoot: prototypeRoot,
    prototypeRoot,
    framework: "vue3",
    languages: ["vue-sfc"],
    policy: buildStampPolicy({ repoRoot: prototypeRoot, buildDirs: [".nuxt"] }),
    frontDoor: { host: "127.0.0.1", port: 5173 },
    internal: { host: "127.0.0.1", port: 45123 },
    artifactDir: join(tmpdir(), "pt-nuxt-artifacts"),
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
  const globals = globalThis as unknown as { __PT_NUXT_STUB?: StubState }
  delete globals.__PT_NUXT_STUB
  vi.restoreAllMocks()
})

describe("the nuxt host declares", () => {
  const host = createNuxtHost()

  it("the proxy as its bridge-tag channel, before and after boot alike", () => {
    // MEASURED: `transformIndexHtml` fires ZERO times on Nuxt — the served
    // document is Nitro's render. The pre-boot declaration is what stops the
    // plugin-assembly site installing the composed `bridgePlugin`, which would
    // name an injection it never performs.
    expect(host.bridgeTags).toBe("proxy-response-injection")
  })

  it("Nuxt's generated directory as build output, and NOT `.output`", () => {
    // `.nuxt` is regenerated every boot, so a stamp there is a stamp on a file
    // that will not exist by the time anyone edits it. `.output` is production
    // output the dev server never transforms — denying it would silently
    // unstamp a repo that keeps source under that name.
    expect(host.buildDirs).toEqual([".nuxt"])
  })

  it("`vue-sfc` unconditionally — never an EMPTY language set", () => {
    // A Nuxt app's templates are `.vue` by construction, so filtering
    // `ctx.languages` (which React Router does, legitimately) would let a
    // mis-detected `framework: "react"` produce an empty set — and an empty set
    // is the one shape where the boot log says nothing at all about stamping,
    // neither a covered dialect nor a declared gap.
    expect(host.stampLanguages(context("/repo"), new Set())).toEqual(["vue-sfc"])
    expect(
      host.stampLanguages(context("/repo", { framework: "react", languages: ["jsx"] }), new Set()),
    ).toEqual(["vue-sfc"])
  })

  it("both private seams, with the expressions spelled out", () => {
    const priv = host.seams.filter((seam) => seam.stability === "private")
    expect(priv).toHaveLength(2)
    const expressions = priv.map((seam) => seam.expression).join(" ")
    // Greppable: the failure messages quote these, so the fix is a search rather
    // than an excavation.
    expect(expressions).toContain("--no-fork")
    expect(expressions).toContain("args.fork")
  })
})

describe("the nuxt host refuses before booting when", () => {
  const host = createNuxtHost()

  it("nuxt is declared but not installed", async () => {
    const result = await host.probe(context(project({ nuxt: false })))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe("host-package-missing")
    expect(result.failure.attachCovers).toBe(true)
    expect(result.failure.remediation.join(" ")).toMatch(/npm install/)
  })

  it("@nuxt/cli cannot be resolved from the project's nuxt", async () => {
    const result = await host.probe(context(project({ cli: false })))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe("seam-missing")
    expect(result.failure.seam?.stability).toBe("private")
  })

  it("@nuxt/cli no longer exports runCommand", async () => {
    const result = await host.probe(
      context(project({ cliSource: "export const main = {}\n" })),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe("seam-shape-changed")
    expect(result.failure.cause).toMatch(/runCommand/)
  })

  it("the dev command no longer declares a `fork` flag — the causal assertion", async () => {
    // `--no-fork` is not a preference: MEASURED, with fork on the pool children
    // die MODULE_NOT_FOUND and the caller loses `result.listener` entirely. This
    // check is what turns that into a pre-boot refusal naming the flag rather
    // than a "boot succeeded, nothing to serve" three steps later.
    const result = await host.probe(
      context(project({ forkArgs: `{ cwd: { type: "string" }, port: { type: "string" } }` })),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe("seam-shape-changed")
    expect(result.failure.seam?.id).toMatch(/args\.fork/)
    // The cause lists what the command DOES declare, so the reader can see how
    // far the surface moved.
    expect(result.failure.cause).toMatch(/cwd, port/)
  })
})

describe("the nuxt host's probe accepts, with notices", () => {
  const host = createNuxtHost()

  it("saying nothing at all when the seam and the version both check out", async () => {
    const result = await host.probe(context(project()))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.version).toBe("4.5.2")
    expect(result.notices).toEqual([])
  })

  it("degrading to a NOTICE when the flag table cannot be read at all", async () => {
    // The assertion is a check, not a dependency. If the command tree itself
    // moves, the boot's own listener guard still catches a forked boot — one
    // step later and with a worse message, which is worth a notice and not a
    // refusal.
    const result = await host.probe(
      context(
        project({
          cliSource: STUB_CLI.replace("__FORK_ARGS__", REAL_FORK_ARGS).replace(
            "subCommands: {",
            "subCommandsMoved: {",
          ),
        }),
      ),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.notices.join(" ")).toMatch(/--no-fork/)
  })

  it("noticing an untested major instead of refusing it", async () => {
    const result = await host.probe(context(project({ nuxt: "5.0.0" })))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.notices.join(" ")).toMatch(/5\.0\.0/)
  })

  it("escalating that notice to a refusal only under --strict-versions", async () => {
    const root = project({ nuxt: "5.0.0" })
    const result = await host.probe(context(root, { strictVersions: true }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe("host-version-unsupported")
    expect(result.failure.detected).toEqual({
      package: "nuxt",
      installed: "5.0.0",
      tested: "^4.0.0",
    })
  })
})

describe("boot hands Nuxt a command line and overrides that", () => {
  const host = createNuxtHost()

  async function boot(ctx: HostContext, plugins: Plugin[] = []) {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    stubState()
    const result = await host.boot(ctx, injection(plugins), null)
    return { result, call: stubState().calls[0] as RecordedCall }
  }

  it("pass --no-fork, and an explicit --cwd rather than trusting process.cwd()", async () => {
    const root = project()
    const { call } = await boot(context(root))
    expect(call.name).toBe("dev")
    expect(call.argv).toEqual(["--no-fork", "--cwd", root])
  })

  it("take the port through devServer, and never the literal 0", async () => {
    // `HostContext.internal.port` is `0` meaning "you pick". Forwarding that
    // literal is MEASURED wrong on Vite 8.0.8, which reads it as UNSET;
    // `pickLoopbackPort` resolves it to a concrete number first.
    const { call } = await boot(context(project(), { internal: { host: "127.0.0.1", port: 0 } }))
    expect(call.overrides.devServer.host).toBe("127.0.0.1")
    expect(call.overrides.devServer.port).not.toBe(0)
    expect(call.overrides.devServer.port).toBeGreaterThan(0)
  })

  it("put the hardening plugin LAST, after everything the pipeline injected", async () => {
    const stamper: Plugin = { name: "@desde/editor-source-tag-plugin" }
    const bridge: Plugin = { name: "@desde/editor-bridge-assets" }
    const { call } = await boot(context(project()), [stamper, bridge])

    const names = call.overrides.vite.plugins.map((p) => p.name)
    expect(names.slice(0, 2)).toEqual([
      "@desde/editor-source-tag-plugin",
      "@desde/editor-bridge-assets",
    ])
    // Last in the array AND `enforce: 'post'` internally, so it is last in the
    // post bucket by both orderings. A repo plugin that re-widens `fs.strict` or
    // `allowedHosts` in its own hook is what this ordering is for.
    expect(names[names.length - 1]).toBe("@desde/editor-harden")
  })

  it("keep Editor's own `.desde` bookkeeping out of the watcher", async () => {
    const { call } = await boot(context(project()))
    expect(call.overrides.vite.server.watch.ignored).toEqual(["**/.desde/**"])
  })
})

describe("boot reports", () => {
  const host = createNuxtHost()

  async function bootResult(
    ctx: HostContext = context(project()),
    seed: Partial<StubState> = {},
  ) {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    Object.assign(stubState(), seed)
    return host.boot(ctx, injection(), null)
  }

  it("the port Nuxt ACTUALLY bound, not the one we asked for", async () => {
    // MEASURED and load-bearing here in a way it is not elsewhere: with a
    // squatter on the requested port Nuxt neither fails (React Router) nor
    // increments (Astro) — get-port falls back to 3000, Nuxt's own default. The
    // stub returns a deliberately different port for exactly this assertion.
    const boot = await bootResult()
    expect(boot.transport).toEqual({ kind: "http-upstream", origin: "http://127.0.0.1:45999" })
  })

  it("`/` as its base, NEVER the inner Vite's `/_nuxt/`", async () => {
    // This host is the reason `HostBoot.base` is defined as the FRONT DOOR's
    // base: Nuxt's inner Vite resolves `base` to `/_nuxt/` (the stub reproduces
    // that on every lane), and reporting it is what breaks the shell's
    // served-stylesheet → source-file mapping.
    const boot = await bootResult()
    expect(boot.base).toBe("/")
  })

  it("Nuxt's own listener as a disclosed side door", async () => {
    const boot = await bootResult()
    expect(boot.sideDoorOrigins).toEqual(["http://127.0.0.1:45999"])
  })

  it("TWO lanes on an SSR app, and `required-in-html` with them", async () => {
    const boot = await bootResult()
    expect(boot.hmr.lanes).toEqual(["client", "ssr"])
    // MEASURED: `ssr: true` (the default) captures two lanes and server-renders
    // `/` with stamps in it, which is what makes zero stamps conclusive.
    expect(boot.stampExpectation).toBe("required-in-html")
  })

  it("ONE lane on a `ssr: false` app, and the verdict that can never tear it down", async () => {
    // MEASURED on the same fixture: `ssr: false` captures ONE lane and serves
    // `/` with ZERO stamps. Reporting `required-in-html` there would refuse to
    // boot a working SPA, so the lane count decides and the safe direction wins.
    const boot = await bootResult(context(project()), { laneSsr: [false] })
    expect(boot.hmr.lanes).toEqual(["client"])
    expect(boot.stampExpectation).toBe("post-hydration")
  })

  it("the `.vue` hot-update profile, with nothing on the full-reload side", async () => {
    const boot = await bootResult()
    expect(boot.hmr.reload.hot).toEqual([".vue"])
    expect(boot.hmr.reload.fullReload).toEqual([])
  })

  it("no security gap — the pins hold here, and the proxy is a second floor", async () => {
    const boot = await bootResult()
    expect(boot.security.narrowedServerConfig).toBe(true)
    expect(boot.security.gaps).toEqual([])
  })

  it("a close that reaches Nuxt's own close()", async () => {
    const boot = await bootResult()
    await boot.close()
    expect(stubState().closed).toBe(1)
  })
})

describe("boot's invalidation reaches EVERY lane", () => {
  const host = createNuxtHost()

  it("emits a change on both watchers, not just the client one", async () => {
    // THE reason this host exists. MEASURED: with both watchers blinded and the
    // file edited, emitting on the client lane alone left the SSR HTML stale
    // ("EDITED" absent, stamps unmoved); emitting on the SSR lane as well
    // refreshed it. A client-only invalidation is indistinguishable from an edit
    // that did not take.
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const root = project()
    stubState()
    const boot = await host.boot(context(root, { repoRoot: root }), injection(), null)

    boot.hmr.invalidate([join(root, "components/Card.vue")])

    const lanes = stubState().lanes
    expect(lanes).toHaveLength(2)
    for (const lane of lanes) {
      expect(lane.watcher.emitted.join(" ")).toContain("change:")
      expect(lane.watcher.emitted.join(" ")).toContain("components/Card.vue")
    }
  })

  it("never throws into an edit response, whatever the lanes do", async () => {
    // `HostHmr.invalidate` is best-effort by contract.
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    stubState()
    const boot = await host.boot(context(project()), injection(), null)
    for (const lane of stubState().lanes) {
      lane.watcher.emit = () => {
        throw new Error("watcher mid-teardown")
      }
    }
    expect(() => boot.hmr.invalidate(["/repo/components/Card.vue"])).not.toThrow()
  })
})

describe("boot's module-graph evidence", () => {
  const host = createNuxtHost()

  async function evidence(seed: Partial<StubState>) {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    Object.assign(stubState(), seed)
    const boot = await host.boot(context(project()), injection(), null)
    return boot.moduleGraphEvidence?.()
  }

  it("promotes from the SSR lane when the client lane has nothing", async () => {
    // MEASURED, and this is a rescue rather than thoroughness: a globally-SSR
    // app with `routeRules: { "/": { ssr: false } }` serves `/` with ZERO stamps
    // while its SSR lane's graph is full of them. A client-only walk reports
    // `false`, which completes § 6's teardown conjunction and shuts down a
    // session whose stamper is running perfectly.
    await expect(evidence({ laneSsr: [false, true], stampedLanes: [1] })).resolves.toBe(true)
  })

  it("reports the absence of evidence when no lane has any", async () => {
    // `false` here is "no evidence", never "proof of absence" — the walk may
    // only ever PROMOTE a verdict (§ 1, `HostBoot.moduleGraphEvidence`).
    await expect(evidence({ laneSsr: [false, true], stampedLanes: [] })).resolves.toBe(false)
  })
})

describe("boot's allowed-hosts report", () => {
  const host = createNuxtHost()

  async function overriddenKeys(allowedHosts: unknown): Promise<string[]> {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    Object.assign(stubState(), { allowedHosts })
    const boot = await host.boot(context(project()), injection(), null)
    return [...boot.security.overridden]
  }

  it("drops the one MEASURED false positive: Nuxt echoing the bind host", async () => {
    // MEASURED: Nuxt sets `server.allowedHosts` to the host it was told to bind,
    // so `hardenServerConfig`'s "a non-empty array means someone widened it"
    // heuristic fires on EVERY boot of EVERY Nuxt project — for something the
    // repo did not do, and that takes nothing away (Vite's defaults already
    // accept loopback). A warning that is always present is a warning nobody
    // reads.
    await expect(overriddenKeys(["127.0.0.1"])).resolves.toEqual([])
  })

  it("still reports a genuine widening", async () => {
    // The filter is one exact value, not a category. `true` is the case that
    // actually disables host validation, and it must still be said out loud.
    await expect(overriddenKeys(true)).resolves.toEqual(["server.allowedHosts"])
    await expect(overriddenKeys(["evil.test"])).resolves.toEqual(["server.allowedHosts"])
  })
})

describe("boot refuses a dev command that hands back no listener", () => {
  const host = createNuxtHost()

  it("naming forked mode and the private seam, and closing what it started", async () => {
    // This is EXACTLY the shape forked mode produces (`result.listener`
    // undefined, pool children dead), and the shape a change to @nuxt/cli's
    // private `runCommand` would produce. Either way the half-started server has
    // to come down, or a failed boot leaves a dev server on a port nothing is
    // pointing at.
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    Object.assign(stubState(), { noListener: true })
    await expect(host.boot(context(project()), injection(), null)).rejects.toThrow(
      /no listener with a bound TCP port/,
    )
    expect(stubState().closed).toBe(1)
  })
})
