"use client"

import { useState, useRef, useEffect, useMemo, type CSSProperties } from "react"
import { createPortal } from "react-dom"
import { useAppStore } from "@/stores"
import { Button } from "@/components/ui/button"
import { MentionInput, encodeBodyMentions } from "@/components/annotations/mention-input"
import { AnnotationCard } from "@/components/annotations/annotation-card"
import { X, ArrowUp } from "lucide-react"
import type { Note } from "@/types/note"
import type { DOMRectJSON } from "@/types/bridge"
import type { AnnotationAuthor, AnnotationPosition } from "@/types/annotation"

interface MentionSelection {
  displayName: string
  email: string
  startIndex: number
}

const POPUP_WIDTH = 320
const POPUP_OFFSET = 12

/**
 * Phase 3: optional overrides let the CLI editor pass its own author
 * identity and write handlers (HTTP-backed `useLocalNotes`). In practice
 * this popup has exactly one mount site (`editor-comments-container.tsx`),
 * which always supplies every override — the slice-backed fallback these
 * props used to have was removed 2026-08-08 (dead code audit) since it
 * could never run. The write-handler props stay optional on the type so a
 * missing handler degrades to a no-op rather than a crash.
 *
 * Override handlers for `onSubmitNew` / `onSubmitReply` return a result
 * envelope `{ ok }` so the form can preserve the user's typed text when a
 * network write fails.
 *
 * Mirrors the Comment popup override contract; see Phase 2 notes in
 * `comment-thread-popup.tsx` for the design rationale.
 */
export type AnnotationWriteResult = { ok: boolean }

export interface NoteThreadPopupOverrides {
  /** Author override. CLI mode passes the OS-derived identity. */
  author?: AnnotationAuthor
  /** Write override: new note. Return `{ ok: false }` to keep the
   *  user's text intact (network failure). */
  onSubmitNew?: (
    body: string,
    position: AnnotationPosition,
    author: AnnotationAuthor,
  ) => Promise<AnnotationWriteResult>
  /** Write override: reply to existing note. */
  onSubmitReply?: (
    noteId: string,
    body: string,
    author: AnnotationAuthor,
  ) => Promise<AnnotationWriteResult>
  /** Write override: toggle resolved state. */
  onToggleResolved?: (noteId: string) => Promise<void> | void
  /** Write override: delete note. */
  onDelete?: (noteId: string) => Promise<void> | void
}

// ── Single note card (rendered for each non-minimized note) ──────────

interface NoteCardProps {
  note: Note
  anchorRect: DOMRectJSON
  overrides?: NoteThreadPopupOverrides
}

function NoteCard({ note, anchorRect, overrides }: NoteCardProps) {
  const toggleNoteMinimized = useAppStore((s) => s.toggleNoteMinimized)

  // The only mounter (editor-comments-container.tsx) always supplies
  // an author override; there is no other identity source.
  const effectiveAuthor: AnnotationAuthor | null = overrides?.author ?? null

  const style = useMemo<CSSProperties>(() => {
    const vw = window.innerWidth
    const vh = window.innerHeight

    // Horizontal: expand right from left edge, or left from right edge
    const left = anchorRect.left < vw / 2
      ? Math.max(8, anchorRect.left)
      : Math.max(8, anchorRect.right - POPUP_WIDTH)

    // Vertical: grow downward from top, or upward from bottom
    const s: CSSProperties = { position: "fixed", left }
    if (anchorRect.top < vh / 2) {
      s.top = Math.max(8, anchorRect.top)
    } else {
      s.bottom = Math.max(8, vh - anchorRect.bottom)
    }

    return s
  }, [anchorRect])

  const handleReply = async (encodedBody: string): Promise<void | { ok: boolean }> => {
    if (!effectiveAuthor) return { ok: false }
    if (!overrides?.onSubmitReply) return

    const result = await overrides.onSubmitReply(
      note.id,
      encodedBody,
      effectiveAuthor,
    )
    // Forward the envelope so AnnotationCard keeps the draft on network
    // failure (same fix as CommentThreadPopup).
    return result
  }

  const handleResolve = () => {
    if (overrides?.onToggleResolved) void overrides.onToggleResolved(note.id)
  }

  const handleDelete = () => {
    if (overrides?.onDelete) void overrides.onDelete(note.id)
  }

  return (
    <div className="z-50" style={style}>
      <AnnotationCard
        variant="note"
        body={note.body}
        author={note.author}
        replies={note.replies}
        resolved={note.resolved}
        onReply={handleReply}
        onResolve={handleResolve}
        onDelete={handleDelete}
        onClose={() => toggleNoteMinimized(note.id)}
      />
    </div>
  )
}

// ── New note form (shown when placing a new note) ────────────────────

interface NewNoteFormProps {
  overrides?: NoteThreadPopupOverrides
}

function NewNoteForm({ overrides }: NewNoteFormProps) {
  const pendingNotePosition = useAppStore((s) => s.pendingNotePosition)
  const notePopupAnchorRect = useAppStore((s) => s.notePopupAnchorRect)
  const setPendingNotePosition = useAppStore((s) => s.setPendingNotePosition)
  const setNotePopupAnchorRect = useAppStore((s) => s.setNotePopupAnchorRect)

  // The only mounter (editor-comments-container.tsx) always supplies
  // an author override; there is no other identity source.
  const effectiveAuthor: AnnotationAuthor | null = overrides?.author ?? null

  const [newNoteText, setNewNoteText] = useState("")
  const newNoteMentionsRef = useRef<MentionSelection[]>([])

  useEffect(() => {
    if (!pendingNotePosition) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNewNoteText("")
      newNoteMentionsRef.current = []
    }
  }, [pendingNotePosition])

  const popupStyle = useMemo<CSSProperties>(() => {
    if (!notePopupAnchorRect) return { position: "fixed", top: -9999, left: -9999, opacity: 0, pointerEvents: "none" }
    const spaceOnRight = window.innerWidth - notePopupAnchorRect.right
    const left = spaceOnRight >= POPUP_WIDTH + POPUP_OFFSET
      ? notePopupAnchorRect.right + POPUP_OFFSET
      : Math.max(8, notePopupAnchorRect.left - POPUP_WIDTH - POPUP_OFFSET)
    const top = Math.max(8, notePopupAnchorRect.top)
    return { position: "fixed", left, top }
  }, [notePopupAnchorRect])

  if (!pendingNotePosition) return null

  const handleClose = () => {
    setPendingNotePosition(null)
    setNotePopupAnchorRect(null)
  }

  const handleSubmit = async () => {
    if (!newNoteText.trim() || !pendingNotePosition || !effectiveAuthor) return
    if (!overrides?.onSubmitNew) return

    const encodedBody = encodeBodyMentions(newNoteText.trim(), newNoteMentionsRef.current)

    // CLI override: HTTP-backed write. Await so the form can keep the
    // user's typed text on failure (fire-and-forget would lose work when
    // /api/editor/notes rejects).
    const result = await overrides.onSubmitNew(
      encodedBody,
      pendingNotePosition,
      effectiveAuthor,
    )
    if (!result.ok) return

    setNewNoteText("")
    newNoteMentionsRef.current = []
    setPendingNotePosition(null)
    setNotePopupAnchorRect(null)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void handleSubmit()
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={handleClose} />
      <div
        className="z-50 flex w-80 flex-col overflow-hidden rounded-sm border border-border bg-note shadow-xl"
        style={popupStyle}
      >
        <div className="flex flex-none items-center justify-between px-3 py-1.5">
          <span className="text-xs text-muted-foreground">New note</span>
          <Button variant="ghost" size="icon-xs" onClick={handleClose}>
            <X className="h-2.5 w-2.5" />
          </Button>
        </div>
        <div className="border-t border-border p-3">
          <div className="relative">
            <MentionInput
              placeholder="Add a note… (@ to mention)"
              value={newNoteText}
              onChange={setNewNoteText}
              onKeyDown={handleKeyDown}
              onMentionsChange={(m) => { newNoteMentionsRef.current = m }}
              className="min-h-[56px] resize-none bg-white pr-10 text-base"
              autoFocus
            />
            <Button
              size="icon-sm"
              className="absolute bottom-2 right-2 rounded-full"
              onClick={() => void handleSubmit()}
              disabled={!newNoteText.trim()}
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}

// ── Main export — renders all open notes + new note form ─────────────

export interface NoteThreadPopupProps {
  /**
   * Optional overrides for CLI mode. When omitted (web project
   * route), behavior is identical to today. When provided (editor
   * surface), writes route through the HTTP-backed `useLocalNotes`
   * handlers and use the CLI-derived author identity.
   */
  overrides?: NoteThreadPopupOverrides
}

export function NoteThreadPopup({ overrides }: NoteThreadPopupProps = {}) {
  const notes = useAppStore((s) => s.notes)
  const minimizedNoteIds = useAppStore((s) => s.minimizedNoteIds)
  const showResolvedNotes = useAppStore((s) => s.showResolvedNotes)
  const notesHidden = useAppStore((s) => s.notesHidden)
  const noteAnchorRects = useAppStore((s) => s.noteAnchorRects)

  const minimizeAllNotes = useAppStore((s) => s.minimizeAllNotes)
  const pendingNotePosition = useAppStore((s) => s.pendingNotePosition)

  const visibleNotes = notesHidden ? [] : notes.filter((n) => {
    if (minimizedNoteIds.has(n.id)) return false
    if (n.resolved && !showResolvedNotes) return false
    if (!noteAnchorRects[n.id]) return false
    return true
  })

  const content = (
    <>
      {/* Backdrop — click to dismiss all open notes (skip if new-note form is open; it has its own backdrop) */}
      {visibleNotes.length > 0 && !pendingNotePosition && (
        <div className="fixed inset-0 z-40" onClick={() => minimizeAllNotes()} />
      )}
      {visibleNotes.map((note) => (
        <NoteCard
          key={note.id}
          note={note}
          anchorRect={noteAnchorRects[note.id]}
          overrides={overrides}
        />
      ))}
      <NewNoteForm overrides={overrides} />
    </>
  )

  return typeof document !== "undefined"
    ? createPortal(content, document.body)
    : null
}
