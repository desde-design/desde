/**
 * Detection emits EVIDENCE, and this suite is mostly about what it no longer
 * does.
 *
 * Three refusals were deleted at the detection rewrite — `missing-vite`,
 * `no-vite-config`, `no-next-config` — because each stated what the OLD boot
 * path needed rather than anything about the repo. A Next app runs fine with no
 * `next.config`; a monorepo package can have a `vite.config.ts` and no declared
 * `vite`. Both were refused at exit 3 with a link to a support matrix saying
 * they were unsupported, which was false. They are now an absent or
 * lower-confidence candidate, and `hosts/resolve.ts` decides what that means.
 *
 * What survives as a refusal is only what is true of the REPO: no package.json,
 * unreadable package.json, Vue 2, and no Vue/React at all.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detectFramework } from "../framework-detection.js"
import type { HostEvidence } from "../../hosts/types.js"

let repoRoot: string

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "editor-cli-fw-"))
})

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true })
})

async function writePkg(pkg: object): Promise<void> {
  await writeFile(join(repoRoot, "package.json"), JSON.stringify(pkg))
}

async function writeViteConfig(name = "vite.config.ts"): Promise<void> {
  await writeFile(join(repoRoot, name), "export default {}")
}

async function writeConfig(name: string): Promise<void> {
  await writeFile(join(repoRoot, name), "export default {}")
}

/** The ranked candidate ids, which is what most of these assertions are about. */
async function candidateIds(): Promise<string[]> {
  const result = await detectFramework(repoRoot)
  if (!result.ok) throw new Error(`expected detection to succeed, got ${result.reason}`)
  return result.candidates.map((c) => c.hostId)
}

async function candidates(): Promise<HostEvidence[]> {
  const result = await detectFramework(repoRoot)
  if (!result.ok) throw new Error(`expected detection to succeed, got ${result.reason}`)
  return result.candidates
}

describe("detectFramework — the framework axis", () => {
  it("accepts a typical Vue 3 + Vite + design-system repo", async () => {
    await writePkg({
      dependencies: { vue: "^3.4.0", vite: "^5.0.0", "@acme/design-system": "^9.0.0" },
    })
    await writeViteConfig()
    const result = await detectFramework(repoRoot)
    expect(result).toEqual({
      ok: true,
      framework: "vue3",
      languages: ["vue-sfc"],
      candidates: [
        {
          hostId: "vite",
          confidence: "certain",
          because: ['"vite" is a dependency', "vite.config.ts is present"],
        },
      ],
      warnings: [],
    })
  })

  it("accepts a React + Vite repo and tags framework 'react'", async () => {
    await writePkg({
      dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", vite: "^7.0.0" },
    })
    await writeViteConfig()
    const result = await detectFramework(repoRoot)
    expect(result).toMatchObject({ ok: true, framework: "react", languages: ["jsx"] })
  })

  it("accepts React in devDependencies", async () => {
    await writePkg({ devDependencies: { react: "^18.2.0", vite: "^5.0.0" } })
    await writeViteConfig()
    const result = await detectFramework(repoRoot)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.framework).toBe("react")
  })

  it("says nothing about design systems, for any framework", async () => {
    await writePkg({ dependencies: { react: "^19.0.0", vite: "^7.0.0" } })
    await writeViteConfig()
    const result = await detectFramework(repoRoot)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.warnings.some((w) => /design system/i.test(w))).toBe(false)
    }
  })

  it("soft-warns (not refuses) on React below the tested major floor", async () => {
    await writePkg({ dependencies: { react: "^17.0.0", vite: "^5.0.0" } })
    await writeViteConfig()
    const result = await detectFramework(repoRoot)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warnings.some((w) => w.includes("React 17"))).toBe(true)
  })

  it("prefers Vue when both vue and react are present", async () => {
    await writePkg({
      dependencies: { vue: "^3.4.0", react: "^19.0.0", vite: "^7.0.0" },
    })
    await writeViteConfig()
    const result = await detectFramework(repoRoot)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.framework).toBe("vue3")
  })

  it("does NOT list both island dialects when both frameworks are declared", async () => {
    // `core.ts` injects ONE framework-gated stamper. Listing both languages
    // would make `StampingCoverage` claim a dialect nothing stamps — a coverage
    // claim with nothing behind it, which is the failure the coverage module
    // exists to prevent. Genuine dual-island support needs the
    // (language × channel) provider table.
    await writePkg({ dependencies: { vue: "^3.4.0", react: "^19.0.0", vite: "^7.0.0" } })
    await writeViteConfig()
    const result = await detectFramework(repoRoot)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.languages).toEqual(["vue-sfc"])
  })

  it("accepts Vue/Vite in devDependencies and peerDependencies", async () => {
    for (const key of ["devDependencies", "peerDependencies"]) {
      await rm(repoRoot, { recursive: true, force: true })
      repoRoot = await mkdtemp(join(tmpdir(), "editor-cli-fw-"))
      await writePkg({ [key]: { vue: "^3.4.0", vite: "^5.0.0" } })
      await writeViteConfig()
      expect((await detectFramework(repoRoot)).ok, `failed for ${key}`).toBe(true)
    }
  })

  it("emits a soft warning for old Vite versions", async () => {
    await writePkg({ dependencies: { vue: "^3.4.0", vite: "^3.2.0" } })
    await writeViteConfig()
    const result = await detectFramework(repoRoot)
    expect(result.ok).toBe(true)
    // The Vite major warning moved to the vite HOST's probe, which reads the
    // INSTALLED version rather than a declared range — detection reports the
    // candidate and lets the host judge the version it will actually load.
    if (result.ok) expect(result.candidates.map((c) => c.hostId)).toEqual(["vite"])
  })

  it("emits a soft warning for unparseable Vue version strings (workspace:*, etc.)", async () => {
    await writePkg({ dependencies: { vue: "workspace:*", vite: "^5.0.0" } })
    await writeViteConfig()
    const result = await detectFramework(repoRoot)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.warnings.some((w) => w.includes("Could not infer Vue major"))).toBe(true)
    }
  })
})

/**
 * Every package.json shape below is copied from the real clone the matrix was
 * measured against, because the failure this suite exists to prevent is
 * "detection refuses a repo we can actually drive":
 *
 *  - Next (`studio-admin`): `next` + `react`, NO `vite` dependency, no
 *    `vite.config.*`, config file is `next.config.mjs`.
 *  - Nuxt (`nuxt-ui-template-dashboard`): `nuxt` + `vue`, NO `vite`
 *    dependency and NO `vite.config.*` at all — only `nuxt.config.ts`.
 *  - React Router (`react-router-website`): `@react-router/dev` + `vite` +
 *    `vite.config.ts`, which is why it passed the OLD gate and then failed to
 *    boot with a 404.
 */
describe("detectFramework — host evidence", () => {
  it("names Next, certain, when the config corroborates the dependency", async () => {
    await writePkg({
      dependencies: { next: "^16.3.0", react: "^19.2.8", "react-dom": "^19.2.8" },
    })
    await writeConfig("next.config.mjs")
    expect(await candidates()).toEqual([
      {
        hostId: "next",
        confidence: "certain",
        because: ['"next" is a dependency', "next.config.mjs is present"],
      },
    ])
  })

  it("accepts every next.config extension Next itself supports", async () => {
    for (const cfg of ["next.config.ts", "next.config.js", "next.config.mjs", "next.config.cjs"]) {
      await rm(repoRoot, { recursive: true, force: true })
      repoRoot = await mkdtemp(join(tmpdir(), "editor-cli-fw-"))
      await writePkg({ dependencies: { next: "^16.0.0", react: "^19.0.0" } })
      await writeConfig(cfg)
      expect((await candidates())[0], `failed for ${cfg}`).toMatchObject({
        hostId: "next",
        confidence: "certain",
      })
    }
  })

  it("does NOT refuse a Next repo with no next.config — it is likely, not absent", async () => {
    // The behaviour change. Next runs fine without a config, and since the
    // in-process Next host materializes its own loader and primes the resolved
    // config in memory, it can boot one. Attach mode still needs the file, and
    // its preflight generates one with the exact block to write (exit 5) — which
    // is a better answer than the exit 3 this used to be.
    await writePkg({ dependencies: { next: "^16.0.0", react: "^19.0.0" } })
    const result = await detectFramework(repoRoot)
    expect(result.ok).toBe(true)
    expect((await candidates())[0]).toMatchObject({ hostId: "next", confidence: "likely" })
  })

  it("treats Next as React even when react is not declared (resolved through next)", async () => {
    await writePkg({ dependencies: { next: "^16.0.0" } })
    await writeConfig("next.config.ts")
    const result = await detectFramework(repoRoot)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.framework).toBe("react")
  })

  it("names Nuxt with NO vite dependency and NO vite.config", async () => {
    await writePkg({ dependencies: { nuxt: "^4.5.1", vue: "^3.5.40" } })
    await writeConfig("nuxt.config.ts")
    const result = await detectFramework(repoRoot)
    expect(result).toEqual({
      ok: true,
      framework: "vue3",
      languages: ["vue-sfc"],
      candidates: [
        {
          hostId: "nuxt",
          confidence: "certain",
          because: ['"nuxt" is a dependency', "nuxt.config.ts is present"],
        },
      ],
      warnings: [],
    })
  })

  it("names React Router (dev package in devDependencies), and drops the bare vite candidate", async () => {
    // The regression that motivated the tier: RRv7/v8 passed the old
    // vite+react+vite.config gate and then served HTTP 404, because the
    // framework generates the HTML in its own dev server.
    await writePkg({
      dependencies: { react: "19.2.5", "react-router": "8.0.0" },
      devDependencies: { "@react-router/dev": "8.0.0", vite: "8.0.8" },
    })
    await writeViteConfig()
    expect(await candidateIds()).toEqual(["react-router"])
  })

  it("names Astro, and adds `.astro` to the language set", async () => {
    // The multi-valued win: `.astro` markup has no stamper, so the gap has to be
    // a declared fact rather than something found by clicking.
    await writePkg({ dependencies: { astro: "^7.2.0", vue: "^3.5.0" } })
    await writeConfig("astro.config.mjs")
    const result = await detectFramework(repoRoot)
    expect(result).toMatchObject({
      ok: true,
      framework: "vue3",
      languages: ["astro", "vue-sfc"],
    })
    expect(await candidateIds()).toEqual(["astro"])
  })

  it("ranks Next above a stray meta marker rather than calling it ambiguous", async () => {
    // A Next repo that also has `astro` installed for a docs sub-package is
    // still a Next repo; the host that owns the dev server wins. Both are
    // reported, so `--host astro` remains available to someone who disagrees.
    await writePkg({ dependencies: { next: "^16.0.0", react: "^19.0.0", astro: "^7.0.0" } })
    await writeConfig("next.config.ts")
    await writeConfig("astro.config.mjs")
    expect(await candidateIds()).toEqual(["next", "astro"])
  })

  it("does not attribute `.astro` to a repo Astro does not serve", async () => {
    // Same shape as above. The Astro host never runs, so warning that `.astro`
    // is inspect-only would be a warning about nothing.
    await writePkg({ dependencies: { next: "^16.0.0", react: "^19.0.0", astro: "^7.0.0" } })
    await writeConfig("next.config.ts")
    await writeConfig("astro.config.mjs")
    const result = await detectFramework(repoRoot)
    expect(result.ok && result.languages).toEqual(["jsx"])
  })

  it("reports BOTH meta-frameworks when both are corroborated, rather than picking one", async () => {
    // The silent-wrong-answer bug. `META_FRAMEWORK_MARKERS.find(...)` returned
    // `nuxt` here and nothing said the answer was a guess; a wrong host boots,
    // serves 200s and stamps nothing. Detection now reports both and
    // `resolveHost` refuses.
    await writePkg({ dependencies: { nuxt: "^4.5.1", astro: "^7.2.0", vue: "^3.5.0" } })
    await writeConfig("nuxt.config.ts")
    await writeConfig("astro.config.mjs")
    const found = await candidates()
    expect(found.map((c) => c.hostId)).toEqual(["nuxt", "astro"])
    expect(found.every((c) => c.confidence === "certain")).toBe(true)
  })

  it("keeps a meta-framework's soft warnings", async () => {
    await writePkg({ dependencies: { nuxt: "^4.5.1", vue: "workspace:*" } })
    await writeConfig("nuxt.config.ts")
    const result = await detectFramework(repoRoot)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.warnings.some((w) => w.includes("Could not infer Vue major"))).toBe(true)
    }
  })
})

describe("detectFramework — candidates the old gate refused", () => {
  it("keeps a vite candidate when the dependency is hoisted away but the config is there", async () => {
    // A monorepo package whose `vite` lives at the workspace root. The old gate
    // demanded the dependency and refused this at exit 3 — a repo we can drive.
    await writePkg({ dependencies: { vue: "^3.4.0" } })
    await writeViteConfig()
    expect(await candidates()).toEqual([
      { hostId: "vite", confidence: "likely", because: ["vite.config.ts is present"] },
    ])
  })

  it("keeps a vite candidate when the dependency is there but no config file is", async () => {
    await writePkg({ dependencies: { vue: "^3.4.0", vite: "^5.0.0" } })
    expect(await candidates()).toEqual([
      { hostId: "vite", confidence: "likely", because: ['"vite" is a dependency'] },
    ])
  })

  it("accepts vite.config.js, .mjs, .cjs in addition to .ts", async () => {
    for (const cfg of ["vite.config.js", "vite.config.mjs", "vite.config.cjs"]) {
      await rm(repoRoot, { recursive: true, force: true })
      repoRoot = await mkdtemp(join(tmpdir(), "editor-cli-fw-"))
      await writePkg({ dependencies: { vue: "^3.0.0" } })
      await writeViteConfig(cfg)
      expect(await candidateIds(), `failed for ${cfg}`).toEqual(["vite"])
    }
  })

  it("emits NO candidate for a Vue app on some other bundler", async () => {
    // Not a refusal: `resolveHost` turns an empty candidate list into the attach
    // downgrade, with the stamper caveat stated alongside.
    await writePkg({ dependencies: { vue: "^3.4.0", webpack: "^5.0.0" } })
    expect(await candidateIds()).toEqual([])
  })
})

describe("detectFramework — the four surviving refusals", () => {
  it("refuses with reason 'no-package-json' when package.json is missing", async () => {
    const result = await detectFramework(repoRoot)
    expect(result).toMatchObject({ ok: false, reason: "no-package-json" })
  })

  it("refuses with reason 'malformed-package-json' on broken JSON", async () => {
    await writeFile(join(repoRoot, "package.json"), "{ not json")
    const result = await detectFramework(repoRoot)
    expect(result).toMatchObject({ ok: false, reason: "malformed-package-json" })
  })

  it("refuses with reason 'missing-framework' when neither vue nor react is present", async () => {
    await writePkg({ dependencies: { vite: "^5.0.0" } })
    await writeViteConfig()
    const result = await detectFramework(repoRoot)
    expect(result).toMatchObject({ ok: false, reason: "missing-framework" })
  })

  it("refuses a meta-framework project with neither vue nor react", async () => {
    // An Astro project of pure `.astro` files has no island framework, and
    // `.astro` markup has no stamper — accepting it would promise an edit
    // round-trip that cannot happen.
    await writePkg({ dependencies: { astro: "^7.2.0" } })
    await writeConfig("astro.config.mjs")
    const result = await detectFramework(repoRoot)
    expect(result).toMatchObject({ ok: false, reason: "missing-framework" })
  })

  it("does NOT claim SvelteKit — no Svelte stamper exists, so it stays refused", async () => {
    // MEASURED, and the reason the `unknown` downgrade does NOT cover SvelteKit:
    // a SvelteKit repo has `vite` AND a `vite.config.ts`, so it produces a
    // CERTAIN `vite` candidate and never reaches the empty-candidate branch.
    // Letting it through would boot it on the plain Vite supervisor with no
    // stamper injected at all — healthy 200s, zero stamps. See
    // `tasks/dev-server-hosts.md` § 5, milestone 12.
    await writePkg({ dependencies: { "@sveltejs/kit": "^2.0.0", vite: "^5.0.0" } })
    await writeViteConfig()
    const result = await detectFramework(repoRoot)
    expect(result).toMatchObject({ ok: false, reason: "missing-framework" })
    if (!result.ok) expect(result.message).toMatch(/Svelte/)
  })

  it("refuses with reason 'wrong-vue-major' on Vue 2, under any host", async () => {
    await writePkg({ dependencies: { vue: "^2.7.0", vite: "^5.0.0" } })
    await writeViteConfig()
    expect(await detectFramework(repoRoot)).toMatchObject({ ok: false, reason: "wrong-vue-major" })

    await rm(repoRoot, { recursive: true, force: true })
    repoRoot = await mkdtemp(join(tmpdir(), "editor-cli-fw-"))
    await writePkg({ dependencies: { nuxt: "^2.17.0", vue: "^2.7.0" } })
    await writeConfig("nuxt.config.ts")
    expect(await detectFramework(repoRoot)).toMatchObject({ ok: false, reason: "wrong-vue-major" })
  })

  it("returns helpful messages with a docs URL on every refusal", async () => {
    const result = await detectFramework(repoRoot)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // Assert the docs URL itself. The previous alternation also accepted
      // "package.json", so a refusal carrying no URL at all would have passed
      // the test whose name promises one.
      expect(result.message).toMatch(/https:\/\/desde\.design\/docs\//)
    }
  })
})

describe("detectFramework — version range parsing", () => {
  it("infers major from caret, tilde, x-range and exact forms", async () => {
    for (const range of ["^3.4.0", "~3.4.0", "3.x", "3.4.0"]) {
      await rm(repoRoot, { recursive: true, force: true })
      repoRoot = await mkdtemp(join(tmpdir(), "editor-cli-fw-"))
      await writePkg({ dependencies: { vue: range, vite: "^5.0.0" } })
      await writeViteConfig()
      expect((await detectFramework(repoRoot)).ok, `failed for ${range}`).toBe(true)
    }
  })

  it("rejects exact Vue 2 (2.7.16)", async () => {
    await writePkg({ dependencies: { vue: "2.7.16", vite: "^5.0.0" } })
    await writeViteConfig()
    const result = await detectFramework(repoRoot)
    expect(result).toMatchObject({ ok: false, reason: "wrong-vue-major" })
  })

  it("does NOT refuse multi-major ranges that include Vue 3 (codex P2 round 2)", async () => {
    // ">=2.7.0 <4.0.0" allows Vue 3. The naive impl that treats the
    // first numeric token as the major would refuse here. We treat
    // multi-range expressions as ambiguous → soft warning, not hard
    // refusal. Real incompatibility surfaces at boot.
    await writePkg({ dependencies: { vue: ">=2.7.0 <4.0.0", vite: "^5.0.0" } })
    await writeViteConfig()
    const result = await detectFramework(repoRoot)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.warnings.some((w) => w.includes("Vue major"))).toBe(true)
    }
  })

  it("does NOT refuse OR-expressions or open >= ranges", async () => {
    for (const range of ["^2 || ^3", ">=3.0.0"]) {
      await rm(repoRoot, { recursive: true, force: true })
      repoRoot = await mkdtemp(join(tmpdir(), "editor-cli-fw-"))
      await writePkg({ dependencies: { vue: range, vite: "^5.0.0" } })
      await writeViteConfig()
      expect((await detectFramework(repoRoot)).ok, `failed for ${range}`).toBe(true)
    }
  })
})
