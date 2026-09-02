import { type StateCreator } from "zustand"
import type { Comment, CommentPosition, DOMRectJSON } from "@/types/bridge"

export interface CommentSlice {
  comments: Comment[]
  activeCommentId: string | null
  showResolved: boolean
  pinsHidden: boolean
  pendingPosition: CommentPosition | null
  popupAnchorRect: DOMRectJSON | null
  /**
   * Cloud project id for the linked viewer project. Never set today (the
   * only setter, `setCommentProjectId`, was removed as dead 2026-08-08 —
   * see the "web default" annotation write path audit) — retained as a
   * field only because a couple of hook test files still reset it via
   * `useAppStore.setState({ commentProjectId: null })`.
   */
  commentProjectId: string | null
  setComments: (comments: Comment[]) => void
  setActiveComment: (id: string | null) => void
  setShowResolved: (show: boolean) => void
  setPinsHidden: (hidden: boolean) => void
  setPendingPosition: (position: CommentPosition | null) => void
  setPopupAnchorRect: (rect: DOMRectJSON | null) => void
  getCommentsForPage: (page: string) => Comment[]
}

export const createCommentSlice: StateCreator<
  CommentSlice,
  [],
  [],
  CommentSlice
> = (set, get) => ({
  comments: [],
  activeCommentId: null,
  showResolved: false,
  pinsHidden: false,
  pendingPosition: null,
  popupAnchorRect: null,
  commentProjectId: null,

  setComments: (comments) => set({ comments }),

  setActiveComment: (id) => {
    // Mutual exclusivity: close any open note when a comment is activated
    const update: Record<string, unknown> = { activeCommentId: id }
    if (id !== null) {
      update.activeNoteId = null
      update.pendingNotePosition = null
      update.notePopupAnchorRect = null
    }
    set(update as Partial<CommentSlice>)
  },
  // Comment placement mode is NOT a field here any more. It is one value of
  // `toolMode` on the tool-mode slice, because it is mutually exclusive with
  // Select and a separate boolean could not express that. See
  // `src/stores/tool-mode-slice.ts`.
  setShowResolved: (show) => set({ showResolved: show }),
  setPinsHidden: (hidden) => set({ pinsHidden: hidden }),
  setPendingPosition: (position) => {
    // Mutual exclusivity: close any open note when placing a new comment
    const update: Record<string, unknown> = { pendingPosition: position }
    if (position !== null) {
      update.activeNoteId = null
      update.pendingNotePosition = null
      update.notePopupAnchorRect = null
    }
    set(update as Partial<CommentSlice>)
  },
  setPopupAnchorRect: (rect) => set({ popupAnchorRect: rect }),

  getCommentsForPage: (page) =>
    get().comments.filter((c) => c.position.page === page),
})
