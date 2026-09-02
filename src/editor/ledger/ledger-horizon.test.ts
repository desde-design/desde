import { describe, expect, it } from 'vitest'

import { ledgerHorizonStart } from './ledger-horizon'
import { resolveEditBranches } from './rename-aliases'
import type { LedgerEntry } from './entry'

function edit(id: string, branch?: string): LedgerEntry {
  return {
    type: 'edit',
    id,
    at: '2026-08-18T10:00:00.000Z',
    kind: 'prop',
    lane: 'direct',
    files: [`${id}.vue`],
    afterHashes: {},
    ...(branch !== undefined ? { branch } : {}),
  }
}

// `branch` defaults to unset (matching most of this file's existing
// currentBranch === undefined cases) — pass it explicitly whenever a test
// scopes the horizon to a real branch name, matching what
// `recordCommitInLedger` (`http-server.ts`) actually writes: `branch` is
// set unconditionally, independent of whether `committedIds` is empty.
function commit(committedIds: string[], branch?: string): LedgerEntry {
  return {
    type: 'commit',
    at: '2026-08-18T10:01:00.000Z',
    ...(branch !== undefined ? { branch } : {}),
    sha: `sha-${committedIds.join('-')}`,
    message: 'wip',
    committedIds,
  }
}

function reconcile(committedIds: string[]): LedgerEntry {
  return { type: 'reconcile', at: '2026-08-18T10:02:00.000Z', committedIds }
}

describe('ledgerHorizonStart', () => {
  it('returns 0 (no cutoff) with zero commit lines', () => {
    const entries = [edit('e1'), edit('e2')]
    const resolved = resolveEditBranches(entries)
    expect(ledgerHorizonStart(entries, resolved, undefined)).toBe(0)
  })

  it('returns 0 (no cutoff) with exactly one commit line — there is no "second-most-recent" yet', () => {
    const entries = [edit('e1'), commit(['e1']), edit('e2')]
    const resolved = resolveEditBranches(entries)
    expect(ledgerHorizonStart(entries, resolved, undefined)).toBe(0)
  })

  it('cuts right after the second-most-recent of exactly two commit lines', () => {
    const entries = [
      edit('e1'), // 0
      commit(['e1']), // 1  <- 2nd-most-recent of the two
      edit('e2'), // 2
      commit(['e2']), // 3  <- most recent
      edit('e3'), // 4
    ]
    const resolved = resolveEditBranches(entries)
    // Right after index 1.
    expect(ledgerHorizonStart(entries, resolved, undefined)).toBe(2)
  })

  it('cuts right after the second-most-recent of THREE commit lines (the middle one), not the first', () => {
    const entries = [
      edit('old1'), // 0
      commit(['old1']), // 1  <- 1st (oldest)
      edit('mid1'), // 2
      commit(['mid1']), // 3  <- 2nd-most-recent
      edit('new1'), // 4
      commit(['new1']), // 5  <- most recent
      edit('pending1'), // 6
    ]
    const resolved = resolveEditBranches(entries)
    expect(ledgerHorizonStart(entries, resolved, undefined)).toBe(4)
  })

  it('treats a reconcile line as a commit line for horizon purposes', () => {
    const entries = [
      edit('old1'), // 0
      reconcile(['old1']), // 1  <- of these two, this IS the 2nd-most-recent
      edit('mid1'), // 2
      reconcile(['mid1']), // 3  <- most recent
      edit('new1'), // 4
    ]
    const resolved = resolveEditBranches(entries)
    expect(ledgerHorizonStart(entries, resolved, undefined)).toBe(2)
  })

  it('mixes commit and reconcile lines in the same chronological count', () => {
    const entries = [
      edit('old1'), // 0
      commit(['old1']), // 1  <- 1st
      edit('mid1'), // 2
      reconcile(['mid1']), // 3  <- 2nd-most-recent
      edit('new1'), // 4
      commit(['new1']), // 5  <- most recent
    ]
    const resolved = resolveEditBranches(entries)
    expect(ledgerHorizonStart(entries, resolved, undefined)).toBe(4)
  })

  it('only counts a commit line as belonging to the CURRENT branch — a foreign branch\'s commits do not advance this branch\'s horizon', () => {
    const entries = [
      edit('main1', 'main'), // 0
      commit(['main1'], 'main'), // 1  <- main's only commit line
      edit('feature1', 'feature'), // 2
      commit(['feature1'], 'feature'), // 3  <- feature's commit, NOT main's
      edit('main2', 'main'), // 4
      commit(['main2'], 'main'), // 5  <- main's SECOND commit line
      edit('main3', 'main'), // 6
    ]
    const resolved = resolveEditBranches(entries)
    // On 'main', only indices 1 and 5 are main's own commit lines — index 3
    // (feature's) must not count as the "second-most-recent" in between.
    expect(ledgerHorizonStart(entries, resolved, 'main')).toBe(2)
  })

  // F1 (codex review round 8, 2026-08-20): a commit whose ENTIRE diff is
  // git-only changes (nothing this product's own ledger had recorded as a
  // pending edit) is written with `committedIds: []` — see
  // `captureCommitCoverage` in `http-server.ts`. The buggy version of this
  // function scoped every commit line to a branch via
  // `committedIds.some(...)`, which is unconditionally `false` on an empty
  // array, so a line like this was silently skipped as a boundary no
  // matter which branch it actually landed on. Mirrors the THREE-commit-
  // line test above exactly, with the middle commit's `committedIds`
  // emptied out — proving the empty-array line still counts as its own
  // boundary as long as its `branch` matches.
  it('a commit whose entire diff is git-only changes (empty committedIds) still counts as a boundary', () => {
    const entries = [
      edit('old1', 'main'), // 0
      commit(['old1'], 'main'), // 1  <- 1st
      edit('mid1', 'main'), // 2
      commit([], 'main'), // 3  <- 2nd-most-recent; git-only commit, no ledger ids
      edit('new1', 'main'), // 4
      commit(['new1'], 'main'), // 5  <- most recent
      edit('pending1', 'main'), // 6
    ]
    const resolved = resolveEditBranches(entries)
    expect(ledgerHorizonStart(entries, resolved, 'main')).toBe(4)
  })

  // Same shape, but the git-only commit landed on a DIFFERENT branch —
  // proves the fix reads `branch` for scoping, not merely "any commit
  // line with an empty committedIds counts unconditionally."
  it('a git-only commit on a FOREIGN branch does not advance this branch\'s horizon', () => {
    const entries = [
      edit('main1', 'main'), // 0
      commit(['main1'], 'main'), // 1  <- main's only real boundary
      edit('feature1', 'feature'), // 2
      commit([], 'feature'), // 3  <- feature's git-only commit, NOT main's
      edit('main2', 'main'), // 4
      commit(['main2'], 'main'), // 5  <- main's SECOND commit line
    ]
    const resolved = resolveEditBranches(entries)
    expect(ledgerHorizonStart(entries, resolved, 'main')).toBe(2)
  })

  // Regression (found while implementing F5, codex review round 4,
  // 2026-08-20): a product `commit` line and a `reconcile` line for a
  // DIFFERENT, unrelated entry can land back to back in the SAME poll —
  // the commit action's own write, immediately followed by that same
  // read's reconcile pass self-healing something else — with no new
  // pending work between them. Counting them as two separate generations
  // trimmed BOTH the just-committed entry and the reconciled one on the
  // very next read: exactly the "just-committed edit vanishes the moment
  // you commit it" failure this feature exists to prevent.
  it('collapses adjacent commit/reconcile lines with no edit between them into ONE boundary, not two', () => {
    const entries = [
      edit('e-external'), // 0
      edit('e-other'), // 1
      commit(['e-other']), // 2  <- a product commit for e-other
      reconcile(['e-external']), // 3  <- same poll's reconcile, e-external
    ]
    const resolved = resolveEditBranches(entries)
    // Only ONE distinct boundary (collapsed onto index 3) — fewer than
    // two, so nothing is trimmed yet. Neither e-external nor e-other
    // should disappear from the very next read after being committed.
    expect(ledgerHorizonStart(entries, resolved, undefined)).toBe(0)
  })

  it('does NOT collapse commit/reconcile lines that have real pending work between them', () => {
    const entries = [
      edit('e1'), // 0
      commit(['e1']), // 1
      edit('e2'), // 2  <- genuine new pending work in between
      reconcile(['e2']), // 3
      edit('e3'), // 4
    ]
    const resolved = resolveEditBranches(entries)
    // Two DISTINCT boundaries (1 and 3) — horizon starts right after the
    // first.
    expect(ledgerHorizonStart(entries, resolved, undefined)).toBe(2)
  })
})
