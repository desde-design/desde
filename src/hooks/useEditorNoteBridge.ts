"use client"

/**
 * CLI-side parallel to the note block in `useBridge.ts`.
 *
 * Mirrors `useEditorCommentBridge` — same wire protocol (Shell →
 * Bridge messages from `src/types/bridge.ts`), different artifact
 * type. Adds one Note-specific listener that has no Comment parallel:
 * `NOTE_ANCHOR_POSITIONS`, which the bridge sends as a periodic batch
 * of per-note pin rects so the in-iframe NoteCard popups can position
 * themselves over their targets. Comments don't need this because the
 * comment popup is a singleton anchored to the pin the user clicked
 * (rect arrives in `COMMENT_PIN_CLICKED`); Notes can have multiple
 * cards open simultaneously, so they need a running mapping.
 *
 * `syncNotes` accepts both the notes array and the slice's
 * `minimizedNoteIds` set because the bridge's wire payload is
 * `BridgeNote[]` (with `minimized: boolean`), not `Note[]`. The
 * container subscribes to both store slots and re-syncs on either
 * change.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { RefObject } from "react"
import { useAppStore } from "@/stores"
import { isBridgeMessage, originOf } from "./bridge-message-guard"
import type {
  BridgeNote,
  DOMRectJSON,
  ShellToBridgeMessage,
} from "@/types/bridge"
import type { Note } from "@/types/note"

/**
 * The prototype's origin, as far as this hook can know it — used BOTH as the
 * `targetOrigin` for posts into the frame (K12) and as the expected origin for
 * messages coming out of it (S10). Same impl and same rationale as
 * `useEditorCommentBridge`'s: the iframe's `src` attribute is shell-written and
 * bridge-uninfluenceable, so it names the origin we actually pointed the frame
 * at; `null` (no `src`, `srcdoc`, `about:blank`, or any other unknown) falls
 * back to `"*"` for sends and to the `event.source` identity check alone for
 * receives, which is also what keeps a sandboxed, opaque-origin frame workable.
 */
function prototypeOrigin(iframe: HTMLIFrameElement): string | null {
  return originOf(iframe.src)
}

export interface UseEditorNoteBridgeOptions {
  /**
   * Fires when the bridge emits `NOTE_PIN_CLICKED`. The editor
   * surface uses this to switch the right rail to the Comments
   * tab (context-aware default opening).
   */
  onPinClicked?: (noteId: string) => void
  /**
   * Fires when the bridge emits `NEW_NOTE_POSITION`. The container
   * uses this to dispatch any side effects beyond the slice updates
   * (e.g. focus the new-note input). Optional.
   */
  onNewNotePosition?: () => void
  /**
   * When false, the hook stays inert (doesn't listen, doesn't post).
   * Used by the editor surface to keep the hook idle until the
   * iframe is actually mounted.
   */
  enabled?: boolean
}

export interface UseEditorNoteBridgeResult {
  /** Post `ENTER_NOTE_MODE` to the iframe. */
  enterNoteMode: () => void
  /** Post `EXIT_NOTE_MODE` to the iframe. */
  exitNoteMode: () => void
  /** Post `HIGHLIGHT_NOTE` to scroll/focus the pin. Cross-page
   *  targets get NAVIGATE first, with HIGHLIGHT_NOTE deferred until
   *  the next BRIDGE_READY (matches `useBridge`'s `pendingHighlightRef`
   *  pattern so the highlight lands after the navigation completes). */
  highlightNote: (noteId: string) => void
  /** Post `SET_SHOW_RESOLVED_NOTES` to toggle resolved-note visibility. */
  setShowResolved: (show: boolean) => void
  /** Post `SET_NOTES_HIDDEN` to hide all notes. */
  setNotesHidden: (hidden: boolean) => void
  /**
   * Post `SET_NOTES` so the bridge re-renders pins / cards. The
   * caller passes `notes` + `minimizedNoteIds`; this method builds
   * the `BridgeNote[]` wire payload.
   */
  syncNotes: (notes: Note[], minimizedNoteIds: ReadonlySet<string>) => void
  /**
   * Increments each time the bridge reports BRIDGE_READY. Starts
   * at 0. Consumers that need to re-sync state after an iframe
   * reload (e.g. the container's `syncNotes` effect) depend on this
   * rather than a one-shot boolean — without it, a second handshake
   * would not re-trigger the sync.
   */
  bridgeReadyEpoch: number
}

export function useEditorNoteBridge(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  options: UseEditorNoteBridgeOptions = {},
): UseEditorNoteBridgeResult {
  const { onPinClicked, onNewNotePosition, enabled = true } = options

  const setActiveNote = useAppStore((s) => s.setActiveNote)
  const setNotePopupAnchorRect = useAppStore((s) => s.setNotePopupAnchorRect)
  const setPendingNotePosition = useAppStore((s) => s.setPendingNotePosition)
  const setNoteMode = useAppStore((s) => s.setNoteMode)
  const setNoteAnchorRects = useAppStore((s) => s.setNoteAnchorRects)
  const setToolMode = useAppStore((s) => s.setToolMode)
  const [bridgeReadyEpoch, setBridgeReadyEpoch] = useState(0)
  // Deferred highlight target — set when `highlightNote` fires a
  // cross-page NAVIGATE; consumed on the next BRIDGE_READY. Matches
  // `useBridge`'s `pendingHighlightRef` so the highlight lands after
  // the bridge handshakes on the new page.
  const pendingHighlightRef = useRef<string | null>(null)

  const onPinClickedRef = useRef(onPinClicked)
  const onNewNotePositionRef = useRef(onNewNotePosition)
  useEffect(() => {
    onPinClickedRef.current = onPinClicked
  }, [onPinClicked])
  useEffect(() => {
    onNewNotePositionRef.current = onNewNotePosition
  }, [onNewNotePosition])

  const send = useCallback(
    (message: ShellToBridgeMessage) => {
      if (!enabled) return
      const iframe = iframeRef.current
      if (!iframe?.contentWindow) return
      // K12: note bodies + author identity ride this channel — name the
      // prototype origin so a relocated frame stops receiving them.
      iframe.contentWindow.postMessage(message, prototypeOrigin(iframe) ?? "*")
    },
    [enabled, iframeRef],
  )

  // Bridge → Shell window listener. Same non-exclusive contract as
  // useEditorCommentBridge — we filter by `source` and `type` and
  // coexist with other listeners.
  useEffect(() => {
    if (!enabled) return
    function onMessage(event: MessageEvent) {
      // S10: authenticate on the sending window's identity (and origin when
      // known) — the payload's `source` marker is forgeable by any window.
      if (
        !isBridgeMessage(event, iframeRef, {
          expectedOrigin: originOf(iframeRef.current?.src),
        })
      ) {
        return
      }
      const data = event.data as {
        type?: string
        payload?: unknown
      }

      if (data.type === "BRIDGE_READY") {
        setBridgeReadyEpoch((e) => e + 1)
        const pendingId = pendingHighlightRef.current
        if (pendingId) {
          pendingHighlightRef.current = null
          window.setTimeout(() => {
            const iframe = iframeRef.current
            if (!iframe?.contentWindow) return
            iframe.contentWindow.postMessage(
              { type: "HIGHLIGHT_NOTE", payload: { noteId: pendingId } },
              prototypeOrigin(iframe) ?? "*",
            )
          }, 200)
        }
        return
      }

      if (data.type === "NOTE_PIN_CLICKED") {
        const payload = data.payload as
          | { noteId?: string; pinRect?: unknown }
          | undefined
        if (typeof payload?.noteId !== "string") return
        setNotePopupAnchorRect(
          (payload.pinRect ?? null) as Parameters<
            typeof setNotePopupAnchorRect
          >[0],
        )
        setActiveNote(payload.noteId)
        onPinClickedRef.current?.(payload.noteId)
        return
      }

      if (data.type === "NEW_NOTE_POSITION") {
        const payload = data.payload as
          | {
              anchorSelector?: string
              page?: string
              anchorX?: number
              anchorY?: number
              elementRect?: unknown
            }
          | undefined
        if (typeof payload?.anchorSelector !== "string") return
        if (typeof payload.page !== "string") return
        setNotePopupAnchorRect(
          (payload.elementRect ?? null) as Parameters<
            typeof setNotePopupAnchorRect
          >[0],
        )
        setNoteMode(false)
        setPendingNotePosition({
          anchorSelector: payload.anchorSelector,
          page: payload.page,
          anchorX: payload.anchorX,
          anchorY: payload.anchorY,
        })
        onNewNotePositionRef.current?.()
        return
      }

      if (data.type === "NOTE_ANCHOR_POSITIONS") {
        // Periodic per-note pin-rect batch from the bridge. Convert
        // the wire array shape into the slice's Record<noteId, rect>
        // shape so NoteThreadPopup can look up rects per note id.
        const payload = data.payload as
          | { noteId: string; rect: DOMRectJSON }[]
          | undefined
        if (!Array.isArray(payload)) return
        const next: Record<string, DOMRectJSON> = {}
        for (const entry of payload) {
          if (
            entry &&
            typeof entry.noteId === "string" &&
            entry.rect != null
          ) {
            next[entry.noteId] = entry.rect
          }
        }
        setNoteAnchorRects(next)
        return
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [
    enabled,
    iframeRef,
    setActiveNote,
    setNotePopupAnchorRect,
    setPendingNotePosition,
    setNoteMode,
    setNoteAnchorRects,
  ])

  const enterNoteMode = useCallback(() => {
    setNoteMode(true)
    // The bridge's ENTER_NOTE_MODE handler calls `pins.exitPlacementMode()`,
    // so asking for note placement ends comment placement inside the iframe.
    // Record that here, or the Comment controls keep claiming a mode the
    // bridge just dropped. Store write only: the bridge is about to do this
    // to itself, so there is nothing to ask it for.
    setToolMode("navigate")
    send({ type: "ENTER_NOTE_MODE" })
  }, [send, setNoteMode, setToolMode])

  const exitNoteMode = useCallback(() => {
    setNoteMode(false)
    send({ type: "EXIT_NOTE_MODE" })
  }, [send, setNoteMode])

  const highlightNote = useCallback(
    (noteId: string) => {
      // Match `useBridge`'s behavior: if the target note lives on a
      // different page than the iframe's current URL, send NAVIGATE
      // first and defer the HIGHLIGHT_NOTE until the next
      // BRIDGE_READY.
      const note = useAppStore
        .getState()
        .notes.find((n) => n.id === noteId)
      const targetPage = note?.position.page
      const currentRoute = useAppStore.getState().currentDisplayRoute
      const crossPage =
        !!targetPage &&
        !!currentRoute &&
        normalizePage(targetPage) !== normalizePage(currentRoute)
      if (crossPage) {
        pendingHighlightRef.current = noteId
        send({ type: "NAVIGATE", payload: { page: targetPage } })
        return
      }
      send({ type: "HIGHLIGHT_NOTE", payload: { noteId } })
    },
    [send],
  )

  const setShowResolved = useCallback(
    (show: boolean) => {
      send({ type: "SET_SHOW_RESOLVED_NOTES", payload: show })
    },
    [send],
  )

  const setNotesHidden = useCallback(
    (hidden: boolean) => {
      send({ type: "SET_NOTES_HIDDEN", payload: hidden })
    },
    [send],
  )

  const syncNotes = useCallback(
    (notes: Note[], minimizedNoteIds: ReadonlySet<string>) => {
      const payload: BridgeNote[] = notes.map((n) => ({
        id: n.id,
        number: n.number,
        position: n.position,
        body: n.body,
        author: n.author,
        createdAt: n.createdAt,
        resolved: n.resolved,
        minimized: minimizedNoteIds.has(n.id),
        replies: n.replies,
      }))
      send({ type: "SET_NOTES", payload })
    },
    [send],
  )

  return useMemo(
    () => ({
      enterNoteMode,
      exitNoteMode,
      highlightNote,
      setShowResolved,
      setNotesHidden,
      syncNotes,
      bridgeReadyEpoch,
    }),
    [
      enterNoteMode,
      exitNoteMode,
      highlightNote,
      setShowResolved,
      setNotesHidden,
      syncNotes,
      bridgeReadyEpoch,
    ],
  )
}

/**
 * Compare two `AnnotationPosition['page']` values stripping trailing
 * slashes + query/hash so "/" and "/?foo=1" match for the cross-page
 * navigation gate. Same impl as `useEditorCommentBridge`.
 */
function normalizePage(page: string): string {
  try {
    const parsed = new URL(page, "http://placeholder")
    return parsed.pathname.replace(/\/+$/, "") || "/"
  } catch {
    return page.split(/[?#]/)[0].replace(/\/+$/, "") || "/"
  }
}
