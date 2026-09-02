import { describe, expect, it } from "vitest"
import { applyUnwrapEdit } from "./apply-unwrap-edit"

const PRELUDE = `<template>\n`
const POSTLUDE = `</template>\n`

function sfc(templateBody: string): string {
  return `${PRELUDE}${templateBody}${POSTLUDE}`
}

describe("applyUnwrapEdit — happy paths", () => {
  it("dissolves a wrapper div, hoisting its children to the parent", () => {
    const source = sfc(`  <section>\n    <div>\n      <p>one</p>\n      <p>two</p>\n    </div>\n  </section>\n`)
    // Inner <div> is line 3, col 5
    const result = applyUnwrapEdit({ source, line: 3, column: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // <div> tags are gone; <p>s are preserved.
    expect(result.source).not.toMatch(/<div>/)
    expect(result.source).not.toMatch(/<\/div>/)
    expect(result.source).toContain("<p>one</p>")
    expect(result.source).toContain("<p>two</p>")
    // Outer <section> stays.
    expect(result.source).toContain("<section>")
    expect(result.source).toContain("</section>")
  })

  it("preserves interpolations and text inside the unwrapped wrapper", () => {
    const source = sfc(`  <section>\n    <span>\n      Hello {{ name }}!\n    </span>\n  </section>\n`)
    // <span> at line 3 col 5
    const result = applyUnwrapEdit({ source, line: 3, column: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).not.toMatch(/<span>/)
    expect(result.source).toContain("Hello {{ name }}!")
  })

  it("works when the wrapper has class + binding props (non-directive)", () => {
    // Plain attributes / bindings on the wrapper are dropped along with
    // it — we don't try to push them onto the children. STRUCTURAL
    // directives (v-for, v-if, v-slot, v-show) are refused separately;
    // see the refusal tests.
    const source = sfc(`  <section>\n    <div class="card" :data-x="y">\n      <p>kept</p>\n    </div>\n  </section>\n`)
    const result = applyUnwrapEdit({ source, line: 3, column: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).not.toMatch(/class="card"/)
    expect(result.source).not.toMatch(/data-x/)
    expect(result.source).toContain("<p>kept</p>")
  })

  it("can unwrap the SFC's only root when it has exactly one element child (still a valid template)", () => {
    const source = sfc(`  <div>\n    <p>only child</p>\n  </div>\n`)
    const result = applyUnwrapEdit({ source, line: 2, column: 3 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).not.toMatch(/<div>/)
    expect(result.source).toContain("<p>only child</p>")
  })
})

describe("applyUnwrapEdit — refusals", () => {
  it("refuses when no element exists at the given coordinates", () => {
    const source = sfc(`  <div>\n    <p>x</p>\n  </div>\n`)
    const result = applyUnwrapEdit({ source, line: 99, column: 5 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/No element found/i)
  })

  it("refuses self-closing wrappers (nothing to unwrap)", () => {
    const source = sfc(`  <div>\n    <KCard />\n  </div>\n`)
    const result = applyUnwrapEdit({ source, line: 3, column: 5 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/self-closing|delete/i)
  })

  it("refuses empty wrappers (nothing to hoist)", () => {
    const source = sfc(`  <div>\n    <span></span>\n  </div>\n`)
    const result = applyUnwrapEdit({ source, line: 3, column: 5 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/no rendered children|delete/i)
  })

  it("refuses wrappers with v-for (the iteration semantics live on the wrapper)", () => {
    const source = sfc(`  <section>\n    <div v-for="x in xs" :key="x">\n      <p>{{ x }}</p>\n    </div>\n  </section>\n`)
    const result = applyUnwrapEdit({ source, line: 3, column: 5 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/v-for|directive/i)
  })

  it("refuses wrappers with v-if (use Flatten Conditional instead)", () => {
    const source = sfc(`  <section>\n    <div v-if="cond">\n      <p>conditional</p>\n    </div>\n    <p>after</p>\n  </section>\n`)
    const result = applyUnwrapEdit({ source, line: 3, column: 5 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/v-if|directive|Flatten Conditional/i)
  })

  it("refuses wrappers with v-slot", () => {
    const source = sfc(`  <KCard>\n    <template v-slot:header>\n      <h1>title</h1>\n    </template>\n  </KCard>\n`)
    const result = applyUnwrapEdit({ source, line: 3, column: 5 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/v-slot|directive/i)
  })

  it("refuses wrappers with v-show (toggle would silently disappear)", () => {
    const source = sfc(`  <section>\n    <div v-show="visible">\n      <p>maybe</p>\n    </div>\n    <p>after</p>\n  </section>\n`)
    const result = applyUnwrapEdit({ source, line: 3, column: 5 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/v-show|directive/i)
  })

  it("refuses unwrap of the only template root when it would produce multiple roots", () => {
    const source = sfc(`  <div>\n    <p>one</p>\n    <p>two</p>\n  </div>\n`)
    const result = applyUnwrapEdit({ source, line: 2, column: 3 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/single root/i)
  })

  it("refuses unwrap when it would orphan a sibling v-else (now via the v-if directive guard)", () => {
    // <template v-if> + <template v-else> paired. The directive guard
    // refuses BEFORE the compile-check phase — the resulting error is
    // more actionable ("Use Flatten Conditional") than the raw v-else
    // orphan compile error.
    const source = sfc(`  <section>\n    <template v-if="x">\n      <p>true</p>\n    </template>\n    <template v-else>\n      <p>false</p>\n    </template>\n  </section>\n`)
    const result = applyUnwrapEdit({ source, line: 3, column: 5 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/v-if|directive|Flatten Conditional/i)
  })

  it("refuses when the SFC has no <template> block", () => {
    const result = applyUnwrapEdit({
      source: '<script setup>const x = 1</script>',
      line: 1,
      column: 1,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/no <template>/i)
  })
})

describe("applyUnwrapEdit — surrounding source", () => {
  it("keeps the <script> block untouched", () => {
    const source = `<template>\n  <section>\n    <div>\n      <p>x</p>\n    </div>\n  </section>\n</template>\n\n<script setup lang="ts">\nconst greeting = 'hi'\n</script>\n`
    const result = applyUnwrapEdit({ source, line: 3, column: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain('<script setup lang="ts">')
    expect(result.source).toContain("const greeting = 'hi'")
    expect(result.source).toContain("</template>")
  })
})
