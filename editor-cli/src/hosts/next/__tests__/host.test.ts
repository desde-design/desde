/**
 * The Next host: what it declares, and every reason it refuses BEFORE spending
 * a boot.
 *
 * **Why `probe()` is exercised against a fake `next` install rather than
 * mocked.** The probe's whole job is to reach into a real `node_modules` — deep
 * import, phase constant, memo identity — and every one of those is a
 * resolution question, not a logic question. A mocked module would test that the
 * branches are wired to each other while leaving the thing that actually breaks
 * on a Next upgrade (the resolution itself) untested. So each case writes a
 * miniature `next` package to disk with exactly one property wrong, and the host
 * resolves it through the same `createRequire(<prototype>/package.json)` path it
 * uses against a customer's install.
 *
 * `boot()` is NOT exercised here: it binds a port and starts Turbopack. Its
 * proof is the live run recorded in `tasks/dev-server-hosts.md`, which is also
 * the only place the properties that matter — repo-relative stamps, a bridge
 * tag, an edit round-trip, the teardown on a stamp-free response — are
 * observable at all.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { createNextHost, NEXT_SECURITY } from "../host.js"
import { buildStampPolicy } from "../../stamp-policy.js"
import type { HostContext } from "../../types.js"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A throwaway directory whose path is REAL.
 *
 * `mkdtemp` under macOS's `/var/folders` hands back a path through the
 * `/var` → `/private/var` symlink, while `require.resolve` — which is how the
 * host learns every path it reports — returns the resolved one. Comparing the
 * two forms is a test that fails for a reason having nothing to do with the
 * behaviour under test.
 */
function realTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return realpathSync(dir)
}

interface FakeNextSpec {
  version?: string
  /** Omit `dist/server/config.js` entirely — a moved deep import. */
  noConfigModule?: boolean
  /** Publish a `constants.js` with no PHASE_DEVELOPMENT_SERVER. */
  noPhaseConstant?: boolean
  /** Ship no `constants.js` at all — the third specifier's walk-up. */
  noConstantsModule?: boolean
  /** The phase string this install publishes. Distinguishes two installs. */
  phase?: string
  /** Return a FRESH config object per call — the memo-identity break. */
  freshConfigPerCall?: boolean
  /**
   * Hand back ONE shared object, frozen — identity holds, the write does not.
   * The mutability break, which is invisible to the identity assertion.
   */
  frozenConfig?: boolean
  /** Seeded onto every resolved config, e.g. an existing turbopack rules map. */
  configSeed?: Record<string, unknown>
}

/**
 * The source of a working `dist/server/config.js`, memoised on `${phase}|${dir}`
 * exactly as Next keys it — the phase being part of the key is what keeps a
 * `next build` from ever seeing our loader.
 *
 * `devFlagAtLoad` records `process.env.__NEXT_DEV_SERVER` AS IT WAS when
 * `loadConfig` ran. That is the regression guard for the ordering bug below —
 * the value has to already be "1" by then, and nothing else in the probe's
 * result can show that.
 */
function configModuleSource(spec: FakeNextSpec): string {
  const seed = JSON.stringify(spec.configSeed ?? {})
  return spec.freshConfigPerCall
    ? `exports.default = async () => ({ configFileName: 'next.config.ts', devFlagAtLoad: process.env.__NEXT_DEV_SERVER ?? null, ...${seed} })\n`
    : `const cache = new Map()
const settle = ${spec.frozenConfig ? "Object.freeze" : "(conf) => conf"}
exports.default = async (phase, dir) => {
  const key = phase + '|' + dir
  if (!cache.has(key)) cache.set(key, settle({ configFileName: 'next.config.ts', devFlagAtLoad: process.env.__NEXT_DEV_SERVER ?? null, ...${seed} }))
  return cache.get(key)
}
`
}

/**
 * A miniature `next` package.
 *
 * Only the three surfaces `probe()` touches are real: the package manifest (for
 * `require.resolve("next")` and the version), `constants.js` (for the phase),
 * and `dist/server/config.js` (for the memo). The entry point exists so
 * `require.resolve("next")` succeeds; nothing here ever calls it.
 */
function writeFakeNextPackage(pkg: string, spec: FakeNextSpec): void {
  mkdirSync(join(pkg, "dist", "server"), { recursive: true })
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "next", version: spec.version ?? "16.3.0", main: "./dist/server/next.js" }),
  )
  writeFileSync(join(pkg, "dist", "server", "next.js"), "module.exports = function next() {}\n")
  if (!spec.noConstantsModule) {
    writeFileSync(
      join(pkg, "constants.js"),
      spec.noPhaseConstant
        ? "exports.PHASE_PRODUCTION_BUILD = 'phase-production-build'\n"
        : `exports.PHASE_DEVELOPMENT_SERVER = ${JSON.stringify(spec.phase ?? "phase-development-server")}\n`,
    )
  }
  if (!spec.noConfigModule) {
    writeFileSync(join(pkg, "dist", "server", "config.js"), configModuleSource(spec))
  }
}

/** A throwaway prototype with one `next` install in its own `node_modules`. */
function fakeNextPrototype(spec: FakeNextSpec = {}): string {
  const root = realTempDir("pt-next-host-")
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { next: spec.version ?? "16.3.0" } }),
  )
  writeFakeNextPackage(join(root, "node_modules", "next"), spec)
  return root
}

/**
 * TWO `next` installations: one in the prototype's own `node_modules` and one in
 * an ANCESTOR directory — the shape a monorepo, an npm workspace, or a stray
 * root-level install produces every day.
 *
 * The ancestor's config module is fully working, so binding it is SILENT unless
 * the caller asks for `ancestorDeclaresCollidingRule` — which seeds its resolved
 * config with a `*.tsx` Turbopack rule and thereby makes "which installation did
 * we bind" observable from the probe's own result. Both spellings are used
 * below, and which one a test wants is the difference between demonstrating the
 * silent failure and discriminating the fix.
 */
function fakeNextWithAncestorInstall(spec: {
  prototypeHasConfigModule?: boolean
  prototypeHasConstantsModule?: boolean
  ancestorDeclaresCollidingRule?: boolean
}): {
  prototypeRoot: string
  ancestorConfigPath: string
  ancestorConstantsPath: string
} {
  const ancestor = realTempDir("pt-next-ancestor-")
  const prototypeRoot = join(ancestor, "app")
  mkdirSync(prototypeRoot, { recursive: true })
  writeFileSync(join(ancestor, "package.json"), JSON.stringify({ name: "workspace-root" }))
  writeFileSync(
    join(prototypeRoot, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { next: "16.3.0" } }),
  )

  const ancestorPkg = join(ancestor, "node_modules", "next")
  writeFakeNextPackage(ancestorPkg, {
    // A phase string of its own, so "which install answered" is legible in any
    // failure that quotes one.
    phase: "phase-development-server-ANCESTOR",
    configSeed: spec.ancestorDeclaresCollidingRule
      ? { turbopack: { rules: { "*.tsx": { loaders: ["ancestor-loader"] } } } }
      : {},
  })
  writeFakeNextPackage(join(prototypeRoot, "node_modules", "next"), {
    noConfigModule: spec.prototypeHasConfigModule === false,
    noConstantsModule: spec.prototypeHasConstantsModule === false,
  })

  return {
    prototypeRoot,
    ancestorConfigPath: join(ancestorPkg, "dist", "server", "config.js"),
    ancestorConstantsPath: join(ancestorPkg, "constants.js"),
  }
}

/**
 * One install, whose `dist/server/config` is a DIRECTORY whose `package.json`
 * `main` points back out of the package.
 *
 * Node resolves `main` relative to that directory and will happily follow it
 * anywhere, so anchoring the resolution inside the install is not by itself
 * enough to guarantee the module comes FROM the install — which is the whole
 * reason the containment assertion exists alongside the anchoring.
 */
function fakeNextWithEscapingConfigDir(): { prototypeRoot: string; escapedPath: string } {
  const prototypeRoot = realTempDir("pt-next-escape-")
  writeFileSync(
    join(prototypeRoot, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { next: "16.3.0" } }),
  )
  const pkg = join(prototypeRoot, "node_modules", "next")
  writeFakeNextPackage(pkg, { noConfigModule: true })

  const escapedPath = join(prototypeRoot, "elsewhere-config.js")
  writeFileSync(escapedPath, configModuleSource({}))

  const configDir = join(pkg, "dist", "server", "config")
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, "package.json"),
    JSON.stringify({ name: "next-config-shim", main: relative(configDir, escapedPath) }),
  )
  return { prototypeRoot, escapedPath }
}

function context(prototypeRoot: string, overrides: Partial<HostContext> = {}): HostContext {
  return {
    repoRoot: prototypeRoot,
    prototypeRoot,
    framework: "react",
    languages: ["jsx"],
    policy: buildStampPolicy({ repoRoot: prototypeRoot, buildDirs: [".next"] }),
    frontDoor: { host: "127.0.0.1", port: 5173 },
    internal: { host: "127.0.0.1", port: 0 },
    artifactDir: join(tmpdir(), "pt-artifacts"),
    strictVersions: false,
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe("the next host — declarations", () => {
  it("declares the Turbopack channel, the proxy bridge lane, and three PRIVATE seams", () => {
    const host = createNextHost()

    expect(host.id).toBe("next")
    // The only host on this channel, and the reason the channel exists: Next has
    // no Vite, so the stamper is a file plus JSON that survives a forked worker.
    expect(host.accepts).toBe("turbopack-loader")
    // `transformIndexHtml` does not exist here — the tags come from the proxy.
    expect(host.bridgeTags).toBe("proxy-response-injection")
    expect(host.devCommand).toBe("npx next dev")
    expect(host.buildDirs).toEqual([".next"])
    expect(host.versionGate).toEqual({ packageName: "next", tested: "^16.3.0" })

    // ALL THREE private, and each carries a greppable expression — the failure
    // message's value is that a user can search for the thing that broke. Three
    // rather than two because the memoized object can stop accepting the write
    // without ever losing identity, which is a separate break with a separate
    // signature (see NEXT_CONFIG_MUTABILITY_SEAM).
    expect(host.seams).toHaveLength(3)
    expect(host.seams.every((seam) => seam.stability === "private")).toBe(true)
    expect(host.seams.map((seam) => seam.expression).join("\n")).toContain(
      'require("next/dist/server/config").default',
    )
  })

  it("declares its security gaps non-empty, because it has no config to narrow", () => {
    // § 4, S11. Vite gives the other four hosts fs.deny / allowedHosts /
    // fs.strict to pin; Next has none of them, so the proxy in front is this
    // host's entire floor and the type has to say so rather than let a reader
    // assume a shared helper was applied.
    expect(NEXT_SECURITY.narrowedServerConfig).toBe(false)
    expect(NEXT_SECURITY.gaps.length).toBeGreaterThan(0)
    expect(NEXT_SECURITY.gaps.join("\n")).toContain("fs.deny")
    expect(NEXT_SECURITY.gaps.join("\n")).toContain("allowedHosts")
  })

  it("always stamps JSX, whatever detection said", () => {
    // Filtering `ctx.languages` would let a mis-detected framework produce an
    // EMPTY language set, which makes `stampingCoverage` report neither a
    // covered dialect nor a gap — the one shape where the boot log says nothing
    // at all about stamping.
    const host = createNextHost()
    const root = fakeNextPrototype()
    expect(host.stampLanguages(context(root, { languages: ["vue-sfc"] }), new Set())).toEqual(["jsx"])
  })
})

describe("the next host — probe", () => {
  it("refuses a project that declares next without installing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "pt-next-bare-"))
    dirs.push(root)
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "16.3.0" } }))

    const probe = await createNextHost().probe(context(root))
    expect(probe.ok).toBe(false)
    if (probe.ok) throw new Error("unreachable")
    expect(probe.failure.code).toBe("host-package-missing")
    expect(probe.failure.remediation.join("\n")).toContain("npm install")
  })

  it("refuses when the deep import has moved, naming it so the fix is greppable", async () => {
    // The single most likely break on a Next upgrade, caught before any boot
    // work rather than as a stack trace mid-`prepare()`.
    const root = fakeNextPrototype({ noConfigModule: true })

    const probe = await createNextHost().probe(context(root))
    expect(probe.ok).toBe(false)
    if (probe.ok) throw new Error("unreachable")
    expect(probe.failure.code).toBe("seam-missing")
    expect(probe.failure.seam?.id).toBe("next/dist/server/config")
    expect(probe.failure.attachCovers).toBe(true)
  })

  it("refuses when PHASE_DEVELOPMENT_SERVER is gone rather than hardcoding the value", async () => {
    // Guessing the phase would prime a cache entry nothing reads: a healthy
    // 200-serving dev server that stamps nothing, which is precisely the failure
    // the whole host is gated against.
    const root = fakeNextPrototype({ noPhaseConstant: true })

    const probe = await createNextHost().probe(context(root))
    expect(probe.ok).toBe(false)
    if (probe.ok) throw new Error("unreachable")
    expect(probe.failure.code).toBe("seam-missing")
    expect(probe.failure.cause).toContain("PHASE_DEVELOPMENT_SERVER")
  })

  it("REFUSES when the config memo stops returning one shared object", async () => {
    // The causal assertion, end to end through the real resolution path: a Next
    // that defensively copies its resolved config breaks in-process injection
    // while leaving every other signal green.
    const root = fakeNextPrototype({ freshConfigPerCall: true })

    const probe = await createNextHost().probe(context(root))
    expect(probe.ok).toBe(false)
    if (probe.ok) throw new Error("unreachable")
    expect(probe.failure.code).toBe("seam-shape-changed")
    expect(probe.failure.seam?.id).toContain("memoized object identity")
    expect(probe.failure.remediation.join("\n")).toContain("--attach")
  })

  it("REFUSES when the shared config object stops accepting the write", async () => {
    // The half of the seam the identity assertion cannot see. A frozen config
    // passes `first === second` and every shape check, and then the injection
    // either throws a bare TypeError mid-boot — after the loader has been
    // bundled to disk — or, if a future Next normalises `turbopack` through an
    // accessor instead, is swallowed and boots a healthy server that stamps
    // nothing. Refused here, before either.
    const root = fakeNextPrototype({ frozenConfig: true })

    const probe = await createNextHost().probe(context(root))
    expect(probe.ok).toBe(false)
    if (probe.ok) throw new Error("unreachable")
    expect(probe.failure.code).toBe("seam-shape-changed")
    expect(probe.failure.seam?.id).toContain("mutability")
    expect(probe.failure.remediation.join("\n")).toContain("--attach")
  })

  it("refuses a project whose own Turbopack rules collide with the stamper's", async () => {
    const root = fakeNextPrototype({
      configSeed: { turbopack: { rules: { "*.jsx": { loaders: ["their-loader"] } } } },
    })

    const probe = await createNextHost().probe(context(root))
    expect(probe.ok).toBe(false)
    if (probe.ok) throw new Error("unreachable")
    expect(probe.failure.code).toBe("boot-failed")
    expect(probe.failure.summary).toContain("*.jsx")
  })

  it("refuses a project rule that only LOOKS disjoint from the stamper's", async () => {
    // Same refusal, reached by spelling the same glob differently. MEASURED
    // against the exact-key check this replaces: ACCEPTED, with `*.{tsx,jsx}`,
    // `*.tsx` and `*.jsx` all registered, so both loaders ran on every file and
    // any line the other one added shifted every stamp Editor wrote.
    const root = fakeNextPrototype({
      configSeed: { turbopack: { rules: { "*.{tsx,jsx}": { loaders: ["their-loader"] } } } },
    })

    const probe = await createNextHost().probe(context(root))
    expect(probe.ok).toBe(false)
    if (probe.ok) throw new Error("unreachable")
    expect(probe.failure.code).toBe("boot-failed")
    expect(probe.failure.summary).toContain("*.{tsx,jsx}")
    expect(probe.failure.attachCovers).toBe(true)
  })

  it("still accepts the measured SVGR project, through the real resolution path", async () => {
    // The bias is toward refusing, so the guard against over-refusing has to be
    // exercised end to end too: this is the fixture the merge behaviour was
    // MEASURED live against (`/svg-demo` 200, the SVGR marker present, and 4 of
    // our stamps on the same boot).
    const root = fakeNextPrototype({
      configSeed: { turbopack: { rules: { "*.svg": { loaders: ["@svgr/webpack"] } } } },
    })

    const probe = await createNextHost().probe(context(root))
    expect(probe.ok).toBe(true)
  })

  it("does NOT leave the probe's own placeholder rule on the config Next will read", async () => {
    // The collision check runs `mergeStampRules`, which mutates by design. Doing
    // that to the memoised object would register a `<probe>` loader path that
    // does not exist — a dev server that boots and then fails to compile.
    const root = fakeNextPrototype()
    const probe = await createNextHost().probe(context(root))
    expect(probe.ok).toBe(true)

    const { createRequire } = await import("node:module")
    const require = createRequire(join(root, "package.json"))
    const loadConfig = (require("next/dist/server/config") as { default: (p: string, d: string) => Promise<unknown> }).default
    const conf = (await loadConfig("phase-development-server", root)) as { turbopack?: unknown }
    expect(conf.turbopack).toBeUndefined()
  })

  it("accepts a healthy install and reports its version", async () => {
    const root = fakeNextPrototype()
    const probe = await createNextHost().probe(context(root))

    expect(probe).toEqual({ ok: true, version: "16.3.0", notices: [] })
  })
})

describe("the next host — which next installation it binds", () => {
  /**
   * `require("next")` (what `boot()` runs) and the deep import of the config
   * loader are two separate resolutions. Node's walk-up makes them separable:
   * for the bare specifier it takes the first `node_modules` holding a
   * resolvable `next`, and for the subpath the first holding THAT FILE — so an
   * installation missing the internal file falls through to an outer one while
   * the bare specifier stays put.
   *
   * MEASURED against the unfixed host, on the fixture below:
   *
   *     require.resolve("next")                   → <proto>/node_modules/next/dist/server/next.js
   *     require.resolve("next/dist/server/config") → <ancestor>/node_modules/next/dist/server/config.js
   *     probe → { ok: true, version: "16.3.0", notices: [] }
   *
   * Each copy has its OWN module state, so the `configCache` we prime is not the
   * one the booted server reads: the dev server comes up healthy, serves 200s
   * and stamps nothing — the exact failure this whole host is gated against,
   * reached silently.
   */
  it("REFUSES to load one installation's config loader while booting another's", async () => {
    const { prototypeRoot, ancestorConfigPath } = fakeNextWithAncestorInstall({
      prototypeHasConfigModule: false,
    })

    const probe = await createNextHost().probe(context(prototypeRoot))
    expect(probe.ok).toBe(false)
    if (probe.ok) throw new Error("unreachable")
    expect(probe.failure.code).toBe("seam-missing")
    expect(probe.failure.seam?.id).toBe("next/dist/server/config")
    // The other installation is NAMED. "Cannot find module" alone would send a
    // user looking for a Next upgrade note when what they have is two installs.
    expect(probe.failure.cause).toContain(ancestorConfigPath)
    expect(probe.failure.attachCovers).toBe(true)
  })

  it("still accepts the ordinary workspace shape, where the prototype's own install is complete", async () => {
    // The guard against over-refusing: two installations are NORMAL. This one
    // passes against the unfixed host too — the bug only shows when the nearer
    // install is incomplete — but it is what stops the fix from being "refuse
    // whenever a second next exists", and it discriminates WHICH install was
    // bound: the ancestor's config declares a `*.tsx` rule, so binding it would
    // come back as a rule-collision refusal rather than an ok.
    const { prototypeRoot } = fakeNextWithAncestorInstall({
      prototypeHasConfigModule: true,
      ancestorDeclaresCollidingRule: true,
    })

    const probe = await createNextHost().probe(context(prototypeRoot))
    expect(probe.ok).toBe(true)
  })

  it("REFUSES a phase constant read from a different installation than it will boot", async () => {
    // `next/constants` is the THIRD bare specifier in this host, and it splits
    // the same way — MEASURED: with the prototype's own next shipping no
    // `constants.js`, `require("next/constants")` walked up and returned the
    // ancestor's, phase string and all. That string is the memo's cache KEY, so
    // a disagreement primes an entry Next never asks for: healthy server, zero
    // stamps, and the identity assertion green because it proved identity of the
    // wrong entry. Fixing only the config module would have left the same class
    // of failure live one line away.
    const { prototypeRoot, ancestorConstantsPath } = fakeNextWithAncestorInstall({
      prototypeHasConstantsModule: false,
    })

    const probe = await createNextHost().probe(context(prototypeRoot))
    expect(probe.ok).toBe(false)
    if (probe.ok) throw new Error("unreachable")
    expect(probe.failure.code).toBe("seam-missing")
    expect(probe.failure.cause).toContain(ancestorConstantsPath)
    expect(probe.failure.attachCovers).toBe(true)
  })

  it("REFUSES a config module that resolves back OUT of the installation it was anchored in", async () => {
    // Anchoring the resolution inside the install is necessary and not
    // sufficient: `dist/server/config` as a directory whose package.json `main`
    // points anywhere at all is a layout that defeats the base by itself. The
    // module it lands on here is a perfectly working loader, so the unfixed host
    // accepts the fixture — which is the point. Where a config loader lives is
    // not evidence about whose module state it holds.
    const { prototypeRoot, escapedPath } = fakeNextWithEscapingConfigDir()

    const probe = await createNextHost().probe(context(prototypeRoot))
    expect(probe.ok).toBe(false)
    if (probe.ok) throw new Error("unreachable")
    expect(probe.failure.code).toBe("seam-missing")
    expect(probe.failure.cause).toContain(escapedPath)
    expect(probe.failure.attachCovers).toBe(true)
  })
})

describe("the next host — __NEXT_DEV_SERVER ordering", () => {
  /**
   * MEASURED, by bisection on a fixture whose config declares a `turbopack`
   * block: setting this flag after the first `loadConfig` call makes EVERY route
   * 500 for the life of the process (`RouteModule`'s constructor latches
   * `isDev` from it once, then reads the production-only
   * `.next/dev/required-server-files.json`). Setting it before `loadConfig`
   * serves 200 with stamps. On a config of `{}` the late set happened to work,
   * which is what made this look like an intermittent race rather than the
   * deterministic ordering bug it is — so a unit test that only checked the
   * final value would have passed while the product was broken.
   */
  const readFlag = (): string | undefined => process.env["__NEXT_DEV_SERVER"]
  let saved: string | undefined

  beforeEach(() => {
    saved = readFlag()
    delete process.env["__NEXT_DEV_SERVER"]
  })
  afterEach(() => {
    if (saved === undefined) delete process.env["__NEXT_DEV_SERVER"]
    else process.env["__NEXT_DEV_SERVER"] = saved
  })

  it("is already set by the time loadConfig runs, not merely by the time boot does", async () => {
    const root = fakeNextPrototype()
    const probe = await createNextHost().probe(context(root))
    expect(probe.ok).toBe(true)

    const { createRequire } = await import("node:module")
    const require = createRequire(join(root, "package.json"))
    const loadConfig = (require("next/dist/server/config") as { default: (p: string, d: string) => Promise<{ devFlagAtLoad?: unknown }> }).default
    const conf = await loadConfig("phase-development-server", root)
    // A cache hit on the object the probe loaded, so this is the value that was
    // live at the FIRST load — not a re-read after the fact.
    expect(conf.devFlagAtLoad).toBe("1")
  })

  it("restores the flag when the probe refuses, so attach mode does not inherit it", async () => {
    // A long-lived CLI whose agent may later shell out to `next build` must not
    // carry a Next-internal dev flag it set for a boot that never happened.
    const root = fakeNextPrototype({ noConfigModule: true })
    const probe = await createNextHost().probe(context(root))

    expect(probe.ok).toBe(false)
    expect(readFlag()).toBeUndefined()
  })

  it("leaves the flag set when the probe succeeds, exactly as Next's own prepare() would", async () => {
    const root = fakeNextPrototype()
    await createNextHost().probe(context(root))
    expect(readFlag()).toBe("1")
  })
})

describe("the next host — version gate", () => {

  it("treats an untested major as a notice, and only --strict-versions as a refusal", async () => {
    // Both seams are asserted causally and the served output is verified after
    // boot, so a version number is the weakest of the three signals and must not
    // be the one that refuses by default.
    const root = fakeNextPrototype({ version: "15.4.2" })

    const lenient = await createNextHost().probe(context(root))
    expect(lenient.ok).toBe(true)
    if (!lenient.ok) throw new Error("unreachable")
    expect(lenient.notices.join("\n")).toContain("15.4.2")

    const strict = await createNextHost().probe(context(root, { strictVersions: true }))
    expect(strict.ok).toBe(false)
    if (strict.ok) throw new Error("unreachable")
    expect(strict.failure.code).toBe("host-version-unsupported")
    expect(strict.failure.detected).toEqual({
      package: "next",
      installed: "15.4.2",
      tested: "^16.3.0",
    })
  })

  it("refuses an untested MINOR under --strict-versions, not just an untested major", async () => {
    // `--strict-versions` exists to refuse anything outside the measured range,
    // and the declared range is `^16.3.0` — which 16.1.0 is not inside. A
    // major-only check accepted it silently, so the flag's whole promise was
    // false for the two minors below the measured one.
    const root = fakeNextPrototype({ version: "16.1.0" })

    const lenient = await createNextHost().probe(context(root))
    expect(lenient.ok).toBe(true)
    if (!lenient.ok) throw new Error("unreachable")
    expect(lenient.notices.join("\n")).toContain("16.1.0")
    expect(lenient.notices.join("\n")).toContain("^16.3.0")

    const strict = await createNextHost().probe(context(root, { strictVersions: true }))
    expect(strict.ok).toBe(false)
    if (strict.ok) throw new Error("unreachable")
    expect(strict.failure.code).toBe("host-version-unsupported")
    expect(strict.failure.detected).toEqual({
      package: "next",
      installed: "16.1.0",
      tested: "^16.3.0",
    })
  })

  it("enforces exactly the range it declares, with the boundary read off the declaration", async () => {
    // The drift guard. The floor is parsed from `versionGate.tested` rather than
    // written down a second time, so bumping the measured version moves both the
    // declaration and this test's boundary together — which is the property the
    // fix is for. Two literals is how they came apart in the first place.
    // `versionGate` became optional when `attach` joined the registry — attach
    // resolves no package from the prototype, so it has no version to gate. It
    // is required of every in-process host, which `resolve.test.ts` asserts over
    // the whole registry; here a missing one is a failure, not a skip.
    const gate = createNextHost().versionGate
    if (gate === undefined) throw new Error("the next host must declare a versionGate")
    const { tested } = gate
    const parsed = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(tested)
    if (parsed === null) throw new Error(`expected a caret range, got ${tested}`)
    const [major, minor, patch] = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])]

    const justBelow =
      patch > 0 ? `${major}.${minor}.${patch - 1}` : minor > 0 ? `${major}.${minor - 1}.99` : `${major - 1}.99.99`
    const strictly = async (version: string): Promise<boolean> =>
      (await createNextHost().probe(context(fakeNextPrototype({ version }), { strictVersions: true }))).ok

    expect(await strictly(`${major}.${minor}.${patch}`)).toBe(true) // the floor itself
    expect(await strictly(`${major}.${minor + 1}.7`)).toBe(true) // a later minor: caret admits it
    expect(await strictly(`${major}.${minor}.${patch + 4}`)).toBe(true) // a later patch
    expect(await strictly(justBelow)).toBe(false)
    expect(await strictly(`${major + 1}.0.0`)).toBe(false) // the next major
  })

  it("treats a prerelease of the measured version as outside the range, as semver does", async () => {
    // `^16.3.0` desugars to `>=16.3.0 <17.0.0-0`, which admits no prerelease at
    // all: a canary is by construction not the build that was measured. A notice
    // by default, so canary users are told rather than blocked, and a refusal
    // only under the flag whose job is refusing.
    const root = fakeNextPrototype({ version: "16.3.0-canary.12" })

    const lenient = await createNextHost().probe(context(root))
    expect(lenient.ok).toBe(true)
    if (!lenient.ok) throw new Error("unreachable")
    expect(lenient.notices.join("\n")).toContain("16.3.0-canary.12")

    expect((await createNextHost().probe(context(root, { strictVersions: true }))).ok).toBe(false)
  })
})
