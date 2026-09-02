"use client"

/**
 * The Editor's note hook. Talks to the CLI's `/api/editor/notes` routes
 * via `createHttpNoteStore()`. Mirrors `useLocalComments` end-to-end —
 * same optimistic-insert + targeted-reconcile pattern, same author
 * resolution, same `enabled` gate.
 *
 * One Note-specific twist: the slice's `setNotes` setter recomputes
 * `minimizedNoteIds` (all-except-`expandedNoteIds`) every call. If we
 * routed every mutation through `setNotes`, every targeted update
 * would reset the user's per-note minimize state. Initial load DOES
 * call `setNotes` (the slice needs to seed the minimization map from
 * the loaded set). Mutations bypass it via direct `setState`, leaving
 * `minimizedNoteIds` / `expandedNoteIds` untouched. This hook's local
 * `optimisticNumber()` computes the next note number itself (max+1 of
 * what's currently in the slice) since `note-slice.ts` has no notion of
 * numbering — it's a pure in-memory cache (`notes: Note[]` plus UI-state
 * setters) with no persistence of its own; this hook is the only thing
 * that writes through to the CLI.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { useAppStore } from "@/stores"
import { createHttpNoteStore } from "@/services/artifact-stores"
import { isArtifactStoreError } from "@/services/artifact-stores/shared"
import { getActiveCliUser } from "@/lib/cli-user-identity"
import type { Note } from "@/types/note"
import type {
  AnnotationAuthor,
  AnnotationPosition,
  AnnotationReply,
} from "@/types/annotation"
import type { NoteStore } from "@/editor/core"

/**
 * Fallback author for environments where the CLI bootstrap didn't
 * populate a real user identity (web `/compose` page, dev). Real CLI
 * runs override this via `__DESDE_CLI__.user`.
 *
 * Shape-identical to FALLBACK_COMMENT_AUTHOR — same AnnotationAuthor
 * structure — but a distinct constant so the two artifacts can drift
 * independently if we ever want per-artifact identity (e.g. a
 * different default email).
 */
export const FALLBACK_NOTE_AUTHOR: AnnotationAuthor = {
  uid: "cli-local",
  displayName: "Local user",
  email: "",
  photoURL: "",
}

export interface UseLocalNotesResult {
  /**
   * First fetch in flight. The Comments panel can render a
   * skeleton while this is true.
   */
  loading: boolean
  /** Last fetch / write error, if any. Cleared on next success. */
  error: string | null
  /** Refetch the full list and replace the slice. */
  refresh: () => Promise<void>
  /** Add a new note at `position` with body `body`. */
  addNote: (
    body: string,
    position: AnnotationPosition,
    author?: AnnotationAuthor,
  ) => Promise<Note | null>
  /** Reply to an existing note. */
  addReply: (
    noteId: string,
    body: string,
    author?: AnnotationAuthor,
  ) => Promise<Note | null>
  /** Toggle the `resolved` flag. */
  toggleResolved: (noteId: string) => Promise<void>
  /** Delete a note. */
  deleteNote: (noteId: string) => Promise<void>
}

export interface UseLocalNotesOptions {
  /** Override the store impl (used by tests). */
  store?: NoteStore
  /** Override the fallback author (CLI bootstrap injects this). */
  author?: AnnotationAuthor
  /**
   * When false, the hook stays inert. Used by the surface to avoid
   * fetching on the `/compose` web page where the CLI endpoints
   * aren't available.
   */
  enabled?: boolean
}

export function useLocalNotes(
  options: UseLocalNotesOptions = {},
): UseLocalNotesResult {
  // Author resolution order:
  //   1. explicit `options.author` (tests, future contexts)
  //   2. CLI bootstrap identity from `setActiveCliUser` (real CLI runs)
  //   3. FALLBACK_NOTE_AUTHOR placeholder (web /compose, dev)
  const { enabled = true } = options
  const author =
    options.author ?? getActiveCliUser() ?? FALLBACK_NOTE_AUTHOR
  // Memoize the default store so the hook doesn't recreate it on
  // every render and trigger downstream effects.
  const store = useMemo<NoteStore>(
    () => options.store ?? createHttpNoteStore(),
    [options.store],
  )

  const setNotes = useAppStore((s) => s.setNotes)
  const [loading, setLoading] = useState<boolean>(enabled)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!enabled) return
    try {
      const list = await store.list()
      if (!mountedRef.current) return
      // Initial / explicit refresh DOES go through setNotes so the
      // slice seeds `minimizedNoteIds` from the loaded set. The
      // targeted-mutate helpers below bypass this on individual
      // writes (see file header).
      setNotes(list)
      setError(null)
    } catch (err) {
      if (!mountedRef.current) return
      const message = (err as Error).message
      setError(`Failed to load notes: ${message}`)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [enabled, store, setNotes])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    void refresh()
  }, [enabled, refresh])

  // Targeted mutate helpers — bypass the slice's `setNotes` setter
  // (which recomputes minimizedNoteIds and would clobber the user's
  // per-note expand/minimize state on every mutation). Direct
  // `setState` on `notes` leaves minimization untouched.
  //
  // Append-fallback mirrors useLocalComments: if a concurrent refresh
  // clears the optimistic id between insert and write-success, append
  // the server's truth so a successful write never disappears from
  // the UI.
  const replaceNoteInSlice = useCallback(
    (targetId: string, replacement: Note | null) => {
      const state = useAppStore.getState()
      const current = state.notes
      if (replacement === null) {
        useAppStore.setState({
          notes: current.filter((n) => n.id !== targetId),
        })
        return
      }
      const idx = current.findIndex((n) => n.id === targetId)
      // Carry the optimistic id's per-note UI state (minimized /
      // expanded) over to the server's truth id so a toggle that
      // happened during the in-flight create doesn't disappear when
      // the id rotates. Codex round-1 should-fix.
      const idChange = targetId !== replacement.id
      const nextMinimized = idChange ? new Set(state.minimizedNoteIds) : null
      const nextExpanded = idChange ? new Set(state.expandedNoteIds) : null
      if (idChange && nextMinimized && nextExpanded) {
        if (nextMinimized.delete(targetId)) nextMinimized.add(replacement.id)
        if (nextExpanded.delete(targetId)) nextExpanded.add(replacement.id)
      }
      if (idx >= 0) {
        useAppStore.setState({
          notes: current.map((n, i) => (i === idx ? replacement : n)),
          ...(idChange && nextMinimized && nextExpanded
            ? { minimizedNoteIds: nextMinimized, expandedNoteIds: nextExpanded }
            : {}),
        })
      } else {
        useAppStore.setState({
          notes: [...current, replacement],
          ...(idChange && nextMinimized && nextExpanded
            ? { minimizedNoteIds: nextMinimized, expandedNoteIds: nextExpanded }
            : {}),
        })
      }
    },
    [],
  )

  const addNote = useCallback(
    async (
      body: string,
      position: AnnotationPosition,
      authorOverride?: AnnotationAuthor,
    ): Promise<Note | null> => {
      const useAuthor = authorOverride ?? author
      const optimisticId = `optimistic-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)}`
      const optimistic: Note = {
        id: optimisticId,
        number: optimisticNumber(),
        position,
        body,
        author: useAuthor,
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
        mentions: [],
        participantEmails: [useAuthor.email].filter(Boolean),
      }
      // Optimistic insert — direct setState so minimization state is
      // untouched. The new optimistic note isn't in expandedNoteIds
      // either, so it stays minimized by default; the popup's
      // toggleNoteMinimized on add (handled at the bridge layer)
      // expands it explicitly.
      useAppStore.setState({
        notes: [...useAppStore.getState().notes, optimistic],
      })
      try {
        const created = await store.create({
          position,
          body,
          author: useAuthor,
        })
        replaceNoteInSlice(optimisticId, created)
        return created
      } catch (err) {
        replaceNoteInSlice(optimisticId, null)
        const message = surfaceError("Failed to add note", err)
        setError(message)
        return null
      }
    },
    [author, store, replaceNoteInSlice],
  )

  const addReply = useCallback(
    async (
      noteId: string,
      body: string,
      authorOverride?: AnnotationAuthor,
    ): Promise<Note | null> => {
      const useAuthor = authorOverride ?? author
      const beforeTarget = useAppStore
        .getState()
        .notes.find((n) => n.id === noteId)
      if (!beforeTarget) {
        const message = `Cannot reply: note ${noteId} not found`
        setError(message)
        toast.error(message)
        return null
      }
      const optimisticReplyId = `optimistic-reply-${Date.now()}`
      const optimisticReply: AnnotationReply = {
        id: optimisticReplyId,
        body,
        author: useAuthor,
        createdAt: new Date().toISOString(),
        mentions: [],
      }
      const withOptimistic: Note = {
        ...beforeTarget,
        replies: [...beforeTarget.replies, optimisticReply],
      }
      replaceNoteInSlice(noteId, withOptimistic)
      try {
        const updated = await store.addReply(noteId, {
          body,
          author: useAuthor,
        })
        replaceNoteInSlice(noteId, updated)
        return updated
      } catch (err) {
        replaceNoteInSlice(noteId, beforeTarget)
        const message = surfaceError("Failed to add reply", err)
        setError(message)
        return null
      }
    },
    [author, store, replaceNoteInSlice],
  )

  const toggleResolved = useCallback(
    async (noteId: string): Promise<void> => {
      const beforeTarget = useAppStore
        .getState()
        .notes.find((n) => n.id === noteId)
      if (!beforeTarget) return
      const next = !beforeTarget.resolved
      replaceNoteInSlice(noteId, { ...beforeTarget, resolved: next })
      try {
        const updated = await store.update(noteId, { resolved: next })
        replaceNoteInSlice(noteId, updated)
      } catch (err) {
        replaceNoteInSlice(noteId, beforeTarget)
        const message = surfaceError("Failed to update note", err)
        setError(message)
      }
    },
    [store, replaceNoteInSlice],
  )

  const deleteNote = useCallback(
    async (noteId: string): Promise<void> => {
      const beforeTarget = useAppStore
        .getState()
        .notes.find((n) => n.id === noteId)
      if (!beforeTarget) return
      // Snapshot the original position so a failure can restore it.
      const beforeIndex = useAppStore
        .getState()
        .notes.findIndex((n) => n.id === noteId)
      replaceNoteInSlice(noteId, null)
      try {
        await store.delete(noteId)
      } catch (err) {
        const current = useAppStore.getState().notes
        const restored = [...current]
        const safeIndex = Math.max(0, Math.min(beforeIndex, restored.length))
        restored.splice(safeIndex, 0, beforeTarget)
        useAppStore.setState({ notes: restored })
        const message = surfaceError("Failed to delete note", err)
        setError(message)
      }
    },
    [store, replaceNoteInSlice],
  )

  return {
    loading,
    error,
    refresh,
    addNote,
    addReply,
    toggleResolved,
    deleteNote,
  }
}

function optimisticNumber(): number {
  // Best-effort: the server is the canonical source for note numbers.
  // The optimistic record is replaced on write-success, so this value
  // is only seen for the brief flash between insert and reconciliation.
  const current = useAppStore.getState().notes
  return current.length === 0
    ? 1
    : Math.max(...current.map((n) => n.number), 0) + 1
}

function surfaceError(prefix: string, err: unknown): string {
  let message = prefix
  if (isArtifactStoreError(err)) {
    message = `${prefix}: ${err.reason}`
  } else if (err instanceof Error) {
    message = `${prefix}: ${err.message}`
  }
  toast.error(message)
  return message
}
