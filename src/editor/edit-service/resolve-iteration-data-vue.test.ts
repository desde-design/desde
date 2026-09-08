/**
 * Tests for the Vue single-file iteration-data resolver. Exercises the
 * end-to-end: SFC source + template-position-of-v-for → array literal
 * location.
 */

import { describe, expect, it } from 'vitest'
import { resolveIterationDataVueSameFile } from './resolve-iteration-data-vue'

const SAME_FILE_SFC = `<template>
  <div>
    <ConfigCardItem
      v-for="item in items"
      :key="item.key"
      :item="item"
    />
  </div>
</template>

<script setup lang="ts">
const items = [
  { key: 'id', label: 'ID' },
  { key: 'type', label: 'Type' },
]
</script>
`

const PROP_BACKED_SFC = `<template>
  <div>
    <ConfigCardItem
      v-for="item in items"
      :key="item.key"
      :item="item"
    />
  </div>
</template>

<script setup lang="ts">
defineProps<{ items: Array<{ key: string; label: string }> }>()
</script>
`

/**
 * Find the SFC-absolute (line, column) of `<ConfigCardItem` (the inner
 * v-for) in `SAME_FILE_SFC`. The compiler-dom reports `loc.start` at
 * the `<` character.
 */
function locateInnerConfigCardItem(sfc: string): { line: number; column: number } {
  const idx = sfc.indexOf('<ConfigCardItem')
  const before = sfc.slice(0, idx)
  const lines = before.split('\n')
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  }
}

describe('resolveIterationDataVueSameFile', () => {
  it('resolves a same-file v-for to its array literal', () => {
    const loc = locateInnerConfigCardItem(SAME_FILE_SFC)
    const result = resolveIterationDataVueSameFile({
      source: SAME_FILE_SFC,
      templateLocation: loc,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file).toBeNull()
    expect(result.iterateeRoot).toBe('items')
    expect(result.iterateeChain).toEqual([])
    // arrayLocation should point at the `[` line in the script block.
    expect(result.arrayLocation.line).toBeGreaterThan(10)
  })

  it('returns Unresolved when the iteratee comes through a prop (cross-component case)', () => {
    const idx = PROP_BACKED_SFC.indexOf('<ConfigCardItem')
    const before = PROP_BACKED_SFC.slice(0, idx)
    const lines = before.split('\n')
    const loc = {
      line: lines.length,
      column: lines[lines.length - 1].length + 1,
    }
    const result = resolveIterationDataVueSameFile({
      source: PROP_BACKED_SFC,
      templateLocation: loc,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/Could not find an array literal/i)
  })

  it('returns Unresolved when the template position has no v-for', () => {
    const result = resolveIterationDataVueSameFile({
      source: SAME_FILE_SFC,
      templateLocation: { line: 1, column: 1 },
    })
    expect(result.ok).toBe(false)
  })

  it('refuses member-access iteratees (Codex P1 #2) — would pick wrong array', () => {
    const sfc = `<template>
  <div>
    <Row v-for="item in group.items" :key="item.id" />
  </div>
</template>
<script setup lang="ts">
const group = { other: [{ id: 1 }], items: [{ id: 2 }] }
</script>
`
    const idx = sfc.indexOf('<Row')
    const before = sfc.slice(0, idx)
    const lines = before.split('\n')
    const result = resolveIterationDataVueSameFile({
      source: sfc,
      templateLocation: {
        line: lines.length,
        column: lines[lines.length - 1].length + 1,
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/property access/i)
  })

  it('extracts keyProperty from `:key="item.id"` so the matcher uses id, not key', () => {
    const sfc = `<template>
  <div>
    <Row v-for="item in items" :key="item.id" />
  </div>
</template>
<script setup lang="ts">
const items = [{ id: 1 }]
</script>
`
    const idx = sfc.indexOf('<Row')
    const before = sfc.slice(0, idx)
    const lines = before.split('\n')
    const result = resolveIterationDataVueSameFile({
      source: sfc,
      templateLocation: {
        line: lines.length,
        column: lines[lines.length - 1].length + 1,
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.keyProperty).toBe('id')
  })

  it('refuses ternary-initialized iteratees (Codex round-2 P2) — would pick wrong branch', () => {
    const sfc = `<template>
  <div>
    <Row v-for="item in items" :key="item.id" />
  </div>
</template>
<script setup lang="ts">
const useAlt = false
const items = useAlt
  ? [{ id: 'alt' }]
  : [{ id: 'base' }]
</script>
`
    const idx = sfc.indexOf('<Row')
    const before = sfc.slice(0, idx)
    const lines = before.split('\n')
    const result = resolveIterationDataVueSameFile({
      source: sfc,
      templateLocation: {
        line: lines.length,
        column: lines[lines.length - 1].length + 1,
      },
    })
    expect(result.ok).toBe(false)
  })

  it('accepts `computed(() => [...])` with single-expression body', () => {
    const sfc = `<template>
  <Row v-for="item in items" :key="item.id" />
</template>
<script setup lang="ts">
import { computed } from 'vue'
const items = computed(() => [{ id: 1 }, { id: 2 }])
</script>
`
    const idx = sfc.indexOf('<Row')
    const before = sfc.slice(0, idx)
    const lines = before.split('\n')
    const result = resolveIterationDataVueSameFile({
      source: sfc,
      templateLocation: {
        line: lines.length,
        column: lines[lines.length - 1].length + 1,
      },
    })
    expect(result.ok).toBe(true)
  })

  it('reports keyProperty=null when `:key` is the iteration variable itself', () => {
    const sfc = `<template>
  <div>
    <Row v-for="item in items" :key="item" />
  </div>
</template>
<script setup lang="ts">
const items = ['a', 'b']
</script>
`
    const idx = sfc.indexOf('<Row')
    const before = sfc.slice(0, idx)
    const lines = before.split('\n')
    const result = resolveIterationDataVueSameFile({
      source: sfc,
      templateLocation: {
        line: lines.length,
        column: lines[lines.length - 1].length + 1,
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.keyProperty).toBeNull()
  })

  it('returns an importCandidate when the iteratee is bound by a relative import', () => {
    const sfc = `<template>
  <div>
    <Row v-for="item in rows" :key="item.id" />
  </div>
</template>
<script setup lang="ts">
import { rows } from "./rows"
</script>
`
    const idx = sfc.indexOf('<Row')
    const before = sfc.slice(0, idx)
    const lines = before.split('\n')
    const result = resolveIterationDataVueSameFile({
      source: sfc,
      templateLocation: {
        line: lines.length,
        column: lines[lines.length - 1].length + 1,
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.importCandidate).toEqual({
      iterateeRoot: 'rows',
      itemVar: 'item',
      keyProperty: 'id',
      binding: { specifier: './rows', importedName: 'rows', via: 'import' },
    })
  })

  it("reports the list's name for a transformed iteratee it will not edit (`r in rows.filter(...)`)", () => {
    const source = `<template>\n  <li v-for="r in rows.filter(Boolean)" :key="r.id">{{ r.name }}</li>\n</template>\n<script setup>\nimport { rows } from './data'\n</script>\n`
    const result = resolveIterationDataVueSameFile({ source, templateLocation: { line: 2, column: 3 } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.iterateeRoot).toBe('rows')
  })

  it("does not follow a module import when the iteratee is an outer v-for's loop variable (codex round 4)", () => {
    const source = `<template>\n  <div v-for="rows in groups" :key="rows.id">\n    <li v-for="item in rows" :key="item.id">{{ item.name }}</li>\n  </div>\n</template>\n<script setup>\nimport { rows } from './data'\nconst groups = [{ id: 1, name: 'g' }]\n</script>\n`
    const result = resolveIterationDataVueSameFile({ source, templateLocation: { line: 3, column: 5 } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.importCandidate).toBeUndefined()
    expect(result.reason).toMatch(/outer v-for/)
  })

  it("treats a destructured outer v-for alias as a loop variable, not the module import (codex round 5)", () => {
    const source = `<template>\n  <div v-for="{ rows } in groups" :key="rows.length">\n    <li v-for="item in rows" :key="item.id">{{ item.name }}</li>\n  </div>\n</template>\n<script setup>\nimport { rows } from './unrelated'\nconst groups = [{ rows: [] }]\n</script>\n`
    const result = resolveIterationDataVueSameFile({ source, templateLocation: { line: 3, column: 5 } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.importCandidate).toBeUndefined()
  })

  it("gives no list-name hint for a transformed iteratee that is an outer v-for alias (codex round 5)", () => {
    const source = `<template>\n  <div v-for="rows in groups" :key="rows.length">\n    <li v-for="item in rows.filter(Boolean)" :key="item.id">{{ item.name }}</li>\n  </div>\n</template>\n<script setup>\nimport { rows } from './unrelated'\nconst groups = [[]]\n</script>\n`
    const result = resolveIterationDataVueSameFile({ source, templateLocation: { line: 3, column: 5 } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.iterateeRoot).toBeUndefined()
  })

  it("does not pick a helper function's local array over the imported list (codex round 5)", () => {
    const source = `<template>\n  <li v-for="r in rows" :key="r.id">{{ r.name }}</li>\n</template>\n<script setup>\nimport { rows } from './data'\nfunction unrelated() {\n  const rows = [{ id: 'wrong' }]\n  return rows\n}\n</script>\n`
    const result = resolveIterationDataVueSameFile({ source, templateLocation: { line: 2, column: 3 } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.importCandidate?.binding.specifier).toBe('./data')
  })

  it("ignores a helper object's setup() and resolves the top-level array (codex round 6)", () => {
    const source = `<template>\n  <li v-for="r in rows" :key="r.id">{{ r.name }}</li>\n</template>\n<script setup>\nconst unrelated = {\n  setup() { const rows = [{ id: 'wrong' }]; return { rows } },\n}\nconst rows = [{ id: 'right' }]\n</script>\n`
    const result = resolveIterationDataVueSameFile({ source, templateLocation: { line: 2, column: 3 } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.arrayLocation.line).toBe(8)
  })

  it("still sees the locals of an Options API setup() on the component definition", () => {
    const source = `<template>\n  <li v-for="r in rows" :key="r.id">{{ r.name }}</li>\n</template>\n<script>\nimport { ref } from 'vue'\nexport default {\n  setup() {\n    const rows = ref([{ id: 1, name: 'a' }])\n    return { rows }\n  },\n}\n</script>\n`
    const result = resolveIterationDataVueSameFile({ source, templateLocation: { line: 2, column: 3 } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.arrayLocation.line).toBe(8)
  })

  it("still sees the locals of defineComponent({ setup() })", () => {
    const source = `<template>\n  <li v-for="r in rows" :key="r.id">{{ r.name }}</li>\n</template>\n<script>\nimport { defineComponent } from 'vue'\nexport default defineComponent({\n  setup() {\n    const rows = [{ id: 1, name: 'a' }]\n    return { rows }\n  },\n})\n</script>\n`
    const result = resolveIterationDataVueSameFile({ source, templateLocation: { line: 2, column: 3 } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.arrayLocation.line).toBe(8)
  })
})
