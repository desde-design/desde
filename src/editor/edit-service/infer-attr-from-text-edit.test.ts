import { describe, expect, it } from 'vitest'
import { inferAttrFromTextEdit } from './infer-attr-from-text-edit'

describe('inferAttrFromTextEdit — single static-attr match', () => {
  it('infers the prop carrying the rendered text from a multi-attr component', () => {
    const sfc = `<template>
  <KEmptyState
    title="No data plane nodes"
    message="Add a data plane node to route traffic."
    icon-background
  >
    <template #icon><span /></template>
  </KEmptyState>
</template>
`
    const result = inferAttrFromTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'No data plane nodes',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.propName).toBe('title')
  })

  it('trims captured before — leading/trailing whitespace matches', () => {
    const sfc = `<template>
  <KEmptyState title="Hello world">
    <template #icon><span /></template>
  </KEmptyState>
</template>
`
    const result = inferAttrFromTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: '  Hello world  ',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.propName).toBe('title')
  })

  it('matches a kebab-case attribute name (action-button-text)', () => {
    const sfc = `<template>
  <KEmptyState
    title="Different"
    action-button-text="New data plane node"
  />
</template>
`
    const result = inferAttrFromTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'New data plane node',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.propName).toBe('action-button-text')
  })
})

describe('inferAttrFromTextEdit — refusal paths', () => {
  it('refuses when no attribute matches before', () => {
    const sfc = `<template>
  <KEmptyState title="Other title" message="Other message" />
</template>
`
    const result = inferAttrFromTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'No data plane nodes',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/No static attribute/)
  })

  it('refuses when two static attrs share the value (ambiguous)', () => {
    const sfc = `<template>
  <KEmptyState title="Hello" message="Hello" />
</template>
`
    const result = inferAttrFromTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'Hello',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/Ambiguous/)
  })

  it('refuses when the element has a v-bind directive (binding could be the real text source)', () => {
    // Codex P1 — bridge captures rendered text from `:title="pageTitle"`
    // where pageTitle evaluates to "No data plane nodes". An unrelated
    // static attribute happens to carry the same string. Heuristic
    // MUST NOT rewrite the unrelated attr — the bound directive is the
    // signal that the real text source is elsewhere, so we refuse and
    // let the LLM lane handle it.
    const sfc = `<template>
  <KEmptyState :title="pageTitle" aria-label="No data plane nodes" />
</template>
`
    const result = inferAttrFromTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'No data plane nodes',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/v-bind/)
  })

  it('refuses when a static and bound directive share the same prop name', () => {
    // Codex P1 — `label="x" :label="binding"` order-dependent prop
    // resolution. applyPropEdit picks the first match (static) and
    // leaves the binding intact. The inferrer must refuse before
    // reaching applyPropEdit so this trap is unreachable from the
    // text-edit path.
    const sfc = `<template>
  <KLabel label="No data" :label="pageTitle" />
</template>
`
    const result = inferAttrFromTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'No data',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/v-bind/)
  })

  it('refuses when the element has a v-model directive', () => {
    const sfc = `<template>
  <KInput v-model="value" placeholder="No data" />
</template>
`
    const result = inferAttrFromTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'No data',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/v-model/)
  })

  it('refuses when a v-bind="…" spread is present', () => {
    const sfc = `<template>
  <KEmptyState v-bind="spread" title="No data" />
</template>
`
    const result = inferAttrFromTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'No data',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/v-bind/)
  })

  it('still infers when only unrelated non-bind directives are present (v-if, v-on)', () => {
    // v-if controls flow, v-on attaches a listener — neither can
    // supply a prop value, so the heuristic is safe to proceed.
    const sfc = `<template>
  <KEmptyState v-if="show" @click="onClick" title="Hi" />
</template>
`
    const result = inferAttrFromTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'Hi',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.propName).toBe('title')
  })

  it('refuses when the element at (line, column) is not in source', () => {
    const sfc = `<template>
  <KEmptyState title="Hi" />
</template>
`
    const result = inferAttrFromTextEdit({
      source: sfc,
      line: 99,
      column: 3,
      before: 'Hi',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/No element found/)
  })

  it('refuses on empty before', () => {
    const sfc = `<template>
  <KEmptyState title="" />
</template>
`
    const result = inferAttrFromTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: '   ',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/before is empty/)
  })
})

describe('inferAttrFromTextEdit — script-first SFC', () => {
  it('handles the template-block offset when <script> comes first', () => {
    const sfc = `<script setup>
const pageTitle = 'Hi'
</script>

<template>
  <KEmptyState title="No data plane nodes" />
</template>
`
    const result = inferAttrFromTextEdit({
      source: sfc,
      line: 6,
      column: 3,
      before: 'No data plane nodes',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.propName).toBe('title')
  })
})
