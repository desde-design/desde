import { describe, expect, it } from 'vitest'
import { listConditionalGroups } from './list-conditional-groups'

describe('listConditionalGroups', () => {
  it('lists a full v-if/v-else-if/v-else chain with member locs', () => {
    const sfc = `<template>
  <section>
    <template v-if="multi">
      <div class="cards">many</div>
    </template>
    <template v-else-if="one">
      <div class="card">one</div>
    </template>
    <template v-else>
      <div class="empty">none</div>
    </template>
  </section>
</template>
`
    const result = listConditionalGroups(sfc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.groups).toHaveLength(1)
    const g = result.groups[0]
    expect(g.directive).toBe('if')
    expect(g.expression).toBe('multi')
    expect(g.head).toEqual({ line: 3, column: 5 })
    expect(g.branches.map((b) => b.directive)).toEqual(['if', 'else-if', 'else'])
    // One element child per branch, at their data-desde-src coordinates.
    expect(g.memberLocs).toEqual([
      { line: 4, column: 7 },
      { line: 7, column: 7 },
      { line: 10, column: 7 },
    ])
  })

  it('lists a standalone v-for wrapper', () => {
    const sfc = `<template>
  <ul>
    <template v-for="x in xs" :key="x">
      <li class="row">{{ x }}</li>
    </template>
  </ul>
</template>
`
    const result = listConditionalGroups(sfc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].directive).toBe('for')
    expect(result.groups[0].expression).toBe('x in xs')
    expect(result.groups[0].branches).toHaveLength(1)
  })

  it('ignores element-level v-if (visible containers) and finds nested groups', () => {
    const sfc = `<template>
  <div v-if="visible">
    <template v-if="inner">
      <span class="a">a</span>
    </template>
  </div>
</template>
`
    const result = listConditionalGroups(sfc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Only the <template v-if="inner"> wrapper — the <div v-if> is a
    // visible element and needs no synthetic row.
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].expression).toBe('inner')
  })

  it('handles script-before-template SFC-absolute coordinates', () => {
    const sfc = `<script setup lang="ts">
const multi = true
</script>

<template>
  <section>
    <template v-if="multi">
      <div class="cards">many</div>
    </template>
  </section>
</template>
`
    const result = listConditionalGroups(sfc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.groups[0].head).toEqual({ line: 7, column: 5 })
    expect(result.groups[0].memberLocs).toEqual([{ line: 8, column: 7 }])
  })

  it('returns empty groups for an SFC with no template wrappers', () => {
    const result = listConditionalGroups('<template>\n  <div>plain</div>\n</template>\n')
    expect(result).toEqual({ ok: true, groups: [] })
  })
})
