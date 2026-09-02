import { describe, expect, it } from "vitest"
import { applyInsertEdit } from "./apply-insert-edit"

describe("applyInsertEdit — happy paths", () => {
  it("appends a new element to a parent's children (destIndex: -1)", () => {
    const source = `<template>\n  <div>\n    <span>existing</span>\n  </div>\n</template>\n`
    // <div> at line 2 col 3
    const result = applyInsertEdit({
      source,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<button>new</button>',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain("<span>existing</span>")
      expect(result.source).toContain("<button>new</button>")
      // Sibling order: existing should come before new.
      expect(result.source.indexOf("<span>existing</span>")).toBeLessThan(
        result.source.indexOf("<button>new</button>"),
      )
    }
  })

  it("inserts at index 0 (prepend)", () => {
    const source = `<template>\n  <div>\n    <span>existing</span>\n  </div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: 0,
      snippet: '<button>new</button>',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source.indexOf("<button>new</button>")).toBeLessThan(
        result.source.indexOf("<span>existing</span>"),
      )
    }
  })

  it("inserts at a middle index", () => {
    const source = `<template>\n  <div>\n    <a>1</a>\n    <c>3</c>\n  </div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: 1,
      snippet: '<b>2</b>',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const i1 = result.source.indexOf("<a>1</a>")
      const i2 = result.source.indexOf("<b>2</b>")
      const i3 = result.source.indexOf("<c>3</c>")
      expect(i1).toBeLessThan(i2)
      expect(i2).toBeLessThan(i3)
    }
  })

  it("inserts into an empty parent", () => {
    const source = `<template>\n  <div></div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: 0,
      snippet: '<span>first</span>',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain("<span>first</span>")
    }
  })

  it("inserts a component (PascalCase tag)", () => {
    const source = `<template>\n  <div>\n    <span>x</span>\n  </div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<UiCard>contents</UiCard>',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain("<UiCard>contents</UiCard>")
    }
  })

  it("inserts a self-closing snippet", () => {
    const source = `<template>\n  <div>\n    <span>x</span>\n  </div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<hr />',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain("<hr />")
    }
  })

  it("clamps a too-large destIndex to append", () => {
    const source = `<template>\n  <div>\n    <span>existing</span>\n  </div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: 999,
      snippet: '<button>new</button>',
    })
    expect(result.ok).toBe(true)
  })
})

describe("applyInsertEdit — auto-import (componentImport)", () => {
  const sfc = (scriptSetup: string) =>
    `<script setup>\n${scriptSetup}\n</script>\n\n<template>\n  <div>\n    <span>x</span>\n  </div>\n</template>\n`

  it("adds a named import for a library component", () => {
    const source = sfc(`import { ref } from 'vue'`)
    const result = applyInsertEdit({
      source,
      destParentLine: 6, // <div> (line 6 in the sfc() template)
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<UiCard>hi</UiCard>',
      componentImport: { name: 'UiCard', importPath: '@acme/design-system' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain("import { UiCard } from '@acme/design-system'")
      expect(result.source).toContain('<UiCard>hi</UiCard>')
      // Import lands inside <script setup>, before </script>.
      expect(result.source.indexOf("import { UiCard }")).toBeLessThan(
        result.source.indexOf('</script>'),
      )
      // Element lands inside <template>.
      expect(result.source.indexOf('<UiCard>hi</UiCard>')).toBeGreaterThan(
        result.source.indexOf('<template>'),
      )
      expect(result.warnings).toBeUndefined()
    }
  })

  it("adds a default import for a .vue single-file component", () => {
    const source = sfc(`import { ref } from 'vue'`)
    const result = applyInsertEdit({
      source,
      destParentLine: 6,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<MyCard />',
      componentImport: { name: 'MyCard', importPath: './MyCard.vue' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain("import MyCard from './MyCard.vue'")
      expect(result.source).not.toContain('import { MyCard }')
    }
  })

  it("honors an explicit named:false override on a non-.vue path", () => {
    const source = sfc(`import { ref } from 'vue'`)
    const result = applyInsertEdit({
      source,
      destParentLine: 6,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<Widget />',
      componentImport: { name: 'Widget', importPath: 'widget-lib', named: false },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain("import Widget from 'widget-lib'")
    }
  })

  it("does not duplicate an already-present named import", () => {
    const source = sfc(`import { UiCard } from '@acme/design-system'`)
    const result = applyInsertEdit({
      source,
      destParentLine: 6,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<UiCard>hi</UiCard>',
      componentImport: { name: 'UiCard', importPath: '@acme/design-system' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const occurrences = result.source.split('import { UiCard }').length - 1
      expect(occurrences).toBe(1)
      expect(result.warnings).toBeUndefined()
    }
  })

  it("does not duplicate an already-present default import", () => {
    const source = sfc(`import MyCard from './MyCard.vue'`)
    const result = applyInsertEdit({
      source,
      destParentLine: 6,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<MyCard />',
      componentImport: { name: 'MyCard', importPath: './MyCard.vue' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const occurrences = result.source.split("import MyCard from './MyCard.vue'").length - 1
      expect(occurrences).toBe(1)
    }
  })

  it("warns and skips when the name is imported from a DIFFERENT module (no wrong-binding, no dup)", () => {
    // Codex P1: UiCard already imported from a local file; a request for
    // UiCard from @acme/design-system must NOT silently skip and bind wrong,
    // nor add a duplicate binding. It inserts the element + warns.
    const source = sfc(`import { UiCard } from './local/UiCard.vue'`)
    const result = applyInsertEdit({
      source,
      destParentLine: 6,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<UiCard>hi</UiCard>',
      componentImport: { name: 'UiCard', importPath: '@acme/design-system' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain('<UiCard>hi</UiCard>')
      // No second UiCard import added.
      expect(result.source).not.toContain("from '@acme/design-system'")
      expect(result.warnings?.[0]).toMatch(/already exists/)
    }
  })

  it("warns and skips when the name is a local declaration (no invalid duplicate binding)", () => {
    // Codex P2: a `const UiCard = …` would collide with an injected import.
    const source = sfc(`const UiCard = { name: 'x' }`)
    const result = applyInsertEdit({
      source,
      destParentLine: 6,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<UiCard>hi</UiCard>',
      componentImport: { name: 'UiCard', importPath: '@acme/design-system' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain('<UiCard>hi</UiCard>')
      expect(result.source).not.toContain('import { UiCard }')
      expect(result.warnings?.[0]).toMatch(/already exists/)
    }
  })

  it("treats a combined `import Foo, { UiCard }` clause as already imported (no duplicate)", () => {
    // Codex round-2 P1: regex missed the named binding behind a default.
    const source = sfc(`import Foo, { UiCard } from '@acme/design-system'`)
    const result = applyInsertEdit({
      source,
      destParentLine: 6,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<UiCard>hi</UiCard>',
      componentImport: { name: 'UiCard', importPath: '@acme/design-system' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Still exactly one UiCard import; no second one injected.
      const importCount = (result.source.match(/\bUiCard\b(?=[^<]*from '@acme\/design-system')/g) || [])
        .length
      expect(result.source.split('import').length - 1).toBe(1) // one import statement total
      expect(importCount).toBeGreaterThan(0)
      expect(result.warnings).toBeUndefined()
    }
  })

  it("adds the real import when the same name is aliased (`{ UiCard as LocalCard }`)", () => {
    // Codex round-2 P1: an alias means the UiCard binding is NOT available,
    // so the requested import must still be added (no false idempotency).
    const source = sfc(`import { UiCard as LocalCard } from '@acme/design-system'`)
    const result = applyInsertEdit({
      source,
      destParentLine: 6,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<UiCard>hi</UiCard>',
      componentImport: { name: 'UiCard', importPath: '@acme/design-system' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain('import { UiCard } from')
      expect(result.source).toContain('UiCard as LocalCard')
      expect(result.warnings).toBeUndefined()
    }
  })

  it("separates the injected import from compact script-setup content", () => {
    // Codex round-2 P2: `<script setup>const n = 1</script>` must not become
    // `import …const n = 1` (no separator) — the result must reparse.
    const source = `<script setup>const n = 1</script>\n\n<template>\n  <div>\n    <span>x</span>\n  </div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 4,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<UiCard>hi</UiCard>',
      componentImport: { name: 'UiCard', importPath: '@acme/design-system' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain("import { UiCard } from '@acme/design-system'")
      // The import must not be glued onto the following statement.
      expect(result.source).not.toContain("@acme/design-system'const")
      expect(result.source).toContain('const n = 1')
    }
  })

  it("does not treat a type-only import as satisfying the runtime import", () => {
    // Codex round-3 P1: `import type { UiCard }` is type-space only; it
    // cannot resolve a runtime <UiCard>. Nor can we add `import { UiCard }`
    // (duplicate identifier) — so warn and skip rather than silently
    // leaving the tag unresolved.
    const source = `<script setup lang="ts">\nimport type { UiCard } from '@acme/design-system'\n</script>\n\n<template>\n  <div>\n    <span>x</span>\n  </div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 6,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<UiCard>hi</UiCard>',
      componentImport: { name: 'UiCard', importPath: '@acme/design-system' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain('<UiCard>hi</UiCard>')
      // No second (value) UiCard import injected.
      expect(result.source).not.toContain("import { UiCard } from '@acme/design-system'")
      expect(result.warnings?.[0]).toMatch(/already exists/)
    }
  })

  it("does not treat a namespace import as satisfying the runtime import", () => {
    // Codex round-4 P2: `import * as UiCard` binds the module object, not
    // the component export — and blocks a same-named value import.
    const source = sfc(`import * as UiCard from '@acme/design-system'`)
    const result = applyInsertEdit({
      source,
      destParentLine: 6,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<UiCard>hi</UiCard>',
      componentImport: { name: 'UiCard', importPath: '@acme/design-system' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).not.toContain('import { UiCard }')
      expect(result.warnings?.[0]).toMatch(/already exists/)
    }
  })

  it("treats a TS enum/runtime declaration as a conflicting binding", () => {
    // Codex round-4 P2: `enum UiCard {}` binds a runtime name; injecting an
    // import would duplicate it (invalid script the template re-parse misses).
    const source = `<script setup lang="ts">\nenum UiCard { A, B }\n</script>\n\n<template>\n  <div>\n    <span>x</span>\n  </div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 6,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<UiCard>hi</UiCard>',
      componentImport: { name: 'UiCard', importPath: '@acme/design-system' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).not.toContain('import { UiCard }')
      expect(result.warnings?.[0]).toMatch(/already exists/)
    }
  })

  it("still adds the import when only a same-named interface/type exists (coexist)", () => {
    // Codex round-5 P2: a value import coexists with a same-named
    // interface/type alias (different namespaces — verified vs tsc), so
    // the import must NOT be suppressed.
    const source = `<script setup lang="ts">\ninterface UiCard { a: number }\n</script>\n\n<template>\n  <div>\n    <span>x</span>\n  </div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 6,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<UiCard>hi</UiCard>',
      componentImport: { name: 'UiCard', importPath: '@acme/design-system' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain("import { UiCard } from '@acme/design-system'")
      expect(result.source).toContain('interface UiCard')
      expect(result.warnings).toBeUndefined()
    }
  })

  it("inserts the import below a leading pragma comment", () => {
    // Codex round-5 P2: an injected import must not jump above a leading
    // pragma such as `// @ts-nocheck` (which would change interpretation).
    const source = `<script setup lang="ts">\n// @ts-nocheck\nimport { ref } from 'vue'\n</script>\n\n<template>\n  <div>\n    <span>x</span>\n  </div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 7,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<UiCard>hi</UiCard>',
      componentImport: { name: 'UiCard', importPath: '@acme/design-system' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain("import { UiCard } from '@acme/design-system'")
      // The pragma must still precede the injected import.
      expect(result.source.indexOf('// @ts-nocheck')).toBeLessThan(
        result.source.indexOf("import { UiCard }"),
      )
    }
  })

  it("does not treat a same-name alias as the requested import", () => {
    // Codex round-6 P2: `import { UiButton as UiCard }` binds UiCard to
    // UiButton — inserting <UiCard> must NOT be considered already-imported.
    const source = sfc(`import { UiButton as UiCard } from '@acme/design-system'`)
    const result = applyInsertEdit({
      source,
      destParentLine: 6,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<UiCard>hi</UiCard>',
      componentImport: { name: 'UiCard', importPath: '@acme/design-system' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // The conflicting alias occupies UiCard, so we can't safely add the
      // import — surface a warning rather than silently binding UiButton.
      expect(result.source).not.toContain("import { UiCard } from '@acme/design-system'")
      expect(result.source).toContain('UiButton as UiCard')
      expect(result.warnings?.[0]).toMatch(/already exists/)
    }
  })

  it("inserts the import below a pragma in a comment-only <script setup>", () => {
    // Codex round-6 P2: no statements but a leading pragma — the import
    // must still land after the comment, not above it.
    const source = `<script setup lang="ts">\n// @ts-nocheck\n</script>\n\n<template>\n  <div>\n    <span>x</span>\n  </div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 6,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<UiCard>hi</UiCard>',
      componentImport: { name: 'UiCard', importPath: '@acme/design-system' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain("import { UiCard } from '@acme/design-system'")
      expect(result.source.indexOf('// @ts-nocheck')).toBeLessThan(
        result.source.indexOf("import { UiCard }"),
      )
    }
  })

  it("does not treat an existing NAMED import as satisfying a requested DEFAULT import", () => {
    // Codex round-7 P1: requested default (named:false) vs existing named
    // import resolves to a different export — must not silently skip.
    const source = sfc(`import { Widget } from 'widget-lib'`)
    const result = applyInsertEdit({
      source,
      destParentLine: 6,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<Widget />',
      componentImport: { name: 'Widget', importPath: 'widget-lib', named: false },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Widget already occupies the local name (as a named import), so the
      // default import can't be added — surface a warning.
      expect(result.warnings?.[0]).toMatch(/already exists/)
    }
  })

  it("auto-imports into a <script setup lang=\"tsx\"> block with JSX", () => {
    // Codex round-7 P2: JSX-bearing setup must still parse so the import runs.
    const source = `<script setup lang="tsx">\nconst Render = () => <div>hi</div>\n</script>\n\n<template>\n  <div>\n    <span>x</span>\n  </div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 6,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<UiCard>hi</UiCard>',
      componentImport: { name: 'UiCard', importPath: '@acme/design-system' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain("import { UiCard } from '@acme/design-system'")
      expect(result.warnings).toBeUndefined()
    }
  })

  it("warns and skips for an invalid import name (would write broken script)", () => {
    const source = sfc(`import { ref } from 'vue'`)
    const result = applyInsertEdit({
      source,
      destParentLine: 6,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<div>x</div>',
      componentImport: { name: 'foo-bar', importPath: '@acme/design-system' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).not.toContain('foo-bar')
      expect(result.warnings?.[0]).toMatch(/invalid import name or module path/)
    }
  })

  it("inserts the element but warns when there is no <script setup>", () => {
    // Options-API SFC: <script> but no <script setup>.
    const source = `<script>\nexport default {}\n</script>\n\n<template>\n  <div>\n    <span>x</span>\n  </div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 6,
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<UiCard>hi</UiCard>',
      componentImport: { name: 'UiCard', importPath: '@acme/design-system' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain('<UiCard>hi</UiCard>')
      expect(result.source).not.toContain('import { UiCard }')
      expect(result.warnings).toBeDefined()
      expect(result.warnings?.[0]).toMatch(/no <script setup>/)
    }
  })

  it("keeps both the template element and the import valid (script before template)", () => {
    // Regression: the import op (low offset, in <script setup>) and the
    // element op (high offset, in <template>) must both apply cleanly via
    // descending-offset ordering without corrupting each other.
    const source = sfc(`import { ref } from 'vue'\nconst n = ref(0)`)
    const result = applyInsertEdit({
      source,
      destParentLine: 7, // shifted: extra script line pushes <div> down
      destParentColumn: 3,
      destIndex: -1,
      snippet: '<UiButton>Go</UiButton>',
      componentImport: { name: 'UiButton', importPath: '@acme/design-system' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain("import { UiButton } from '@acme/design-system'")
      expect(result.source).toContain('<UiButton>Go</UiButton>')
      expect(result.source).toContain('const n = ref(0)')
      expect(result.source).toContain('<span>x</span>')
    }
  })
})

describe("applyInsertEdit — refusals", () => {
  it("refuses when destination parent doesn't exist", () => {
    const source = `<template>\n  <div></div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 99,
      destParentColumn: 99,
      destIndex: 0,
      snippet: '<span/>',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/No destination parent/)
    }
  })

  it("refuses an empty snippet", () => {
    const source = `<template>\n  <div></div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: 0,
      snippet: '',
    })
    expect(result.ok).toBe(false)
  })

  it("refuses a whitespace-only snippet", () => {
    const source = `<template>\n  <div></div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: 0,
      snippet: '   \n  ',
    })
    expect(result.ok).toBe(false)
  })

  it("refuses inserting into a self-closing element", () => {
    const source = `<template>\n  <div>\n    <hr />\n  </div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 3,
      destParentColumn: 5,
      destIndex: 0,
      snippet: '<span/>',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/self-closing/)
    }
  })

  it("refuses a malformed snippet (post-splice template parse fails)", () => {
    const source = `<template>\n  <div></div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: 0,
      // Missing close tag — the post-splice parse should reject.
      snippet: '<unclosed>',
    })
    expect(result.ok).toBe(false)
  })
})

describe("applyInsertEdit — contentKind:'text' (bare text)", () => {
  it("inserts plain text as a child of a parent", () => {
    const source = `<template>\n  <div>\n    <span>existing</span>\n  </div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: -1,
      snippet: "Hello world",
      contentKind: "text",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain("Hello world")
      // After the existing span (append).
      expect(result.source.indexOf("<span>existing</span>")).toBeLessThan(
        result.source.indexOf("Hello world"),
      )
    }
  })

  it("inserts text into an EMPTY parent", () => {
    const source = `<template>\n  <div></div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: -1,
      snippet: "Just text",
      contentKind: "text",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain("Just text")
      // Template still parses (no ok:false) — implied by ok:true.
    }
  })

  it("HTML-escapes & and < in text content", () => {
    const source = `<template>\n  <div></div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: -1,
      snippet: "a < b && c",
      contentKind: "text",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain("a &lt; b &amp;&amp; c")
      expect(result.source).not.toContain("a < b")
    }
  })

  it("refuses text containing Vue interpolation delimiters", () => {
    const source = `<template>\n  <div></div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: -1,
      snippet: "Count: {{ n }}",
      contentKind: "text",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/interpolation/i)
  })

  it("does not add an import in text mode even if componentImport is passed", () => {
    const source = `<script setup lang="ts">\n</script>\n\n<template>\n  <div></div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 5,
      destParentColumn: 3,
      destIndex: -1,
      snippet: "plain text",
      contentKind: "text",
      componentImport: { name: "UiCard", importPath: "@acme/design-system" },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).not.toContain("import")
      expect(result.source).toContain("plain text")
    }
  })
})

describe("applyInsertEdit — element single-root validation", () => {
  it("refuses a multi-sibling element snippet", () => {
    const source = `<template>\n  <div></div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: -1,
      snippet: "<span>a</span><span>b</span>",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/single root element/i)
  })

  it("refuses a bare-text snippet in element mode (directs to text mode)", () => {
    const source = `<template>\n  <div></div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: -1,
      snippet: "just text",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/no root element|contentKind/i)
  })

  it("accepts a single element with children + trailing whitespace", () => {
    const source = `<template>\n  <div></div>\n</template>\n`
    const result = applyInsertEdit({
      source,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: -1,
      snippet: "<ul>\n  <li>Item</li>\n</ul>\n",
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.source).toContain("<li>Item</li>")
  })
})

describe("applyInsertEdit — unresolvable component detection", () => {
  const base = (script = "") =>
    `<template>\n  <div>\n    <span>existing</span>\n  </div>\n</template>\n${script}`

  function insert(source: string, snippet: string, extra: Record<string, unknown> = {}) {
    return applyInsertEdit({
      source,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: -1,
      snippet,
      ...extra,
    })
  }

  it("warns when the tag resolves to nothing", () => {
    const result = insert(base(), "<TotallyMadeUpComponent />", {
      resolvableComponents: ["Button", "DataTable"],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings?.join(" ")).toContain("TotallyMadeUpComponent")
    expect(result.warnings?.join(" ")).toContain("will not resolve")
  })

  it("stays silent when the project auto-imports or globally registers the name", () => {
    // The vue3-vite case: PrimeVue components carry no import statement, and
    // warning about them would become a hard refusal in the agent tools.
    const result = insert(base(), "<Button label='Go' />", {
      resolvableComponents: ["Button", "DataTable"],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings ?? []).toEqual([])
  })

  it("stays silent with no ground truth, rather than guessing", () => {
    // Purely local evidence cannot separate "typo" from "auto-imported", and a
    // false warning is a false refusal downstream.
    const result = insert(base(), "<TotallyMadeUpComponent />")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings ?? []).toEqual([])
  })

  it("stays silent for a component bound in <script setup>", () => {
    const source = base(
      `<script setup>\nimport UiCard from './UiCard.vue'\n</script>\n`,
    )
    const result = insert(source, "<UiCard />", { resolvableComponents: [] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings ?? []).toEqual([])
  })

  it("warns for a name that is only TYPE-imported (no runtime value)", () => {
    const source = base(
      `<script setup lang="ts">\nimport type { UiCard } from './types'\n</script>\n`,
    )
    const result = insert(source, "<UiCard />", { resolvableComponents: [] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings?.join(" ")).toContain("will not resolve")
  })

  it("matches kebab-case usage against a PascalCase registration", () => {
    const result = insert(base(), "<ui-card />", { resolvableComponents: ["UiCard"] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings ?? []).toEqual([])
  })

  it("stays silent for the import this call is adding", () => {
    const source = base(`<script setup>\nconst n = 1\n</script>\n`)
    const result = insert(source, "<UiCard />", {
      componentImport: { name: "UiCard", importPath: "@acme/ds" },
      resolvableComponents: [],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings ?? []).toEqual([])
  })

  it("never warns for native HTML or SVG tags", () => {
    for (const snippet of ["<div />", "<span>x</span>", "<svg><circle /></svg>"]) {
      const result = insert(base(), snippet, { resolvableComponents: [] })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.warnings ?? []).toEqual([])
    }
  })

  it("never warns for Vue built-in components", () => {
    for (const snippet of [
      "<Transition><div /></Transition>",
      "<KeepAlive><div /></KeepAlive>",
      "<Teleport to='body'><div /></Teleport>",
      "<component :is='x' />",
    ]) {
      const result = insert(base(), snippet, { resolvableComponents: [] })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.warnings ?? []).toEqual([])
    }
  })

  it("never warns for text inserts", () => {
    const result = insert(base(), "Hello", {
      contentKind: "text",
      resolvableComponents: [],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings ?? []).toEqual([])
  })

  it("stays silent when an Options-API <script> mentions the name", () => {
    const source = base(
      `<script>\nimport UiCard from './UiCard.vue'\nexport default { components: { UiCard } }\n</script>\n`,
    )
    const result = insert(source, "<UiCard />", { resolvableComponents: [] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings ?? []).toEqual([])
  })
})
