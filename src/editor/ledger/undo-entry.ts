/**
 * Per-entry undo planner for the edit ledger (Plan B, Task 1).
 *
 * Pure of filesystem access — every read is injected via {@link UndoDeps},
 * the same shape `reconcileLedger` uses for its injected `isDirty`
 * predicate (`edit-ledger.ts`). That is what makes the three backup
 * cases below testable without a real repo.
 *
 * **The safety rule this module exists to enforce.** Undo restores a
 * file's pre-edit bytes. That is safe only when nothing has touched the
 * file since. Every file the entry touched must still hash to the value
 * recorded in `afterHashes` — any mismatch refuses the WHOLE undo,
 * before anything is planned to write. Never a partial restore.
 *
 * **The backup cases**, which the caller (the CLI route) reaches through
 * `entry.backupDir` and, per file, `entry.createdFiles`:
 *
 * | `backupDir` | Per file | Undo does |
 * | --- | --- | --- |
 * | absent from the entry | file listed in `createdFiles` | this edit genuinely created the file (stated, not guessed): delete it |
 * | absent from the entry | file NOT listed in `createdFiles` (or `createdFiles` itself is absent) | can't tell whether this write created the file or modified it without ever taking a backup: refuse |
 * | present, missing on disk | (n/a — this is entry-wide) | the retention GC swept the whole backup: refuse |
 * | present, exists on disk | file present in the backup | ordinary edit: restore it |
 * | present, exists on disk | file absent from the backup, and listed in `createdFiles` | this edit genuinely created the file: delete it |
 * | present, exists on disk | file absent from the backup, and NOT listed in `createdFiles` (or `createdFiles` itself is absent — an entry written before this field existed) | can't tell whether this is a genuine creation or a partially-swept backup: refuse |
 *
 * `backupDir` presence and existence are different questions on purpose
 * — Plan A made `backupDir` conditional precisely so its presence means
 * a backup was really written (see `write-broker.ts`'s ledger-append
 * comment, "C1").
 *
 * **P1-3 (codex review finding, 2026-08-20).** The per-file row used to be
 * inferred from `backupHasFile` returning false alone — treated as proof
 * the edit created the file. Absence from the backup has two causes, not
 * one: a genuine creation, or a backup directory that survived while one
 * of ITS children was removed or became unreadable (an interrupted
 * retention GC is the obvious way to get there). The second case is a
 * plain overwrite; inferring "created" for it makes Undo DELETE the
 * user's current file instead of refusing. `createdFiles` turns
 * "created" into something the entry STATES at write time (see its doc
 * comment on `LedgerEditEntry`), so the planner never has to guess. An
 * entry written before this field existed carries no such record — the
 * safe direction for that is to refuse, using the same `backup-gone`
 * code: from the user's perspective it is the identical situation (the
 * bytes this undo needs are not where they should be), regardless of
 * whether the cause is a swept directory or an unrecorded creation.
 *
 * **P1-1 (codex review, round 3, 2026-08-20): the fix above was only
 * half-applied.** It closed the missing-*child* case (a `backupDir` that
 * exists but doesn't contain a given file) and left the missing-
 * *directory* case — `entry.backupDir === undefined` entirely — still
 * guessing "every file was created" for the whole entry. That inference
 * is false whenever a producer appends an `edit` entry with an
 * `afterHash` but genuinely never wrote a backup for a file that already
 * existed: `fs-structural-tools.ts`'s `manage_package` handler does
 * exactly this for its lockfile-tracking append (it records the
 * lockfile's post-install hash with no `backupDir` at all, whether or
 * not the lockfile pre-existed), and the mini-turn path can do the same
 * for an unbacked modified file. Those rows passed the hash check and
 * were offered in the UI — clicking Undo DELETED an existing file. The
 * fix is the same discipline `createdFiles` already established for the
 * missing-child case, applied to the missing-directory case too: delete
 * only when `createdFiles` explicitly names the file; anything else
 * refuses. This case gets its OWN code, `unbacked`, rather than reusing
 * `backup-gone` — a swept-GC backup and a write that never took one are
 * different facts, and the UI reads them differently (see
 * `activity-row.tsx`'s `undoAvailability`, which pre-disables a row that
 * is guaranteed to hit this case rather than let the user click into a
 * dead end).
 */

import type { LedgerEditEntry } from './entry'

/**
 * Why {@link planLedgerUndo} refused. `wrong-branch` is never produced by
 * this module — `planLedgerUndo` is pure of filesystem/git access, and
 * knowing the checked-out branch needs both — but it is part of this
 * union because it is part of the same wire contract: the CLI route
 * (`handleLedgerUndoRequest`) returns it through the identical `{ ok:
 * false, code, reason }` shape this module's own refusals use, so the
 * client-side type (`LedgerUndoRefusal`, `useEditorLedger.ts`) stays one
 * complete enumeration of every code Undo can send, not two.
 *
 * `unbacked` (P1-1, codex review round 3, 2026-08-20): this entry never
 * recorded a backup for a file it touched, and never recorded the file
 * as one it created either — so undo cannot tell whether the write was a
 * creation (safe to delete) or a modification with no backup (unsafe to
 * delete). Distinct from `backup-gone`, which means a backup WAS taken
 * and is now missing (a swept retention GC); `unbacked` means no backup
 * was ever taken for this file in the first place. See the module doc
 * comment's backup-cases table.
 */
export type UndoRefusal = 'drifted' | 'backup-gone' | 'unverifiable' | 'wrong-branch' | 'unbacked'

/** One filesystem mutation the caller carries out to perform the undo. */
export type UndoOp =
  | { kind: 'restore'; repoRel: string; content: Buffer }
  | { kind: 'delete'; repoRel: string }

export type UndoPlan =
  | { ok: true; ops: UndoOp[] }
  | { ok: false; code: UndoRefusal; reason: string }

/**
 * Filesystem reads {@link planLedgerUndo} needs, injected so the planner
 * itself never touches disk. The CLI route builds these over the real
 * filesystem; tests build them over fixtures.
 */
export interface UndoDeps {
  /** sha256 hex of the file's current content, or null when it is gone. */
  hashFile: (repoRel: string) => Promise<string | null>
  backupDirExists: (backupDir: string) => Promise<boolean>
  backupHasFile: (repoRel: string, backupDir: string) => Promise<boolean>
  readBackup: (repoRel: string, backupDir: string) => Promise<Buffer>
}

/**
 * Plan the filesystem ops that would undo `entry`, or refuse. Never
 * writes anything itself — the returned {@link UndoOp}s are a plan for
 * the caller to carry out in a SINGLE `brokeredWrite` call, whose
 * all-or-nothing rollback is what makes "never a partial restore" true
 * at the filesystem level; a planner that wrote per-file would throw
 * that guarantee away.
 *
 * Checks run cheapest-and-most-likely-refusal first, and never do a
 * read that a later check would have made pointless:
 * `unverifiable` (no hashes recorded at all — nothing to prove safety
 * with) → `backup-gone` (the retention GC swept the backup) →
 * `drifted` (a file changed since the edit) → build the ops.
 */
export async function planLedgerUndo(
  entry: LedgerEditEntry,
  deps: UndoDeps,
): Promise<UndoPlan> {
  // An entry with no recorded hashes at all cannot be proven safe to
  // undo — there is nothing to compare the current file against. This is
  // un-undoable by design, not assumed safe.
  if (Object.keys(entry.afterHashes).length === 0) {
    return {
      ok: false,
      code: 'unverifiable',
      reason: "This edit has no recorded file hashes, so it can't be undone.",
    }
  }

  // `backupDir` is CONDITIONAL on the entry (see the table above): its
  // absence means the edit created every file it touched, and there is
  // nothing to check for existence. Its presence means a backup was
  // really written, and undo depends on it still being there.
  if (entry.backupDir !== undefined) {
    const exists = await deps.backupDirExists(entry.backupDir)
    if (!exists) {
      return {
        ok: false,
        code: 'backup-gone',
        reason: "The backup for this edit is gone, so it can't be undone.",
      }
    }
  }

  for (const file of entry.files) {
    const current = await deps.hashFile(file)
    const expected = entry.afterHashes[file]
    if (current !== expected) {
      const reason =
        current === null
          ? `'${file}' no longer exists, so it can't be undone.`
          : `'${file}' changed after this edit, so it can't be undone.`
      return { ok: false, code: 'drifted', reason }
    }
  }

  const ops: UndoOp[] = []
  for (const file of entry.files) {
    if (entry.backupDir === undefined) {
      // P1-1 (codex review round 3, 2026-08-20): a missing `backupDir`
      // used to be read as proof the edit created EVERY file it
      // touched. That's false whenever a producer appends an entry with
      // an `afterHash` but never wrote a backup for a file that already
      // existed (`manage_package`'s lockfile-tracking append is the
      // running example — see the module doc comment). Delete is safe
      // ONLY when this entry explicitly states the file was created;
      // anything else — including an entry written before `createdFiles`
      // existed — refuses rather than guesses, exactly like the
      // present-but-missing-child case below.
      if (entry.createdFiles?.includes(file)) {
        ops.push({ kind: 'delete', repoRel: file })
        continue
      }
      return {
        ok: false,
        code: 'unbacked',
        reason: `No backup was recorded for '${file}', so it can't be safely undone.`,
      }
    }
    const backupDir = entry.backupDir
    const hasFile = await deps.backupHasFile(file, backupDir)
    if (hasFile) {
      ops.push({ kind: 'restore', repoRel: file, content: await deps.readBackup(file, backupDir) })
      continue
    }
    // The backup exists but doesn't have this file. See the module doc
    // comment's per-file table (P1-3): that is proof of a genuine
    // creation ONLY when this entry actually recorded it as one —
    // otherwise it's indistinguishable from a partially-swept backup,
    // and deleting the user's current file on a guess is exactly the
    // defect this field exists to close.
    if (!entry.createdFiles?.includes(file)) {
      return {
        ok: false,
        code: 'backup-gone',
        reason: `The backup for '${file}' is missing, so it can't be undone.`,
      }
    }
    ops.push({ kind: 'delete', repoRel: file })
  }

  return { ok: true, ops }
}
