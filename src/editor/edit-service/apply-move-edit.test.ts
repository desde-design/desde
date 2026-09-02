/**
 * Tests for the pure move/reorder applicator. SFC source → SFC source
 * with one element relocated. No filesystem, no Next.js.
 *
 * SFC-absolute (line, column) coordinates throughout — the same convention
 * `data-desde-src` carries from the substrate's source-tag plugin.
 */

import { describe, expect, it } from 'vitest'
import { applyMoveEdit } from './apply-move-edit'

const sfcThreeButtons = `<template>
  <div class="row">
    <KButton variant="primary">A</KButton>
    <KButton variant="secondary">B</KButton>
    <KButton variant="danger">C</KButton>
  </div>
</template>
`
// Line/column of the three KButtons (4-space indent → column 5):
//   A: line 3, col 5
//   B: line 4, col 5
//   C: line 5, col 5
// Parent <div class="row">: line 2, col 3

describe('applyMoveEdit — same-parent reorder', () => {
  it('moves A to the end of the parent (final index 2)', () => {
    const result = applyMoveEdit({
      source: sfcThreeButtons,
      sourceLine: 3,
      sourceColumn: 5,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: 2,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Order should be B, C, A.
    const idxB = result.source.indexOf('variant="secondary"')
    const idxC = result.source.indexOf('variant="danger"')
    const idxA = result.source.indexOf('variant="primary"')
    expect(idxB).toBeGreaterThan(-1)
    expect(idxC).toBeGreaterThan(idxB)
    expect(idxA).toBeGreaterThan(idxC)
  })

  it('moves C to the start of the parent (final index 0)', () => {
    const result = applyMoveEdit({
      source: sfcThreeButtons,
      sourceLine: 5,
      sourceColumn: 5,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: 0,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const idxA = result.source.indexOf('variant="primary"')
    const idxB = result.source.indexOf('variant="secondary"')
    const idxC = result.source.indexOf('variant="danger"')
    expect(idxC).toBeGreaterThan(-1)
    expect(idxA).toBeGreaterThan(idxC)
    expect(idxB).toBeGreaterThan(idxA)
  })

  it('moves A to the middle (final index 1) — order becomes B, A, C', () => {
    const result = applyMoveEdit({
      source: sfcThreeButtons,
      sourceLine: 3,
      sourceColumn: 5,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: 1,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const idxA = result.source.indexOf('variant="primary"')
    const idxB = result.source.indexOf('variant="secondary"')
    const idxC = result.source.indexOf('variant="danger"')
    expect(idxB).toBeLessThan(idxA)
    expect(idxA).toBeLessThan(idxC)
  })

  it('returns the original source unchanged when destIndex equals current index (no-op)', () => {
    const result = applyMoveEdit({
      source: sfcThreeButtons,
      sourceLine: 4,
      sourceColumn: 5,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: 1,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toBe(sfcThreeButtons)
    }
  })

  it('handles negative destIndex (-1 means append at end)', () => {
    const result = applyMoveEdit({
      source: sfcThreeButtons,
      sourceLine: 3,
      sourceColumn: 5,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: -1,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // A should be at the end.
    const idxA = result.source.indexOf('variant="primary"')
    const idxC = result.source.indexOf('variant="danger"')
    expect(idxA).toBeGreaterThan(idxC)
  })
})

const sfcTwoColumns = `<template>
  <section>
    <div class="left">
      <KButton variant="primary">A</KButton>
    </div>
    <div class="right">
      <KButton variant="secondary">B</KButton>
    </div>
  </section>
</template>
`

describe('applyMoveEdit — cross-parent move (same file)', () => {
  it('moves A from .left into .right at index 0', () => {
    const result = applyMoveEdit({
      source: sfcTwoColumns,
      sourceLine: 4,
      sourceColumn: 7,
      destParentLine: 6,
      destParentColumn: 5,
      destIndex: 0,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // .left should now be empty (no KButton inside).
    const leftMatch = result.source.match(/<div class="left">[\s\S]*?<\/div>/)
    expect(leftMatch).not.toBeNull()
    if (leftMatch) {
      expect(leftMatch[0]).not.toContain('KButton')
    }
    // .right should contain both A (primary) and B (secondary), with A first.
    const rightMatch = result.source.match(/<div class="right">[\s\S]*?<\/div>/)
    expect(rightMatch).not.toBeNull()
    if (rightMatch) {
      const inner = rightMatch[0]
      const idxA = inner.indexOf('variant="primary"')
      const idxB = inner.indexOf('variant="secondary"')
      expect(idxA).toBeGreaterThan(-1)
      expect(idxB).toBeGreaterThan(idxA)
    }
  })
})

describe('applyMoveEdit — refusals', () => {
  it('refuses when source element does not exist at the given location', () => {
    const result = applyMoveEdit({
      source: sfcThreeButtons,
      sourceLine: 99,
      sourceColumn: 5,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: 0,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/No element found/i)
    }
  })

  it('refuses when destination parent does not exist', () => {
    const result = applyMoveEdit({
      source: sfcThreeButtons,
      sourceLine: 3,
      sourceColumn: 5,
      destParentLine: 99,
      destParentColumn: 5,
      destIndex: 0,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/No destination parent/i)
    }
  })

  it('refuses moving an element into itself', () => {
    // The <div class="row"> wrapper at line 2, col 3 — try to "move" it
    // into itself.
    const result = applyMoveEdit({
      source: sfcThreeButtons,
      sourceLine: 2,
      sourceColumn: 3,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: 0,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/cannot be its own destination parent/i)
    }
  })

  it('refuses moving an ancestor into its own descendant (cycle)', () => {
    const sfc = `<template>
  <div class="outer">
    <div class="inner"></div>
  </div>
</template>
`
    // Try to move .outer (line 2, col 3) INTO .inner (line 3, col 5).
    const result = applyMoveEdit({
      source: sfc,
      sourceLine: 2,
      sourceColumn: 3,
      destParentLine: 3,
      destParentColumn: 5,
      destIndex: 0,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/descendant/i)
    }
  })

  it('refuses moving into a self-closing destination with a designer-readable reason', () => {
    // <input /> can't host children. The applicator must refuse before it
    // bottoms out at the opaque "Could not compute destination insertion
    // offset" message, since this refusal surfaces directly in the
    // pending-changes-panel save-status banner.
    const sfc = `<template>
  <div>
    <span>tag</span>
    <input class="enabled" />
  </div>
</template>
`
    const result = applyMoveEdit({
      source: sfc,
      sourceLine: 3,
      sourceColumn: 5,
      destParentLine: 4,
      destParentColumn: 5,
      destIndex: 0,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/self-closing/i)
      expect(result.reason).toMatch(/input/)
    }
  })

  it('refuses when the SFC has no template block', () => {
    const result = applyMoveEdit({
      source: '<script setup>const x = 1</script>',
      sourceLine: 1,
      sourceColumn: 1,
      destParentLine: 1,
      destParentColumn: 1,
      destIndex: 0,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/no <template>/i)
    }
  })

  it('refuses moves that orphan a sibling v-else (would fail Vite compile)', () => {
    // Repro of the AIGatewayModelCreate.vue bug: a <div v-for> child lives
    // inside a <template v-if> with a paired <template v-else> sibling.
    // Moving the v-for OUT of the v-if into the grandparent slots it
    // between the v-if and v-else, leaving the v-else with no preceding
    // v-if/v-else-if sibling. Markup parses fine but Vue codegen explodes.
    const sfc = `<template>
  <section>
    <template v-if="multi">
      <div class="card" v-for="x in xs" :key="x">{{ x }}</div>
    </template>
    <template v-else>
      <div class="single">single</div>
    </template>
  </section>
</template>
`
    // Move the <div class="card"> (line 4, col 7) out of its v-if parent
    // and into <section> (line 2, col 3) at index 1 (between the two
    // template branches).
    const result = applyMoveEdit({
      source: sfc,
      sourceLine: 4,
      sourceColumn: 7,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: 1,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // Since WS2 this refuses UPSTREAM at the template-wrapper closure
      // guard (clearer reason, no reliance on the compile backstop): the
      // move crosses out of the <template v-if> wrapper. The post-splice
      // compile check remains as defense-in-depth for shapes the guard
      // doesn't model.
      expect(result.reason).toMatch(/compile failed|v-else|out of its enclosing <template v-if/i)
    }
  })
})

describe('applyMoveEdit — preserves surrounding source', () => {
  it('keeps the script block and other markup untouched', () => {
    const sfc = `<template>
  <div>
    <KButton>A</KButton>
    <KButton>B</KButton>
  </div>
</template>

<script setup lang="ts">
const greeting = "hello"
</script>
`
    const result = applyMoveEdit({
      source: sfc,
      sourceLine: 3,
      sourceColumn: 5,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: 1,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain('<script setup lang="ts">')
    expect(result.source).toContain('const greeting = "hello"')
    expect(result.source).toContain('</template>')
  })
})

// WS2 semantic-closure guard (tasks/edit-pipeline-rearchitecture.md):
// moves crossing OUT of an invisible <template v-if/v-else/v-for> wrapper
// refuse instead of silently dropping the condition/iteration. This is the
// regression suite for the reproduced 2026-07-24 bug: a v-if-gated element
// moved to the end of its section landed ok:true and rendered
// unconditionally.
describe('applyMoveEdit — template-wrapper closure guard (WS2)', () => {
  const sfcConditional = `<template>
  <section>
    <template v-if="multi">
      <div class="card" v-for="x in xs" :key="x">{{ x }}</div>
    </template>
    <template v-else>
      <div class="single">single</div>
    </template>
    <footer>end</footer>
  </section>
</template>
`

  it('refuses moving an element OUT of its <template v-if> wrapper (reproduced bug)', () => {
    // Move the .card div to append at the end of <section> — previously
    // ok:true with the v-if silently dropped.
    const result = applyMoveEdit({
      source: sfcConditional,
      sourceLine: 4,
      sourceColumn: 7,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: -1,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('v-if="multi"')
    expect(result.reason).toMatch(/renders no visible element/i)
  })

  it('refuses moving an element out of a <template v-else> branch', () => {
    const result = applyMoveEdit({
      source: sfcConditional,
      sourceLine: 7,
      sourceColumn: 7,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: -1,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('v-else')
  })

  it('refuses moving the sole child out of a <template v-for> wrapper', () => {
    const sfc = `<template>
  <ul>
    <template v-for="item in items" :key="item.id">
      <li class="row">{{ item.name }}</li>
    </template>
    <li class="static">static</li>
  </ul>
</template>
`
    const result = applyMoveEdit({
      source: sfc,
      sourceLine: 4,
      sourceColumn: 7,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: -1,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('v-for')
    expect(result.reason).toMatch(/stop repeating/i)
  })

  it('refuses dropping immediately BEFORE the wrapper (boundary — codex P1)', () => {
    // destIndex 0 in <section> computes an insertion offset EQUAL to the
    // <template v-if> wrapper's own start byte — the element would land
    // just outside the wrapper, silently unconditional. The lower bound
    // must be exclusive.
    const result = applyMoveEdit({
      source: sfcConditional,
      sourceLine: 4,
      sourceColumn: 7,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: 0,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('v-if="multi"')
  })

  it('allows reordering WITHIN the same <template v-if> wrapper', () => {
    const sfc = `<template>
  <section>
    <template v-if="show">
      <div class="a">A</div>
      <div class="b">B</div>
    </template>
  </section>
</template>
`
    // Move .a after .b — both stay inside the wrapper.
    const result = applyMoveEdit({
      source: sfc,
      sourceLine: 4,
      sourceColumn: 7,
      destParentLine: 3,
      destParentColumn: 5,
      destIndex: -1,
    })
    // Dest parent is the <template v-if> wrapper itself — it isn't stamped
    // (source-tag skips template tags), but the applicator can still be
    // handed it by index-based flows; if resolution refuses that's also
    // acceptable. What must NOT happen is a cross-wrapper silent move.
    if (result.ok) {
      expect(result.source.indexOf('class="b"')).toBeLessThan(result.source.indexOf('class="a"'))
    }
  })

  it('allows moving an element whose v-if is on the element ITSELF (directive travels)', () => {
    const sfc = `<template>
  <section>
    <div class="gated" v-if="show">gated</div>
    <footer>end</footer>
  </section>
</template>
`
    const result = applyMoveEdit({
      source: sfc,
      sourceLine: 3,
      sourceColumn: 5,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: -1,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The directive traveled with the element.
    expect(result.source).toContain('<div class="gated" v-if="show">gated</div>')
  })

  it('allows moving OUT of a visible conditional container (<div v-if>)', () => {
    const sfc = `<template>
  <section>
    <div class="panel" v-if="open">
      <span class="chip">chip</span>
    </div>
    <footer>end</footer>
  </section>
</template>
`
    const result = applyMoveEdit({
      source: sfc,
      sourceLine: 4,
      sourceColumn: 7,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: -1,
    })
    // The container is visible in the DOM — the user can see they're
    // dragging out of it. Normal reparent, allowed.
    expect(result.ok).toBe(true)
  })
})

// WS2 follow-up: conditional-GROUP moves (moveGroup: true) — the whole
// v-if/v-else-if/v-else chain relocates as one unit, pairing intact.
describe('applyMoveEdit — conditional group move (moveGroup)', () => {
  const sfc = `<template>
  <section>
    <header>top</header>
    <template v-if="multi">
      <div class="cards">many</div>
    </template>
    <template v-else-if="one">
      <div class="card">one</div>
    </template>
    <template v-else>
      <div class="empty">none</div>
    </template>
    <footer>end</footer>
  </section>
</template>
`

  it('moves the whole group (all three branches) and stays compilable', () => {
    // Head <template v-if> at line 4, col 5 → append at end of <section>.
    const result = applyMoveEdit({
      source: sfc,
      sourceLine: 4,
      sourceColumn: 5,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: -1,
      moveGroup: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const out = result.source
    // All three branches present exactly once, in order, after <footer>.
    expect(out.indexOf('v-if="multi"')).toBeGreaterThan(out.indexOf('<footer>'))
    expect(out.indexOf('v-else-if="one"')).toBeGreaterThan(out.indexOf('v-if="multi"'))
    expect(out.lastIndexOf('v-else>')).toBeGreaterThan(out.indexOf('v-else-if="one"'))
    expect(out.match(/v-if="multi"/g)).toHaveLength(1)
  })

  it('refuses when targeting a v-else branch instead of the head', () => {
    const result = applyMoveEdit({
      source: sfc,
      sourceLine: 10,
      sourceColumn: 5,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: -1,
      moveGroup: true,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/v-if HEAD/)
  })

  it('refuses when the source is not a template wrapper', () => {
    const result = applyMoveEdit({
      source: sfc,
      sourceLine: 3,
      sourceColumn: 5,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: -1,
      moveGroup: true,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/template v-if/)
  })

  it('same-parent reorder accounts for the group width (index math)', () => {
    // Move the group to index 0 (before <header>): three branches removed
    // from later positions must not skew the insertion point.
    const result = applyMoveEdit({
      source: sfc,
      sourceLine: 4,
      sourceColumn: 5,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: 0,
      moveGroup: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const out = result.source
    expect(out.indexOf('v-if="multi"')).toBeLessThan(out.indexOf('<header>'))
    expect(out.indexOf('v-else>')).toBeLessThan(out.indexOf('<header>'))
    expect(out.indexOf('<footer>')).toBeGreaterThan(out.indexOf('<header>'))
  })

  it('moves a <template v-for> group (single wrapper) as a unit', () => {
    const forSfc = `<template>
  <ul>
    <template v-for="x in xs" :key="x">
      <li class="row">{{ x }}</li>
    </template>
    <li class="static">static</li>
  </ul>
</template>
`
    const result = applyMoveEdit({
      source: forSfc,
      sourceLine: 3,
      sourceColumn: 5,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: -1,
      moveGroup: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source.indexOf('v-for="x in xs"')).toBeGreaterThan(
      result.source.indexOf('class="static"'),
    )
  })
})

describe("applyMoveEdit — whitespace and formatting", () => {
  it("keeps reordered same-line siblings separated (a RENDERED space)", () => {
    // Vue's default `whitespace: 'condense'` collapses a same-line run to one
    // space rather than dropping it, so gluing `</a><b>` removes a space the
    // page actually shows. Reproduced from vue3-vite's Documentation.vue.
    const source = `<template>\n  <p>text <a>one</a> and <b>two</b> end</p>\n</template>\n`
    const result = applyMoveEdit({
      source,
      sourceLine: 2,
      sourceColumn: 11,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: 1,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).not.toContain("</b><a>")
    expect(result.source).toContain("<b>two</b> <a>one</a>")
  })

  it("leaves no whitespace-only orphan line at the vacated position", () => {
    const source = `<template>\n  <div>\n    <a>one</a>\n    <b>two</b>\n  </div>\n</template>\n`
    const result = applyMoveEdit({
      source,
      sourceLine: 3,
      sourceColumn: 5,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: 1,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const orphans = result.source
      .split("\n")
      .filter((l) => l.length > 0 && l.trim().length === 0)
    expect(orphans).toEqual([])
    expect(result.source).toBe(
      `<template>\n  <div>\n    <b>two</b>\n    <a>one</a>\n  </div>\n</template>\n`,
    )
  })

  it("adopts the destination's indentation when moving across parents", () => {
    const source =
      `<template>\n  <div>\n    <section>\n      <a>moved</a>\n    </section>\n` +
      `    <aside>\n      <b>here</b>\n    </aside>\n  </div>\n</template>\n`
    // <a> at line 4 col 7 → into <aside> (line 6 col 5) at the tail.
    const result = applyMoveEdit({
      source,
      sourceLine: 4,
      sourceColumn: 7,
      destParentLine: 6,
      destParentColumn: 5,
      destIndex: -1,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toBe(
      `<template>\n  <div>\n    <section>\n    </section>\n` +
        `    <aside>\n      <b>here</b>\n      <a>moved</a>\n    </aside>\n  </div>\n</template>\n`,
    )
  })

  it("reorders to the head without gluing onto the parent's open tag", () => {
    const source = `<template>\n  <div>\n    <a>one</a>\n    <b>two</b>\n  </div>\n</template>\n`
    const result = applyMoveEdit({
      source,
      sourceLine: 4,
      sourceColumn: 5,
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: 0,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toBe(
      `<template>\n  <div>\n    <b>two</b>\n    <a>one</a>\n  </div>\n</template>\n`,
    )
  })

  it("indents into a previously empty destination parent", () => {
    const source =
      `<template>\n  <div>\n    <a>moved</a>\n    <section></section>\n  </div>\n</template>\n`
    const result = applyMoveEdit({
      source,
      sourceLine: 3,
      sourceColumn: 5,
      destParentLine: 4,
      destParentColumn: 5,
      destIndex: 0,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toBe(
      `<template>\n  <div>\n    <section>\n      <a>moved</a></section>\n  </div>\n</template>\n`,
    )
  })
})
