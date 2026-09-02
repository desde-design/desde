import { describe, expect, it } from 'vitest'
import { resolveCommitState } from './commit-state'
import type { LedgerEntry } from './entry'

function edit(id: string, files: string[] = ['a.vue'], branch?: string): LedgerEntry {
  return {
    type: 'edit',
    id,
    at: '2026-08-18T10:00:00.000Z',
    branch,
    kind: 'prop',
    lane: 'direct',
    files,
    afterHashes: {},
  }
}

function commit(sha: string, committedIds: string[], branch?: string): LedgerEntry {
  return { type: 'commit', at: '2026-08-18T10:01:00.000Z', branch, sha, message: 'wip', committedIds }
}

function reconcile(ids: string[]): LedgerEntry {
  return { type: 'reconcile', at: '2026-08-18T10:02:00.000Z', committedIds: ids }
}

function rename(from: string, to: string): LedgerEntry {
  return { type: 'rename', at: '2026-08-18T10:00:30.000Z', from, to }
}

describe('resolveCommitState', () => {
  it('leaves an edit with no commit after it uncommitted', () => {
    const state = resolveCommitState([edit('e1')])
    expect(state.get('e1')).toEqual({ committed: false })
  })

  it('marks exactly the ids named in committedIds', () => {
    const state = resolveCommitState([edit('e1'), edit('e2'), commit('abc123', ['e1', 'e2'])])
    expect(state.get('e1')).toEqual({ committed: true, sha: 'abc123' })
    expect(state.get('e2')).toEqual({ committed: true, sha: 'abc123' })
  })

  // P1 (round-7 whole-branch review finding, 2026-08-19): the reducer no
  // longer sweeps "everyone pending" and carves exceptions out of it — a
  // commit line only ever covers what its own `committedIds` names. An
  // id NOT in that list stays exactly as it was, whether it's a
  // still-pending edit on the same branch or one recorded on another
  // branch entirely — the write site resolved branch membership once,
  // before this line was even written, and the reducer trusts that
  // resolution completely.
  it('does not touch a pending edit the commit line does not name, even one on the same branch', () => {
    const state = resolveCommitState([
      edit('e1', ['a.vue']),
      edit('e2', ['b.vue']),
      commit('abc123', ['e1']),
    ])
    expect(state.get('e1')).toEqual({ committed: true, sha: 'abc123' })
    expect(state.get('e2')).toEqual({ committed: false })
  })

  it('does not retroactively commit an edit made after the commit line, even if a later line happened to name its id', () => {
    const state = resolveCommitState([edit('e1'), commit('abc123', ['e1']), edit('e2')])
    expect(state.get('e1')).toEqual({ committed: true, sha: 'abc123' })
    expect(state.get('e2')).toEqual({ committed: false })
  })

  it('ignores a commit line naming an unknown id — it must not invent an entry', () => {
    const state = resolveCommitState([edit('e1'), commit('abc123', ['e1', 'ghost'])])
    expect(state.get('e1')).toEqual({ committed: true, sha: 'abc123' })
    expect(state.has('ghost')).toBe(false)
  })

  it('marks only the named ids on a reconcile line', () => {
    const state = resolveCommitState([edit('e1'), edit('e2'), reconcile(['e1'])])
    expect(state.get('e1')).toEqual({ committed: true })
    expect(state.get('e2')).toEqual({ committed: false })
  })

  it('leaves a reconciled edit committed when a later commit lands', () => {
    const state = resolveCommitState([
      edit('e1'),
      edit('e2'),
      reconcile(['e1']),
      commit('abc123', ['e2']),
    ])
    expect(state.get('e1')).toEqual({ committed: true })
    expect(state.get('e2')).toEqual({ committed: true, sha: 'abc123' })
  })

  it('ignores a reconcile naming an unknown id', () => {
    const state = resolveCommitState([edit('e1'), reconcile(['ghost'])])
    expect(state.get('e1')).toEqual({ committed: false })
    expect(state.has('ghost')).toBe(false)
  })

  // The write site resolves branch membership BEFORE writing
  // `committedIds` (`captureCommitCoverage`, http-server.ts) — this
  // reducer no longer re-derives it, so there is nothing left here to
  // test about branch scoping or rename retargeting specifically; that
  // coverage now lives on the write-site tests
  // (`http-server-ledger-commit.integration.test.ts`,
  // `http-server-ledger-cross-process-commit.integration.test.ts`). This
  // test only proves the reducer stays branch-agnostic: two edits on
  // different branches, only one of them named, and a `rename` line in
  // the log that the reducer must not act on at all.
  it('is branch-agnostic — trusts committedIds and ignores unrelated rename lines', () => {
    const state = resolveCommitState([
      edit('e1', ['a.vue'], 'branch-a'),
      edit('e2', ['b.vue'], 'branch-b'),
      rename('branch-a', 'branch-c'),
      commit('abc123', ['e2'], 'branch-b'),
    ])
    expect(state.get('e1')).toEqual({ committed: false })
    expect(state.get('e2')).toEqual({ committed: true, sha: 'abc123' })
  })

  // F2 (round-5 whole-branch review finding, 2026-08-19): a ledger poll
  // can read pending entries BEFORE a product commit lands, then append
  // its now-stale `reconcile` line AFTER the commit marker the concurrent
  // commit wrote. Replayed in log order, the commit line correctly
  // attaches the real `sha` first — then, before this fix, the reconcile
  // line unconditionally overwrote it with `{ committed: true }`,
  // permanently dropping the sha.
  it('does not let a reconcile line landing AFTER a commit line overwrite the sha the commit already attached', () => {
    const state = resolveCommitState([edit('e1'), commit('abc123', ['e1']), reconcile(['e1'])])
    expect(state.get('e1')).toEqual({ committed: true, sha: 'abc123' })
  })

  // Unaffected control case, restated here for the F2 fix specifically:
  // reconcile-before-commit (the ordinary order) still works exactly as
  // the pre-existing 'leaves a reconciled edit committed when a later
  // commit lands' test above already proves — reconcile has no sha to
  // protect yet at the point it runs, so there is nothing for the F2
  // guard to block.
  it('a reconcile line that runs BEFORE any commit line is unaffected by the sha-precedence guard', () => {
    const state = resolveCommitState([edit('e1'), reconcile(['e1'])])
    expect(state.get('e1')).toEqual({ committed: true })
  })
})
