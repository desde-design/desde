import { describe, expect, it } from 'vitest'
import { classifyMutationScope } from './mutation-scope'

/**
 * The rule is small; what it protects is not. Each case below is a shape that
 * really occurs, and the two that must stay `definition` are the ones where
 * offering a per-item edit would move more than the item.
 */
describe('classifyMutationScope', () => {
  it('is definition for a single candidate — nothing to disambiguate', () => {
    expect(classifyMutationScope(['src/App.tsx:21:6'])).toBe('definition')
    expect(classifyMutationScope([])).toBe('definition')
  })

  it('is callsite when every candidate has its own distinct callsite', () => {
    // The measured shadcn shape: two <Button>s sharing button.tsx's stamp,
    // written at two separate lines of App.tsx.
    expect(
      classifyMutationScope(['src/App.tsx:21:6', 'src/App.tsx:22:6']),
    ).toBe('callsite')
  })

  it('is definition when candidates SHARE a callsite — a real loop', () => {
    // `<Row v-for>` / `{items.map(...)}`: one authored line, N renderings.
    // Editing "just this row" at that line would change every row.
    expect(
      classifyMutationScope([
        'src/App.tsx:30:8',
        'src/App.tsx:30:8',
        'src/App.tsx:30:8',
      ]),
    ).toBe('definition')
  })

  it('is definition for the MIXED shape — a loop plus a standalone usage', () => {
    // The case that rules out "any two differ": 3 loop rows at one callsite
    // plus 1 standalone. A per-item option would be honest for the standalone
    // and a silent all-rows edit for the other three, so it must not be
    // offered at all.
    expect(
      classifyMutationScope([
        'src/App.tsx:30:8',
        'src/App.tsx:30:8',
        'src/App.tsx:30:8',
        'src/App.tsx:44:4',
      ]),
    ).toBe('definition')
  })

  it('is definition when ANY candidate has an unknown callsite', () => {
    // Cannot prove the 1:1 mapping, so it must not be claimed.
    expect(
      classifyMutationScope(['src/App.tsx:21:6', null]),
    ).toBe('definition')
    expect(
      classifyMutationScope(['src/App.tsx:21:6', '']),
    ).toBe('definition')
  })

  it('does not depend on candidate order', () => {
    const distinct = ['a.tsx:1:0', 'b.tsx:2:0', 'c.tsx:3:0']
    expect(classifyMutationScope(distinct)).toBe('callsite')
    expect(classifyMutationScope([...distinct].reverse())).toBe('callsite')
    const shared = ['a.tsx:1:0', 'b.tsx:2:0', 'a.tsx:1:0']
    expect(classifyMutationScope(shared)).toBe('definition')
    expect(classifyMutationScope([...shared].reverse())).toBe('definition')
  })
})
