/**
 * Which branch each `edit` line CURRENTLY belongs to, given the ledger's
 * own `rename` lines.
 *
 * P2-3 (whole-branch review finding, 2026-08-18): a ledger entry pins the
 * branch it was written on by NAME (`LedgerEditEntry.branch`), captured
 * once at write time. A branch rename changes that name going forward
 * without touching a single earlier line — the log is append-only — so an
 * exact-match filter (`entry.branch === currentBranch`) makes every entry
 * recorded under the OLD name silently vanish from a branch-scoped read
 * the instant the rename lands, even though the rename didn't touch the
 * branch's commits or working tree at all.
 *
 * B1 (round-2 whole-branch review finding, 2026-08-19 — a flaw in the
 * P2-3 fix above, not a new defect class): the first version of this file
 * exported `resolveBranchAliases`, which built a global SET of "every name
 * that ever resolves to `currentBranch`" by matching `rename.to`/`rename.from`
 * pairs with no notion of ORDER. That is wrong whenever a branch name gets
 * REUSED: rename A -> B, then later create a brand-new branch also named
 * A. The old function still had 'A' in B's alias set forever, so every
 * edit recorded on the NEW A — a completely different branch that happens
 * to share a name with the old one — showed up mixed into B's ledger view,
 * and `reconcileLedger` could mark those edits committed based on B's tree.
 *
 * The fix is to resolve identity PER EDIT, walking forward from that
 * edit's own position in the log, and to only apply a rename if it
 * happened AFTER the edit. An edit recorded on the new A (after the old
 * A -> B rename already ran) never sees that earlier rename in its
 * forward walk, so it correctly stays 'A' — distinct from B.
 *
 * Pure — no I/O. Callers that need this for a live read already have the
 * `entries` array in hand (`readLedger`'s result).
 */

import type { LedgerEntry } from './entry'

/**
 * For every `edit` line in the log, the branch name it currently belongs
 * to: its own `branch` at write time, carried forward through every
 * `rename` line that appears AFTER it in the log (and none that appear
 * before — those belong to whatever held the name at that earlier point,
 * which may be a different branch entirely once a name has been reused).
 *
 * A single forward pass, in ledger order: seeing an `edit` line records
 * its branch; seeing a `rename` line retargets every edit id CURRENTLY
 * tracking `rename.from` to `rename.to`. Because renames are applied in
 * the order they were appended, a multi-step chain (A -> B, later B -> C)
 * resolves correctly on its own — no extra fixed-point pass needed, and
 * no risk of an unrelated later reuse of a freed-up name leaking in,
 * since a reused name only starts being tracked from the `edit` line that
 * uses it, never retroactively.
 *
 * An edit with no recorded `branch` (predates the field) maps to
 * `undefined` and stays there — `undefined` never equals a rename's
 * `from`, so it is never "claimed" by an unrelated rename chain.
 *
 * Ledger size is bounded (the read route caps at 200 rows; the underlying
 * file is a normal per-repo append log), so one pass over it is cheap.
 */
export function resolveEditBranches(
  entries: readonly LedgerEntry[],
): ReadonlyMap<string, string | undefined> {
  const resolved = new Map<string, string | undefined>()
  for (const entry of entries) {
    if (entry.type === 'edit') {
      resolved.set(entry.id, entry.branch)
    } else if (entry.type === 'rename') {
      for (const [id, branch] of resolved) {
        if (branch === entry.from) resolved.set(id, entry.to)
      }
    }
  }
  return resolved
}

/**
 * Whether an edit — already resolved through `resolveEditBranches` —
 * belongs to `currentBranch`.
 *
 * An edit with no recorded branch (predates the field) is always
 * eligible: we cannot prove it is foreign, and refusing it would strand
 * it as "pending"/"hidden" forever, a permanent wrong answer in the other
 * direction. This mirrors `resolveCommitState`'s own rule for the same
 * case, so the two never disagree about what "no branch recorded" means.
 *
 * `currentBranch === undefined` (the checkout's branch itself couldn't be
 * resolved) excludes every branch-tagged edit — conservative, same
 * direction as `resolveCommitState`'s commit-branch scoping: we cannot
 * prove a match we have no anchor for.
 */
export function editBelongsToBranch(
  resolvedBranch: string | undefined,
  currentBranch: string | undefined,
): boolean {
  if (resolvedBranch === undefined) return true
  return resolvedBranch === currentBranch
}

/**
 * Whether `resolvedBranch` (an edit's current resolved identity, from
 * `resolveEditBranches`) names a branch that no longer exists at all.
 *
 * F3 (round-5 whole-branch review finding, 2026-08-19): the rename
 * tracking above only recognises a rename made THROUGH the product's own
 * Branch menu, which appends a `rename` line. `git branch -m` typed in
 * the user's own terminal appends nothing — `resolveBranchCached` reports
 * the new name on the very next read (it reads `.git/HEAD` directly, not
 * the ledger), but every earlier entry still carries the OLD name, and
 * `editBelongsToBranch`'s exact match then hides them. The working tree
 * and the branch's real identity never changed; only its name did.
 *
 * There is no reliable way to tell "renamed outside the product" apart
 * from "this really is a different, unrelated branch" — nothing in the
 * ledger or in a plain `git branch -m` proves the two are the same
 * branch, and guessing wrong writes a claim (or in the read-only case
 * below, a display decision) this append-only log can never take back.
 * See `resolveEditBranches`'s own doc comment for why a name-matching
 * guess at READ time was rejected as too clever for exactly this reason.
 *
 * What CAN be told, without guessing: whether `resolvedBranch` names a
 * branch that exists in the repo at all right now. If it doesn't, there
 * is no other view the user could switch to that would ever surface
 * these entries again — hiding them isn't "scoped to another branch,"
 * it's gone, permanently. That is a strictly worse outcome than showing
 * a few extra rows, so a caller deciding what to DISPLAY (never a caller
 * deciding what to durably RECORD, like `reconcileLedger` — see its own
 * doc comment for why reconcile stays conservative) can use this to fail
 * open instead of closed.
 *
 * This also fires for a branch that was genuinely DELETED, not renamed —
 * the two are indistinguishable from the ledger alone, and the harm is
 * asymmetric on purpose: a few stale rows from a branch nobody can check
 * out anymore is a visible, temporary annoyance the next real edit
 * crowds out; a renamed branch's still-pending work vanishing forever is
 * a silent, permanent loss. Given the log can't be corrected after the
 * fact, this picks the smaller harm rather than trying to guess which
 * case it is.
 *
 * `existingBranches: null` means "the branch list couldn't be obtained
 * this poll" (P2, round-6 whole-branch review finding, 2026-08-19) —
 * `tryListLocalBranchNames` returns `null` on a git failure, distinct
 * from the genuinely-empty `[]` a repo with no local branches produces.
 * Collapsing that distinction before it reached here meant a transient
 * git failure (not just "no branches") made EVERY resolved branch read
 * as orphaned, so this filter fell open for every row on the poll — not
 * just a genuinely renamed-outside-the-product one. The fail-open
 * behaviour above is deliberate and stays for the case it was built for;
 * it must not also fire on ignorance. `null` here returns `false`
 * unconditionally: on doubt, this poll shows the same rows the ordinary
 * `editBelongsToBranch` filter would already show, nothing more.
 */
export function isOrphanedBranch(
  resolvedBranch: string | undefined,
  existingBranches: ReadonlySet<string> | null,
): boolean {
  if (existingBranches === null) return false
  return resolvedBranch !== undefined && !existingBranches.has(resolvedBranch)
}
