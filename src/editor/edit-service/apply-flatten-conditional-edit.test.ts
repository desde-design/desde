import { describe, expect, it } from "vitest"
import { applyFlattenConditionalEdit } from "./apply-flatten-conditional-edit"

const PRELUDE = `<template>\n`
const POSTLUDE = `</template>\n`

function sfc(templateBody: string): string {
  return `${PRELUDE}${templateBody}${POSTLUDE}`
}

describe("applyFlattenConditionalEdit — happy paths", () => {
  it("keeps the v-if branch and drops the v-else", () => {
    const source = sfc(`  <section>\n    <template v-if="x">\n      <p>true</p>\n    </template>\n    <template v-else>\n      <p>false</p>\n    </template>\n  </section>\n`)
    // <template v-if> at line 3, col 5
    const result = applyFlattenConditionalEdit({
      source,
      line: 3,
      column: 5,
      branchToKeep: 0,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain("<p>true</p>")
    expect(result.source).not.toMatch(/<p>false<\/p>/)
    expect(result.source).not.toMatch(/v-if|v-else/)
  })

  it("keeps a COMPONENT branch whole, stripping only its directive (slot templates cannot float)", () => {
    // The measured F-15 shape (stress test 2026-09-01): a component branch
    // whose children are slot templates. Unwrap-to-children spliced the slot
    // templates into plain markup and the post-splice compile refused with
    // the orphaned-branch signature; the fix keeps the element and removes
    // only the conditional directive. This test fails against the old
    // unwrap-everything behavior.
    const source = sfc(
      `  <div class="tab-content">\n    <KCatalog\n      v-if="viewMode === 'card'"\n      :fetcher="catalogFetcher"\n      card-size="large"\n    >\n      <template #toolbar>\n        <span>tools</span>\n      </template>\n    </KCatalog>\n    <EntityBaseTable\n      v-else\n      :fetcher="fetcher"\n    />\n  </div>\n`,
    )
    const result = applyFlattenConditionalEdit({
      source,
      line: 3,
      column: 5,
      branchToKeep: 0,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain("<KCatalog")
    expect(result.source).toContain('card-size="large"')
    expect(result.source).toContain("<template #toolbar>")
    expect(result.source).not.toContain("v-if")
    expect(result.source).not.toContain("EntityBaseTable")
  })

  it("keeps an ELEMENT v-else branch whole when chosen, stripping the v-else", () => {
    const source = sfc(
      `  <section>\n    <div v-if="x" class="a">\n      <p>true</p>\n    </div>\n    <div v-else class="b">\n      <p>false</p>\n    </div>\n  </section>\n`,
    )
    const result = applyFlattenConditionalEdit({
      source,
      line: 3,
      column: 5,
      branchToKeep: "else",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain('<div class="b">')
    expect(result.source).toContain("<p>false</p>")
    expect(result.source).not.toContain("v-else")
    expect(result.source).not.toContain('class="a"')
  })

  it("keeps the v-else branch and drops the v-if", () => {
    const source = sfc(`  <section>\n    <template v-if="x">\n      <p>true</p>\n    </template>\n    <template v-else>\n      <p>false</p>\n    </template>\n  </section>\n`)
    const result = applyFlattenConditionalEdit({
      source,
      line: 3,
      column: 5,
      branchToKeep: "else",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain("<p>false</p>")
    expect(result.source).not.toMatch(/<p>true<\/p>/)
  })

  it("keeps the first v-else-if branch in a 4-link chain", () => {
    const source = sfc(`  <section>\n    <template v-if="a">\n      <p>A</p>\n    </template>\n    <template v-else-if="b">\n      <p>B</p>\n    </template>\n    <template v-else-if="c">\n      <p>C</p>\n    </template>\n    <template v-else>\n      <p>D</p>\n    </template>\n  </section>\n`)
    // branchToKeep=1 → first v-else-if (branch B)
    const result = applyFlattenConditionalEdit({
      source,
      line: 3,
      column: 5,
      branchToKeep: 1,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain("<p>B</p>")
    expect(result.source).not.toMatch(/<p>A<\/p>/)
    expect(result.source).not.toMatch(/<p>C<\/p>/)
    expect(result.source).not.toMatch(/<p>D<\/p>/)
  })

  it("works on non-template elements (e.g., <div v-if> / <div v-else>)", () => {
    const source = sfc(`  <section>\n    <div v-if="x">true</div>\n    <div v-else>false</div>\n  </section>\n`)
    // <div v-if> at line 3 col 5
    const result = applyFlattenConditionalEdit({
      source,
      line: 3,
      column: 5,
      branchToKeep: 0,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain("true")
    expect(result.source).not.toMatch(/false/)
    expect(result.source).not.toMatch(/v-if|v-else/)
  })

  it("matches the AIGatewayModelCreate regression — flatten an outer v-if to its multi branch", () => {
    // Mirror of the user's real bug: a multi/single conditional where
    // they want to keep only the multi branch.
    const source = sfc(`  <main>\n    <template v-if="multi">\n      <div v-for="x in xs" :key="x">{{ x }}</div>\n    </template>\n    <template v-else>\n      <SingleCard />\n    </template>\n  </main>\n`)
    const result = applyFlattenConditionalEdit({
      source,
      line: 3,
      column: 5,
      branchToKeep: 0,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain(`v-for="x in xs"`)
    expect(result.source).not.toMatch(/SingleCard/)
    expect(result.source).not.toMatch(/v-if|v-else/)
  })
})

describe("applyFlattenConditionalEdit — reachability via enclosing v-if (codex #9)", () => {
  it("walks up to find the enclosing v-if when given a rendered child's coordinate", () => {
    // The chain root is <template v-if> at line 3. The source-tag
    // plugin skips <template>, so the designer can only right-click
    // the <div v-for> at line 4. The applicator must walk up.
    const source = sfc(`  <section>\n    <template v-if="multi">\n      <div v-for="x in xs" :key="x">{{ x }}</div>\n    </template>\n    <template v-else>\n      <SingleCard />\n    </template>\n  </section>\n`)
    // Pass coordinate of the <div v-for> (line 4, col 7) — INSIDE the v-if branch.
    const result = applyFlattenConditionalEdit({
      source,
      line: 4,
      column: 7,
      branchToKeep: 0,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain('v-for="x in xs"')
    expect(result.source).not.toMatch(/SingleCard/)
  })

  it("walks up when target is a deeply nested child of the v-if branch", () => {
    const source = sfc(`  <section>\n    <template v-if="x">\n      <div>\n        <p>\n          <span>deep</span>\n        </p>\n      </div>\n    </template>\n    <template v-else>\n      <p>else branch</p>\n    </template>\n  </section>\n`)
    // <span>deep</span> at line 6, col 11
    const result = applyFlattenConditionalEdit({
      source,
      line: 6,
      column: 11,
      branchToKeep: 0,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain("<span>deep</span>")
    expect(result.source).not.toMatch(/else branch/)
  })

  it("refuses when no enclosing v-if exists in any ancestor", () => {
    const source = sfc(`  <section>\n    <div>\n      <p>plain child, no conditional</p>\n    </div>\n  </section>\n`)
    // <p> at line 4, col 7
    const result = applyFlattenConditionalEdit({
      source,
      line: 4,
      column: 7,
      branchToKeep: 0,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/not in a v-if branch|conditional chain/i)
  })
})

describe("applyFlattenConditionalEdit — refusals", () => {
  it("refuses if the element at (line,col) has no v-if directive AND no enclosing v-if", () => {
    const source = sfc(`  <section>\n    <p>no directive</p>\n  </section>\n`)
    const result = applyFlattenConditionalEdit({
      source,
      line: 3,
      column: 5,
      branchToKeep: 0,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/not in a v-if branch|conditional chain/i)
  })

  it("refuses if branchToKeep names a branch that doesn't exist", () => {
    const source = sfc(`  <section>\n    <div v-if="x">a</div>\n    <div v-else>b</div>\n  </section>\n`)
    const result = applyFlattenConditionalEdit({
      source,
      line: 3,
      column: 5,
      branchToKeep: 2, // chain has 0 v-else-ifs
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/v-else-if/i)
  })

  it("refuses if asking for v-else when the chain doesn't have one", () => {
    const source = sfc(`  <section>\n    <div v-if="x">a</div>\n    <p>after</p>\n  </section>\n`)
    const result = applyFlattenConditionalEdit({
      source,
      line: 3,
      column: 5,
      branchToKeep: "else",
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/no v-else/i)
  })

  it("refuses if the chosen branch has no rendered children", () => {
    const source = sfc(`  <section>\n    <template v-if="x"></template>\n    <template v-else>\n      <p>fallback</p>\n    </template>\n  </section>\n`)
    const result = applyFlattenConditionalEdit({
      source,
      line: 3,
      column: 5,
      branchToKeep: 0,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/no rendered children/i)
  })

  it("refuses when flattening would leave the template with multiple roots", () => {
    // Chain occupies the only top-level slot; chosen branch has 2 elements.
    const source = sfc(`    <template v-if="x">\n      <p>one</p>\n      <p>two</p>\n    </template>\n    <template v-else>\n      <p>single</p>\n    </template>\n`)
    const result = applyFlattenConditionalEdit({
      source,
      line: 2,
      column: 5,
      branchToKeep: 0,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/multiple roots/i)
  })

  it("refuses when no template block exists", () => {
    const result = applyFlattenConditionalEdit({
      source: '<script setup>const x = 1</script>',
      line: 1,
      column: 1,
      branchToKeep: 0,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/no <template>/i)
  })
})
