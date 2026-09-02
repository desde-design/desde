/**
 * Locks in the canonical-selector contract shared by the bridge
 * (`build-attribution-context.ts`) and the Phase 4 probe driver
 * (`probe-driver.ts`). These cases mirror the selector assertions in
 * `src/bridge/build-attribution-context.test.ts` — if this file's behavior
 * ever changes, that bridge test (real click-time extraction) must be
 * re-verified against the new shape too, since both now share this exact
 * function.
 */
import { describe, it, expect } from 'vitest'
import { canonicalSelectorOf, sortedClasses } from './canonical-selector'

function fakeEl(tagName: string, classes: string[] = []): { tagName: string; classList: { length: number; item(i: number): string | null } } {
  return {
    tagName,
    classList: {
      length: classes.length,
      item: (i: number) => classes[i] ?? null,
    },
  }
}

describe('sortedClasses', () => {
  it('sorts classList tokens alphabetically', () => {
    expect(sortedClasses(fakeEl('div', ['kappa', 'alpha', 'beta']))).toEqual([
      'alpha',
      'beta',
      'kappa',
    ])
  })

  it('returns an empty array for a class-less element', () => {
    expect(sortedClasses(fakeEl('div'))).toEqual([])
  })
})

describe('canonicalSelectorOf', () => {
  it('composes tag + sorted dotted classes', () => {
    expect(canonicalSelectorOf(fakeEl('div', ['kappa', 'alpha', 'beta']))).toBe(
      'div.alpha.beta.kappa',
    )
  })

  it('lowercases the tag name', () => {
    expect(canonicalSelectorOf(fakeEl('SECTION', ['Foo']))).toBe('section.Foo')
  })

  it('falls back to a bare tag when there are no classes', () => {
    expect(canonicalSelectorOf(fakeEl('span'))).toBe('span')
  })
})
