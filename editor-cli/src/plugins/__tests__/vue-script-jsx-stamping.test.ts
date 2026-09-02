/**
 * JSX inside a Vue SFC's `<script setup lang="tsx">` must be source-stamped.
 *
 * It was stamped by NOBODY: the Vue plugin walks only `descriptor.template.ast`
 * and the JSX plugin bails on any id that is not `.tsx`/`.jsx`, which a `.vue`
 * never is. Measured on the dogfood Vue subject — 1 stamp in a
 * `<script setup lang="tsx">` component against 24 in a template-based sibling.
 * With no stamp the bridge cannot map a click back to source, so the Editor was
 * inspect-only there and refused every edit with "No source-location ancestor".
 *
 * WHAT THESE TESTS ARE REALLY GUARDING is the coordinate math, because that is
 * the part whose failure is silent. Babel reports positions relative to the
 * BLOCK; `data-desde-src` must carry positions relative to the SFC. A wrong line
 * does not throw — it names a real, different line, and the edit lands there.
 * So every assertion below checks the stamp against the line the element
 * actually occupies in the whole file, computed from the file text rather than
 * hardcoded.
 */
import { describe, expect, it } from "vitest"
import type { Plugin } from "vite"
import { sourceTagPlugin } from "../source-tag-plugin.js"

const REPO = "/repo"

function transform(sfc: string, file = "src/Comp.vue"): string | null {
  const plugin = sourceTagPlugin({ repoRoot: REPO }) as Plugin
  const t = plugin.transform as unknown as (
    code: string,
    id: string,
  ) => { code: string } | null
  const out = t.call({} as never, sfc, `${REPO}/${file}`)
  return out?.code ?? null
}

/** Every `data-desde-src` value in transform output, in document order. */
function stamps(code: string): string[] {
  return Array.from(code.matchAll(/data-desde-src="([^"]+)"/g)).map((m) => m[1])
}

/** 1-based line of the first occurrence of `needle` in `text`. */
function lineOf(text: string, needle: string): number {
  const idx = text.indexOf(needle)
  if (idx < 0) throw new Error(`not found: ${needle}`)
  return text.slice(0, idx).split("\n").length
}

describe("Vue SFC with <script setup lang=\"tsx\">", () => {
  const sfc = [
    `<script setup lang="tsx">`,
    `import { ref } from "vue"`,
    ``,
    `const label = ref("hi")`,
    ``,
    `const Row = () => <li class="row">{label.value}</li>`,
    ``,
    `const Panel = () => (`,
    `  <section class="panel">`,
    `    <Row />`,
    `  </section>`,
    `)`,
    `</script>`,
    ``,
    `<template>`,
    `  <div class="wrap">`,
    `    <Panel />`,
    `  </div>`,
    `</template>`,
    ``,
  ].join("\n")

  it("stamps the JSX in the script block, not just the template", () => {
    const out = transform(sfc)
    expect(out, "transform must produce output").not.toBeNull()
    const all = stamps(out!)
    // Template gives <div> and <Panel/>; script gives <li>, <section>, <Row/>.
    expect(all.length).toBeGreaterThanOrEqual(5)
  })

  it("reports SFC-ABSOLUTE line numbers for script JSX", () => {
    // The regression that matters. Block-relative lines would name real but
    // WRONG lines, and every edit would land there silently.
    const out = transform(sfc)!
    const all = stamps(out)

    const expectLineFor = (needle: string) => lineOf(sfc, needle)

    // `<li class="row">` — find the stamp Babel produced for it.
    const liStamp = all.find((s) => s.endsWith(`:${expectLineFor("<li class=")}:` + s.split(":").pop()))
    expect(
      all.some((s) => s.split(":")[1] === String(expectLineFor("<li class="))),
      `no stamp on the <li>'s real line ${expectLineFor("<li class=")}; got ${JSON.stringify(all)}`,
    ).toBe(true)
    expect(
      all.some((s) => s.split(":")[1] === String(expectLineFor("<section class="))),
      `no stamp on the <section>'s real line ${expectLineFor("<section class=")}`,
    ).toBe(true)
    void liStamp
  })

  it("still stamps the template block correctly alongside it", () => {
    const out = transform(sfc)!
    const all = stamps(out)
    expect(
      all.some((s) => s.split(":")[1] === String(lineOf(sfc, `<div class="wrap">`))),
      "template stamping must not regress",
    ).toBe(true)
  })

  it("splices at the right BYTE offset — output is still valid and unmangled", () => {
    const out = transform(sfc)!
    // A wrong offsetShift corrupts tokens rather than moving a line number.
    expect(out).toContain(`import { ref } from "vue"`)
    expect(out).toContain(`const label = ref("hi")`)
    expect(out).toMatch(/<li[^>]*class="row"/)
    expect(out).toMatch(/<section[^>]*class="panel"/)
    // No stamp landed inside a string literal or an import.
    expect(out).not.toMatch(/import \{ ref data-desde-src/)
  })

  it("every stamped line actually exists in the file", () => {
    const out = transform(sfc)!
    const total = sfc.split("\n").length
    for (const s of stamps(out)) {
      const line = Number(s.split(":")[1])
      expect(line, `stamp ${s} points past EOF (${total} lines)`).toBeLessThanOrEqual(total)
      expect(line, `stamp ${s} has a non-positive line`).toBeGreaterThan(0)
    }
  })

  it("leaves a plain <script setup> (no jsx) alone", () => {
    const plain = [
      `<script setup>`,
      `const a = 1 < 2`,
      `</script>`,
      `<template>`,
      `  <p>hi</p>`,
      `</template>`,
      ``,
    ].join("\n")
    const out = transform(plain)
    // Template still stamped; the script must be untouched.
    expect(out).not.toBeNull()
    expect(out!).toContain(`const a = 1 < 2`)
  })

  /**
   * The script block deliberately comes AFTER the template.
   *
   * The first fixture above puts `<script>` on line 1, where block-relative
   * and SFC-absolute numbering coincide — so it CANNOT tell them apart, and
   * deleting Babel's `startLine` left all six of its assertions green. Found
   * by falsifying the fix and watching nothing fail. A test that cannot fail
   * is not coverage.
   */
  const templateFirst = [
    `<template>`,
    `  <div class="wrap">`,
    `    <Panel />`,
    `  </div>`,
    `</template>`,
    ``,
    `<script setup lang="tsx">`,
    `import { ref } from "vue"`,
    ``,
    `const label = ref("hi")`,
    ``,
    `const Panel = () => <section class="panel">{label.value}</section>`,
    `</script>`,
    ``,
  ].join("\n")

  it("uses SFC-absolute lines when the script block does NOT start at line 1", () => {
    const out = transform(templateFirst)
    expect(out).not.toBeNull()
    const all = stamps(out!)

    const sectionLine = lineOf(templateFirst, `<section class="panel">`)
    expect(sectionLine).toBeGreaterThan(6) // guard the fixture's own premise

    expect(
      all.some((s) => s.split(":")[1] === String(sectionLine)),
      `expected a stamp on the <section>'s real SFC line ${sectionLine}; got ${JSON.stringify(all)}`,
    ).toBe(true)

    // And explicitly NOT the block-relative line, which is what a missing
    // `startLine` would produce.
    const blockRelative = sectionLine - lineOf(templateFirst, `<script setup lang="tsx">`) + 1
    expect(
      all.some((s) => s.split(":")[1] === String(blockRelative)),
      `found a BLOCK-relative line ${blockRelative} — startLine is not being applied`,
    ).toBe(false)
  })
})

/**
 * Vite's query suffix.
 *
 * Vite appends `?t=<timestamp>` to every HMR re-request and
 * `?vue&type=script&lang.tsx` to SFC sub-blocks. Matching on the raw id meant
 * the plugin skipped all of them, so a Vue file kept its stamps only until its
 * FIRST hot update and then silently lost every one — the Editor going
 * inspect-only on a file it had been editing a moment earlier, until a full
 * page reload. Measured against the dogfood subject: 15 stamps for the bare
 * id, 0 for the same file with `?t=123`.
 *
 * `jsx-source-tag-plugin.ts` has carried this guard since it was written. This
 * plugin never got it, which is exactly the kind of gap a per-plugin test
 * catches and a shared integration test does not.
 */
describe("Vite query suffixes", () => {
  const sfc = [
    `<template>`,
    `  <div class="wrap">hi</div>`,
    `</template>`,
    ``,
  ].join("\n")

  function stampCount(id: string): number {
    const plugin = sourceTagPlugin({ repoRoot: REPO }) as Plugin
    const t = plugin.transform as unknown as (c: string, i: string) => { code: string } | null
    const out = t.call({} as never, sfc, id)
    return out ? (out.code.match(/data-desde-src/g) ?? []).length : 0
  }

  it("stamps the bare id", () => {
    expect(stampCount(`${REPO}/src/A.vue`)).toBeGreaterThan(0)
  })

  it("stamps an HMR re-request (?t=…) identically", () => {
    expect(stampCount(`${REPO}/src/A.vue?t=1786280000`)).toBe(stampCount(`${REPO}/src/A.vue`))
  })

  it("stamps an SFC sub-block request", () => {
    expect(stampCount(`${REPO}/src/A.vue?vue&type=script&lang.tsx`)).toBeGreaterThan(0)
  })

  it("keeps the query OUT of the stamped path", () => {
    // A `?t=` inside `data-desde-src` would make every coordinate unmatchable
    // against a real file path downstream.
    const plugin = sourceTagPlugin({ repoRoot: REPO }) as Plugin
    const t = plugin.transform as unknown as (c: string, i: string) => { code: string } | null
    const out = t.call({} as never, sfc, `${REPO}/src/A.vue?t=999`)!
    expect(out.code).toContain(`data-desde-src="src/A.vue:`)
    expect(out.code).not.toContain("?t=999")
  })

  it("still ignores non-Vue ids and node_modules", () => {
    expect(stampCount(`${REPO}/src/A.tsx`)).toBe(0)
    expect(stampCount(`${REPO}/node_modules/pkg/A.vue`)).toBe(0)
  })
})

/**
 * Routing outlets must be skipped on the SCRIPT path too, not just the
 * template path.
 *
 * The template walker skips `<NuxtPage>` / `<RouterView>` because the outlet's
 * fallthrough attrs land on the ROUTED page's root element — so the stamp names
 * app.vue while the element lives in pages/index.vue, and an edit writes the
 * wrong file. That is a Vue RUNTIME behaviour, so it is identical when the
 * outlet is rendered from a `<script setup lang="tsx">` render function. Before
 * this was wired, the two paths disagreed: the template skipped the outlet and
 * the script stamped it, reopening the same cross-file bug through a second
 * door.
 */
describe("source-tag-plugin — routing outlets inside <script setup lang=\"tsx\">", () => {
  it("does not stamp NuxtPage / NuxtLayout / RouterView rendered from TSX", () => {
    const sfc = [
      `<script setup lang="tsx">`,
      `const render = () => (`,
      `  <div class="shell">`,
      `    <NuxtLayout>`,
      `      <NuxtPage />`,
      `    </NuxtLayout>`,
      `    <RouterView />`,
      `  </div>`,
      `)`,
      `</script>`,
      ``,
      // The plugin requires a template block to run at all
      // (`if (!descriptor.template?.ast) return null`), so give it a trivial
      // one. Its single element accounts for one of the stamps below.
      `<template>`,
      `  <render />`,
      `</template>`,
      ``,
    ].join("\n")
    const out = transform(sfc, "src/App.vue")
    expect(out).not.toBeNull()
    const code = out as string
    // The TSX wrapper <div class="shell"> plus the template's <render />.
    // The three outlets contribute nothing.
    expect(stamps(code).length).toBe(2)
    // The wrapper IS stamped. The stamp splices in right after the tag name,
    // so assert on the stamped form rather than the original attribute order.
    expect(code).toMatch(/<div [^>]*data-desde-src="[^"]+"[^>]*class="shell"/)
    for (const outlet of ["NuxtLayout", "NuxtPage", "RouterView"]) {
      const at = code.indexOf(`<${outlet}`)
      expect(at).toBeGreaterThan(-1)
      // No stamp may be spliced between the tag name and the end of that tag.
      const tail = code.slice(at, code.indexOf(">", at) + 1)
      expect(tail).not.toContain("data-desde-src")
      expect(tail).not.toContain("data-desde-v")
    }
  })

  it("leaves ordinary components stamped (the skip is not a blanket one)", () => {
    const sfc = [
      `<script setup lang="tsx">`,
      `const render = () => <NuxtLink to="/x"><Card /></NuxtLink>`,
      `</script>`,
      ``,
      `<template>`,
      `  <render />`,
      `</template>`,
      ``,
    ].join("\n")
    const code = transform(sfc, "src/A.vue") as string
    // NuxtLink renders a real <a>, so its stamp is correct and must survive:
    // NuxtLink + Card from the TSX, plus <render /> from the template.
    expect(stamps(code).length).toBe(3)
  })
})
