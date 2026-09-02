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
    expect(result.reason).toMatch(/Could not locate array literal/i)
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
})
