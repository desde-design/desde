import type { Mutation } from "@/editor/core"

/**
 * Edit-pipeline conflict/failure types shared by the editor's save UI
 * (`save-progress-dialog.tsx`) and the editing hook (`useEditorEditing.ts`).
 *
 * These lived in `pending-changes-panel.tsx` until that (now-unused) panel was
 * removed; they're plain data contracts, not tied to any component.
 */

/** A capture failure: the bridge couldn't resolve a selection into an edit. */
export interface ResolutionFailure {
  id: string
  reason: string
  selector: string
}

/**
 * The working tree changed under a set of buffered mutations — the files no
 * longer match what was captured, so a save would clobber external edits.
 */
export interface ExternalEditConflict {
  files: ReadonlyArray<{ file: string; expected: string; actual: string }>
  pendingMutations: readonly Mutation[]
}
