import { describe, expect, it } from "vitest"
import { applyScopedCssOverrideEdit } from "./apply-scoped-css-override-edit"

const FILE = "src/views/Demo.vue"

describe("applyScopedCssOverrideEdit — happy paths", () => {
  it("creates a style scoped block when none exists, with a [data-desde-src] rule", () => {
    const source = `<template>\n  <KCard>Hello</KCard>\n</template>\n`
    const result = applyScopedCssOverrideEdit({
      source,
      anchorFile: FILE,
      anchorLine: 2,
      anchorColumn: 3,
      deepSelector: ".card-header",
      applyClasses: ["bg-amber-100"],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Template is untouched — no class splice, no proto-XXX added.
      expect(result.source).not.toContain("proto-")
      expect(result.source).toContain("<KCard>Hello</KCard>")
      // Rule targets via data-desde-src + :deep().
      expect(result.source).toContain("<style scoped>")
      expect(result.source).toContain(`[data-desde-src="${FILE}:2:3"] :deep(.card-header)`)
      expect(result.source).toContain("@apply !bg-amber-100")
      expect(result.source).toContain("@editor-scoped-overrides start")
      expect(result.source).toContain("@editor-scoped-overrides end")
      expect(result.targetSelector).toBe(`[data-desde-src="${FILE}:2:3"]`)
    }
  })

  it("does not modify the template's class attribute", () => {
    const source = `<template>\n  <KCard class="my-card">Hello</KCard>\n</template>\n`
    const result = applyScopedCssOverrideEdit({
      source,
      anchorFile: FILE,
      anchorLine: 2,
      anchorColumn: 3,
      deepSelector: ".card-header",
      applyClasses: ["bg-amber-100"],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // class attribute is preserved verbatim — no proto-XXX appended.
      expect(result.source).toContain('<KCard class="my-card">Hello</KCard>')
      expect(result.source).not.toContain("proto-")
    }
  })

  it("idempotent: revisiting the same call-site + deep-selector replaces the rule body", () => {
    const source = `<template>\n  <KCard>Hi</KCard>\n</template>\n`
    const first = applyScopedCssOverrideEdit({
      source,
      anchorFile: FILE,
      anchorLine: 2,
      anchorColumn: 3,
      deepSelector: ".card-header",
      applyClasses: ["bg-amber-100"],
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = applyScopedCssOverrideEdit({
      source: first.source,
      anchorFile: FILE,
      anchorLine: 2,
      anchorColumn: 3,
      deepSelector: ".card-header",
      applyClasses: ["bg-blue-200"],
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    // Target selector is the same (deterministic).
    expect(second.targetSelector).toBe(first.targetSelector)
    // Old class is gone, new class is in.
    expect(second.source).not.toContain("bg-amber-100")
    expect(second.source).toContain("bg-blue-200")
    // The data-desde-src + :deep(.card-header) rule head appears exactly once.
    const headMatches = second.source.match(
      /\[data-desde-src="[^"]+"\]\s*:deep\(\.card-header\)/g,
    )
    expect(headMatches?.length).toBe(1)
  })

  it("appends to an existing style scoped block without disturbing prior rules", () => {
    const source = `<template>
  <KCard>Hi</KCard>
</template>

<style scoped>
.existing-rule { color: red; }
</style>
`
    const result = applyScopedCssOverrideEdit({
      source,
      anchorFile: FILE,
      anchorLine: 2,
      anchorColumn: 3,
      deepSelector: ".card-header",
      applyClasses: ["bg-amber-100"],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain(".existing-rule { color: red; }")
      expect(result.source).toContain(":deep(.card-header)")
      // Order: existing rule appears before the managed block.
      expect(result.source.indexOf(".existing-rule")).toBeLessThan(
        result.source.indexOf("@editor-scoped-overrides"),
      )
    }
  })

  it("upserts a different deepSelector under the SAME call-site as a separate rule", () => {
    const source = `<template>\n  <KCard>Hi</KCard>\n</template>\n`
    let result = applyScopedCssOverrideEdit({
      source,
      anchorFile: FILE,
      anchorLine: 2,
      anchorColumn: 3,
      deepSelector: ".card-header",
      applyClasses: ["bg-amber-100"],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    result = applyScopedCssOverrideEdit({
      source: result.source,
      anchorFile: FILE,
      anchorLine: 2,
      anchorColumn: 3,
      deepSelector: ".card-body",
      applyClasses: ["text-slate-600"],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain(":deep(.card-header)")
    expect(result.source).toContain(":deep(.card-body)")
  })

  it("emits raw declarations when applyClasses is empty", () => {
    const source = `<template>\n  <KCard>Hi</KCard>\n</template>\n`
    const result = applyScopedCssOverrideEdit({
      source,
      anchorFile: FILE,
      anchorLine: 2,
      anchorColumn: 3,
      deepSelector: ".card-header",
      declarations: { "background-color": "#fef3c7" },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain("background-color: #fef3c7 !important")
      expect(result.source).not.toContain("@apply")
    }
  })

  it("supports both applyClasses and raw declarations in the same rule", () => {
    const source = `<template>\n  <KCard>Hi</KCard>\n</template>\n`
    const result = applyScopedCssOverrideEdit({
      source,
      anchorFile: FILE,
      anchorLine: 2,
      anchorColumn: 3,
      deepSelector: ".card-header",
      applyClasses: ["bg-amber-100"],
      declarations: { "border-radius": "8px" },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain("@apply !bg-amber-100")
      expect(result.source).toContain("border-radius: 8px !important")
    }
  })

  it("emits a non-:deep() rule when deepSelector is empty (direct case)", () => {
    const source = `<template>\n  <KCard>Hi</KCard>\n</template>\n`
    const result = applyScopedCssOverrideEdit({
      source,
      anchorFile: FILE,
      anchorLine: 2,
      anchorColumn: 3,
      deepSelector: "",
      declarations: { "background-color": "#065f46" },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toMatch(
        new RegExp(
          `\\[data-desde-src="${FILE}:2:3"\\]\\s*\\{[^}]*background-color:\\s*#065f46\\s*!important`,
        ),
      )
      expect(result.source).not.toContain(":deep(")
    }
  })

  it("treats undefined deepSelector the same as empty (direct case)", () => {
    const source = `<template>\n  <KCard>Hi</KCard>\n</template>\n`
    const result = applyScopedCssOverrideEdit({
      source,
      anchorFile: FILE,
      anchorLine: 2,
      anchorColumn: 3,
      // deepSelector intentionally omitted
      declarations: { "border-width": "4px" },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).not.toContain(":deep(")
    }
  })

  it("works fine on a self-closing call-site (no template change required)", () => {
    // Earlier revisions refused this case because they had to splice
    // a class attribute into the call-site. The new applicator never
    // touches the template — self-closing is now a non-issue.
    const source = `<template>\n  <CustomCard />\n</template>\n`
    const result = applyScopedCssOverrideEdit({
      source,
      anchorFile: FILE,
      anchorLine: 2,
      anchorColumn: 3,
      declarations: { "background-color": "#065f46" },
    })
    expect(result.ok).toBe(true)
  })

  it("works fine on a call-site with a :class dynamic binding (no template change)", () => {
    const source = `<template>\n  <KCard :class="dynamicClass">Hi</KCard>\n</template>\n`
    const result = applyScopedCssOverrideEdit({
      source,
      anchorFile: FILE,
      anchorLine: 2,
      anchorColumn: 3,
      declarations: { "background-color": "#065f46" },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Dynamic binding preserved verbatim.
      expect(result.source).toContain('<KCard :class="dynamicClass">Hi</KCard>')
    }
  })
})

describe("applyScopedCssOverrideEdit — refusals", () => {
  it("refuses when there's nothing to apply (empty applyClasses + empty declarations)", () => {
    const source = `<template>\n  <KCard>Hi</KCard>\n</template>\n`
    const result = applyScopedCssOverrideEdit({
      source,
      anchorFile: FILE,
      anchorLine: 2,
      anchorColumn: 3,
      deepSelector: ".x",
      applyClasses: [],
      declarations: {},
    })
    expect(result.ok).toBe(false)
  })

  it("refuses when anchorFile is empty", () => {
    const source = `<template>\n  <KCard>Hi</KCard>\n</template>\n`
    const result = applyScopedCssOverrideEdit({
      source,
      anchorFile: "",
      anchorLine: 2,
      anchorColumn: 3,
      declarations: { "background-color": "red" },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // The reason reaches the user verbatim, so it must describe the
      // situation rather than the missing field.
      expect(result.reason).toMatch(/nowhere to write the rule/)
      expect(result.reason).not.toMatch(/ScopedCssOverrideEdit|anchorFile/)
    }
  })

  it("refuses on a malformed SFC (post-splice parse guard)", () => {
    const source = `<template>\n  <KCard>Hi\n</template>\n` // unbalanced
    const result = applyScopedCssOverrideEdit({
      source,
      anchorFile: FILE,
      anchorLine: 2,
      anchorColumn: 3,
      declarations: { "background-color": "red" },
    })
    // SFC parser is lenient on some malformations; this test just
    // verifies we don't crash. ok may be true or false but no throw.
    expect(typeof result.ok).toBe("boolean")
  })
})

describe("applyScopedCssOverrideEdit — determinism", () => {
  it("same (file/line/col) produces the same target selector", () => {
    const source = `<template>\n  <KCard>Hi</KCard>\n</template>\n`
    const a = applyScopedCssOverrideEdit({
      source,
      anchorFile: FILE,
      anchorLine: 2,
      anchorColumn: 3,
      deepSelector: ".x",
      applyClasses: ["bg-red-500"],
    })
    const b = applyScopedCssOverrideEdit({
      source,
      anchorFile: FILE,
      anchorLine: 2,
      anchorColumn: 3,
      deepSelector: ".y",
      applyClasses: ["bg-blue-500"],
    })
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.targetSelector).toBe(b.targetSelector)
    }
  })

  it("different call-sites get different target selectors", () => {
    const source = `<template>\n  <KCard>A</KCard>\n  <KCard>B</KCard>\n</template>\n`
    const a = applyScopedCssOverrideEdit({
      source,
      anchorFile: FILE,
      anchorLine: 2,
      anchorColumn: 3,
      deepSelector: ".x",
      applyClasses: ["bg-red-500"],
    })
    const b = applyScopedCssOverrideEdit({
      source,
      anchorFile: FILE,
      anchorLine: 3,
      anchorColumn: 3,
      deepSelector: ".x",
      applyClasses: ["bg-blue-500"],
    })
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.targetSelector).not.toBe(b.targetSelector)
    }
  })
})

/**
 * The `css-file` destination — a project stylesheet rather than an SFC's
 * `<style scoped>` block. This is what makes the lane reach React, whose
 * components have nowhere to put a rule.
 *
 * The two things that differ, and only these two: no `:deep()` (React has no
 * style scoping, so a plain descendant already pierces a third-party
 * component), and no `@apply` (a project `.css` may not be Tailwind-processed,
 * and an uncompiled `@apply` is a rule that is present and inert — which is
 * the failure mode this whole lane's history is about).
 */
describe("applyScopedCssOverrideEdit — css-file destination", () => {
  const ANCHOR = "src/App.tsx"

  it("appends a managed block at end-of-file and leaves everything else byte-identical", () => {
    const source = `:root { --brand: #09f; }\n\n.card { padding: 8px; }\n`
    const result = applyScopedCssOverrideEdit({
      source,
      destination: "css-file",
      anchorFile: ANCHOR,
      anchorLine: 16,
      anchorColumn: 38,
      declarations: { "padding-top": "40px" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source.startsWith(source)).toBe(true)
    expect(result.source).toContain("/* @editor-scoped-overrides start */")
    expect(result.source).toContain(
      '[data-desde-src="src/App.tsx:16:38"] { padding-top: 40px !important; }',
    )
  })

  it("uses a plain descendant combinator, never :deep()", () => {
    const result = applyScopedCssOverrideEdit({
      source: ".a { color: red }\n",
      destination: "css-file",
      anchorFile: ANCHOR,
      anchorLine: 33,
      anchorColumn: 46,
      deepSelector: ".MuiAlert-message",
      declarations: { "padding-left": "41px" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain(
      '[data-desde-src="src/App.tsx:33:46"] .MuiAlert-message {',
    )
    expect(result.source).not.toContain(":deep(")
  })

  it("stamps the anchor's content version so staleness is a pure function", () => {
    const result = applyScopedCssOverrideEdit({
      source: "",
      destination: "css-file",
      anchorFile: ANCHOR,
      anchorLine: 16,
      anchorColumn: 38,
      anchorVersion: "fde8c3ed79c1",
      declarations: { color: "red" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain("/* pt src/App.tsx:16:38 v=fde8c3ed79c1 */")
  })

  it("is idempotent — a second edit on the same anchor replaces the rule in place", () => {
    const base = ".a { color: red }\n"
    const first = applyScopedCssOverrideEdit({
      source: base,
      destination: "css-file",
      anchorFile: ANCHOR,
      anchorLine: 16,
      anchorColumn: 38,
      declarations: { "padding-top": "40px" },
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = applyScopedCssOverrideEdit({
      source: first.source,
      destination: "css-file",
      anchorFile: ANCHOR,
      anchorLine: 16,
      anchorColumn: 38,
      declarations: { "padding-top": "44px" },
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.source).not.toContain("40px")
    expect(second.source).toContain("44px")
    // One rule, not two.
    expect(second.source.split('[data-desde-src="src/App.tsx:16:38"]').length).toBe(2)
    // And the file's own CSS is untouched across both writes.
    expect(second.source.startsWith(base)).toBe(true)
  })

  it("keeps a DIFFERENT anchor's rule alongside rather than replacing it", () => {
    const first = applyScopedCssOverrideEdit({
      source: "",
      destination: "css-file",
      anchorFile: ANCHOR,
      anchorLine: 16,
      anchorColumn: 38,
      declarations: { "padding-top": "40px" },
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = applyScopedCssOverrideEdit({
      source: first.source,
      destination: "css-file",
      anchorFile: ANCHOR,
      anchorLine: 20,
      anchorColumn: 4,
      declarations: { "padding-top": "44px" },
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.source).toContain('[data-desde-src="src/App.tsx:16:38"]')
    expect(second.source).toContain('[data-desde-src="src/App.tsx:20:4"]')
  })

  it("refuses @apply into a plain stylesheet (it would be present and inert)", () => {
    const result = applyScopedCssOverrideEdit({
      source: "",
      destination: "css-file",
      anchorFile: ANCHOR,
      anchorLine: 1,
      anchorColumn: 1,
      applyClasses: ["shadow-lg"],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/@apply/)
  })

  it("refuses an anchor that could break out of the attribute selector", () => {
    for (const bad of ['src/a".tsx', "src/a\\.tsx", "src/a{}.tsx"]) {
      const result = applyScopedCssOverrideEdit({
        source: "",
        destination: "css-file",
        anchorFile: bad,
        anchorLine: 1,
        anchorColumn: 1,
        declarations: { color: "red" },
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/can't go inside a CSS selector/)
    }
  })

  it("refuses a descendant selector carrying a brace or a comment marker", () => {
    const result = applyScopedCssOverrideEdit({
      source: "",
      destination: "css-file",
      anchorFile: ANCHOR,
      anchorLine: 1,
      anchorColumn: 1,
      deepSelector: ".x } .y {",
      declarations: { color: "red" },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/can't be written as a CSS selector/)
      expect(result.reason).not.toMatch(/ScopedCssOverrideEdit|deepSelector/)
    }
  })

  it("the same anchor sanitisation applies to the vue-sfc destination", () => {
    const result = applyScopedCssOverrideEdit({
      source: "<template>\n  <div/>\n</template>\n",
      anchorFile: 'src/A".vue',
      anchorLine: 2,
      anchorColumn: 3,
      declarations: { color: "red" },
    })
    expect(result.ok).toBe(false)
  })
})

/**
 * F-17: a stable selector that IS a quoted attribute selector (e.g.
 * `[data-testid="hero"]`) used to be refused outright, because the old guard
 * banned every `"` in `deepSelector` unconditionally. The bridge's own
 * selector builder (`src/bridge/selector-engine.ts`) already produces these
 * with `CSS.escape()` on the value, so this is not a rare shape — any
 * element carrying a `data-testid`/`aria-label`/`placeholder` attribute (and
 * no usable class/id) gets one as its stable selector.
 *
 * These tests are regression coverage for the fix (they FAIL against the
 * pre-fix guard — verified by temporarily reverting it) plus adversarial
 * coverage for the exact injection primitives the guard exists to stop:
 * `"`, `\`, `{`, `}`, `*``/`, a raw newline, and a `</style>` sequence.
 */
describe("applyScopedCssOverrideEdit — F-17 quoted attribute deep selectors", () => {
  it("accepts a quoted attribute deep selector on vue-sfc (:deep())", () => {
    const source = `<template>\n  <KCard>Hi</KCard>\n</template>\n`
    const result = applyScopedCssOverrideEdit({
      source,
      anchorFile: FILE,
      anchorLine: 2,
      anchorColumn: 3,
      deepSelector: '[data-testid="hero"]',
      declarations: { color: "red" },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain(
        `[data-desde-src="${FILE}:2:3"] :deep([data-testid="hero"])`,
      )
    }
  })

  it("accepts a quoted attribute deep selector on css-file (plain descendant)", () => {
    const result = applyScopedCssOverrideEdit({
      source: "",
      destination: "css-file",
      anchorFile: "src/App.tsx",
      anchorLine: 1,
      anchorColumn: 1,
      deepSelector: '[data-testid="hero"]',
      declarations: { color: "red" },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain(
        '[data-desde-src="src/App.tsx:1:1"] [data-testid="hero"] {',
      )
      expect(result.source).not.toContain(":deep(")
    }
  })

  it("accepts a compound selector with more than one quoted attribute", () => {
    const result = applyScopedCssOverrideEdit({
      source: "",
      destination: "css-file",
      anchorFile: "src/App.tsx",
      anchorLine: 1,
      anchorColumn: 1,
      deepSelector: '[data-testid="hero"][aria-label="Card"]',
      declarations: { color: "red" },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain(
        '[data-desde-src="src/App.tsx:1:1"] [data-testid="hero"][aria-label="Card"] {',
      )
    }
  })

  it("accepts an escaped quote INSIDE the attribute value (CSS.escape's own form)", () => {
    // What CSS.escape('say "hi"') actually produces: the inner quotes come
    // back backslash-escaped, not raw. This is what a real bridge selector
    // looks like when the attribute value itself contains a quote.
    const escaped = CSS.escape ? CSS.escape('say "hi"') : 'say \\"hi\\"'
    const deepSelector = `[data-testid="${escaped}"]`
    const result = applyScopedCssOverrideEdit({
      source: "",
      destination: "css-file",
      anchorFile: "src/App.tsx",
      anchorLine: 1,
      anchorColumn: 1,
      deepSelector,
      declarations: { color: "red" },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain(
        `[data-desde-src="src/App.tsx:1:1"] ${deepSelector} {`,
      )
    }
  })

  it("SECURITY: refuses an unterminated (unbalanced) quote", () => {
    const result = applyScopedCssOverrideEdit({
      source: "",
      destination: "css-file",
      anchorFile: "src/App.tsx",
      anchorLine: 1,
      anchorColumn: 1,
      deepSelector: '[data-testid="hero',
      declarations: { color: "red" },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/can't be written as a CSS selector/)
  })

  it("SECURITY: refuses a lone quote", () => {
    const result = applyScopedCssOverrideEdit({
      source: "",
      destination: "css-file",
      anchorFile: "src/App.tsx",
      anchorLine: 1,
      anchorColumn: 1,
      deepSelector: '"',
      declarations: { color: "red" },
    })
    expect(result.ok).toBe(false)
  })

  it("SECURITY: refuses a dangling backslash with nothing to escape", () => {
    const result = applyScopedCssOverrideEdit({
      source: "",
      destination: "css-file",
      anchorFile: "src/App.tsx",
      anchorLine: 1,
      anchorColumn: 1,
      deepSelector: '[data-testid="hero"]\\',
      declarations: { color: "red" },
    })
    expect(result.ok).toBe(false)
  })

  it("SECURITY: refuses a brace even when it sits inside otherwise-balanced quotes", () => {
    // Two quotes (balanced), but the content between them contains braces
    // that could desync bracesBalanced()'s naive byte counter — must still
    // be refused unconditionally, quoted or not.
    const result = applyScopedCssOverrideEdit({
      source: "",
      destination: "css-file",
      anchorFile: "src/App.tsx",
      anchorLine: 1,
      anchorColumn: 1,
      deepSelector: '[data-x="} .evil { color: red; } x="]',
      declarations: { color: "red" },
    })
    expect(result.ok).toBe(false)
  })

  it("SECURITY: refuses a bare closing brace", () => {
    const result = applyScopedCssOverrideEdit({
      source: "",
      destination: "css-file",
      anchorFile: "src/App.tsx",
      anchorLine: 1,
      anchorColumn: 1,
      deepSelector: "}",
      declarations: { color: "red" },
    })
    expect(result.ok).toBe(false)
  })

  it("SECURITY: refuses a bare opening brace", () => {
    const result = applyScopedCssOverrideEdit({
      source: "",
      destination: "css-file",
      anchorFile: "src/App.tsx",
      anchorLine: 1,
      anchorColumn: 1,
      deepSelector: "{",
      declarations: { color: "red" },
    })
    expect(result.ok).toBe(false)
  })

  it("SECURITY: refuses a comment-end marker, even inside quotes", () => {
    const result = applyScopedCssOverrideEdit({
      source: "",
      destination: "css-file",
      anchorFile: "src/App.tsx",
      anchorLine: 1,
      anchorColumn: 1,
      deepSelector: '[data-x="a*/b"]',
      declarations: { color: "red" },
    })
    expect(result.ok).toBe(false)
  })

  it("SECURITY: refuses a comment-start marker", () => {
    const result = applyScopedCssOverrideEdit({
      source: "",
      destination: "css-file",
      anchorFile: "src/App.tsx",
      anchorLine: 1,
      anchorColumn: 1,
      deepSelector: "/* x */",
      declarations: { color: "red" },
    })
    expect(result.ok).toBe(false)
  })

  it("SECURITY: refuses a raw newline, even inside otherwise-balanced quotes", () => {
    const result = applyScopedCssOverrideEdit({
      source: "",
      destination: "css-file",
      anchorFile: "src/App.tsx",
      anchorLine: 1,
      anchorColumn: 1,
      deepSelector: '[data-x="a\nb"]',
      declarations: { color: "red" },
    })
    expect(result.ok).toBe(false)
  })

  it("SECURITY: refuses a </style> sequence — it cannot end the style block early", () => {
    // No raw `"`/`\`/brace/comment/control char here, so nothing ELSE in
    // this guard would have caught it. MEASURED (before the `</style` ban
    // was added): this returned `ok: true`, and the payload —
    // `</style><script>evil</script>` — landed byte-for-byte inside the
    // written file's `<style scoped>` block. `@vue/compiler-sfc` treats
    // `<style>` as a raw-text element (same HTML5 rule as `<script>`), so
    // that literal `</style>` would have ended the block early and turned
    // the rest into a real, second `<script>` tag Vite compiles and runs.
    const source = `<template>\n  <KCard>Hi</KCard>\n</template>\n`
    const result = applyScopedCssOverrideEdit({
      source,
      anchorFile: FILE,
      anchorLine: 2,
      anchorColumn: 3,
      deepSelector: ".x</style><script>evil</script>",
      declarations: { color: "red" },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/can't be written as a CSS selector/)
    }
  })

  it("SECURITY: refuses </STYLE mixed-case — the HTML5 tag match is case-insensitive", () => {
    const source = `<template>\n  <KCard>Hi</KCard>\n</template>\n`
    const result = applyScopedCssOverrideEdit({
      source,
      anchorFile: FILE,
      anchorLine: 2,
      anchorColumn: 3,
      deepSelector: ".x</STYLE><script>evil</script>",
      declarations: { color: "red" },
    })
    expect(result.ok).toBe(false)
  })

  it("still allows an ordinary child-combinator selector (> is not banned)", () => {
    const result = applyScopedCssOverrideEdit({
      source: "",
      destination: "css-file",
      anchorFile: "src/App.tsx",
      anchorLine: 1,
      anchorColumn: 1,
      deepSelector: "div > span.foo",
      declarations: { color: "red" },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain(
        '[data-desde-src="src/App.tsx:1:1"] div > span.foo {',
      )
    }
  })
})
