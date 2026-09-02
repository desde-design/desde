/**
 * The Activity list's horizon (F5, codex review round 4, 2026-08-20).
 *
 * The design spec (`docs/superpowers/specs/2026-08-18-activity-panel-edit-ledger-design.md`
 * § 3, "Horizon") says the list shows ledger entries for the current
 * branch since the SECOND-most-recent commit line, plus every dirty
 * path — bounded, and always keeping the last commit's worth of work
 * visible so a just-committed edit does not vanish the moment you commit
 * it. That was never built: `GET /api/editor/ledger` returned the newest
 * 200 entries with no commit-boundary cutoff at all, so a long-lived
 * branch's old, already-committed history fills the panel and crowds out
 * recent activity.
 *
 * Pure — no I/O, no framework, no design system, matching every other
 * module in this directory. `http-server.ts`'s ledger route is the sole
 * caller (server-side, not `activity-rows.ts` client-side — see the
 * rationale on {@link ledgerHorizonStart} below).
 */

import type { LedgerCommitEntry, LedgerEntry, LedgerReconcileEntry } from './entry'
import { editBelongsToBranch } from './rename-aliases'

/**
 * The index into `entries` (chronological, oldest first — `readLedger`'s
 * own order) at which the Activity list's horizon begins. An entry at or
 * after this index may be shown even if it is committed; a committed
 * entry BEFORE it is old history the horizon exists to trim.
 *
 * **This bounds committed entries only — never a pending one.** The
 * design spec's horizon is "what you have done lately, AND everything
 * you have not committed" — the second half is unconditional. An edit
 * can sit uncommitted through several unrelated commits (the user
 * committed OTHER files while this one stayed dirty) and still be
 * exactly as old, chronologically, as history this function trims; the
 * CALLER must check `!committed || index >= ledgerHorizonStart(...)`,
 * never gate on the index alone. Getting that backwards silently drops a
 * dirty file from the panel — the same class of lie the panel exists to
 * never tell.
 *
 * **Server-side, not `buildActivityRows` client-side.** The client only
 * ever receives the CURATED, already-200-capped `LedgerRow[]` projection
 * — never the raw ledger entries, and never a `commit`/`reconcile` line
 * at all (`LedgerRow` has no such variant; see `useEditorLedger.ts`).
 * Computing the horizon client-side would mean shipping the client
 * enough raw ledger history to re-derive it — duplicating this logic AND
 * widening what the ledger exposes over the wire, when the branch/rename
 * resolution this needs (`resolvedBranches`, from `resolveEditBranches`)
 * already lives in the route that builds `resolvedBranches` for its OWN
 * row filter. `activity-rows.ts` stays what it already documents itself
 * as: a pure UNION of an already-bounded ledger projection and the
 * working tree, with no ledger internals of its own.
 *
 * **What counts as a "commit line."** Both `commit` (the product's own
 * Commit/Publish/pre-merge-auto-commit path) and `reconcile` (a commit
 * the product only OBSERVED, typically made from the user's own
 * terminal) — both represent the same fact from the Activity list's
 * point of view: a batch of pending work just became committed history.
 * Treating only `commit` lines as boundaries would mean a horizon that
 * never advances on a branch the user commits to exclusively from a
 * terminal.
 *
 * **Branch scoping reads `entry.branch` directly for a `commit` line, and
 * falls back to `committedIds` only for a `reconcile` line.**
 *
 * F1 (codex review round 8, 2026-08-20): the first version of this
 * function scoped BOTH entry types the same way — via `committedIds`,
 * checking whether any id the line names resolves (through
 * `resolvedBranches`) to `currentBranch`. That is the only option for
 * `reconcile` (`LedgerReconcileEntry` has no `branch` field at all), but
 * for `commit` it silently assumed `committedIds` is never empty. It can
 * be: `captureCommitCoverage` (`http-server.ts`) populates `committedIds`
 * from PENDING ledger edits only, so a commit whose entire diff is
 * git-only changes — nothing this product's own ledger had recorded as
 * pending — is written with `committedIds: []`. `.some(...)` over an
 * empty array is always `false`, so that commit line was silently
 * skipped as a boundary no matter which branch it actually landed on:
 * a real commit on the current branch never advanced the horizon, and
 * old already-committed ledger rows kept accumulating in the panel
 * forever, which is exactly what the horizon exists to prevent.
 *
 * `LedgerCommitEntry.branch` doesn't have this gap: `recordCommitInLedger`
 * sets it from `commit.branch` unconditionally, whether or not the commit
 * covered any pending ledger id, so a `commit` line can be scoped to
 * `currentBranch` directly, without going through `committedIds` at all.
 * `resolveCommitState` deliberately does NOT do this for its own,
 * different question ("which ids are committed" needs the closed-list
 * discipline `committedIds` provides against a concurrent-write race —
 * see that module's own doc comment, "No branch field to match, no
 * rename retargeting to replay") — but this function is answering a
 * different question ("does this commit LINE belong to this branch,
 * for display"), where the direct field is exactly what's needed and
 * `committedIds` being empty must not read as "foreign branch."
 *
 * **Adjacent commit lines with no edit between them collapse into ONE
 * boundary, not two.** MEASURED failure without this: a route's own
 * commit action appends a `commit` line, and the SAME poll's reconcile
 * pass — reading the ledger fresh right afterward — can immediately
 * append a `reconcile` line for a DIFFERENT, already-externally-
 * committed entry, with no new pending work in between. Counted as two
 * separate generations, the horizon advanced past BOTH the commit the
 * user just made AND the entry the reconcile just resolved — the exact
 * "just-committed edit vanishes the moment you commit it" failure this
 * whole feature exists to prevent, just reached through a second
 * bookkeeping line instead of a second commit. From a reader's point of
 * view a run of commit/reconcile lines with nothing pending in between is
 * ONE "the tree went clean" moment, however many lines record it — this
 * function tracks whether an eligible `edit` entry has appeared since the
 * last counted boundary and, if not, moves that boundary forward onto
 * the new line instead of adding a second one.
 *
 * @param entries The ledger's full entries, in the order `readLedger`
 *   returns them (chronological, oldest first).
 * @param resolvedBranches Each `edit` entry's CURRENT resolved branch —
 *   `resolveEditBranches(entries)`, which the caller already computes for
 *   its own row filter; reused here rather than re-derived.
 * @param currentBranch The checked-out branch, or `undefined` if it
 *   could not be resolved.
 * @returns 0 (no cutoff — everything is in horizon) when fewer than two
 *   DISTINCT commit-line boundaries belong to `currentBranch`; otherwise
 *   the index right after the second-most-recent one.
 */
export function ledgerHorizonStart(
  entries: readonly LedgerEntry[],
  resolvedBranches: ReadonlyMap<string, string | undefined>,
  currentBranch: string | undefined,
): number {
  const commitLineIndices: number[] = []
  // Seeded true: the FIRST eligible commit line found always counts as
  // its own boundary — there is no earlier one for it to collapse into.
  let sawEditSinceLastBoundary = true
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.type === 'edit') {
      if (editBelongsToBranch(resolvedBranches.get(entry.id), currentBranch)) {
        sawEditSinceLastBoundary = true
      }
      continue
    }
    if (entry.type !== 'commit' && entry.type !== 'reconcile') continue
    if (!commitLineBelongsToBranch(entry, resolvedBranches, currentBranch)) continue
    if (sawEditSinceLastBoundary) {
      commitLineIndices.push(i)
      sawEditSinceLastBoundary = false
    } else {
      // No new pending work since the last boundary — same "commit
      // moment," a second bookkeeping line for it. Move the existing
      // boundary forward rather than opening a new generation.
      commitLineIndices[commitLineIndices.length - 1] = i
    }
  }
  if (commitLineIndices.length < 2) return 0
  return commitLineIndices[commitLineIndices.length - 2] + 1
}

function commitLineBelongsToBranch(
  entry: LedgerCommitEntry | LedgerReconcileEntry,
  resolvedBranches: ReadonlyMap<string, string | undefined>,
  currentBranch: string | undefined,
): boolean {
  // F1 (round 8): a `commit` line carries its own `branch`, recorded
  // unconditionally at write time regardless of whether it covered any
  // pending ledger id — read it directly rather than through
  // `committedIds`, which is empty (and so always `.some()`-false) for a
  // commit whose whole diff was git-only changes. `editBelongsToBranch`
  // already encodes "no recorded branch is always eligible," matching
  // every other branch check in this module.
  if (entry.type === 'commit') {
    return editBelongsToBranch(entry.branch, currentBranch)
  }
  // A `reconcile` line has no `branch` field of its own — this is the
  // only signal available for it.
  return entry.committedIds.some((id) => editBelongsToBranch(resolvedBranches.get(id), currentBranch))
}
