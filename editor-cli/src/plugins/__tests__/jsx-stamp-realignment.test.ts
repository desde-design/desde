/**
 * A `data-desde-src` must name the AUTHORED coordinate even when an earlier Vite
 * plugin rewrote the module first.
 *
 * ── The measured defect ─────────────────────────────────────────────────────
 *
 * Both stampers are `enforce: "pre"`, and that is not a guarantee of running
 * first: Vite preserves array order within a bucket, and every host merges the
 * repo's own plugins ahead of ours. `@vitejs/plugin-react` v4's
 * `vite:react-babel` is also `enforce: "pre"` and regenerates the module from a
 * Babel AST with the react-refresh preamble prepended. MEASURED 2026-08-11 on a
 * fixture whose only non-default plugin was `react()`: every stamp's LINE was
 * 19 too high, 18 of 20 stamps named no element at all, and 2 named a REAL BUT
 * DIFFERENT element (`src/App.tsx:29:6` sat on a `<p class="row">` while naming
 * a `<div class="insert-host">`).
 *
 * The second row is the one that matters. The applicator re-reads the file from
 * disk and so does any instrument checking it, which means the two agree with
 * each other while pointing at an element the user never clicked — the exact
 * signature of the detach defect that broke 59 of 65 apparent successes with
 * green unit tests throughout.
 *
 * ── What these tests hold ───────────────────────────────────────────────────
 *
 * Every coordinate assertion is computed from the AUTHORED file text, never
 * hardcoded, and each is paired with a proof that the REWRITTEN text puts that
 * element somewhere else — so a test cannot pass by accident if realignment is
 * removed. `rewriteLikePluginReactV4` reproduces the two things v4 actually
 * does (a multi-line prepend, and reformatting that makes the authored bytes
 * not even a contiguous substring of the output), so the fixture is not a
 * strawman that a naive byte-offset fix would satisfy.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Plugin } from "vite"
import { jsxSourceTagPlugin } from "../jsx-source-tag-plugin.js"
import { sourceTagPlugin } from "../source-tag-plugin.js"
import { readModuleStampNotices, resetTransformInputWarnings } from "../transform-input.js"

let repo: string

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "pt-realign-"))
  resetTransformInputWarnings()
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** Write the authored file to disk — `classifyTransformInput` reads it back. */
function authorFile(relPath: string, source: string): string {
  const abs = join(repo, relPath)
  writeFileSync(abs, source, "utf8")
  return abs
}

function transform(code: string, abs: string): string | null {
  const plugin = jsxSourceTagPlugin({ repoRoot: repo }) as Plugin
  const t = plugin.transform as unknown as (
    code: string,
    id: string,
  ) => { code: string } | null
  return t.call({} as never, code, abs)?.code ?? null
}

/** Every `data-desde-src` value in transform output, in document order. */
function stamps(code: string | null): string[] {
  if (code === null) return []
  return Array.from(code.matchAll(/data-desde-src="([^"]+)"/g)).map((m) => m[1])
}

function ptv(code: string | null): string[] {
  if (code === null) return []
  return Array.from(code.matchAll(/data-desde-v="([^"]+)"/g)).map((m) => m[1])
}

/** 1-based line of the first occurrence of `needle`. */
function lineOf(text: string, needle: string): number {
  const idx = text.indexOf(needle)
  if (idx < 0) throw new Error(`not found: ${needle}`)
  return text.slice(0, idx).split("\n").length
}

/** 0-based column (Babel's convention) of the `<` opening `needle`'s element. */
function columnOfTag(text: string, needle: string): number {
  const idx = text.indexOf(needle)
  if (idx < 0) throw new Error(`not found: ${needle}`)
  const open = text.lastIndexOf("<", idx)
  return open - (text.lastIndexOf("\n", open) + 1)
}

/**
 * Stand-in for `@vitejs/plugin-react` v4's transform, reproducing the two
 * properties that break naive stamping — MEASURED against the real 4.7.0
 * plugin, not invented:
 *   1. a multi-line preamble PREPENDED (v4's own sourcemap fix-up spells the
 *      height as `";".repeat(16)` + `";;;"`, i.e. 19 lines);
 *   2. regeneration from AST, so the authored bytes are not a contiguous
 *      substring of the output (`</main>\n  );` comes back as `</main>);`).
 */
function rewriteLikePluginReactV4(source: string): string {
  const preamble = Array.from({ length: 19 }, (_, i) => `// refresh-preamble-line-${i}`).join("\n")
  const reformatted = source.replace(/\n\s*\);/g, ");")
  return `${preamble}\n${reformatted}`
}

const APP = [
  `import { useState } from "react"`,
  ``,
  `export default function App() {`,
  `  const [n] = useState(0)`,
  `  return (`,
  `    <main className="app-root">`,
  `      <p className="row">hello {n}</p>`,
  `      <Card title="ALPHA" />`,
  `    </main>`,
  `  );`,
  `}`,
].join("\n")

describe("a module rewritten by an earlier pre-plugin", () => {
  it("stamps AUTHORED coordinates, not the rewritten module's", () => {
    const abs = authorFile("App.tsx", APP)
    const rewritten = rewriteLikePluginReactV4(APP)

    // The premise of the whole test: the rewrite really does move things.
    expect(rewritten.includes(APP)).toBe(false)
    expect(lineOf(rewritten, `className="row"`)).toBe(lineOf(APP, `className="row"`) + 19)

    const out = transform(rewritten, abs)
    expect(stamps(out)).toEqual([
      `App.tsx:${lineOf(APP, `className="app-root"`)}:${columnOfTag(APP, `className="app-root"`)}`,
      `App.tsx:${lineOf(APP, `className="row"`)}:${columnOfTag(APP, `className="row"`)}`,
      `App.tsx:${lineOf(APP, `title="ALPHA"`)}:${columnOfTag(APP, `title="ALPHA"`)}`,
    ])
  })

  it("still splices the attribute into the REWRITTEN source, so the DOM gets it", () => {
    const abs = authorFile("App.tsx", APP)
    const out = transform(rewriteLikePluginReactV4(APP), abs)

    // Present on the elements, and the preamble the rewrite added survives —
    // returning the authored source instead would silently drop react-refresh.
    expect(out).toMatch(/<main [^>]*data-desde-src="App\.tsx:6:4"[^>]*className="app-root">/)
    expect(out).toContain(`// refresh-preamble-line-18`)
  })

  it("hashes the AUTHORED bytes into data-desde-v", () => {
    const abs = authorFile("App.tsx", APP)
    const rewritten = rewriteLikePluginReactV4(APP)

    const fromRewritten = transform(rewritten, abs)
    const asAuthored = transform(APP, abs)

    // `edit-handler.ts`'s stale-target guard compares this against the hash of
    // the file ON DISK and 409s on a mismatch, so a hash of transformed bytes
    // would refuse every mutation that carries one.
    expect(new Set(ptv(fromRewritten)).size).toBe(1)
    expect(ptv(fromRewritten)[0]).toBe(ptv(asAuthored)[0])
  })

  it("refuses — with no stamps — when the element count changed", () => {
    const abs = authorFile("App.tsx", APP)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    // A transform that INVENTS an element: the pairing is no longer sound, and
    // guessing would put a real coordinate on the wrong element.
    const rewritten = rewriteLikePluginReactV4(APP).replace(
      `<main className="app-root">`,
      `<main className="app-root"><span className="injected" />`,
    )

    expect(transform(rewritten, abs)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain("inspect-only")
  })

  it("refuses when a paired element has a different tag", () => {
    const abs = authorFile("App.tsx", APP)
    vi.spyOn(console, "warn").mockImplementation(() => {})

    // Same count, different identity — the count check alone would miss this.
    const rewritten = rewriteLikePluginReactV4(APP).replace(
      `<p className="row">hello {n}</p>`,
      `<section className="row">hello {n}</section>`,
    )

    expect(transform(rewritten, abs)).toBeNull()
  })

  it("warns once per module, not once per HMR round", () => {
    const abs = authorFile("App.tsx", APP)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const rewritten = rewriteLikePluginReactV4(APP).replace(
      `<main className="app-root">`,
      `<main className="app-root"><span className="injected" />`,
    )

    transform(rewritten, abs)
    transform(rewritten, abs)
    transform(rewritten, abs)

    expect(warn).toHaveBeenCalledTimes(1)
  })
})

/**
 * A refusal that only reaches `console.warn` is a fact nothing downstream can
 * act on. MEASURED (`tasks/dev-server-hosts.md` § 12f): under `styled-jsx/babel`
 * one of three files refused, printed this warning, and the CLI then printed
 * `▸ Smoke check passed` six lines below it — because the boot report had no
 * way to read what the stamper had just said.
 */
describe("the refusal is recorded, not only printed", () => {
  it("puts the refused file in the ledger as inspect-only", () => {
    const abs = authorFile("App.tsx", APP)
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const rewritten = rewriteLikePluginReactV4(APP).replace(
      `<main className="app-root">`,
      `<main className="app-root"><span className="injected" />`,
    )

    expect(readModuleStampNotices()).toEqual([])
    expect(transform(rewritten, abs)).toBeNull()

    expect(readModuleStampNotices()).toEqual([
      {
        // Repo-RELATIVE, because that is what a user can open. The dedupe key is
        // the absolute id; the reported name must not be.
        file: "App.tsx",
        outcome: "inspect-only",
        detail: expect.stringContaining("could not be realigned onto the authored source"),
      },
    ])
  })

  it("records the Vue lane's stamped-but-suspect case under its own outcome", () => {
    // This file DOES stamp, so `verifyStamping` sees stamps and says "passed".
    // Nothing else in the boot report would ever mention it — which is why it
    // has to be its own outcome rather than being folded into the refusal case.
    const sfc = `<template>\n  <p class="row">hi</p>\n</template>\n`
    const abs = join(repo, "Comp.vue")
    writeFileSync(abs, sfc, "utf8")
    vi.spyOn(console, "warn").mockImplementation(() => {})

    const plugin = sourceTagPlugin({ repoRoot: repo }) as Plugin
    const t = plugin.transform as unknown as (code: string, id: string) => { code: string } | null
    const out = t.call({} as never, `<!-- injected by some plugin -->\n${sfc}`, abs)

    expect(out?.code).toContain("data-desde-src")
    expect(readModuleStampNotices()).toEqual([
      {
        file: "Comp.vue",
        outcome: "coordinates-suspect",
        detail: expect.stringContaining("no realignment"),
      },
    ])
  })

  it("records once per module, on the same key the warning dedupes on", () => {
    // `transform` re-runs on every HMR round. A ledger that grew per round would
    // turn one refused file into a boot report listing it forty times.
    const abs = authorFile("App.tsx", APP)
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const rewritten = rewriteLikePluginReactV4(APP).replace(
      `<main className="app-root">`,
      `<main className="app-root"><span className="injected" />`,
    )

    transform(rewritten, abs)
    transform(rewritten, abs)
    transform(rewritten, abs)

    expect(readModuleStampNotices()).toHaveLength(1)
  })

  it("says nothing at all when every file stamps cleanly", () => {
    // The requirement that keeps this signal readable: a healthy boot must print
    // exactly what it printed before the ledger existed.
    const abs = authorFile("App.tsx", APP)
    expect(stamps(transform(APP, abs))).toHaveLength(3)
    expect(readModuleStampNotices()).toEqual([])
  })
})

describe("the untouched paths are untouched", () => {
  it("stamps as before when the input IS the authored file", () => {
    const abs = authorFile("App.tsx", APP)
    const out = transform(APP, abs)
    expect(stamps(out)).toEqual([
      `App.tsx:${lineOf(APP, `className="app-root"`)}:${columnOfTag(APP, `className="app-root"`)}`,
      `App.tsx:${lineOf(APP, `className="row"`)}:${columnOfTag(APP, `className="row"`)}`,
      `App.tsx:${lineOf(APP, `title="ALPHA"`)}:${columnOfTag(APP, `title="ALPHA"`)}`,
    ])
  })

  it("stamps a module whose id is not a readable file at all", () => {
    // Virtual / generated modules (Nuxt's `.nuxt/*`, Astro containers) have no
    // authored bytes to disagree with. Refusing them would take away working
    // coverage on the strength of a check that cannot apply.
    const out = transform(APP, join(repo, "src", "virtual-never-written.tsx"))
    expect(stamps(out)).toHaveLength(3)
  })

  it("the Vue stamper says so out loud, and keeps stamping", () => {
    // The Vue lane gets DETECTION and not repair, on evidence: the edit matrix
    // drove all thirteen Vue-applicable kinds through plain Vite, Nuxt and
    // Astro with 20/20 stamp agreement on each, so no Vue pre-transform has
    // ever been observed. What must not happen is the failure passing in
    // silence if one ever appears.
    const sfc = `<template>\n  <p class="row">hi</p>\n</template>\n`
    const abs = join(repo, "Comp.vue")
    writeFileSync(abs, sfc, "utf8")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const plugin = sourceTagPlugin({ repoRoot: repo }) as Plugin
    const t = plugin.transform as unknown as (
      code: string,
      id: string,
    ) => { code: string } | null

    expect(t.call({} as never, sfc, abs)?.code).toContain("data-desde-src")
    expect(warn).not.toHaveBeenCalled()

    const out = t.call({} as never, `<!-- injected by some plugin -->\n${sfc}`, abs)
    // Still stamps — turning a green lane dark to defend an unobserved case is
    // the worse trade — but the risk is now stated rather than swallowed.
    expect(out?.code).toContain("data-desde-src")
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain("may land in the wrong place")
  })

  it("does not double-stamp a module it already stamped", () => {
    const abs = authorFile("App.tsx", APP)
    const once = transform(APP, abs)
    expect(stamps(once)).toHaveLength(3)
    // Second pass over the stamped output: nothing left to add.
    expect(transform(once as string, abs)).toBeNull()
  })
})
