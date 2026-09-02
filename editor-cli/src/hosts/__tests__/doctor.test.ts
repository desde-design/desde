/**
 * `--doctor` — the facts a support conversation should start from.
 *
 * The assertions worth having here are about what it says when things are
 * WRONG, because that is when someone runs it. A report that only works on a
 * healthy project is a report nobody needs.
 *
 * Every fixture below is a package.json and a config file, with NO
 * `node_modules` anywhere — which is also the test that the report boots
 * nothing and probes nothing. A `probe()` call would try to resolve the
 * framework out of the prototype and fail on all of them.
 */
import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runDoctor } from "../doctor.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "editor-cli-doctor-"))
  roots.push(root)
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(root, name), body)
  }
  return root
}

const pkg = (deps: Record<string, string>): string => JSON.stringify({ dependencies: deps })

describe("runDoctor — the ordinary report", () => {
  it("names the resolved host, quotes the evidence, and lists its seams", async () => {
    const repoPath = await fixture({
      "package.json": pkg({ vue: "^3.5.0", vite: "^7.0.0" }),
      "vite.config.ts": "export default {}",
    })
    const report = await runDoctor({ repoPath })

    expect(report).toContain("Framework:    vue3")
    expect(report).toContain("vite  (certain)")
    expect(report).toContain('"vite" is a dependency')
    expect(report).toContain("Resolved host: vite")
    // The seam table is the point: a support conversation about a broken seam
    // should start from the list of them, not from archaeology.
    expect(report).toMatch(/expression:/)
    expect(report).toContain("vue-sfc: covered via vite-plugin")
  })

  /**
   * Retargeted from `nuxt` to `astro` by the 2026-08-11 milestone-13 flip,
   * which put `nuxt`, `react-router` and `next` into `DEFAULT_ENABLED`. The
   * property is unchanged — a host can be BUILT and still not be ON, and the
   * doctor has to say which — but `nuxt` stopped being a witness for it the
   * moment it became default-on. `astro` is the only host left that can
   * demonstrate it, and it is held deliberately (see `DEFAULT_ENABLED`).
   */
  it("says a built host is not turned on, because those are different facts", async () => {
    const repoPath = await fixture({
      "package.json": pkg({ astro: "^7.2.0", vue: "^3.5.0" }),
      "astro.config.mjs": "export default {}",
    })
    const report = await runDoctor({ repoPath })

    expect(report).toContain("Resolved host: astro")
    expect(report).toContain("NOT ENABLED")
    expect(report).toContain('{"hosts":{"astro":true}}')
  })

  it("reports a flipped host as on, without an opt-in line to paste", async () => {
    // The other half of the same fact, and the one the flip created. A Nuxt
    // repo that configures nothing is now booted rather than refused, so the
    // doctor must not still be telling its user to paste an opt-in.
    const repoPath = await fixture({
      "package.json": pkg({ nuxt: "^4.5.1", vue: "^3.5.40" }),
      "nuxt.config.ts": "export default {}",
    })
    const report = await runDoctor({ repoPath })

    expect(report).toContain("Resolved host: nuxt")
    expect(report).not.toContain("NOT ENABLED")
    expect(report).not.toContain('{"hosts":{"nuxt":true}}')
  })

  it("declares the .astro gap rather than leaving it to be found by clicking", async () => {
    const repoPath = await fixture({
      "package.json": pkg({ astro: "^7.2.0", vue: "^3.5.0" }),
      "astro.config.mjs": "export default {}",
    })
    const report = await runDoctor({ repoPath })

    expect(report).toContain("Languages:    astro, vue-sfc")
    expect(report).toMatch(/astro: NOT covered/)
    expect(report).toContain("vue-sfc: covered via vite-plugin")
  })

  it("describes the attach host, including its empty seam table", async () => {
    const repoPath = await fixture({
      "package.json": pkg({ next: "^16.3.0", react: "^19.2.8" }),
      "next.config.ts": "export default {}",
    })
    const report = await runDoctor({ repoPath, attachUrl: "http://localhost:3000" })

    expect(report).toContain("Resolved host: attach")
    expect(report).toContain("this is why attach mode is the fallback")
    // No package of ours resolves from the prototype, so there is no version to
    // gate — printed as a plain aside rather than a fabricated range.
    expect(report).toMatch(/Version gate: \(no package/)
  })
})

describe("runDoctor — the reports someone actually runs it for", () => {
  it("reports an ambiguous project with both evidence lists", async () => {
    const repoPath = await fixture({
      "package.json": pkg({ nuxt: "^4.5.1", astro: "^7.2.0", vue: "^3.5.0" }),
      "nuxt.config.ts": "export default {}",
      "astro.config.mjs": "export default {}",
    })
    const report = await runDoctor({ repoPath })

    expect(report).toContain("Resolved host: NONE (ambiguous-host)")
    expect(report).toContain("nuxt.config.ts is present")
    expect(report).toContain("astro.config.mjs is present")
    expect(report).toContain("--host nuxt")
    // And NOT a config shape for attach mode. Ambiguity refuses on that lane
    // too, so naming one would contradict the refusal directly above it. Found
    // by running the real CLI against the ambiguous fixture, which printed both.
    expect(report).not.toMatch(/Attach mode would wire/)
  })

  it("resolves the host --host names, so the report matches the next boot", async () => {
    const repoPath = await fixture({
      "package.json": pkg({ nuxt: "^4.5.1", astro: "^7.2.0", vue: "^3.5.0" }),
      "nuxt.config.ts": "export default {}",
      "astro.config.mjs": "export default {}",
    })
    const report = await runDoctor({ repoPath, hostId: "astro" })
    expect(report).toContain("Resolved host: astro")
    expect(report).toContain("--host astro was passed explicitly")
  })

  it("reports the unknown downgrade, and which config shape attach would wire", async () => {
    const repoPath = await fixture({
      "package.json": pkg({ vue: "^3.5.0", webpack: "^5.0.0" }),
    })
    const report = await runDoctor({ repoPath })

    expect(report).toContain("(none: this project would downgrade to attach mode)")
    expect(report).toContain("Resolved host: NONE (no-in-process-host)")
    expect(report).toContain("Attach mode would wire the vite config shape")
  })

  it("reports a refusal as a report, not as a crash", async () => {
    const repoPath = await fixture({ "package.json": pkg({ "@sveltejs/kit": "^2.0.0" }) })
    const report = await runDoctor({ repoPath })

    expect(report).toContain("Detection:    REFUSED (missing-framework)")
    expect(report).toContain("Svelte")
    expect(report).toContain("nothing further to report")
  })

  it("survives a directory that is not a project at all", async () => {
    const repoPath = await fixture({})
    await expect(runDoctor({ repoPath })).resolves.toContain("REFUSED (no-package-json)")
  })
})
