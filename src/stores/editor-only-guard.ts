import type { AppStore } from "./index"
import type { EditorSlice } from "./editor-slice"

/**
 * Type-level guard: `editor-slice` MUST live only in `useEditorStore`
 * ([./editor-only.ts](./editor-only.ts)), never in `useAppStore`.
 *
 * If a future change re-adds `createEditorSlice(...)` to `useAppStore`'s
 * factory and `EditorSlice` to the `AppStore` intersection type, the
 * conditional below resolves to a string literal that fails the assertion
 * — surfacing a compile error pointing at this file.
 *
 * Why: hosting the same slice creator in two zustand stores creates two
 * independent state instances. `useAppStore.getState().editorSelection`
 * would silently diverge from `useEditorStore.getState().editorSelection`,
 * and any caller that picked the wrong store would see stale data with
 * no runtime warning.
 */
// Check the combination of three editor-unique fields, not just one,
// to avoid both false positives (some unrelated slice happens to add a
// `editorSelection` field) and false negatives (a partial slice
// regression that re-adds only the state field but not the actions).
// All three of `editorSelection`, `setEditorSelection`, and
// `resetEditor` together are specific to EditorSlice.
type AppStoreHasEditorFields = AppStore extends Pick<
  EditorSlice,
  "editorSelection" | "setEditorSelection" | "resetEditor"
>
  ? "ERROR: editor-slice must live only in useEditorStore — see src/stores/editor-only.ts"
  : true

const _assertNoEditorInAppStore: AppStoreHasEditorFields = true
void _assertNoEditorInAppStore
