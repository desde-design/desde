import { type StateCreator } from "zustand"
import type { ComponentManifest, Selection } from "@/editor/core"
import type { VerificationResult } from "@/editor/verification"
import { EDITOR_PROJECT_ID } from "@/lib/editor-feature-flags"

/** Cap on retained verification records (newest kept). */
const MAX_VERIFICATIONS = 25

/**
 * One per-edit verification. `phase` is `running` while the verifier polls the
 * live DOM and `done` once it resolves (pass / fail / skipped). Ephemeral —
 * never persisted.
 *
 * Classified by `stateOf`/`describeState`
 * (`src/components/editor/verification-checks-list.tsx`) into the pill on
 * an Activity row and the verification section of that row's detail
 * dialog — see `activity-panel.tsx`'s module doc comment.
 */
export interface VerificationRecord {
  editId: string
  /** Human label, e.g. `label = "Submit"`. */
  label: string
  phase: "running" | "done"
  /** Populated once `phase === "done"`. */
  result?: VerificationResult
  /** ms-epoch when the verification began (ordering + relative display). */
  startedAt: number
  /**
   * SHA of the commit this edit produced, when known. Absent for no-op writes
   * (nothing committed) or when the dispatch response carried no `autoCommit`
   * — which, in branch mode, is every edit: editor writes the working tree
   * in place and the user commits with their own git. Retained as the join key
   * for a future per-commit view; nothing reads it today.
   */
  commitSha?: string
}

/**
 * Zustand slice for editor's authoring surface. Holds the active
 * `Selection` (sourced from the framework adapter) and the
 * `ComponentManifest` for the selected component (sourced from the
 * design system's `ComponentManifestSource`). Both are independent —
 * a selection without a known manifest still renders the Identity
 * section; a manifest without a current selection is held as a
 * dev-mode preview.
 */
export interface EditorSlice {
  editorSelection: Selection | null
  editorManifest: ComponentManifest | null
  /**
   * Phase 6 — additional simultaneously-selected elements alongside
   * `editorSelection` (the "primary"). Empty array when single-
   * select is active. The primary always appears first when callers
   * need the full set; chat surfaces both as a single list ("3
   * selected"). Inspector/pending-changes only operate on the
   * primary — multi-select today is read-only metadata for chat.
   */
  editorSelectionMany: Selection[]
  /**
   * Tier-2 edit-verification records, newest last, capped at
   * {@link MAX_VERIFICATIONS}. Keyed conceptually by `editId` — `beginVerification`
   * replaces any existing record for the same edit so a re-edit doesn't stack.
   */
  verifications: VerificationRecord[]
  /**
   * Monotonic counter bumped the moment a editor live-preview override reaches
   * a TERMINAL state — resolved `confirmed` / `failed` / `ineffective`, reverted
   * by the bridge, or discarded on the v-for disambiguation dialog.
   *
   * That instant is exactly "editor's inline `!important` preview shim is gone;
   * what the element shows now comes from source", and it is the only honest
   * signal for the inspector's style rows (L1). They used to POLL until
   * `StyleOrigin.inline.fromPreview` cleared, on a fixed 8 × 250 ms budget —
   * which the user's own reading time consumed whenever a dialog stood between
   * the edit and its resolution, leaving the swatch naming a colour that then
   * existed nowhere. A resolution is an event, so no amount of user-paced delay
   * can exhaust it.
   *
   * Display-only: nothing gates or delays an edit on this.
   */
  previewSettleNonce: number
  /**
   * Cloud project this checkout is linked to. Seeded from the CLI
   * bootstrap (`window.__DESDE_CLI__.project.projectId`) and
   * updated in place by the link flow — so linking flips comment sync
   * local→cloud reactively, without a CLI restart (the persisted
   * `.desde/config.json` catches the next boot up). Null when
   * unlinked / web shell.
   */
  activeProjectId: string | null
  setEditorSelection: (selection: Selection | null) => void
  /** Set/clear the linked cloud project id (link / unlink / switch). */
  setActiveProjectId: (projectId: string | null) => void
  setEditorSelectionMany: (selections: Selection[]) => void
  setEditorManifest: (manifest: ComponentManifest | null) => void
  /** Record that a verification has started (or restart one for the same edit). */
  beginVerification: (
    editId: string,
    label: string,
    startedAt: number,
    commitSha?: string,
  ) => void
  /** Resolve a verification with its result. No-op if the edit isn't tracked. */
  completeVerification: (editId: string, result: VerificationResult) => void
  /** A live-preview override reached a terminal state — see {@link EditorSlice.previewSettleNonce}. */
  notePreviewSettled: () => void
  clearVerifications: () => void
  resetEditor: () => void
}

export const createEditorSlice: StateCreator<
  EditorSlice,
  [],
  [],
  EditorSlice
> = (set) => ({
  editorSelection: null,
  editorSelectionMany: [],
  editorManifest: null,
  verifications: [],
  previewSettleNonce: 0,
  // Seed from the bootstrap so the first render already knows the link
  // (no local→cloud flash for an already-linked repo).
  activeProjectId: EDITOR_PROJECT_ID,
  setActiveProjectId: (activeProjectId) => set({ activeProjectId }),
  setEditorSelection: (editorSelection) =>
    // Single-select supersedes any prior multi-select. Without this,
    // setting a single selection would leave `editorSelectionMany`
    // stale and the chat header would still show "N selected" after
    // the user clicked away.
    set({ editorSelection, editorSelectionMany: [] }),
  setEditorSelectionMany: (editorSelectionMany) =>
    // Multi-select also updates the primary to the first entry (or
    // clears it when the list is empty) so the rest of the
    // single-selection inspector path keeps a coherent view.
    set({
      editorSelectionMany,
      editorSelection: editorSelectionMany[0] ?? null,
    }),
  setEditorManifest: (editorManifest) => set({ editorManifest }),
  beginVerification: (editId, label, startedAt, commitSha) =>
    set((state) => {
      const next = state.verifications.filter((v) => v.editId !== editId)
      next.push({ editId, label, phase: "running", startedAt, commitSha })
      // Keep only the most recent records (the list is newest-last).
      return { verifications: next.slice(-MAX_VERIFICATIONS) }
    }),
  completeVerification: (editId, result) =>
    set((state) => ({
      verifications: state.verifications.map((v) =>
        v.editId === editId ? { ...v, phase: "done", result } : v,
      ),
    })),
  clearVerifications: () => set({ verifications: [] }),
  notePreviewSettled: () =>
    set((state) => ({ previewSettleNonce: state.previewSettleNonce + 1 })),
  resetEditor: () =>
    set({
      editorSelection: null,
      editorSelectionMany: [],
      editorManifest: null,
      verifications: [],
      // Not reset: `previewSettleNonce` is a monotonic edge counter, and zeroing
      // it could make the NEXT settle collide with a value a subscriber already
      // saw (0 → 1 twice), silently swallowing a refresh.
    }),
})
