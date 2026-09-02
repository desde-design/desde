/**
 * The React Router host's PRE-BOOT half: what it declares, and every reason it
 * refuses before spending a boot.
 *
 * The live boot is proved against real fixtures (a scaffolded `create-react-router`
 * app and the reactrouter.com repo) rather than here — a synthetic React Router
 * project is not a meaningful thing to build, and a test that stubbed
 * `@react-router/dev` would be asserting the stub. What IS worth pinning down in
 * a unit test is the refusal ladder: each check has to fire in order, name the
 * missing thing, and offer attach mode, because that is the message a customer
 * sees when their install is incomplete.
 */
import { afterEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createReactRouterHost } from "../host.js"
import { buildStampPolicy } from "../../stamp-policy.js"
import type { HostContext } from "../../types.js"

const dirs: string[] = []

/**
 * A prototype root with stub packages in `node_modules`.
 *
 * Stubs, not the real packages: `probe()` asks `require.resolve` whether a
 * specifier exists and reads a version out of `package.json`, and nothing more.
 * Installing React Router to assert that resolution finds it would make the
 * test slower and no stronger.
 */
function project(opts: {
  reactRouterDev?: string | false
  vite?: boolean
  viteConfig?: string | false
  /** Stub `createServer` records its inline config and returns a usable server. */
  recordVite?: boolean
}): string {
  const root = mkdtempSync(join(tmpdir(), "pt-rr-probe-"))
  dirs.push(root)
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }))

  if (opts.reactRouterDev !== false) {
    const pkg = join(root, "node_modules", "@react-router", "dev")
    mkdirSync(pkg, { recursive: true })
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "@react-router/dev",
        version: opts.reactRouterDev ?? "8.3.0",
        exports: { "./vite": "./vite.js", "./package.json": "./package.json" },
      }),
    )
    writeFileSync(join(pkg, "vite.js"), "export const reactRouter = () => ({ name: 'stub' })\n")
  }

  if (opts.vite !== false) {
    const pkg = join(root, "node_modules", "vite")
    mkdirSync(pkg, { recursive: true })
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "vite", version: "8.2.1", main: "./index.js" }),
    )
    writeFileSync(
      join(pkg, "index.js"),
      opts.recordVite
        ? // Records the inline config, then behaves enough like a dev server for
          // `boot()` to finish: listen, report a bound address, expose a
          // `config` for the ssr read. The reported port deliberately DIFFERS
          // from the requested one, so a host that assumed its own request
          // instead of reading the socket back fails here.
          `export async function createServer(config) {
             const g = globalThis
             g.__PT_RR_STUB ??= { calls: [], closed: 0 }
             g.__PT_RR_STUB.calls.push(config)
             return {
               config: { __reactRouterPluginContext: { reactRouterConfig: { ssr: true } } },
               httpServer: { address: () => ({ address: "127.0.0.1", port: 45998 }) },
               listen: async () => undefined,
               close: async () => { g.__PT_RR_STUB.closed++ },
             }
           }\n`
        : "export const createServer = async () => ({})\n",
    )
  }

  if (opts.viteConfig !== false) {
    writeFileSync(join(root, "vite.config.ts"), opts.viteConfig ?? "export default {}\n")
  }
  return root
}

function context(prototypeRoot: string, overrides: Partial<HostContext> = {}): HostContext {
  return {
    repoRoot: prototypeRoot,
    prototypeRoot,
    framework: "react",
    languages: ["jsx"],
    policy: buildStampPolicy({ repoRoot: prototypeRoot, buildDirs: [".react-router"] }),
    frontDoor: { host: "127.0.0.1", port: 5173 },
    internal: { host: "127.0.0.1", port: 0 },
    artifactDir: join(tmpdir(), "pt-rr-artifacts"),
    strictVersions: false,
    signal: new AbortController().signal,
    ...overrides,
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("the react-router host declares", () => {
  const host = createReactRouterHost()

  it("the proxy as its bridge-tag channel, before and after boot alike", () => {
    // MEASURED: `transformIndexHtml` fires ZERO times on React Router. The
    // pre-boot declaration is what stops the plugin-assembly site installing the
    // composed `bridgePlugin`, which would name an injection it never performs.
    expect(host.bridgeTags).toBe("proxy-response-injection")
  })

  it("React Router's generated directory as build output, and NOT `build/`", () => {
    // `.react-router` is regenerated every boot, so a stamp there is a stamp on
    // a file that will not exist by the time anyone edits it. `build/` is
    // production output the dev server never transforms — denying it would
    // silently unstamp a repo that keeps source under that name.
    expect(host.buildDirs).toEqual([".react-router"])
  })

  it("only the languages a Vite plugin can stamp here", () => {
    expect(
      host.stampLanguages(
        context("/repo", { languages: ["jsx", "vue-sfc", "astro"] }),
        // `installed` is what an Astro host branches on (React islands, Vue
        // islands, both); a React Router app is JSX by construction, so this
        // host ignores it and the assertion says so.
        new Set(["vue", "react"]),
      ),
    ).toEqual(["jsx"])
  })

  it("its private seam as private, with the expression spelled out", () => {
    const priv = host.seams.filter((seam) => seam.stability === "private")
    expect(priv).toHaveLength(1)
    // Greppable: the failure message quotes it, so the fix is a search rather
    // than an excavation.
    expect(priv[0]!.expression).toContain("__reactRouterPluginContext")
  })
})

describe("the react-router host refuses before booting when", () => {
  const host = createReactRouterHost()

  it("@react-router/dev is declared but not installed", async () => {
    const result = await host.probe(context(project({ reactRouterDev: false })))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe("host-package-missing")
    expect(result.failure.attachCovers).toBe(true)
    expect(result.failure.remediation.join(" ")).toMatch(/npm install/)
  })

  it("the project has no Vite of its own", async () => {
    // Unlike the plain `vite` host — which supplies editor-cli's copy and boots
    // a repo with no Vite at all — this host has no such escape: React Router's
    // plugin closes over the Vite it resolved for itself.
    const result = await host.probe(context(project({ vite: false })))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe("host-package-missing")
    expect(result.failure.summary).toMatch(/project's own Vite/i)
  })

  it("there is no Vite config FILE, which React Router requires", async () => {
    const result = await host.probe(context(project({ viteConfig: false })))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe("boot-failed")
    // The cause quotes React Router's own error, so the refusal is traceable to
    // the thing that would otherwise have thrown mid-boot.
    expect(result.failure.cause).toMatch(/requires the use of a Vite config file/)
    expect(result.failure.remediation.join(" ")).toMatch(/--attach/)
  })
})

describe("the react-router host's version gate", () => {
  const host = createReactRouterHost()

  it("passes the measured range with nothing to say", async () => {
    const result = await host.probe(context(project({ reactRouterDev: "8.0.0" })))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.version).toBe("8.0.0")
    expect(result.notices).toEqual([])
  })

  it("notices an untested major instead of refusing it", async () => {
    // Version drift is not evidence of breakage; `verifyStamping` is the real
    // gate. A refusal here would turn a working session into a support ticket.
    const result = await host.probe(context(project({ reactRouterDev: "9.1.0" })))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.notices.join(" ")).toMatch(/9\.1\.0/)
  })

  it("escalates that notice to a refusal only under --strict-versions", async () => {
    const root = project({ reactRouterDev: "9.1.0" })
    const result = await host.probe(context(root, { strictVersions: true }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe("host-version-unsupported")
    expect(result.failure.detected).toEqual({
      package: "@react-router/dev",
      installed: "9.1.0",
      tested: "^8.0.0",
    })
  })
})

/**
 * `boot()` coverage — absent until a review pointed out that this host was the
 * ONE with no test calling it, while its own source comment says of the plugin
 * ordering: "This is the entire security floor on this path — there is no
 * pre-merge `hardenServerConfig` call here, because there is no merge we
 * perform." Astro and Nuxt both assert the invariant; React Router, which
 * depends on it most, asserted nothing.
 */
describe("boot hands Vite an inline config that", () => {
  const host = createReactRouterHost()

  interface RecordedCall {
    configFile: string
    configLoader: string
    server: { host: string; port: number; strictPort: boolean }
    plugins: { name: string }[]
  }
  function stubCalls(): RecordedCall[] {
    const g = globalThis as unknown as { __PT_RR_STUB?: { calls: RecordedCall[] } }
    return g.__PT_RR_STUB?.calls ?? []
  }
  function resetStub(): void {
    const g = globalThis as unknown as { __PT_RR_STUB?: { calls: unknown[]; closed: number } }
    g.__PT_RR_STUB = { calls: [], closed: 0 }
  }

  async function boot(plugins: { name: string }[] = []) {
    resetStub()
    const root = project({ recordVite: true })
    const injection = { channel: "vite-plugin", plugins } as unknown as Parameters<
      typeof host.boot
    >[1]
    const result = await host.boot(context(root), injection, null)
    return { result, call: stubCalls()[0], root }
  }

  it("puts the hardening plugin LAST, after everything the pipeline injected", async () => {
    const stamper = { name: "@desde/editor-jsx-source-tag-plugin" }
    const bridge = { name: "@desde/editor-bridge-assets" }
    const { call, result } = await boot([stamper, bridge])
    await result.close()

    const names = call.plugins.map((p) => p.name)
    // The pipeline's own plugins keep their relative order and stay ahead of
    // the floor; `rootDefaultPlugin` legitimately precedes them.
    expect(names).toContain("@desde/editor-jsx-source-tag-plugin")
    expect(names).toContain("@desde/editor-bridge-assets")
    expect(names.indexOf("@desde/editor-jsx-source-tag-plugin")).toBeLessThan(
      names.indexOf("@desde/editor-bridge-assets"),
    )
    // Last in the array AND `enforce: 'post'` internally, so last in the post
    // bucket by both orderings. A repo plugin re-widening `fs.strict` or
    // `allowedHosts` from its own hook is exactly what this ordering defeats.
    expect(names[names.length - 1]).toBe("@desde/editor-harden")
  })

  it("passes a REAL config file path, never configFile:false", async () => {
    const { call, result } = await boot()
    await result.close()
    // The line React Router's own guard is about: it throws outright on
    // `configFile: false`, which is what `bootSupervisor` sets.
    expect(call.configFile).toMatch(/vite\.config\.ts$/)
    expect(call.configLoader).toBe("runner")
  })

  it("binds the inner server to loopback with strictPort", async () => {
    const { call, result } = await boot()
    await result.close()
    expect(call.server.host).toBe("127.0.0.1")
    expect(call.server.strictPort).toBe(true)
    // Port 0 in the context must be resolved to a real one BEFORE the call —
    // Vite 8.0.8 turns a literal 0 into 5173, i.e. into the front door's port.
    expect(call.server.port).toBeGreaterThan(0)
  })

  it("reports the origin the socket bound, not the one it asked for", async () => {
    const { result } = await boot()
    // The stub reports 45998 regardless of what was requested.
    expect(result.transport).toEqual({ kind: "http-upstream", origin: "http://127.0.0.1:45998" })
    // The FRONT DOOR's base. Reporting the inner Vite's base here is the
    // mistake that breaks the shell's stylesheet-to-source mapping.
    expect(result.base).toBe("/")
    await result.close()
  })
})
