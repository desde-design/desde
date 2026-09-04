"use client"

import { useState, useEffect, useMemo, type CSSProperties } from "react"
import { createPortal } from "react-dom"
import { useAppStore } from "@/stores"
import { Button } from "@/components/ui/button"
import { MentionInput } from "@/components/annotations/mention-input"
import type { MentionParticipant } from "@/components/annotations/mention-encoding"
import { AnnotationCard } from "@/components/annotations/annotation-card"
import { X, ArrowUp } from "lucide-react"
import type { CommentAuthor, CommentPosition } from "@/types/bridge"

const POPUP_WIDTH = 320

/**
 * Phase 2: optional overrides let the CLI editor pass its own author
 * identity and write handlers (HTTP-backed `useLocalComments`). In
 * practice this popup has exactly one mount site
 * (`editor-comments-container.tsx`), which always supplies every
 * override — the slice-backed fallback these props used to have was
 * removed 2026-08-08 (dead code audit) since it could never run. The
 * write-handler props stay optional on the type so a missing handler
 * degrades to a no-op rather than a crash.
 *
 * Override handlers return a result envelope `{ ok }` so the
 * popup can preserve the user's typed text when a network write fails.
 */
type AnnotationWriteResult = { ok: boolean }

interface CommentThreadPopupProps {
  /** Author override. CLI mode passes the OS-derived identity. */
  author?: CommentAuthor
  /** Write override: new comment. Return `{ ok: false }` to keep
   *  the user's text intact (network failure). */
  onSubmitNew?: (
    body: string,
    position: CommentPosition,
    author: CommentAuthor,
  ) => Promise<AnnotationWriteResult>
  /** Write override: reply to existing comment. */
  onSubmitReply?: (
    commentId: string,
    body: string,
    author: CommentAuthor,
  ) => Promise<AnnotationWriteResult>
  /** Write override: toggle resolved state. */
  onToggleResolved?: (commentId: string) => Promise<void> | void
  /** Write override: delete comment. */
  onDelete?: (commentId: string) => Promise<void> | void
  /**
   * Optional "Fix with AI" action for an existing comment (CLI only).
   * When provided, the active comment's card shows a button that hands the
   * comment to the chat agent. Returns whether chat ACCEPTED the handoff —
   * the popup only closes the thread on `true`, so a rejected handoff (edit
   * session not active) keeps the comment open instead of silently losing
   * the user's intent. Omitted on the web path → no button.
   */
  onFixWithAI?: (commentId: string) => boolean
  /**
   * The @-mention directory, when this repo is linked to a Viewer prototype
   * (`useEditorParticipants`). Empty on a local-only repo, where there is no
   * directory to mention against and the composer says so by dropping the
   * `@` hint from its placeholder.
   */
  participants?: MentionParticipant[]
}

export function CommentThreadPopup({
  author: authorOverride,
  onSubmitNew,
  onSubmitReply,
  onToggleResolved,
  onDelete,
  onFixWithAI,
  participants,
}: CommentThreadPopupProps = {}) {
  const comments = useAppStore((s) => s.comments)
  const activeCommentId = useAppStore((s) => s.activeCommentId)
  const pendingPosition = useAppStore((s) => s.pendingPosition)
  const popupAnchorRect = useAppStore((s) => s.popupAnchorRect)
  const setActiveComment = useAppStore((s) => s.setActiveComment)
  const setPendingPosition = useAppStore((s) => s.setPendingPosition)
  const setPopupAnchorRect = useAppStore((s) => s.setPopupAnchorRect)

  // The only mounter (editor-comments-container.tsx) always supplies
  // an author override; there is no other identity source.
  const effectiveAuthor: CommentAuthor | null = authorOverride ?? null

  const [newCommentText, setNewCommentText] = useState("")

  const activeComment = comments.find((c) => c.id === activeCommentId) ?? null

  const popupStyle = useMemo<CSSProperties>(() => {
    if (!popupAnchorRect) return { position: "fixed", top: -9999, left: -9999, opacity: 0, pointerEvents: "none" }
    const vw = window.innerWidth
    const vh = window.innerHeight

    // Horizontal: expand right from left edge, or left from right edge
    const left = popupAnchorRect.left < vw / 2
      ? Math.max(8, popupAnchorRect.left)
      : Math.max(8, popupAnchorRect.right - POPUP_WIDTH)

    // Vertical: grow downward from top, or upward from bottom
    const style: CSSProperties = { position: "fixed", left }
    if (popupAnchorRect.top < vh / 2) {
      style.top = Math.max(8, popupAnchorRect.top)
    } else {
      style.bottom = Math.max(8, vh - popupAnchorRect.bottom)
    }

    return style
  }, [popupAnchorRect])

  useEffect(() => {
    if (!pendingPosition) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNewCommentText("")
    }
  }, [pendingPosition])

  const isVisible = !!activeComment || !!pendingPosition
  if (!isVisible) return null

  const handleClose = () => {
    setActiveComment(null)
    setPendingPosition(null)
    setPopupAnchorRect(null)
  }

  const handleSubmitNewComment = async () => {
    if (!newCommentText.trim() || !pendingPosition || !effectiveAuthor) return
    if (!onSubmitNew) return

    // Mentions are already `@[Name](id)` in the text: the picker writes the
    // wire format inline, so there is no separate list to encode here.
    const encodedBody = newCommentText.trim()

    // CLI override: HTTP-backed write. Await the handler so we can keep
    // the user's typed text on failure — fire-and-forget here would lose
    // work when /api/editor/comments rejects the request.
    const result = await onSubmitNew(
      encodedBody,
      pendingPosition,
      effectiveAuthor,
    )
    if (!result.ok) return

    setNewCommentText("")
    setPendingPosition(null)
    setPopupAnchorRect(null)
    setActiveComment(null)
  }

  const handleReply = async (encodedBody: string): Promise<void | { ok: boolean }> => {
    if (!activeComment || !effectiveAuthor) return { ok: false }
    if (!onSubmitReply) return

    const result = await onSubmitReply(
      activeComment.id,
      encodedBody,
      effectiveAuthor,
    )
    // Forward the envelope so AnnotationCard keeps the draft on network
    // failure. Without this return, the card treats every call as success
    // and discards the user's typed text.
    return result
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void handleSubmitNewComment()
    }
  }

  const content = (
    <>
      {/* Backdrop — click to dismiss */}
      <div className="fixed inset-0 z-40" onClick={handleClose} />

      <div className="z-50" style={popupStyle}>
        {activeComment ? (
          <AnnotationCard
            variant="comment"
            body={activeComment.body}
            author={activeComment.author}
            replies={activeComment.replies}
            resolved={activeComment.resolved}
            onReply={handleReply}
            onResolve={() => {
              if (onToggleResolved) void onToggleResolved(activeComment.id)
              if (!activeComment.resolved) handleClose()
            }}
            onDelete={() => {
              if (onDelete) void onDelete(activeComment.id)
              handleClose()
            }}
            participants={participants}
            onFix={
              onFixWithAI
                ? () => {
                    // Only close the thread when chat ACCEPTED the handoff.
                    // On a rejected handoff (session not active → the seam
                    // toasts why) keep the comment open so the intent isn't
                    // silently lost — mirrors session-log-panel's escalate.
                    if (onFixWithAI(activeComment.id)) handleClose()
                  }
                : undefined
            }
            onClose={handleClose}
          />
        ) : (
          <div
            /* No `overflow-hidden`: the mention picker inside opens upward
               out of this card (`absolute bottom-full`), and a clip here cut
               its list in half. Same reasoning as `AnnotationCard`. */
            className="flex w-80 flex-col rounded-sm border border-border bg-background shadow-xl"
          >
            <div className="flex flex-none items-center justify-between px-3 py-1.5">
              <span className="text-xs text-muted-foreground">New comment</span>
              <Button variant="ghost" size="icon-xs" onClick={handleClose}>
                <X className="h-2.5 w-2.5" />
              </Button>
            </div>
            <div className="border-t border-border p-3">
              <div className="relative">
                <MentionInput
                  placeholder="Add a comment"
                  value={newCommentText}
                  onChange={setNewCommentText}
                  onKeyDown={handleKeyDown}
                  participants={participants}
                  className="min-h-[56px] resize-none pr-10 text-base"
                  autoFocus
                />
                <Button
                  size="icon-sm"
                  className="absolute bottom-2 right-2 rounded-full"
                  onClick={() => void handleSubmitNewComment()}
                  disabled={!newCommentText.trim()}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  )

  return typeof document !== "undefined"
    ? createPortal(content, document.body)
    : null
}
