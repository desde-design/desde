"use client"

/**
 * Wired-up Comments tab body for the editor right rail. Owns both
 * artifact types — Comments (Phase 2) and Notes (Phase 3) — and
 * renders them in a single merged list via `<CommentsListPanel>`,
 * per the architecture doc (line 168: "Comments and Notes are merged
 * into one panel").
 *
 * The tab is named "Comments" (Mo, 2026-08-14) even though the list
 * also carries Notes. Splitting Notes into their own tab was
 * considered and rejected.
 *
 * Notes are DORMANT by product decision on that same date. This container is
 * the ONLY place `EDITOR_NOTES` is read on the Comments surface: the note
 * hooks are called with `enabled: false`, and the leaf components are handed
 * absent note handlers, so the flag never travels further down. Gated at both
 * ends, so the CLI refuses `/api/editor/notes/*` on the same config.
 *
 * Per-artifact wiring:
 *
 *  - `useLocalComments` / `useLocalNotes` — HTTP-backed persistence
 *    against the CLI's own store. (An earlier version of this comment
 *    said these were "parallel to `useComments` / `useNotes` Firestore
 *    subscriptions on the web project route"; neither hook exists, and
 *    the web project route was removed 2026-06-04.)
 *  - `useEditorNoteBridge` — the note postMessage channel to the
 *    iframe (parallel to `useBridge`'s note block)
 *  - the COMMENT bridge and the comment store are NOT mounted here.
 *    They are owned by `EditorSurface` and handed down as props,
 *    because the toolbar's Comment button needs the same instances.
 *    Calling `useEditorCommentBridge` a second time would register a
 *    second window message listener and double-handle every
 *    COMMENT_PIN_CLICKED / NEW_COMMENT_POSITION, and
 *    `useEditorCommentStore` transitively mounts `useViewerAuthStatus`,
 *    which fetches `/api/editor/viewer-auth` per mount.
 *  - syncs slice's `comments` / `notes` arrays → bridge whenever they
 *    change so pins inside the iframe stay current. The Note bridge
 *    sync also re-fires when `minimizedNoteIds` flips, because the
 *    BridgeNote wire payload includes per-note minimized state.
 *  - renders `<CommentThreadPopup>`, and `<NoteThreadPopup>` while
 *    Notes are live, with CLI overrides for author + HTTP-backed
 *    writes. The two popups coexist because the comment / note slices
 *    enforce mutual exclusivity (opening one closes the other).
 *
 * NOTE_PIN_CLICKED routes through `onPinClicked` so the surface
 * switches the right rail to the Comments tab. Its comment twin,
 * COMMENT_PIN_CLICKED, reaches the same surface handler directly from
 * the lifted comment bridge.
 */

import { useCallback, useEffect, useMemo } from "react"
import type { RefObject } from "react"
import { Button } from "@/components/ui/button"
import { useAppStore } from "@/stores"
import { CommentThreadPopup } from "@/components/comments/comment-thread-popup"
import { NoteThreadPopup } from "@/components/notes/note-thread-popup"
import { CommentsListPanel } from "@/components/editor/comments-list-panel"
import { useLocalComments } from "@/hooks/useLocalComments"
import {
  useLocalNotes,
  FALLBACK_NOTE_AUTHOR,
} from "@/hooks/useLocalNotes"
import type { EditorCommentStoreResult } from "@/hooks/useEditorCommentStore"
import type { UseEditorCommentBridgeResult } from "@/hooks/useEditorCommentBridge"
import { useEditorNoteBridge } from "@/hooks/useEditorNoteBridge"
import { getActiveCliUser } from "@/lib/cli-user-identity"
import { EDITOR_NOTES } from "@/lib/editor-feature-flags"
import { buildCommentFixPrompt } from "@/editor/edit-service/build-edit-escalation-prompt"
import { cn } from "@/lib/utils"
import { TONE_SURFACE } from "@/lib/tone-surface"

interface EditorCommentsContainerProps {
  /**
   * Iframe ref the editor surface owns. The note bridge posts to this
   * iframe's contentWindow; note pin events come back via window
   * messages. (The comment bridge uses the same ref, but it is mounted
   * one level up.)
   */
  iframeRef: RefObject<HTMLIFrameElement | null>
  /**
   * The comment bridge, mounted by `EditorSurface` (see the file header
   * for why it is not mounted here). Handed over whole rather than as
   * six callbacks, because that is how many members this container
   * consumes.
   */
  commentBridge: UseEditorCommentBridgeResult
  /**
   * The active comment store + author, also mounted by `EditorSurface`.
   */
  commentSync: EditorCommentStoreResult
  /**
   * Toggle comment placement mode. Lifted to `EditorSurface` so the
   * toolbar's Comment button and this panel's Comment button fire the
   * exact same handler. Threaded down to the shared `CommentModeButton`
   * in the panel header, which is literally the toolbar's control.
   */
  onCommentModeChange: (next: boolean) => void
  /**
   * Fired when the NOTE bridge emits a pin-clicked event. The surface
   * uses this to switch the right rail's active tab to Comments
   * (context-aware default opening). The kind is forwarded so the
   * surface could choose to do per-type behavior later; v1 treats
   * comments and notes the same. The comment half of this signal is
   * wired at the surface, on the lifted bridge.
   */
  onPinClicked?: (id: string, kind: "comment" | "note") => void
  /**
   * When false, the container stays inert (no fetch, no listener, no
   * posts). Used by the surface to keep the container idle when the
   * right rail isn't visible.
   */
  enabled?: boolean
  /**
   * Hand a built chat prompt to the chat agent (the same escalate-to-chat
   * seam direct-manipulation edits use). Returns whether chat ACCEPTED the
   * handoff (false when the edit session isn't active yet). When omitted
   * (e.g. no chat surface wired), the per-comment "Fix with AI" affordance
   * hides.
   */
  onEscalateToChat?: (prompt: string) => boolean
}

export function EditorCommentsContainer({
  iframeRef,
  commentBridge,
  commentSync,
  onCommentModeChange,
  onPinClicked,
  enabled = true,
  onEscalateToChat,
}: EditorCommentsContainerProps) {
  const localComments = useLocalComments({
    enabled,
    store: commentSync.store,
    author: commentSync.author,
  })
  // Notes are DORMANT by product decision 2026-08-14 (flip `editor.notes:
  // true` in .desde/config.json, or EDITOR_NOTES=1, to restore). This
  // container is the one place the flag is read: everything below it is
  // gated by handing the leaf components an absent handler, so the flag does
  // not have to travel into every leaf.
  //
  // Both hooks stay CALLED, with `enabled` false. That keeps hook order
  // stable and is already the inert path: neither fetches, listens, nor
  // posts while disabled. The note bridge never handshakes, so nothing
  // paints note pins in the iframe and `src/bridge/note-pins.ts` needs no
  // change at all.
  const notesEnabled = enabled && EDITOR_NOTES
  const localNotes = useLocalNotes({ enabled: notesEnabled })

  const handleNotePinClicked = useCallback(
    (id: string) => onPinClicked?.(id, "note"),
    [onPinClicked],
  )
  const noteBridge = useEditorNoteBridge(iframeRef, {
    enabled: notesEnabled,
    onPinClicked: handleNotePinClicked,
  })

  // Comment author is the CLI machine identity in BOTH modes —
  // `useEditorCommentStore` derives it from `getActiveCliUser()` and only
  // reshapes it for the viewer payload; there is no separate signed-in
  // identity to stamp. Notes stay on the CLI identity too (no note sync yet).
  const commentAuthor = commentSync.author
  const noteAuthor = getActiveCliUser() ?? FALLBACK_NOTE_AUTHOR

  // Keep the iframe's pin layer in sync with the slice's comments.
  // Same three-concern shape as Phase 2:
  //  1) Initial load: comments often arrive before the bridge
  //     handshakes. send() no-ops on a null contentWindow; gate on
  //     bridgeReadyEpoch > 0.
  //  2) Iframe reload: bridge re-handshakes → epoch increments →
  //     effect re-runs and re-syncs.
  //  3) Steady state: re-sync on every array identity change. The
  //     bridge tolerates unchanged-list re-syncs cheaply.
  const comments = useAppStore((s) => s.comments)
  useEffect(() => {
    if (!enabled) return
    if (commentBridge.bridgeReadyEpoch === 0) return
    commentBridge.syncComments(comments)
  }, [enabled, commentBridge, comments])

  // Same shape for notes, with one extra concern: BridgeNote includes
  // per-note `minimized: boolean`, so we re-sync when the user toggles
  // expand/minimize too (not just when the notes array itself changes).
  const notes = useAppStore((s) => s.notes)
  const minimizedNoteIds = useAppStore((s) => s.minimizedNoteIds)
  useEffect(() => {
    if (!notesEnabled) return
    if (noteBridge.bridgeReadyEpoch === 0) return
    noteBridge.syncNotes(notes, minimizedNoteIds)
  }, [notesEnabled, noteBridge, notes, minimizedNoteIds])

  // ── Panel callbacks ──────────────────────────────────────────────
  const handleHighlightComment = useCallback(
    (commentId: string) => {
      commentBridge.highlightComment(commentId)
    },
    [commentBridge],
  )
  const handleHighlightNote = useCallback(
    (noteId: string) => {
      noteBridge.highlightNote(noteId)
    },
    [noteBridge],
  )
  const handleShowResolvedChange = useCallback(
    (show: boolean) => {
      commentBridge.setShowResolved(show)
    },
    [commentBridge],
  )
  const handleShowResolvedNotesChange = useCallback(
    (show: boolean) => {
      noteBridge.setShowResolved(show)
    },
    [noteBridge],
  )
  const handlePinsHiddenChange = useCallback(
    (hidden: boolean) => {
      commentBridge.setPinsHidden(hidden)
    },
    [commentBridge],
  )
  const handleNotesHiddenChange = useCallback(
    (hidden: boolean) => {
      noteBridge.setNotesHidden(hidden)
    },
    [noteBridge],
  )
  const handleAddNote = useCallback(() => {
    noteBridge.enterNoteMode()
  }, [noteBridge])

  // ── Popup write overrides ────────────────────────────────────────
  // Adapt useLocalComments / useLocalNotes return values (Note | null)
  // into the popup's `{ ok }` envelope so the popup can preserve the
  // user's typed text on network failure.
  const handleCommentPopupSubmitNew = useCallback(
    async (
      body: string,
      position: Parameters<typeof localComments.addComment>[1],
    ) => {
      const created = await localComments.addComment(body, position, commentAuthor)
      return { ok: created !== null }
    },
    [localComments, commentAuthor],
  )
  const handleCommentPopupSubmitReply = useCallback(
    async (commentId: string, body: string) => {
      const updated = await localComments.addReply(commentId, body, commentAuthor)
      return { ok: updated !== null }
    },
    [localComments, commentAuthor],
  )
  const handleCommentPopupToggleResolved = useCallback(
    async (commentId: string) => {
      await localComments.toggleResolved(commentId)
    },
    [localComments],
  )
  const handleCommentPopupDelete = useCallback(
    async (commentId: string) => {
      await localComments.deleteComment(commentId)
    },
    [localComments],
  )

  // "Fix with AI": build a grounded seed prompt from the comment (body +
  // anchor selector/page) and hand it to chat via the escalate seam. v1
  // anchors on the selector + a screenshot hint; resolving the selector to
  // a source location for stronger grounding is a follow-up. Exposed only
  // when a chat handoff is wired, so the popup hides the button otherwise.
  const handleCommentFix = useMemo(
    () =>
      onEscalateToChat
        ? (commentId: string): boolean => {
            const comment = comments.find((c) => c.id === commentId)
            if (!comment) return false
            const prompt = buildCommentFixPrompt({
              body: comment.body,
              selector: comment.position.anchorSelector,
              page: comment.position.page,
              number: comment.number,
            })
            // Forward the accept/reject verdict so the popup keeps the
            // thread open when the handoff is gated (session not active).
            return onEscalateToChat(prompt)
          }
        : undefined,
    [onEscalateToChat, comments],
  )

  const handleNotePopupSubmitNew = useCallback(
    async (
      body: string,
      position: Parameters<typeof localNotes.addNote>[1],
    ) => {
      const created = await localNotes.addNote(body, position, noteAuthor)
      return { ok: created !== null }
    },
    [localNotes, noteAuthor],
  )
  const handleNotePopupSubmitReply = useCallback(
    async (noteId: string, body: string) => {
      const updated = await localNotes.addReply(noteId, body, noteAuthor)
      return { ok: updated !== null }
    },
    [localNotes, noteAuthor],
  )
  const handleNotePopupToggleResolved = useCallback(
    async (noteId: string) => {
      await localNotes.toggleResolved(noteId)
    },
    [localNotes],
  )
  const handleNotePopupDelete = useCallback(
    async (noteId: string) => {
      await localNotes.deleteNote(noteId)
    },
    [localNotes],
  )

  // The merged panel surfaces a single error banner. Comments wins
  // priority because that path has been live longer; if a note error
  // arrives later it shows once the comment one clears. Both share
  // the same Retry semantic (re-fetch).
  const error = localComments.error ?? localNotes.error
  const retry = useCallback(() => {
    void localComments.refresh()
    void localNotes.refresh()
  }, [localComments, localNotes])

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="editor-comments-container"
    >
      <div className="shrink-0 border-b px-3 py-2">
        <h3 className="text-sm font-semibold">Comments</h3>
        <p className="text-2xs text-muted-foreground">
          {EDITOR_NOTES
            ? "Comments and notes on the prototype"
            : "Comments on the prototype"}
        </p>
      </div>
      {error ? (
        <div
          // A full-bleed strip, not a rounded Alert, so it composes the
          // shared tone recipe rather than being one. `border-b` picks the
          // side; TONE_SURFACE supplies the colour.
          className={cn(
            "shrink-0 border-b px-3 py-2 text-xs",
            TONE_SURFACE.destructive,
          )}
          data-testid="comments-error-banner"
          role="alert"
        >
          {error}{" "}
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 underline hover:no-underline"
            onClick={retry}
          >
            Retry
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <CommentsListPanel
          onHighlightComment={handleHighlightComment}
          onCommentModeChange={onCommentModeChange}
          onPinsHiddenChange={handlePinsHiddenChange}
          onShowResolvedChange={handleShowResolvedChange}
          // The four note handlers travel together. Absent means Notes do not
          // exist for this panel: no "Note" button, no note rows, no note
          // filters. See EDITOR_NOTES.
          onHighlightNote={EDITOR_NOTES ? handleHighlightNote : undefined}
          onAddNote={EDITOR_NOTES ? handleAddNote : undefined}
          onNotesHiddenChange={EDITOR_NOTES ? handleNotesHiddenChange : undefined}
          onShowResolvedNotesChange={
            EDITOR_NOTES ? handleShowResolvedNotesChange : undefined
          }
          syncMode={commentSync.mode}
          needsViewerToken={commentSync.needsViewerToken}
          offTargetCommentIds={commentBridge.offTargetCommentIds}
        />
      </div>
      <CommentThreadPopup
        author={commentAuthor}
        onSubmitNew={handleCommentPopupSubmitNew}
        onSubmitReply={handleCommentPopupSubmitReply}
        onToggleResolved={handleCommentPopupToggleResolved}
        onDelete={handleCommentPopupDelete}
        onFixWithAI={handleCommentFix}
      />
      {EDITOR_NOTES ? (
        <NoteThreadPopup
          overrides={{
            author: noteAuthor,
            onSubmitNew: handleNotePopupSubmitNew,
            onSubmitReply: handleNotePopupSubmitReply,
            onToggleResolved: handleNotePopupToggleResolved,
            onDelete: handleNotePopupDelete,
          }}
        />
      ) : null}
    </div>
  )
}
