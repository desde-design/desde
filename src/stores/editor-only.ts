import { create } from "zustand"
import { createEditorSlice, type EditorSlice } from "./editor-slice"

/**
 * Single-source-of-truth store for editor state.
 *
 * The platform's `useAppStore` ([./index.ts](./index.ts)) composes several
 * slices (`comment-slice`, `note-slice`, `current-page-slice`,
 * `canvas-slice` — see `index.ts` for the current list; it drifts). Two of
 * them (`comment-slice`, `note-slice`) capture references to
 * `notifications` — pulling the
 * NEXT_PUBLIC_* env-var consumers into any bundle that imports the store.
 *
 * The Editor CLI shell needs none of that. It needs only the editor
 * slice. This store gives it a clean entry that excludes the platform's
 * transitive deps from the CLI bundle.
 *
 * `editor-slice` is hosted **only** here, not in `useAppStore`, to avoid
 * state desync between two zustand instances of the same slice creator.
 * Used by `src/editor-ui/editor-page.tsx` and
 * `src/components/editor/live-prototype-pane.tsx`.
 *
 * The companion type assertion in `editor-only-guard.ts` enforces this
 * at the type level — if a future change re-adds `EditorSlice` to the
 * `AppStore` intersection, that file fails to compile.
 */
export const useEditorStore = create<EditorSlice>()((...a) => ({
  ...createEditorSlice(...a),
}))
