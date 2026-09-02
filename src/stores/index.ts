import { create } from "zustand"
import { createCommentSlice, type CommentSlice } from "./comment-slice"
import { createNoteSlice, type NoteSlice } from "./note-slice"
import { createCurrentPageSlice, type CurrentPageSlice } from "./current-page-slice"
import { createCanvasSlice, type CanvasSlice } from "./canvas-slice"
import { createToolModeSlice, type ToolModeSlice } from "./tool-mode-slice"

// Editor slice is hosted exclusively in `useEditorStore`
// (./editor-only.ts). The original reason was bundle hygiene — keeping the
// platform's firebase + notifications transitive deps out of the standalone
// Editor CLI bundle. That reason expired 2026-08-08 when both were deleted
// (the Firebase auth surface reached nothing; notifications.ts had zero
// importers). The split stands on its own merit now: Do NOT add
// `createEditorSlice` here — keeping it single-host avoids state desync
// between the two stores.

export type AppStore = CommentSlice &
  NoteSlice &
  CurrentPageSlice &
  CanvasSlice &
  ToolModeSlice

export const useAppStore = create<AppStore>()((...a) => ({
  ...createCommentSlice(...a),
  ...createNoteSlice(...a),
  ...createCurrentPageSlice(...a),
  ...createCanvasSlice(...a),
  ...createToolModeSlice(...a),
}))
