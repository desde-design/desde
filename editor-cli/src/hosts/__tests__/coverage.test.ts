/**
 * What the build can and cannot stamp, as a declared fact.
 *
 * The property under test is not "the table is correct" — the table is the
 * definition. It is that an UNCOVERED language produces a reason a user can act
 * on, and that adding a language cannot silently default to "covered".
 */
import { describe, expect, it } from "vitest"
import { languageOfStampPath, stampingCoverage } from "../coverage.js"

describe("stampingCoverage", () => {
  it("covers the two dialects a Vite plugin stamps today", () => {
    expect(stampingCoverage(["vue-sfc", "jsx"], "vite-plugin")).toEqual({
      covered: [
        { language: "vue-sfc", via: "vite-plugin" },
        { language: "jsx", via: "vite-plugin" },
      ],
      uncovered: [],
    })
  })

  it("reports `.astro` as uncovered, with the consequence stated first", () => {
    const coverage = stampingCoverage(["astro", "jsx"], "vite-plugin")
    expect(coverage.covered).toEqual([{ language: "jsx", via: "vite-plugin" }])
    expect(coverage.uncovered).toHaveLength(1)
    expect(coverage.uncovered[0]?.language).toBe("astro")
    // "inspect-only" is the thing the user would otherwise discover by clicking.
    expect(coverage.uncovered[0]?.reason).toContain("inspect-only")
    // And the mitigation, because it is what makes the gap survivable: an island
    // inside the page still stamps, so the page is not simply dead.
    expect(coverage.uncovered[0]?.reason).toContain("islands")
  })

  it("covers JSX on the Turbopack lane, because it is the same stamper", () => {
    // The Next loader wraps the UNMODIFIED `jsxSourceTagPlugin(...).transform`,
    // so JSX coverage is a fact about one implementation reachable through two
    // channels — not two implementations that happen to agree.
    expect(stampingCoverage(["jsx"], "turbopack-loader")).toEqual({
      covered: [{ language: "jsx", via: "turbopack-loader" }],
      uncovered: [],
    })
  })

  it("treats a right-language / wrong-channel pairing as uncovered", () => {
    // There is no Next-and-Vue host, so the Turbopack lane has no Vue provider.
    // A host that asked for one must get a declared gap, not a claim of coverage
    // it does not have.
    const coverage = stampingCoverage(["vue-sfc", "astro"], "turbopack-loader")
    expect(coverage.covered).toEqual([])
    expect(coverage.uncovered.map((u) => u.language)).toEqual(["vue-sfc", "astro"])
  })

  it("never reports the same language twice", () => {
    // `stampLanguages` implementations union several sources; a duplicate there
    // must not become a duplicated boot warning.
    const coverage = stampingCoverage(["jsx", "jsx", "astro", "astro"], "vite-plugin")
    expect(coverage.covered).toHaveLength(1)
    expect(coverage.uncovered).toHaveLength(1)
  })

  it("says nothing at all about an empty language list", () => {
    // Zero covered languages is § 1's one refusing condition — but it belongs
    // with the detection rewrite, which is what produces a MEASURED language
    // set. Refusing on today's defaulted-from-framework list would refuse a
    // project on the strength of a default, so this returns empty and the gate
    // that catches a host stamping nothing stays `verifyStamping`.
    expect(stampingCoverage([], "vite-plugin")).toEqual({ covered: [], uncovered: [] })
  })
})

/**
 * The inverse lookup, and its only job: letting the per-module boot report
 * (`stamp-notices.ts`) defer to a coverage declaration instead of restating it.
 */
describe("languageOfStampPath", () => {
  it("maps each stampable extension to the language whose stamper owns it", () => {
    expect(languageOfStampPath("src/App.tsx")).toBe("jsx")
    expect(languageOfStampPath("src/App.jsx")).toBe("jsx")
    expect(languageOfStampPath("src/App.vue")).toBe("vue-sfc")
    expect(languageOfStampPath("src/pages/index.astro")).toBe("astro")
  })

  it("calls a `.vue` vue-sfc even though its JSX block is stamped by the JSX collector", () => {
    // A `<script setup lang="tsx">` block is walked by `collectEmbeddedJsxInsertions`,
    // but the file's LANGUAGE is what a coverage declaration is about — and a
    // host that declared `vue-sfc` uncovered means this file, not some notional
    // JSX one.
    expect(languageOfStampPath("src/Renderer.vue")).toBe("vue-sfc")
  })

  it("returns null for anything unrecognised, which is not a filter", () => {
    // `visibleStampNotices` KEEPS a null-language notice: no declaration applies,
    // so there is nothing to defer to. Suppressing it would silently lose the
    // notices of any stamper added before this table is extended.
    expect(languageOfStampPath("src/Thing.svelte")).toBeNull()
    expect(languageOfStampPath("src/main.ts")).toBeNull()
    expect(languageOfStampPath("vue")).toBeNull()
  })

  it("is case-insensitive, because a case-preserving filesystem is not case-sensitive", () => {
    expect(languageOfStampPath("src/App.TSX")).toBe("jsx")
  })
})
