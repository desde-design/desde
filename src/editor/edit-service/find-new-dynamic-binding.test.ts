/**
 * The llm-patch LLM lane's dynamic-binding post-condition.
 *
 * From the 2026-09-17 codex review, P1: the deterministic applicator escapes the
 * designer's text mechanically (`escapeJsxText`), while the LLM lane had only a
 * prompt rule plus a syntax parse. A parse accepts `Add {n}` as a live
 * expression container — valid JSX, wrong meaning. These assert the structural
 * check that closes the ADDITION half of that, in both dialects.
 */

import { describe, expect, it } from 'vitest'
import { findNewDynamicBinding } from './find-new-dynamic-binding'

describe('findNewDynamicBinding — React', () => {
  const file = 'src/components/AppHeader.tsx'

  it('refuses literal text emitted as a live expression container', () => {
    const result = findNewDynamicBinding({
      file,
      original: 'export const A = () => <span>Add (3)</span>;',
      // The designer typed the characters "Add {n}". Emitting them raw binds
      // to a variable instead of rendering the text.
      patched: 'export const A = () => <span>Add {n}</span>;',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/1 new dynamic binding/)
      expect(result.reason).toMatch(/0 → 1/)
    }
  })

  it('allows the same text once it is properly escaped', () => {
    expect(
      findNewDynamicBinding({
        file,
        original: 'export const A = () => <span>Add (3)</span>;',
        patched: 'export const A = () => <span>Add &#123;n&#125;</span>;',
      }).ok,
    ).toBe(true)
  })

  it('refuses a static attribute rewritten as a binding', () => {
    const result = findNewDynamicBinding({
      file,
      original: 'export const A = () => <span title="x" />;',
      patched: 'export const A = () => <span title={x} />;',
    })
    expect(result.ok).toBe(false)
  })

  it('allows editing a literal INSIDE an existing expression — the documented case', () => {
    expect(
      findNewDynamicBinding({
        file,
        original: 'export const A = () => <span>Add {n > 0 ? `(${n})` : ""}</span>;',
        patched: 'export const A = () => <span>Add {n > 0 ? `${n}` : ""}</span>;',
      }).ok,
    ).toBe(true)
  })

  it('allows expanding a self-closing call-site and adding a static attribute', () => {
    expect(
      findNewDynamicBinding({
        file,
        original: 'export const A = () => <button className="b" />;',
        patched: 'export const A = () => <button className="b" title="Tip">Save</button>;',
      }).ok,
    ).toBe(true)
  })

  it('allows a patch that removes a binding', () => {
    expect(
      findNewDynamicBinding({
        file,
        original: 'export const A = () => <span>{label}</span>;',
        patched: 'export const A = () => <span>Save</span>;',
      }).ok,
    ).toBe(true)
  })
})

describe('findNewDynamicBinding — Vue', () => {
  const file = 'src/components/Card.vue'

  it('refuses literal text emitted as a live interpolation', () => {
    const result = findNewDynamicBinding({
      file,
      original: '<template><span>Add (3)</span></template>',
      patched: '<template><span>Add {{ n }}</span></template>',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/0 → 1/)
  })

  it('refuses a static attribute rewritten as a directive binding', () => {
    // The React side catches `title={x}` because it is an expression node; Vue's
    // equivalent is a DIRECTIVE, which is why directives are counted too.
    const result = findNewDynamicBinding({
      file,
      original: '<template><span title="x" /></template>',
      patched: '<template><span :title="x" /></template>',
    })
    expect(result.ok).toBe(false)
  })

  it('allows editing a literal INSIDE an existing interpolation', () => {
    expect(
      findNewDynamicBinding({
        file,
        original: "<template><span>Add {{ n > 0 ? '(' + n + ')' : '' }}</span></template>",
        patched: "<template><span>Add {{ n > 0 ? '' + n + '' : '' }}</span></template>",
      }).ok,
    ).toBe(true)
  })

  it('leaves an existing directive alone', () => {
    expect(
      findNewDynamicBinding({
        file,
        original: '<template><span :title="x">Old</span></template>',
        patched: '<template><span :title="x">New</span></template>',
      }).ok,
    ).toBe(true)
  })
})

describe('findNewDynamicBinding — fails open', () => {
  it('passes a file type it cannot classify', () => {
    expect(
      findNewDynamicBinding({ file: 'src/styles.scss', original: 'a', patched: 'b {} {}' }).ok,
    ).toBe(true)
  })

  it('passes when a source will not parse — the strict gate owns that verdict', () => {
    expect(
      findNewDynamicBinding({
        file: 'src/A.vue',
        original: 'not an sfc at all',
        patched: '<template><span>{{ n }}</span></template>',
      }).ok,
    ).toBe(true)
  })
})
