import { describe, expect, it } from 'vitest'
import { editBelongsToBranch, isOrphanedBranch, resolveEditBranches } from './rename-aliases'
import type { LedgerEntry } from './entry'

function editEntry(id: string, branch: string | undefined): LedgerEntry {
  return {
    type: 'edit',
    id,
    at: '2026-08-18T10:00:00.000Z',
    branch,
    kind: 'prop',
    lane: 'direct',
    files: ['a.vue'],
    afterHashes: {},
  }
}

function rename(from: string, to: string): LedgerEntry {
  return { type: 'rename', at: '2026-08-18T10:00:15.000Z', from, to }
}

describe('resolveEditBranches', () => {
  it('resolves an edit with no rename activity to its own recorded branch', () => {
    const resolved = resolveEditBranches([editEntry('e1', 'main')])
    expect(resolved.get('e1')).toBe('main')
  })

  it('carries an edit forward through a rename recorded after it', () => {
    const resolved = resolveEditBranches([editEntry('e1', 'feature'), rename('feature', 'feature-v2')])
    expect(resolved.get('e1')).toBe('feature-v2')
  })

  it('does not carry an edit through a rename recorded BEFORE it', () => {
    // The rename happened first; the edit below is on a DIFFERENT branch
    // that only starts existing (in the log) after the rename — most
    // naturally read as "feature" was freed up and reused.
    const resolved = resolveEditBranches([rename('feature', 'feature-v2'), editEntry('e1', 'feature')])
    expect(resolved.get('e1')).toBe('feature')
  })

  it('chains a multi-step rename (A -> B -> C)', () => {
    const resolved = resolveEditBranches([
      editEntry('e1', 'a'),
      rename('a', 'b'),
      rename('b', 'c'),
    ])
    expect(resolved.get('e1')).toBe('c')
  })

  it('leaves an edit with no recorded branch as undefined, even across an unrelated rename', () => {
    const resolved = resolveEditBranches([editEntry('e1', undefined), rename('a', 'b')])
    expect(resolved.get('e1')).toBeUndefined()
  })

  it('ignores a rename that has nothing to do with the edit', () => {
    const resolved = resolveEditBranches([editEntry('e1', 'main'), rename('other-a', 'other-b')])
    expect(resolved.get('e1')).toBe('main')
  })

  // B1 (round-2 whole-branch review finding, 2026-08-19) — the flaw in the
  // original P2-3 fix. `resolveBranchAliases` built a global alias SET with
  // no notion of order: rename A -> B, then later create a brand-new
  // branch ALSO named A. The old function still had 'A' aliased to B
  // forever, so an edit recorded on the new, unrelated A resolved as
  // though it were on B. Resolving per-edit, forward from its own
  // position, keeps them distinct.
  it('does not fold a NEW branch reusing a freed-up name into the branch that was renamed away from it', () => {
    const entries = [
      editEntry('old-on-a', 'A'), // written while the original A existed
      rename('A', 'B'), // original A renamed away
      editEntry('new-on-a', 'A'), // a different, later branch reuses the name 'A'
    ]
    const resolved = resolveEditBranches(entries)
    expect(resolved.get('old-on-a')).toBe('B') // correctly carried through the rename
    expect(resolved.get('new-on-a')).toBe('A') // NOT folded into B
  })

  it('resolves a multi-step chain correctly even when an unrelated later rename reuses an intermediate name', () => {
    // A -> B -> C, and afterwards a brand new branch is created named 'B'
    // (the intermediate name, now free again). The new B's edit must
    // resolve to 'B' itself, not get pulled into C by the earlier A->B->C
    // chain.
    const entries = [
      editEntry('e1', 'A'),
      rename('A', 'B'),
      rename('B', 'C'),
      editEntry('e2', 'B'),
    ]
    const resolved = resolveEditBranches(entries)
    expect(resolved.get('e1')).toBe('C')
    expect(resolved.get('e2')).toBe('B')
  })
})

describe('editBelongsToBranch', () => {
  it('is always eligible when no branch was recorded', () => {
    expect(editBelongsToBranch(undefined, 'main')).toBe(true)
    expect(editBelongsToBranch(undefined, undefined)).toBe(true)
  })

  it('matches only the exact resolved branch', () => {
    expect(editBelongsToBranch('main', 'main')).toBe(true)
    expect(editBelongsToBranch('feature', 'main')).toBe(false)
  })

  it('excludes a branch-tagged edit when the current branch is unresolvable', () => {
    expect(editBelongsToBranch('main', undefined)).toBe(false)
  })
})

// F3 (round-5 whole-branch review finding, 2026-08-19): `git branch -m`
// typed in the user's own terminal renames a branch without appending a
// `rename` line, so an entry recorded under the old name resolves to a
// branch that no longer exists at all. `isOrphanedBranch` is what lets a
// DISPLAY-only caller (the ledger route) fail open for exactly that case
// instead of hiding the entry forever.
describe('isOrphanedBranch', () => {
  it('is not orphaned when no branch was recorded', () => {
    expect(isOrphanedBranch(undefined, new Set(['main']))).toBe(false)
  })

  it('is not orphaned when the resolved branch still exists', () => {
    expect(isOrphanedBranch('feature', new Set(['main', 'feature']))).toBe(false)
  })

  it('is orphaned when the resolved branch exists under no name at all', () => {
    // The externally-renamed case: 'feature' was `git branch -m`'d to
    // something else in the user's own terminal, so it simply isn't in
    // the current branch list — no rename line exists to explain why.
    expect(isOrphanedBranch('feature', new Set(['main', 'feature-v2']))).toBe(true)
  })

  it('is orphaned against an empty branch list', () => {
    expect(isOrphanedBranch('feature', new Set())).toBe(true)
  })

  // P2 (round-6 whole-branch review finding, 2026-08-19): `[]` (genuinely
  // no local branches) and a failed `git for-each-ref` used to collapse
  // into the same empty Set, so a transient git failure made every
  // resolved branch read as orphaned — bypassing the branch filter for
  // the whole poll, not just a genuinely renamed-outside-the-product row.
  // `null` is the caller's way of saying "couldn't ask"; this must NOT
  // fail open on it, unlike the genuinely-empty-list case right above.
  it('is not orphaned when the branch list could not be obtained', () => {
    expect(isOrphanedBranch('feature', null)).toBe(false)
  })
})
