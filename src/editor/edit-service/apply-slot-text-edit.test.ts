import { describe, expect, it } from 'vitest'
import { applySlotTextEdit } from './apply-slot-text-edit'

describe('applySlotTextEdit — happy path', () => {
  it('rewrites slot text preserving indentation and surrounding whitespace', () => {
    const sfc = `<template>
  <div>
    <KLabel :info="'tip'">
      Default ACL
    </KLabel>
  </div>
</template>
`
    const result = applySlotTextEdit({
      source: sfc,
      line: 3,
      column: 5,
      before: 'Default ACL',
      after: 'Welcome',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain('Welcome')
      expect(result.source).not.toContain('Default ACL')
      // Preserve the open/close tags and the indentation around the text.
      expect(result.source).toContain(`<KLabel :info="'tip'">\n      Welcome\n    </KLabel>`)
    }
  })

  it('handles single-line slot text (`<KLabel>Foo</KLabel>`)', () => {
    const sfc = `<template>
  <KLabel>Foo</KLabel>
</template>
`
    const result = applySlotTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'Foo',
      after: 'Bar',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain('<KLabel>Bar</KLabel>')
    }
  })

  it('tolerates whitespace-only differences between before/after via trim', () => {
    // Bridge captures `before` from a text node which may include
    // surrounding whitespace. The applicator trims both sides before
    // matching so the same logical content matches even when the
    // captured text has different framing whitespace than the source.
    const sfc = `<template>
  <KLabel>  Spaced  </KLabel>
</template>
`
    const result = applySlotTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'Spaced',
      after: 'Tight',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Whitespace within the text node is preserved; just the meaningful
      // content swaps.
      expect(result.source).toContain('<KLabel>  Tight  </KLabel>')
    }
  })
})

describe('applySlotTextEdit — refusal paths', () => {
  it('refuses interpolations (`{{ x }}`) — requires runtime context', () => {
    const sfc = `<template>
  <KLabel>{{ title }}</KLabel>
</template>
`
    const result = applySlotTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'Whatever',
      after: 'Welcome',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/interpolation/i)
    }
  })

  it('refuses mixed slot content when no text child matches before', () => {
    const sfc = `<template>
  <KLabel>
    <Icon />
    Default ACL
  </KLabel>
</template>
`
    const result = applySlotTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'Something else',
      after: 'Welcome',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/no text child matches before/)
    }
  })

  it('refuses mixed slot content when multiple text children match before (ambiguous)', () => {
    const sfc = `<template>
  <div>
    Hello
    <Icon />
    Hello
  </div>
</template>
`
    const result = applySlotTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'Hello',
      after: 'Bye',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/ambiguous/)
    }
  })

  it('refuses self-closing components', () => {
    const sfc = `<template>
  <KLabel />
</template>
`
    const result = applySlotTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'Default ACL',
      after: 'Welcome',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/self-closing/i)
    }
  })

  it('refuses when slot text does not match before', () => {
    const sfc = `<template>
  <KLabel>Different</KLabel>
</template>
`
    const result = applySlotTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'Default ACL',
      after: 'Welcome',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/does not match before/)
    }
  })

  it('refuses no-op (before equals after)', () => {
    const sfc = `<template>
  <KLabel>Same</KLabel>
</template>
`
    const result = applySlotTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'Same',
      after: 'Same',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/no-op/)
    }
  })

  it('refuses empty before', () => {
    const sfc = `<template>
  <KLabel>Anything</KLabel>
</template>
`
    const result = applySlotTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: '   ',
      after: 'Welcome',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/before is empty/)
    }
  })

  it('refuses when element not found at line/column', () => {
    const sfc = `<template>
  <KLabel>Foo</KLabel>
</template>
`
    const result = applySlotTextEdit({
      source: sfc,
      line: 99,
      column: 99,
      before: 'Foo',
      after: 'Bar',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/No element found/)
    }
  })

  it('refuses when SFC has no <template> block', () => {
    const sfc = `<script setup></script>`
    const result = applySlotTextEdit({
      source: sfc,
      line: 1,
      column: 1,
      before: 'Foo',
      after: 'Bar',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/no <template>/)
    }
  })
})

describe('applySlotTextEdit — mixed slot content', () => {
  it('rewrites the unique text-child sibling next to a nested component', () => {
    const sfc = `<template>
  <KCard><KEmptyState
      title="No data plane nodes"
    >
      <template #icon><Icon /></template>
    </KEmptyState>Content</KCard>
</template>
`
    const result = applySlotTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'Content',
      after: 'Body copy',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain('</KEmptyState>Body copy</KCard>')
      // KEmptyState's title prop and #icon slot are untouched.
      expect(result.source).toContain('title="No data plane nodes"')
      expect(result.source).toContain('<template #icon><Icon /></template>')
    }
  })

  it('deletes the unique text-child sibling when after is empty', () => {
    const sfc = `<template>
  <KCard><KEmptyState title="No data plane nodes" />Content</KCard>
</template>
`
    const result = applySlotTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'Content',
      after: '',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain('</KCard>')
      expect(result.source).not.toContain('Content')
      // Sibling component stays intact.
      expect(result.source).toContain('<KEmptyState title="No data plane nodes" />')
    }
  })

  it('rewrites text next to an icon (Icon + text case)', () => {
    const sfc = `<template>
  <KLabel>
    <Icon />
    Default ACL
  </KLabel>
</template>
`
    const result = applySlotTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'Default ACL',
      after: 'Welcome',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain('Welcome')
      expect(result.source).not.toContain('Default ACL')
      expect(result.source).toContain('<Icon />')
    }
  })
})

describe('applySlotTextEdit — script-first SFC (regression)', () => {
  it('matches SFC-absolute coordinates with `<script>` before `<template>`', () => {
    const sfc = `<script setup>
const x = 1
</script>

<template>
  <KLabel>Foo</KLabel>
</template>
`
    const result = applySlotTextEdit({
      source: sfc,
      line: 6,
      column: 3,
      before: 'Foo',
      after: 'Bar',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain('<KLabel>Bar</KLabel>')
    }
  })
})

describe('applySlotTextEdit — post-splice validation (WS2 defense-in-depth)', () => {
  // tasks/edit-pipeline-rearchitecture.md WS2: unlike its JSX sibling
  // (apply-jsx-slot-text-edit.ts, which HTML-entity-escapes `<`/`>`/`{`/`}`/`&`
  // before splicing), this Vue applicator writes `after` into the template as
  // raw text with NO escaping — so a designer typing text containing `<`
  // genuinely produces broken markup through the public API today. This is a
  // real, reachable corruption case (not hypothetical), and the post-splice
  // compile backstop is what turns it into a clean refusal instead of a
  // silently-written broken file.
  it('refuses when the new text contains an unterminated tag', () => {
    const sfc = `<template>
  <KLabel>Default ACL</KLabel>
</template>
`
    const result = applySlotTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'Default ACL',
      after: '<div>unterminated',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/Post-splice template compile failed/)
    }
  })

  it('refuses when the new text embeds a disallowed <script> tag', () => {
    const sfc = `<template>
  <KEmptyState>Default ACL</KEmptyState>
</template>
`
    const result = applySlotTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'Default ACL',
      after: '5 < 10 & <script>alert(1)</script>',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/Post-splice template compile failed/)
    }
  })

  it('still returns ok:true for a normal edit that compiles cleanly', () => {
    const sfc = `<template>
  <KLabel>Foo</KLabel>
</template>
`
    const result = applySlotTextEdit({
      source: sfc,
      line: 2,
      column: 3,
      before: 'Foo',
      after: 'Bar',
    })
    expect(result.ok).toBe(true)
  })
})
