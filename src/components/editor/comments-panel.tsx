"use client"

/**
 * The Comments panel mounts `<EditorCommentsContainer>` and wires
 * Comments end-to-end via the HTTP store + bridge. This surface runs on
 * the CLI editor only (the web compose mode was removed 2026-06-04).
 * The CLI always passes a populated `iframeRef`.
 */

import { memo, type RefObject } from "react"
import { EditorCommentsContainer } from "@/components/editor/editor-comments-container"
import type { EditorCommentStoreResult } from "@/hooks/useEditorCommentStore"
import type { UseEditorCommentBridgeResult } from "@/hooks/useEditorCommentBridge"

interface CommentsPanelProps {
  iframeRef: RefObject<HTMLIFrameElement | null>
  /** The comment bridge, mounted by `EditorSurface`. */
  commentBridge: UseEditorCommentBridgeResult
  /** The active comment store + author, mounted by `EditorSurface`. */
  commentSync: EditorCommentStoreResult
  /** Toggle comment placement mode; the same handler the toolbar fires. */
  onCommentModeChange: (next: boolean) => void
  /**
   * Fired when the note bridge emits a pin-clicked event. `kind`
   * disambiguates Comment vs Note so the surface can choose per-type
   * behavior; v1 treats both the same and just switches the tab.
   */
  onPinClicked?: (id: string, kind: "comment" | "note") => void
  enabled?: boolean
  /** Forwarded to the container's per-comment "Fix with AI" affordance. */
  onEscalateToChat?: (prompt: string) => boolean
}

function CommentsPanelImpl({
  iframeRef,
  commentBridge,
  commentSync,
  onCommentModeChange,
  onPinClicked,
  enabled,
  onEscalateToChat,
}: CommentsPanelProps) {
  return (
    <EditorCommentsContainer
      iframeRef={iframeRef}
      commentBridge={commentBridge}
      commentSync={commentSync}
      onCommentModeChange={onCommentModeChange}
      onPinClicked={onPinClicked}
      enabled={enabled}
      onEscalateToChat={onEscalateToChat}
    />
  )
}

/**
 * Memoized. Props are the iframe ref, two memoized hook results and three
 * useCallback-stable surface handlers, so the forceMounted Comments tab stops
 * re-rendering on every streamed token. The two hook results are memoized at
 * their source (`useEditorCommentBridge`, `useEditorCommentStore`) — that is
 * load-bearing for this memo now that they arrive as props.
 */
export const CommentsPanel = memo(CommentsPanelImpl)
CommentsPanel.displayName = "CommentsPanel"
