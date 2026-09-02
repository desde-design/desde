import { describe, expect, it } from "vitest"
import { applyDeleteEdit } from "./apply-delete-edit"

const PRELUDE = `<template>\n`
const POSTLUDE = `</template>\n`

function sfc(templateBody: string): string {
  return `${PRELUDE}${templateBody}${POSTLUDE}`
}

describe("applyDeleteEdit — happy paths", () => {
  it("removes a leaf element from a multi-child parent", () => {
    const source = sfc(`  <div>\n    <button>Click</button>\n    <span>Hi</span>\n  </div>\n`)
    // <button> is on line 3 col 5 (template-content line 2 col 5 + template-block offset).
    const result = applyDeleteEdit({ source, line: 3, column: 5 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).not.toContain("<button>")
      expect(result.source).toContain("<span>Hi</span>")
    }
  })

  it("removes a nested element with its children", () => {
    const source = sfc(`  <div>\n    <section>\n      <p>nested</p>\n    </section>\n    <span>kept</span>\n  </div>\n`)
    // <section> at line 3, col 5
    const result = applyDeleteEdit({ source, line: 3, column: 5 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).not.toContain("<section>")
      expect(result.source).not.toContain("<p>nested</p>")
      expect(result.source).toContain("<span>kept</span>")
    }
  })

  it("removes a self-closing element", () => {
    const source = sfc(`  <div>\n    <hr />\n    <p>after</p>\n  </div>\n`)
    const result = applyDeleteEdit({ source, line: 3, column: 5 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).not.toContain("<hr")
    }
  })

  it("removes a component (PascalCase tag)", () => {
    const source = sfc(`  <div>\n    <KButton variant="primary">Go</KButton>\n    <span>kept</span>\n  </div>\n`)
    const result = applyDeleteEdit({ source, line: 3, column: 5 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).not.toContain("KButton")
    }
  })

  it("removes a single component usage at a call site, leaving sibling usages", () => {
    // A 'callsite'-scoped DeleteEdit points the applicator at the parent
    // template + the <Card> usage's coordinates. Same single-file splice as
    // any element delete — only the target tag is a component instance.
    const source = sfc(
      `  <div>\n    <Card title="A" />\n    <Card title="B" />\n  </div>\n`,
    )
    // First <Card> at line 3, col 5.
    const result = applyDeleteEdit({ source, line: 3, column: 5 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).not.toContain('title="A"')
      expect(result.source).toContain('title="B"')
    }
  })

  it("post-splice template still parses (multi-child template stays valid)", () => {
    // Template with two top-level siblings; delete one keeps the other.
    const source = `<template>\n  <span>one</span>\n  <span>two</span>\n</template>\n`
    const result = applyDeleteEdit({ source, line: 2, column: 3 })
    expect(result.ok).toBe(true)
  })
})

describe("applyDeleteEdit — refusals", () => {
  it("refuses when (line, column) doesn't match any element", () => {
    const source = sfc(`  <div>\n    <span>Hi</span>\n  </div>\n`)
    const result = applyDeleteEdit({ source, line: 99, column: 99 })
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("No element found"),
    })
  })

  it("refuses when the SFC has no <template> block", () => {
    const source = `<script setup lang="ts">\nconst x = 1\n</script>\n`
    const result = applyDeleteEdit({ source, line: 1, column: 1 })
    expect(result.ok).toBe(false)
  })

  it("refuses when the target IS the SFC's only root element", () => {
    const source = sfc(`  <div>only root</div>\n`)
    // <div> at line 2 col 3
    const result = applyDeleteEdit({ source, line: 2, column: 3 })
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("only rendered content"),
    })
  })

  it("ALLOWS deleting the only element when an interpolation root remains (codex P2 round 2)", () => {
    // `<template>{{ msg }}<div>kept</div></template>` — deleting the
    // div leaves `{{ msg }}` as renderable content, so the refusal
    // shouldn't fire. The previous version counted only Element roots
    // and would have falsely refused.
    const source = `<template>\n  {{ msg }}\n  <div>doomed</div>\n</template>\n`
    // <div> at line 3, col 3
    const result = applyDeleteEdit({ source, line: 3, column: 3 })
    expect(result.ok).toBe(true)
  })

  it("ALLOWS deleting the only element when a non-whitespace text root remains", () => {
    const source = `<template>\n  Static text\n  <div>doomed</div>\n</template>\n`
    const result = applyDeleteEdit({ source, line: 3, column: 3 })
    expect(result.ok).toBe(true)
  })

  it("STILL refuses when the only meaningful root is the target (whitespace-only siblings don't count)", () => {
    const source = `<template>\n\n   \n  <div>only meaningful child</div>\n\n</template>\n`
    const result = applyDeleteEdit({ source, line: 4, column: 3 })
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("only rendered content"),
    })
  })

  it("refuses on malformed template", () => {
    const source = `<template>\n  <div>\n</template>\n`
    // Template body unclosed — parseSfc may accept but parseTemplate should fail.
    // If it doesn't, the (99,99) lookup will produce "No element found" instead;
    // either ok:false outcome is acceptable.
    const result = applyDeleteEdit({ source, line: 99, column: 99 })
    expect(result.ok).toBe(false)
  })
})

describe("applyDeleteEdit — siblings preserved correctly", () => {
  it("doesn't touch siblings before or after the deleted element", () => {
    const source = sfc(`  <div>\n    <a>before</a>\n    <b>target</b>\n    <c>after</c>\n  </div>\n`)
    // <b> at line 4, col 5
    const result = applyDeleteEdit({ source, line: 4, column: 5 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain("<a>before</a>")
      expect(result.source).toContain("<c>after</c>")
      expect(result.source).not.toContain("<b>target</b>")
    }
  })
})

describe("applyDeleteEdit — whitespace and formatting", () => {
  it("leaves no whitespace-only orphan line where the element was", () => {
    const source = sfc(`  <div>\n    <a>keep</a>\n    <b>gone</b>\n    <c>keep</c>\n  </div>\n`)
    const result = applyDeleteEdit({ source, line: 4, column: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const orphans = result.source
      .split("\n")
      .filter((l) => l.length > 0 && l.trim().length === 0)
    expect(orphans).toEqual([])
    expect(result.source).toBe(sfc(`  <div>\n    <a>keep</a>\n    <c>keep</c>\n  </div>\n`))
  })

  it("keeps exactly one separator between the siblings that become adjacent", () => {
    // Same-LINE siblings: the space between them is a RENDERED space (Vue's
    // condense only drops newline-bearing runs), so removing the middle
    // element must consume one separator, not zero and not both.
    const source = sfc(`  <p><a>x</a> <b>gone</b> <c>y</c></p>\n`)
    const result = applyDeleteEdit({ source, line: 2, column: 15 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toBe(sfc(`  <p><a>x</a> <c>y</c></p>\n`))
  })

  it("does not eat into the <template> open tag when the target is the first root", () => {
    const source = `<template>\n  <a>gone</a>\n  <b>kept</b>\n</template>\n`
    const result = applyDeleteEdit({ source, line: 2, column: 3 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toBe(`<template>\n  <b>kept</b>\n</template>\n`)
  })

  it("preserves a deliberate blank line between siblings", () => {
    const source = sfc(`  <div>\n    <a>keep</a>\n\n    <b>gone</b>\n  </div>\n`)
    const result = applyDeleteEdit({ source, line: 5, column: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toBe(sfc(`  <div>\n    <a>keep</a>\n\n  </div>\n`))
  })
})

describe("applyDeleteEdit — post-splice compile validation", () => {
  it("refuses a delete that would orphan a v-else branch", () => {
    // Parsing alone accepts an orphaned v-else; only the full compile catches
    // it. Without this the applicator returned ok:true and the caller wrote a
    // file Vite refused to build.
    const source = sfc(
      `  <div>\n    <p v-if="flag">yes</p>\n    <p v-else>no</p>\n    <span>other</span>\n  </div>\n`,
    )
    const result = applyDeleteEdit({ source, line: 3, column: 5 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("v-else")
  })

  it("still allows deleting the v-else branch itself", () => {
    const source = sfc(
      `  <div>\n    <p v-if="flag">yes</p>\n    <p v-else>no</p>\n    <span>other</span>\n  </div>\n`,
    )
    const result = applyDeleteEdit({ source, line: 4, column: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).not.toContain("v-else")
    expect(result.source).toContain('v-if="flag"')
  })

  it("does not block edits on a template that already failed to compile", () => {
    // Pre-existing breakage (an orphaned v-else the user is mid-way through
    // fixing) must not lock them out of the delete that would fix it.
    const source = sfc(`  <div>\n    <p v-else>orphan</p>\n    <span>other</span>\n  </div>\n`)
    const result = applyDeleteEdit({ source, line: 3, column: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).not.toContain("v-else")
  })
})
