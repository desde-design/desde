/**
 * Merges the two Activity panel sources into one row list — Plan B, Task 3.
 *
 * The panel used to stack two sections: verification checks on top, a
 * `git status` file list below. Mo's read on that design: "It is confusing
 * and expects a deep knowledge of Git." This file is the pure function
 * behind the replacement, ONE list, so the union rule is testable without
 * mounting React — getting it wrong either double-counts a file (a ledger
 * entry AND a git row for the same path) or hides a real change (a path
 * outside the ledger silently dropped).
 *
 * The two sources:
 * - `LedgerRow[]` (`useEditorLedger`) — one row per Editor edit, already
 *   newest-first, each carrying a server-rendered description and the
 *   files it touched.
 * - `WorkingTreeChange[]` (`useEditorBranches`) — what `git status` reports:
 *   a path, a status, and a `from` for renames.
 *
 * The union rule: one row per ledger entry, then one row per dirty path
 * that no ledger entry claims. Those unclaimed paths are changes made
 * outside the editor — a file edited in VS Code, a codemod, a `git mv` —
 * and dropping them would make the panel lie about the working tree, which
 * is the one thing it must not do. A rename claims BOTH its `from` and its
 * `path`: a ledger entry naming either name of a renamed file claims the
 * single `WorkingTreeChange` row git reports for that rename, because
 * checking only `path` would leave a ledger entry that recorded the
 * pre-rename name looking like it explains nothing, and the same rename
 * would resurface as a second, unexplained git row right alongside the
 * ledger row that actually caused it. A COMMITTED ledger entry does NOT
 * claim a path (P2-1) — it explains bytes as they were at commit time,
 * not whatever is dirty right now, so a path whose only ledger history is
 * committed still gets its own git row when it's dirty again.
 *
 * Ordering: ledger rows stay newest-first, in the order they arrive (the
 * server already orders them; this function does not re-sort). Git-only
 * rows go AFTER all ledger rows, in `changes`' own order. They have no
 * timestamp to interleave by — `WorkingTreeChange` carries none — so any
 * interleaving with the ledger's real timestamps would be invented, and an
 * invented ordering is worse than a deliberately coarse one. Trailing them
 * also matches what they represent: work the editor didn't do, discovered
 * as leftover rather than reported as it happened. Promoting them above or
 * between ledger rows would suggest a "just now" recency they don't carry.
 */

import type { LedgerRow } from "@/hooks/useEditorLedger"
import type { WorkingTreeChange } from "@/hooks/useEditorBranches"

export type ActivityRow =
  | { source: "ledger"; id: string; row: LedgerRow }
  | {
      source: "git"
      id: string
      path: string
      status: WorkingTreeChange["status"]
      from?: string
      /**
       * True when this row is unclaimed only because the ledger could not
       * be read when this list was built (still loading, or its last
       * request failed) — NOT because the ledger was read and this path
       * genuinely has no entry. See `buildActivityRows`'s `ledgerAvailable`
       * param below.
       *
       * F3 (codex review round 8, 2026-08-20): a caller used to pass this
       * function `rows: []` whenever the ledger's own fetch had failed,
       * which is indistinguishable here from "the ledger really is empty."
       * Every dirty path then came out as a plain unclaimed git row, and
       * `ActivityRow` (the row component) rendered every one of them as
       * "Changed outside the editor" — a confident claim this function had
       * no basis for. This field lets the row component tell "confirmed
       * external" from "can't tell yet" apart, so it stops asserting the
       * former when it only knows the latter.
       */
      ledgerUnavailable?: boolean
    }

/**
 * Merge ledger entries and unclaimed working-tree changes into one
 * newest-first row list. See the module doc comment for the union rule and
 * the ordering rationale.
 *
 * @param ledgerAvailable Whether `ledger` is trustworthy: the ledger has
 *   successfully loaded at least once. Defaults to `true` (existing
 *   callers, and every test predating F3, mean "the ledger really is
 *   this — possibly empty — list"). Pass `false` only when the caller
 *   knows `ledger` is `[]` because the read hasn't succeeded yet (loading
 *   or errored), not because the ledger is confirmed empty; every
 *   unclaimed git row then carries `ledgerUnavailable: true` instead of
 *   being reported as a confirmed external change.
 */
export function buildActivityRows(
  ledger: readonly LedgerRow[],
  changes: readonly WorkingTreeChange[],
  ledgerAvailable = true,
): ActivityRow[] {
  const claimed = new Set<string>()
  for (const entry of ledger) {
    // P2-1 (codex review finding, 2026-08-20): a COMMITTED row is a past
    // fact — it explains bytes that existed at commit time, not whatever
    // is dirty in the working tree right now. If the only ledger entry
    // for a path is committed and that path is dirty again, the dirt is
    // a NEW change the ledger never recorded (edited outside the editor
    // after the commit) — claiming it would hide a real current change,
    // which is the one thing this panel must not do. An UNCOMMITTED
    // entry for the same path still claims it, whether or not an older
    // committed entry also names it: this loop simply skips committed
    // entries, so any uncommitted one contributes normally.
    if (entry.committed) continue
    for (const file of entry.files) claimed.add(file)
  }

  const rows: ActivityRow[] = ledger.map((row) => ({
    source: "ledger",
    id: row.id,
    row,
  }))

  for (const change of changes) {
    // `WorkingTreeChange` reports a rename as ONE entry with two names —
    // its current `path` and the `from` it moved from — not two separate
    // dirty paths. Which name an applicator records in a ledger entry's
    // `files` is that applicator's own convention, so a ledger entry
    // naming EITHER side has to claim the whole change: if only `path`
    // were checked, a ledger entry that recorded just the pre-rename name
    // would leave this same rename looking unclaimed, and it would
    // resurface as a second, "unexplained" row for the very rename the
    // ledger row already accounts for.
    const claimedByLedger =
      claimed.has(change.path) ||
      (change.from !== undefined && claimed.has(change.from))
    if (claimedByLedger) continue
    rows.push({
      source: "git",
      id: change.path,
      path: change.path,
      status: change.status,
      ...(change.from !== undefined ? { from: change.from } : {}),
      ...(ledgerAvailable ? {} : { ledgerUnavailable: true }),
    })
  }

  return rows
}
