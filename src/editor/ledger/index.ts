/**
 * Edit ledger — the durable, semantic record of Editor source mutations.
 * See `entry.ts` for the shape and the design doc at
 * `docs/superpowers/specs/2026-08-18-activity-panel-edit-ledger-design.md`.
 *
 * Barrel for the http-server route + test consumers only — every symbol
 * here has a real caller through THIS path. `ledgerFieldsForEdit` and
 * `LEDGER_KINDS` are real and used, but by direct submodule import
 * (`edit-handler.ts`, `describe-entry.test.ts`) rather than through this
 * barrel, so they are not re-exported here; add them back only when a
 * consumer actually needs them from this path.
 */

export { describeLedgerEntry } from './describe-entry'
export { resolveCommitState } from './commit-state'
export { editBelongsToBranch, resolveEditBranches } from './rename-aliases'
export { ledgerHorizonStart } from './ledger-horizon'
export { planLedgerUndo } from './undo-entry'
export type { UndoDeps, UndoOp, UndoPlan, UndoRefusal } from './undo-entry'
export {
  appendLedgerEntry,
  editEntries,
  hashContent,
  invalidateBranchCache,
  ledgerPath,
  readGitHeadRaw,
  readLedger,
  reconcileLedger,
  resolveBranchCached,
  resolveBranchCachedWithHead,
  type BranchResolution,
} from './edit-ledger'
