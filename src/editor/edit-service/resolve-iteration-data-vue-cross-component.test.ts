/**
 * Tests for the cross-component Vue iteration-data resolver. The
 * scenario: a row component is fed its data via a prop from a page,
 * and the array literal lives in the page's <script setup>.
 */

import { describe, expect, it } from 'vitest'
import { resolveIterationDataVueCrossComponent } from './resolve-iteration-data-vue-cross-component'

const ROW_COMPONENT = `<template>
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

const PAGE_SFC = `<template>
  <ConfigCardDisplay :items="rowsForCard" />
</template>

<script setup lang="ts">
import ConfigCardDisplay from '@/components/ConfigCardDisplay.vue'

const rowsForCard = [
  { key: 'id', label: 'ID' },
  { key: 'type', label: 'Type' },
  { key: 'tags', label: 'Tags' },
]
</script>
`

function locateInnerVForInComponent(sfc: string): { line: number; column: number } {
  const idx = sfc.indexOf('<ConfigCardItem')
  const before = sfc.slice(0, idx)
  const lines = before.split('\n')
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  }
}

describe('resolveIterationDataVueCrossComponent', () => {
  it('traces a prop-passed iteratee to the page-level array literal', () => {
    const loc = locateInnerVForInComponent(ROW_COMPONENT)
    const result = resolveIterationDataVueCrossComponent({
      componentSource: ROW_COMPONENT,
      templateLocation: loc,
      pageSource: PAGE_SFC,
      pageSourceFile: 'src/views/SomePage.vue',
      componentName: 'ConfigCardDisplay',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file).toBe('src/views/SomePage.vue')
    // Array should be located somewhere in the page script.
    expect(result.arrayLocation.line).toBeGreaterThan(5)
  })

  it('returns Unresolved when the iteratee is a member-access expression', () => {
    const component = ROW_COMPONENT.replace(
      'v-for="item in items"',
      'v-for="item in container.items"',
    )
    const loc = locateInnerVForInComponent(component)
    const result = resolveIterationDataVueCrossComponent({
      componentSource: component,
      templateLocation: loc,
      pageSource: PAGE_SFC,
      pageSourceFile: 'src/views/SomePage.vue',
      componentName: 'ConfigCardDisplay',
    })
    expect(result.ok).toBe(false)
  })

  it('returns Unresolved when the page does not bind the prop', () => {
    const naked = `<template><div /></template><script setup></script>`
    const loc = locateInnerVForInComponent(ROW_COMPONENT)
    const result = resolveIterationDataVueCrossComponent({
      componentSource: ROW_COMPONENT,
      templateLocation: loc,
      pageSource: naked,
      pageSourceFile: 'src/views/SomePage.vue',
      componentName: 'ConfigCardDisplay',
    })
    expect(result.ok).toBe(false)
  })

  it('does NOT cross-bind to a sibling component with the same prop name (Codex P1 #3)', () => {
    const pageWithSibling = `<template>
  <OtherTable :items="otherRows" />
  <ConfigCardDisplay :items="configRows" />
</template>
<script setup lang="ts">
const otherRows = [{ key: 'wrong' }]
const configRows = [{ key: 'right' }]
</script>
`
    const loc = locateInnerVForInComponent(ROW_COMPONENT)
    const result = resolveIterationDataVueCrossComponent({
      componentSource: ROW_COMPONENT,
      templateLocation: loc,
      pageSource: pageWithSibling,
      pageSourceFile: 'src/views/SomePage.vue',
      componentName: 'ConfigCardDisplay',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The array literal we picked must be the one bound to <ConfigCardDisplay>,
    // not the one bound to <OtherTable>. Check by inspecting the line in the page
    // source — `configRows` is declared on a later line than `otherRows`.
    const otherIdx = pageWithSibling.indexOf('otherRows =')
    const configIdx = pageWithSibling.indexOf('configRows =')
    const otherLine = pageWithSibling.slice(0, otherIdx).split('\n').length
    const configLine = pageWithSibling.slice(0, configIdx).split('\n').length
    expect(result.arrayLocation.line).toBe(configLine)
    expect(result.arrayLocation.line).not.toBe(otherLine)
  })

  it('returns Unresolved when the iteratee is not a declared prop', () => {
    const component = ROW_COMPONENT.replace(
      'defineProps<{ items: Array<{ key: string; label: string }> }>()',
      '// no props',
    )
    const loc = locateInnerVForInComponent(component)
    const result = resolveIterationDataVueCrossComponent({
      componentSource: component,
      templateLocation: loc,
      pageSource: PAGE_SFC,
      pageSourceFile: 'src/views/SomePage.vue',
      componentName: 'ConfigCardDisplay',
    })
    expect(result.ok).toBe(false)
  })
})
