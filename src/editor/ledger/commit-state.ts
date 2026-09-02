/**
 * Which edits are committed, derived from the ledger alone.
 *
 * Two markers put an edit into the committed state:
 *
 *  - a `commit` line, appended by every commit path the product owns
 *    (nav-bar Commit, Publish, the pre-merge auto-commit). It names the
 *    EXACT ids it covers in `committedIds` — see the interface doc on
 *    `LedgerCommitEntry` for why this is a closed list rather than a
 *    branch-wide sweep.
 *  - a `reconcile` line, which catches a commit made in the user's own
 *    terminal. It also names exact ids, for the same reason: a terminal
 *    commit may have covered only some files.
 *
 * Pure — the git observations that PRODUCE both kinds of line live
 * elsewhere (`edit-ledger.ts`'s `reconcileLedger`, `http-server.ts`'s
 * `captureCommitCoverage`); this only reads what was recorded. Neither
 * line needs branch matching or rename retargeting done HERE: both
 * producers already resolve "which pending ids does this cover" once, at
 * write time, using `resolveEditBranches`/`editBelongsToBranch`
 * (`rename-aliases.ts`) — the same helpers this reducer used to
 * reimplement per `commit` line, replayed on every read. See "P1" below
 * for why that reimplementation was the bug, not a redundant safety net.
 *
 * ## P1 — inclusion, not exclusion (round-7 whole-branch review finding, 2026-08-19)
 *
 * Earlier rounds had the `commit` case sweep every PENDING edit whose
 * `branch` field matched the commit line's own `branch` (with a rename-
 * tracking pass to follow a branch through a rename first), minus an
 * `excludedIds` list the write site attached for pending edits whose
 * files were all `.gitignore`d (F1, round 5). That is an EXCLUSION
 * design: everything pending-on-this-branch is covered by default,
 * unless named otherwise.
 *
 * The locks that make a sweep-by-default safe are process-local
 * (`session-lock.ts`'s `withTreeLock`), but the ledger is deliberately
 * lock-free JSONL so that a SECOND Editor process on the same repo can
 * append concurrently (see `edit-ledger.ts`'s module doc). Two processes,
 * one repo: process A runs Commit — `git add -A` stages exactly what's on
 * disk at that instant, then `git commit` lands. Process B appends a new
 * pending edit after A's `git add -A` already ran (so B's bytes are NOT
 * actually in A's commit) but before A gets around to appending its
 * `commit` marker. A's marker, computed from a POST-commit read of "what's
 * pending on this branch," cannot tell B's edit apart from one that
 * genuinely predates the commit — an exclusion list only carves out
 * `.gitignore`d ids, and B's edit isn't one of those. The sweep durably
 * marks B's still-dirty edit committed, under A's sha, and the log can
 * never take that back.
 *
 * The fix: the write site captures the pending-id list ONCE, from a
 * ledger read taken BEFORE `git add -A` runs (`captureCommitCoverage` in
 * `http-server.ts`), and the `commit` line carries that exact list as
 * `committedIds`. Nothing appended after that read — by this process or
 * any other — can be in it, because it is a value fixed at read time, not
 * a predicate this reducer re-evaluates against the ledger's CURRENT
 * shape. `case 'commit'` below does exactly what `case 'reconcile'`
 * already did: mark exactly the named ids, refusing to invent an entry
 * for one this reducer has never seen. No branch field to match, no
 * rename retargeting to replay — both were only ever in service of
 * reimplementing, at every read, a membership decision the write site can
 * make once, correctly, with the git access this reducer deliberately
 * doesn't have.
 *
 * **The `.gitignore` check is NOT subsumed by "read before staging."**
 * It is tempting to reason that once the id list is captured before `git
 * add -A`, everything in it must have been staged — but "pending, as of
 * this read" and "about to be staged" are different facts. A pending edit
 * whose files are ALL `.gitignore`d is observed as pending at read time
 * exactly like any other, and `git add -A` will still silently skip it a
 * moment later. `captureCommitCoverage` therefore still runs the same
 * `git status --ignored` check F1 introduced — it just folds the result
 * into what goes INTO `committedIds`, rather than shipping a second field
 * for this reducer to subtract back out. One list, closed at read time;
 * `LedgerCommitEntry.excludedIds` is deleted, not carried alongside it.
 *
 * **Under-counting is the safe failure mode, over-counting is not.** A
 * narrower race remains: a concurrent write landing between
 * `captureCommitCoverage`'s read and the `git add -A` moment gets staged
 * for real but isn't in `committedIds` (it wasn't pending yet when
 * observed... the reverse: it becomes pending after the read, so it's
 * simply absent from the list). That edit is UNDER-counted — it stays
 * "pending" on this marker — and self-heals on the next
 * `reconcileLedger` poll once its file reads clean, via a `reconcile`
 * line instead of this `commit` line's `sha`. Missing a real commit for
 * one extra poll costs nothing; the append-only log can never recover
 * from the opposite mistake.
 *
 * ## Reconcile precedence over a weaker state (F2, round-5 whole-branch review finding, 2026-08-19)
 *
 * A `reconcile` line used to overwrite ANY already-`committed` state
 * unconditionally — `state.set(id, { committed: true })`, dropping
 * whatever was there, including a `sha` a `commit` line had already
 * attached. That is safe when `reconcile` runs BEFORE the matching
 * `commit` line in the log (the ordinary case). It is NOT safe in the
 * other order: a ledger poll can read `entries` (for its own
 * `reconcileLedger` call) BEFORE a product commit lands, then append its
 * now-stale `reconcile` line AFTER the `commit` line the concurrent
 * commit wrote. Replayed in log order, the `commit` line correctly
 * attaches the real `sha` first — then the stale `reconcile` line
 * overwrites it with `{ committed: true }`, permanently losing the sha.
 *
 * **This one has history.** An earlier review parked exactly this
 * interleaving as a deferred-as-unreachable minor, reasoning that
 * `reconcileLedger` (the producer) skips any id it already sees as
 * committed, so a stale reconcile naming an already-committed id could
 * never happen. Round 4 (2026-08-19, the `.gitignore`-unprovable fix
 * documented in `edit-ledger.ts`) made the producer read the ledger
 * BEFORE the status snapshot instead of after — which is correct for the
 * race that fix targets, but it also means the producer's view of
 * "already committed" can now be a stale SNAPSHOT rather than a live
 * read. The guard that made this branch "unreachable" was a fact about
 * that one producer, not a law about the reducer's inputs, and it stopped
 * holding the moment the producer's read strategy changed. A guard
 * justified as "unreachable from the current producer" is only as
 * durable as that producer — this is the second time on this branch that
 * reasoning has expired, so the fix below makes the reducer's own
 * precedence explicit instead of relying on the producer to never send a
 * conflicting line.
 *
 * The fix: a state that already carries a `sha` (proof of a real product
 * commit) outranks one that doesn't (a `reconcile` line's best guess from
 * a clean working tree). `case 'reconcile'` below skips an id whose
 * current state already has a `sha`, rather than last-writer-wins.
 */

import type { LedgerEntry } from './entry'

export interface CommitState {
  committed: boolean
  /** Present only when a `commit` line named it. Reconciled edits have none. */
  sha?: string
}

export function resolveCommitState(
  entries: readonly LedgerEntry[],
): Map<string, CommitState> {
  const state = new Map<string, CommitState>()

  for (const entry of entries) {
    switch (entry.type) {
      case 'edit':
        state.set(entry.id, { committed: false })
        break
      case 'commit':
        // P1: `committedIds` is a closed list the write site captured
        // BEFORE `git add -A` ran — see the module doc above. Mark
        // exactly those ids, nothing else: no branch match, no rename
        // retargeting, both resolved once already at write time.
        for (const id of entry.committedIds) {
          // Only ids we have actually seen — a commit line naming an id
          // from a pruned or foreign log must not invent an entry (same
          // rule `reconcile` below already followed).
          if (!state.has(id)) continue
          state.set(id, { committed: true, sha: entry.sha })
        }
        break
      case 'reconcile':
        for (const id of entry.committedIds) {
          // Only ids we have actually seen — a reconcile naming an id from a
          // pruned or foreign log must not invent an entry.
          if (!state.has(id)) continue
          // F2: a state already carrying a `sha` is a real product commit —
          // it outranks a `reconcile` line's guess, which never carries one.
          // See the module doc above for the interleaving this guards
          // against (a stale reconcile landing AFTER the commit it should
          // have deferred to).
          if (state.get(id)?.sha !== undefined) continue
          state.set(id, { committed: true })
        }
        break
      case 'rename':
        // No longer read here (P1, round-7): branch identity for a
        // commit's coverage is resolved once, at write time, by
        // `captureCommitCoverage` (`http-server.ts`), using the same
        // `resolveEditBranches` this reducer used to reimplement per
        // read. `resolveEditBranches` itself still needs `rename` lines
        // — just not through this reducer.
        break
    }
  }

  return state
}
