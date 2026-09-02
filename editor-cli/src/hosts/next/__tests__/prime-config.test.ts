/**
 * The private Next seam: the identity assertion that makes in-process injection
 * possible, and the rules merge that makes it safe.
 *
 * **Why this is the most important test file in the Next host.** Every other
 * failure on this host is loud — a moved module throws, a bad port refuses to
 * bind, a broken config crashes `app.prepare()`. The one that is not is the
 * memo losing object identity: `loadConfig` still returns a config, the server
 * still boots, every route still serves 200, and NOTHING is stamped. That is
 * Next's documented `conf` option reproduced by an upgrade, and the only thing
 * standing between a customer and an inspect-only session discovered mid-click
 * is that `probeConfigMemo` refuses first. So the case with a stubbed
 * `loadConfig` returning a fresh object per call is not one test among several;
 * it is the reason the function exists.
 */
import { describe, expect, it } from "vitest"
import {
  developmentPhaseFrom,
  mergeStampRules,
  probeConfigMemo,
  STAMP_RULE_GLOBS,
  type LoadNextConfig,
  type NextConfigObject,
} from "../prime-config.js"
import type { StampPolicy, StamperLoaderOptions } from "../../types.js"

const DIR = "/repo"
const DEV_PHASE = "phase-development-server"
const BUILD_PHASE = "phase-production-build"

const POLICY: StampPolicy = {
  roots: ["/repo"],
  denySegments: ["node_modules"],
  denyDirs: ["/repo/.next"],
  stampRoot: "/repo",
}
const OPTIONS: StamperLoaderOptions = { repoRoot: "/repo", policy: POLICY }
const LOADER = "/cache/desde/0.0.0/stamp/next-loader.cjs"

/**
 * A stand-in for `next/dist/server/config`, memoised the way Next memoises it.
 *
 * The key mirrors Next's own (`config.js:1319` keys on `{dir, phase, …, pid}`),
 * because the phase being PART of the key is the mechanism under test in the
 * phase-gate case below — not an incidental detail of the fake.
 */
function memoisedLoadConfig(seed: Record<string, unknown> = {}): {
  loadConfig: LoadNextConfig
  entryFor(phase: string): NextConfigObject | undefined
  calls: () => number
} {
  const cache = new Map<string, NextConfigObject>()
  let calls = 0
  return {
    loadConfig: async (phase, dir) => {
      calls += 1
      const key = `${phase}|${dir}`
      let hit = cache.get(key)
      if (hit === undefined) {
        hit = { configFileName: "next.config.ts", ...structuredClone(seed) }
        cache.set(key, hit)
      }
      return hit
    },
    entryFor: (phase) => cache.get(`${phase}|${DIR}`),
    calls: () => calls,
  }
}

/**
 * The same memo, but over a config object the caller builds — so a test can hand
 * back a FROZEN one, or one whose `turbopack` is an accessor. Identity across
 * calls is preserved exactly as above; these fakes differ from a healthy Next
 * only in whether the object accepts the one write the injection performs.
 */
function memoisedConfigOf(make: () => NextConfigObject): LoadNextConfig {
  let held: NextConfigObject | undefined
  return async () => (held ??= make())
}

describe("probeConfigMemo — the causal assertion", () => {
  it("accepts a memo that hands back one shared object", async () => {
    const memo = memoisedLoadConfig()
    const probe = await probeConfigMemo(memo.loadConfig, DEV_PHASE, DIR)

    expect(probe.ok).toBe(true)
    if (!probe.ok) throw new Error("unreachable")
    // The object it returns must BE the cached one — mutating anything else
    // reaches nothing, which is the whole failure this guards.
    expect(probe.conf).toBe(memo.entryFor(DEV_PHASE))
    // Two calls, sequentially. Concurrent calls could both miss the cache and
    // both compute, reporting a false identity failure for a working memo.
    expect(memo.calls()).toBe(2)
  })

  it("REFUSES a memo that returns a fresh object each call", async () => {
    // THE test. A future Next that defensively copies its resolved config would
    // break in-process injection while every other signal stays green: the
    // module resolves, loadConfig returns a config, prepare() succeeds, routes
    // serve 200. Only this turns that into a loud pre-boot refusal.
    const freshEachTime: LoadNextConfig = async () => ({ configFileName: "next.config.ts" })
    const probe = await probeConfigMemo(freshEachTime, DEV_PHASE, DIR)

    expect(probe.ok).toBe(false)
    if (probe.ok) throw new Error("unreachable")
    expect(probe.failure.code).toBe("seam-shape-changed")
    expect(probe.failure.seam?.id).toContain("memoized object identity")
    expect(probe.failure.seam?.stability).toBe("private")
    // The cause has to say what actually happened, or the reader is left with
    // "Next changed" and nowhere to look.
    expect(probe.failure.cause).toContain("DIFFERENT objects")
    // …and what booting anyway would have cost, because "the server works" is
    // exactly what the user will be looking at.
    expect(probe.failure.cause).toContain("stamps nothing")
    // The fallback needs none of these seams, so this is a downgrade to attach
    // mode rather than a dead end.
    expect(probe.failure.attachCovers).toBe(true)
    expect(probe.failure.remediation.join("\n")).toContain("--attach")
  })

  it("reports a load failure against the MODULE seam, with the cause verbatim", async () => {
    const throws: LoadNextConfig = async () => {
      throw new Error("Unexpected token in next.config.ts")
    }
    const probe = await probeConfigMemo(throws, DEV_PHASE, DIR)

    expect(probe.ok).toBe(false)
    if (probe.ok) throw new Error("unreachable")
    expect(probe.failure.seam?.id).toBe("next/dist/server/config")
    expect(probe.failure.cause).toBe("Unexpected token in next.config.ts")
  })

  it("refuses a loader that stops returning an object at all", async () => {
    const notAnObject: LoadNextConfig = async () => undefined
    const probe = await probeConfigMemo(notAnObject, DEV_PHASE, DIR)

    expect(probe.ok).toBe(false)
    if (probe.ok) throw new Error("unreachable")
    expect(probe.failure.code).toBe("seam-shape-changed")
    expect(probe.failure.cause).toContain("undefined")
  })

  it("diagnoses a missing configFileName as a MODULE shape change, not an identity loss", async () => {
    // Ordering matters here: identity is checked first precisely so a
    // fresh-object memo — which still returns a well-shaped config — is not
    // mis-reported as a field problem. This is the other half of that ordering.
    const shared = { distDir: ".next" }
    const noFileName: LoadNextConfig = async () => shared
    const probe = await probeConfigMemo(noFileName, DEV_PHASE, DIR)

    expect(probe.ok).toBe(false)
    if (probe.ok) throw new Error("unreachable")
    expect(probe.failure.seam?.id).toBe("next/dist/server/config")
    expect(probe.failure.cause).toContain("configFileName")
  })
})

/**
 * The second half of the same assertion, and it was missing.
 *
 * Identity answers "is this the object Next will read?". It does NOT answer "will
 * this object accept the write?" — and MEASURED against the shipped probe, four
 * different config shapes hold identity, pass all six pre-boot gates, and then
 * fail at the injection:
 *
 * | shape                                   | identity | probe | what happens next                    |
 * | --------------------------------------- | -------- | ----- | ------------------------------------ |
 * | `Object.freeze(conf)`                    | true     | PASS  | TypeError, mid-boot, no seam named   |
 * | `Object.seal(conf)`, no `turbopack` yet  | true     | PASS  | TypeError, mid-boot, no seam named   |
 * | `turbopack` getter-only                  | true     | PASS  | TypeError, mid-boot, no seam named   |
 * | `turbopack` normalising accessor         | true     | PASS  | **merge returns ok:true, Next reads no rules at all** |
 *
 * The last row is the one that matters most: it is the `conf`-option failure
 * exactly — healthy server, every route 200, zero stamps, discovered mid-click —
 * manufactured by a Next release rather than by us. The three TypeError rows are
 * milder but still wrong: they surface as a raw internal `TypeError` AFTER the
 * loader has been bundled to disk, with nothing naming the seam that broke.
 */
describe("probeConfigMemo — the mutability assertion", () => {
  it("REFUSES a frozen config, even though identity holds perfectly", async () => {
    const load = memoisedConfigOf(
      () => Object.freeze({ configFileName: "next.config.ts" }) as NextConfigObject,
    )
    const probe = await probeConfigMemo(load, DEV_PHASE, DIR)

    expect(probe.ok).toBe(false)
    if (probe.ok) throw new Error("unreachable")
    expect(probe.failure.code).toBe("seam-shape-changed")
    expect(probe.failure.seam?.id).toContain("mutability")
    expect(probe.failure.seam?.stability).toBe("private")
    expect(probe.failure.attachCovers).toBe(true)
    expect(probe.failure.remediation.join("\n")).toContain("--attach")
  })

  it("REFUSES a turbopack accessor that accepts the write and drops it", async () => {
    // THE silent one. A getter/setter pair that normalises — the shape a Next
    // release would plausibly introduce to validate `turbopack` — makes
    // `mergeStampRules` return ok:true while the config Next reads has no rules
    // on it at all. Nothing downstream of the probe can tell that apart from a
    // successful injection until `verifyStamping` sees a stamp-free document,
    // by which point the server is up and the user is clicking.
    const load = memoisedConfigOf(() => {
      const conf: NextConfigObject = { configFileName: "next.config.ts" }
      let held: unknown
      Object.defineProperty(conf, "turbopack", {
        get: () => held,
        set: () => {
          held = undefined
        },
        enumerable: true,
        configurable: true,
      })
      return conf
    })
    const probe = await probeConfigMemo(load, DEV_PHASE, DIR)

    expect(probe.ok).toBe(false)
    if (probe.ok) throw new Error("unreachable")
    expect(probe.failure.seam?.id).toContain("mutability")
    // The cause has to say what happened — "read it back changed" is the only
    // observable, and a reader who greps `turbopack` in their own config needs it.
    expect(probe.failure.cause).toContain("read back")
    // …and what booting anyway would have cost, because "the server works" is
    // exactly what the user will be looking at.
    expect(probe.failure.cause).toContain("stamps nothing")
  })

  it("REFUSES a getter-only turbopack", async () => {
    const load = memoisedConfigOf(() => {
      const conf: NextConfigObject = { configFileName: "next.config.ts" }
      Object.defineProperty(conf, "turbopack", {
        get: () => ({ rules: {} }),
        enumerable: true,
        configurable: true,
      })
      return conf
    })
    const probe = await probeConfigMemo(load, DEV_PHASE, DIR)

    expect(probe.ok).toBe(false)
    if (probe.ok) throw new Error("unreachable")
    expect(probe.failure.seam?.id).toContain("mutability")
    // Verbatim, because "which has only a getter" is the sentence that tells a
    // maintainer which of the four shapes above they are looking at.
    expect(probe.failure.cause).toContain("only a getter")
  })

  it("REFUSES a sealed config that has no turbopack key to overwrite", async () => {
    // Distinct from frozen: an existing `turbopack` would still be writable, so a
    // probe that only checked `Object.isFrozen` would pass this one.
    const load = memoisedConfigOf(
      () => Object.seal({ configFileName: "next.config.ts" }) as NextConfigObject,
    )
    const probe = await probeConfigMemo(load, DEV_PHASE, DIR)

    expect(probe.ok).toBe(false)
    if (probe.ok) throw new Error("unreachable")
    expect(probe.failure.seam?.id).toContain("mutability")
  })

  it("ACCEPTS a turbopack accessor that faithfully stores what it is given", async () => {
    // The other direction, and the reason the probe asks the object rather than
    // inspecting its descriptor: an accessor is not by itself a break. A Next
    // that aliased `turbopack` onto some other field — a deprecation shim is the
    // obvious way that happens — would pass the write straight through, so
    // refusing every accessor would refuse a config the injection works on.
    // Restoring one is the part that needs care: the descriptor never changed,
    // so only writing the prior value back through the setter puts it right.
    const seed = { rules: { "*.svg": { loaders: ["@svgr/webpack"] } } }
    const load = memoisedConfigOf(() => {
      const conf: NextConfigObject = { configFileName: "next.config.ts" }
      let held: unknown = seed
      Object.defineProperty(conf, "turbopack", {
        get: () => held,
        set: (value: unknown) => {
          held = value
        },
        enumerable: true,
        configurable: true,
      })
      return conf
    })

    const probe = await probeConfigMemo(load, DEV_PHASE, DIR)

    expect(probe.ok).toBe(true)
    if (!probe.ok) throw new Error("unreachable")
    // …and the project's own rule is still there, not a sentinel.
    expect(probe.conf.turbopack).toBe(seed)
  })

  it("leaves a healthy config byte-for-byte as it found it", async () => {
    // The assertion costs a trial write to the very object Next is about to
    // read, so proving the restore is not optional: a leaked sentinel would
    // register a turbopack block with no rules — the clobber bug, reintroduced
    // by the check that exists to prevent a subtler version of it.
    const projectRules = { "*.svg": { loaders: ["@svgr/webpack"], as: "*.js" } }
    const memo = memoisedLoadConfig({ turbopack: { root: "/repo", rules: projectRules } })
    const conf = (await memo.loadConfig(DEV_PHASE, DIR)) as NextConfigObject
    const before = conf.turbopack
    const descriptorBefore = Object.getOwnPropertyDescriptor(conf, "turbopack")

    const probe = await probeConfigMemo(memo.loadConfig, DEV_PHASE, DIR)

    expect(probe.ok).toBe(true)
    // IDENTITY, not deep equality: a restored copy would silently drop any
    // aliasing Next itself holds on that sub-object.
    expect(conf.turbopack).toBe(before)
    expect(Object.getOwnPropertyDescriptor(conf, "turbopack")).toEqual(descriptorBefore)
  })

  it("leaves no turbopack key behind on a config that had none", async () => {
    const memo = memoisedLoadConfig()
    const probe = await probeConfigMemo(memo.loadConfig, DEV_PHASE, DIR)

    expect(probe.ok).toBe(true)
    if (!probe.ok) throw new Error("unreachable")
    // `hasOwn`, not `=== undefined`: the trial write leaves an own key holding
    // `undefined` if the restore deletes nothing, and `mergeStampRules` would
    // then spread an object that is not the project's.
    expect(Object.hasOwn(probe.conf, "turbopack")).toBe(false)
  })
})

describe("mergeStampRules — merge, never clobber", () => {
  it("keeps a project's own SVGR rule alongside ours", async () => {
    // MEASURED regression: `turbopack = { ...turbopack, rules: OURS }` replaces
    // the whole map, so this project's SVG imports silently stopped working with
    // Editor as the only difference and nothing in the logs.
    const memo = memoisedLoadConfig({
      turbopack: {
        root: "/repo",
        rules: { "*.svg": { loaders: ["@svgr/webpack"], as: "*.js" } },
      },
    })
    const conf = (await memo.loadConfig(DEV_PHASE, DIR)) as NextConfigObject

    const merged = mergeStampRules(conf, { loaderPath: LOADER, options: OPTIONS, globs: STAMP_RULE_GLOBS })

    expect(merged.ok).toBe(true)
    if (!merged.ok) throw new Error("unreachable")
    expect(merged.preserved).toEqual(["*.svg"])

    const turbopack = conf.turbopack as { root: string; rules: Record<string, unknown> }
    expect(turbopack.rules["*.svg"]).toEqual({ loaders: ["@svgr/webpack"], as: "*.js" })
    // Non-`rules` keys survive too — `turbopack.root` in particular is a
    // filesystem boundary, and quietly dropping it would widen or narrow what
    // Turbopack may read.
    expect(turbopack.root).toBe("/repo")
  })

  it("registers BOTH extensions, with the loader path and the JSON options", async () => {
    const memo = memoisedLoadConfig()
    const conf = (await memo.loadConfig(DEV_PHASE, DIR)) as NextConfigObject

    mergeStampRules(conf, { loaderPath: LOADER, options: OPTIONS, globs: STAMP_RULE_GLOBS })

    const rules = (conf.turbopack as { rules: Record<string, unknown> }).rules
    // A `*.tsx` rule alone leaves every `.jsx` file unstamped — MEASURED on the
    // fixture's `app/jsx-demo/page.jsx`, which rendered fine and stamped zero.
    expect(Object.keys(rules).sort()).toEqual(["*.jsx", "*.tsx"])
    for (const glob of ["*.tsx", "*.jsx"]) {
      expect(rules[glob]).toEqual({ loaders: [{ loader: LOADER, options: OPTIONS }] })
    }
  })

  it("does not set turbopack.root", async () => {
    // MEASURED: a loader at an absolute path entirely outside the project works
    // with `root` left at its default. Widening it would be a filesystem
    // boundary change bought for nothing.
    const memo = memoisedLoadConfig()
    const conf = (await memo.loadConfig(DEV_PHASE, DIR)) as NextConfigObject

    mergeStampRules(conf, { loaderPath: LOADER, options: OPTIONS, globs: STAMP_RULE_GLOBS })

    expect("root" in (conf.turbopack as Record<string, unknown>)).toBe(false)
  })

  it("mutates in place, because the object identity IS the seam", async () => {
    const memo = memoisedLoadConfig()
    const conf = (await memo.loadConfig(DEV_PHASE, DIR)) as NextConfigObject

    mergeStampRules(conf, { loaderPath: LOADER, options: OPTIONS, globs: STAMP_RULE_GLOBS })

    // The very object Next's own later load will receive carries the rule. A
    // version that returned a new config instead would typecheck, pass every
    // shape assertion, and reach nothing.
    const reread = (await memo.loadConfig(DEV_PHASE, DIR)) as NextConfigObject
    expect(reread).toBe(conf)
    expect(Object.keys((reread.turbopack as { rules: object }).rules)).toContain("*.tsx")
  })

  it("refuses a collision on one of our own globs, and changes nothing", async () => {
    // Composing two loaders on one extension needs Turbopack's application
    // order, which is not measured. If the other loader ran first and shifted a
    // line, every stamp would point at the wrong line and edits would land in
    // the wrong place — worse than not stamping at all.
    const memo = memoisedLoadConfig({
      turbopack: { rules: { "*.tsx": { loaders: ["some-user-loader"] } } },
    })
    const conf = (await memo.loadConfig(DEV_PHASE, DIR)) as NextConfigObject
    const before = structuredClone(conf.turbopack)

    const merged = mergeStampRules(conf, { loaderPath: LOADER, options: OPTIONS, globs: STAMP_RULE_GLOBS })

    expect(merged.ok).toBe(false)
    if (merged.ok) throw new Error("unreachable")
    expect(merged.failure.code).toBe("boot-failed")
    expect(merged.failure.summary).toContain("*.tsx")
    expect(merged.failure.attachCovers).toBe(true)
    // Attach mode is the honest answer here: there the user writes the rule and
    // controls the loader order.
    expect(merged.failure.remediation.join("\n")).toContain("--attach")
    // And the refusal must not have half-applied.
    expect(conf.turbopack).toEqual(before)
  })

  /**
   * The refusal above compared rule keys with `Object.hasOwn` — exact string
   * equality against `"*.tsx"` / `"*.jsx"`. Turbopack rule keys are arbitrary
   * globs, so MEASURED against the shipped check, every one of these was
   * ACCEPTED and both loaders were registered on the same files:
   *
   *     "*.{tsx,jsx}"  ->  rules ["*.{tsx,jsx}", "*.tsx", "*.jsx"]
   *     "**\/*.tsx"     ->  rules ["**\/*.tsx", "*.tsx", "*.jsx"]
   *     "*.[jt]sx"     ->  rules ["*.[jt]sx", "*.tsx", "*.jsx"]
   *     "*"            ->  rules ["*", "*.tsx", "*.jsx"]
   *
   * Which is the outcome the exact-match refusal exists to prevent, reached by
   * spelling the same glob differently. And it is the WORSE half of the failure
   * space: a dead stamper refuses edits, while a stamper whose coordinates are
   * shifted by the lines another loader injected lands edits on the wrong line
   * of the right file.
   */
  describe("a rule that only LOOKS disjoint", () => {
    function withProjectRule(glob: string): NextConfigObject {
      return {
        configFileName: "next.config.ts",
        turbopack: { rules: { [glob]: { loaders: ["their-loader"] } } },
      }
    }

    // Every one of these can match a .tsx or .jsx file, or cannot be proven not
    // to. Exact-key comparison saw none of them.
    it.each([
      ["*.{tsx,jsx}", "a brace expansion covering both of our extensions"],
      ["**/*.tsx", "the same extension, reached recursively"],
      ["*.[jt]sx", "a character class covering both"],
      ["*.ts?(x)", "an extglob that optionally covers ours"],
      ["*", "a rule for literally every file"],
      ["**/*", "the same, recursively"],
      ["src/*.TSX", "our extension in a different case"],
    ])("refuses %s — %s", (glob) => {
      const conf = withProjectRule(glob)
      const before = structuredClone(conf.turbopack)

      const merged = mergeStampRules(conf, {
        loaderPath: LOADER,
        options: OPTIONS,
        globs: STAMP_RULE_GLOBS,
      })

      expect(merged.ok).toBe(false)
      if (merged.ok) throw new Error("unreachable")
      expect(merged.failure.code).toBe("boot-failed")
      // The user's own glob, verbatim, or they cannot find it in their config.
      expect(merged.failure.summary).toContain(glob)
      expect(merged.failure.attachCovers).toBe(true)
      expect(merged.failure.remediation.join("\n")).toContain("--attach")
      // And nothing half-applied.
      expect(conf.turbopack).toEqual(before)
    })

    it("says WHY a glob it cannot decide was refused, not just that it collided", () => {
      // "Editor cannot prove this is safe" and "this collides with ours" are
      // different problems with different fixes, and a user staring at
      // `*.{tsx,jsx}` needs to know which one they have.
      const merged = mergeStampRules(withProjectRule("*.{tsx,jsx}"), {
        loaderPath: LOADER,
        options: OPTIONS,
        globs: STAMP_RULE_GLOBS,
      })

      expect(merged.ok).toBe(false)
      if (merged.ok) throw new Error("unreachable")
      expect(merged.failure.cause).toContain("cannot prove")
      // The consequence, in the terms the user experiences it.
      expect(merged.failure.cause).toContain("wrong line")
      // And the fix that is cheaper than dropping to attach mode: this refusal
      // is bought by a soundness rule, so respelling the glob clears it.
      expect(merged.failure.remediation.join("\n")).toContain("one key per literal extension")
    })

    it("keeps the plainer remediation when the rule genuinely collides", () => {
      // Nothing to respell here — `*.tsx` IS our glob — so suggesting a spelling
      // change would be advice that cannot work.
      const merged = mergeStampRules(withProjectRule("*.tsx"), {
        loaderPath: LOADER,
        options: OPTIONS,
        globs: STAMP_RULE_GLOBS,
      })

      expect(merged.ok).toBe(false)
      if (merged.ok) throw new Error("unreachable")
      expect(merged.failure.remediation.join("\n")).toContain("remove the *.tsx rule")
      expect(merged.failure.remediation.join("\n")).not.toContain("one key per literal extension")
    })

    // The other half of the bias, and the reason this is a classifier rather
    // than a blanket "any rule at all is a refusal": the SVGR case is the
    // measured, shipped, working configuration this host was built against.
    it.each([
      ["*.svg", "the measured SVGR case"],
      ["**/*.svg", "the same, recursively"],
      ["*.module.css", "a compound extension"],
      ["./src/**/*.graphql", "a rooted path glob"],
      ["*.tsx.snap", "a literal tail that merely CONTAINS ours"],
    ])("still composes with %s — %s", (glob) => {
      const conf = withProjectRule(glob)

      const merged = mergeStampRules(conf, {
        loaderPath: LOADER,
        options: OPTIONS,
        globs: STAMP_RULE_GLOBS,
      })

      expect(merged.ok).toBe(true)
      if (!merged.ok) throw new Error("unreachable")
      expect(merged.preserved).toEqual([glob])
      const rules = (conf.turbopack as { rules: Record<string, unknown> }).rules
      expect(Object.keys(rules).sort()).toEqual([glob, "*.jsx", "*.tsx"].sort())
    })
  })

  it("handles a config with no turbopack block at all", async () => {
    const memo = memoisedLoadConfig()
    const conf = (await memo.loadConfig(DEV_PHASE, DIR)) as NextConfigObject
    expect(conf.turbopack).toBeUndefined()

    const merged = mergeStampRules(conf, { loaderPath: LOADER, options: OPTIONS, globs: STAMP_RULE_GLOBS })

    expect(merged).toEqual({ ok: true, preserved: [] })
    expect(Object.keys((conf.turbopack as { rules: object }).rules)).toHaveLength(2)
  })
})

describe("the phase gate", () => {
  it("touches only the development-server phase, so `next build` never sees the loader", async () => {
    // The gate is the PHASE, which is part of the memo's cache key. Priming the
    // development entry cannot reach the production-build entry, in this process
    // or any other.
    const memo = memoisedLoadConfig()

    const dev = await probeConfigMemo(memo.loadConfig, DEV_PHASE, DIR)
    expect(dev.ok).toBe(true)
    if (!dev.ok) throw new Error("unreachable")
    mergeStampRules(dev.conf, { loaderPath: LOADER, options: OPTIONS, globs: STAMP_RULE_GLOBS })

    const build = (await memo.loadConfig(BUILD_PHASE, DIR)) as NextConfigObject
    expect(build).not.toBe(dev.conf)
    expect(build.turbopack).toBeUndefined()
  })

  it("is decided by the phase and NOT by process.env.NODE_ENV", async () => {
    // NODE_ENV is ambient: any parent process, shell profile or CI runner can
    // set it, so a NODE_ENV-based gate is one `export` away from shipping
    // data-desde-src into prerendered production HTML (MEASURED in attach mode:
    // 34 stamps in the build output before the phase gate existed). The phase is
    // an argument Next passes at its own call site, which nothing outside Next
    // can forge — so flipping NODE_ENV must change neither answer.
    const original = process.env["NODE_ENV"]
    try {
      for (const nodeEnv of ["production", "development", "test"]) {
        process.env["NODE_ENV"] = nodeEnv
        const memo = memoisedLoadConfig()

        const dev = await probeConfigMemo(memo.loadConfig, DEV_PHASE, DIR)
        if (!dev.ok) throw new Error("unreachable")
        mergeStampRules(dev.conf, { loaderPath: LOADER, options: OPTIONS, globs: STAMP_RULE_GLOBS })

        // The dev entry is stamped regardless of NODE_ENV…
        expect((dev.conf.turbopack as { rules: object }).rules).toHaveProperty("*.tsx")
        // …and the build entry is clean regardless of NODE_ENV.
        const build = (await memo.loadConfig(BUILD_PHASE, DIR)) as NextConfigObject
        expect(build.turbopack).toBeUndefined()
      }
    } finally {
      if (original === undefined) delete process.env["NODE_ENV"]
      else process.env["NODE_ENV"] = original
    }
  })
})

describe("developmentPhaseFrom", () => {
  it("reads Next's own constant rather than hardcoding its value", () => {
    expect(developmentPhaseFrom({ PHASE_DEVELOPMENT_SERVER: "phase-development-server" })).toBe(
      "phase-development-server",
    )
    // A renamed VALUE is followed automatically; a hardcoded string would prime
    // a cache entry nothing reads, which boots a healthy server that stamps
    // nothing.
    expect(developmentPhaseFrom({ PHASE_DEVELOPMENT_SERVER: "phase-dev-2" })).toBe("phase-dev-2")
  })

  it("returns null rather than guessing when the constant is gone", () => {
    expect(developmentPhaseFrom({})).toBeNull()
    expect(developmentPhaseFrom({ PHASE_DEVELOPMENT_SERVER: "" })).toBeNull()
    expect(developmentPhaseFrom({ PHASE_DEVELOPMENT_SERVER: 3 })).toBeNull()
    expect(developmentPhaseFrom(null)).toBeNull()
  })
})
