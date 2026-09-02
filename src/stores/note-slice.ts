import { type StateCreator } from "zustand"
import type { CommentPosition, DOMRectJSON } from "@/types/bridge"
import type { Note } from "@/types/note"

export interface NoteSlice {
  notes: Note[]
  activeNoteId: string | null
  noteMode: boolean
  showResolvedNotes: boolean
  notesHidden: boolean
  pendingNotePosition: CommentPosition | null
  notePopupAnchorRect: DOMRectJSON | null
  /**
   * Cloud project id for the linked viewer project. Never set today (the
   * only setter, `setNoteProjectId`, was removed as dead 2026-08-08 — see
   * the "web default" annotation write path audit) — retained as a field
   * only because a hook test file still resets it via
   * `useAppStore.setState({ noteProjectId: null })`.
   */
  noteProjectId: string | null
  minimizedNoteIds: Set<string>
  expandedNoteIds: Set<string>
  noteAnchorRects: Record<string, DOMRectJSON>
  setNotes: (notes: Note[]) => void
  setActiveNote: (id: string | null) => void
  setNoteMode: (mode: boolean) => void
  setShowResolvedNotes: (show: boolean) => void
  setNotesHidden: (hidden: boolean) => void
  setPendingNotePosition: (position: CommentPosition | null) => void
  setNotePopupAnchorRect: (rect: DOMRectJSON | null) => void
  getNotesForPage: (page: string) => Note[]
  toggleNoteMinimized: (noteId: string) => void
  minimizeAllNotes: () => void
  expandAllNotes: () => void
  setNoteAnchorRects: (rects: Record<string, DOMRectJSON>) => void
}

export const createNoteSlice: StateCreator<
  NoteSlice,
  [],
  [],
  NoteSlice
> = (set, get) => ({
  notes: [],
  activeNoteId: null,
  noteMode: false,
  showResolvedNotes: false,
  notesHidden: false,
  pendingNotePosition: null,
  notePopupAnchorRect: null,
  noteProjectId: null,
  minimizedNoteIds: new Set<string>(),
  expandedNoteIds: new Set<string>(),
  noteAnchorRects: {},

  setNotes: (notes) => {
    // All notes start minimized; user explicitly expands via click
    const expanded = get().expandedNoteIds
    const minimized = new Set(notes.filter((n) => !expanded.has(n.id)).map((n) => n.id))
    set({ notes, minimizedNoteIds: minimized })
  },

  setActiveNote: (id) => {
    // Mutual exclusivity: close any open comment when a note is activated
    const update: Record<string, unknown> = { activeNoteId: id }
    if (id !== null) {
      update.activeCommentId = null
      update.pendingPosition = null
      update.popupAnchorRect = null
    }
    set(update as Partial<NoteSlice>)
  },
  setNoteMode: (mode) => set({ noteMode: mode }),
  setShowResolvedNotes: (show) => set({ showResolvedNotes: show }),
  setNotesHidden: (hidden) => set({ notesHidden: hidden }),
  setPendingNotePosition: (position) => {
    // Mutual exclusivity: close any open comment when placing a new note
    const update: Record<string, unknown> = { pendingNotePosition: position }
    if (position !== null) {
      update.activeCommentId = null
      update.pendingPosition = null
      update.popupAnchorRect = null
    }
    set(update as Partial<NoteSlice>)
  },
  setNotePopupAnchorRect: (rect) => set({ notePopupAnchorRect: rect }),

  getNotesForPage: (page) =>
    get().notes.filter((n) => n.position.page === page),

  toggleNoteMinimized: (noteId) => {
    set((state) => {
      const isCurrentlyMinimized = state.minimizedNoteIds.has(noteId)
      if (isCurrentlyMinimized) {
        // Expanding this note — minimize all others so only one is open
        const allIds = state.notes.map((n) => n.id)
        const nextMin = new Set(allIds.filter((id) => id !== noteId))
        const nextExp = new Set([noteId])
        return { minimizedNoteIds: nextMin, expandedNoteIds: nextExp }
      } else {
        // Minimizing this note
        const nextMin = new Set(state.minimizedNoteIds)
        const nextExp = new Set(state.expandedNoteIds)
        nextMin.add(noteId)
        nextExp.delete(noteId)
        return { minimizedNoteIds: nextMin, expandedNoteIds: nextExp }
      }
    })
  },

  minimizeAllNotes: () => {
    const allIds = new Set(get().notes.map((n) => n.id))
    set({ minimizedNoteIds: allIds, expandedNoteIds: new Set<string>() })
  },

  expandAllNotes: () => {
    const allIds = new Set(get().notes.map((n) => n.id))
    set({ minimizedNoteIds: new Set<string>(), expandedNoteIds: allIds })
  },

  setNoteAnchorRects: (rects) => set({ noteAnchorRects: rects }),
})
