/**
 * Integration tests for the static iteration-data applicator. Goes
 * end-to-end: real Vue SFC source in → real (mutated) Vue SFC source
 * out, including the script-block splice.
 */

import { describe, expect, it } from 'vitest'
import { applyIterationDataEditStatic } from './apply-iteration-data-edit-static'

const SFC_FIXTURE = `<template>
  <div>
    <ConfigCardItem
      v-for="item in configPropertyCollections[0].items"
      :key="item.key"
      :item="item"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const configPropertyCollections = computed(() => {
  const items = [
    { key: 'id', label: 'ID', value: 'consumer-1' },
    { key: 'username', label: 'Username', value: 'gregs-dev-key' },
    { key: 'type', label: 'Type', value: 'proxy' },
    { key: 'tags', label: 'Tags' },
  ]
  return [{ items }]
})
</script>
`

/** Find SFC-absolute (line, column) of the `[` after `items =`. */
function findItemsArrayLocation(sfc: string): { line: number; column: number } {
  const idx = sfc.indexOf('items = [') + 'items = '.length
  const before = sfc.slice(0, idx)
  const lines = before.split('\n')
  return { line: lines.length, column: lines[lines.length - 1].length + 1 }
}

describe('applyIterationDataEditStatic — Vue SFC', () => {
  it('removes one item from a script-setup data array, preserving the rest of the SFC', () => {
    const loc = findItemsArrayLocation(SFC_FIXTURE)
    const result = applyIterationDataEditStatic({
      source: SFC_FIXTURE,
      file: 'src/views/AIGatewayConsumerDetails.vue',
      arrayLocation: loc,
      matchers: [{ kind: 'object-property', property: 'key', value: 'type' }],
      operation: { operation: 'remove' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain('<template>') // template untouched
    expect(result.source).toContain("key: 'id'")
    expect(result.source).toContain("key: 'tags'")
    expect(result.source).not.toContain("key: 'type'")
    // Make sure we didn't damage the template-side reference.
    expect(result.source).toContain('configPropertyCollections[0].items')
  })

  it('patches a field on one row without touching others', () => {
    const loc = findItemsArrayLocation(SFC_FIXTURE)
    const result = applyIterationDataEditStatic({
      source: SFC_FIXTURE,
      file: 'src/views/AIGatewayConsumerDetails.vue',
      arrayLocation: loc,
      matchers: [{ kind: 'object-property', property: 'key', value: 'type' }],
      operation: { operation: 'patch', updates: { value: 'admin' } },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toMatch(/value:\s*"admin"/)
    expect(result.source).not.toContain("value: 'proxy'")
    // Other rows' values are untouched.
    expect(result.source).toContain("value: 'consumer-1'")
  })

  it('refuses cleanly when the matcher misses', () => {
    const loc = findItemsArrayLocation(SFC_FIXTURE)
    const result = applyIterationDataEditStatic({
      source: SFC_FIXTURE,
      file: 'src/views/AIGatewayConsumerDetails.vue',
      arrayLocation: loc,
      matchers: [{ kind: 'object-property', property: 'key', value: 'no-such-row' }],
      operation: { operation: 'remove' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/No entry where key/)
  })
})

describe('applyIterationDataEditStatic — plain JS/TS', () => {
  const PLAIN_TS = `export const items = [
  { id: 1, name: 'a' },
  { id: 2, name: 'b' },
  { id: 3, name: 'c' },
]
`
  it('rewrites a plain .ts file', () => {
    const idx = PLAIN_TS.indexOf('[')
    const before = PLAIN_TS.slice(0, idx)
    const lines = before.split('\n')
    const result = applyIterationDataEditStatic({
      source: PLAIN_TS,
      file: 'src/data/items.ts',
      arrayLocation: {
        line: lines.length,
        column: lines[lines.length - 1].length + 1,
      },
      matchers: [{ kind: 'object-property', property: 'id', value: 2 }],
      operation: { operation: 'remove' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).not.toContain("id: 2")
    expect(result.source).toContain("id: 1")
    expect(result.source).toContain("id: 3")
  })
})
