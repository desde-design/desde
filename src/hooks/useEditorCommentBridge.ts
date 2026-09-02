"use client"

/**
 * CLI-side parallel to the comment block in `useBridge.ts`.
 *
 * The web app's project route uses `useBridge` to talk to the
 * prototype iframe — it exposes `enterCommentMode`, `highlightComment`,
 * etc. via a ref-based viewer handle. The editor's iframe is
 * driven by `useEditorEditing`, which doesn't expose those
 * methods, so this hook adds the parallel surface.
 *
 * Same wire protocol (Shell → Bridge message types from
 * `src/types/bridge.ts`), just a different React mounting point.
 * Inside the iframe, `comment-bridge.ts` is identical.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { RefObject } from "react"
import { useAppStore } from "@/stores"
import { isBridgeMessage, originOf } from "./bridge-message-guard"
import type {
  Comment,
  ShellToBridgeMessage,
} from "@/types/bridge"

/**
 * The prototype's origin, as far as this hook can know it — used BOTH as the
 * `targetOrigin` for posts into the frame (K12) and as the expected origin for
 * messages coming out of it (S10).
 *
 * The iframe's own `src` attribute is the only prototype-URL input this hook
 * has (the comments container passes just the ref), and it is a sound one:
 * the shell writes it — React binds it to `prototypeUrl`, imperative
 * re-navigations assign it directly — so the bridge can never influence it. It
 * names the origin the shell actually pointed the frame at, which is precisely
 * what a `targetOrigin` should assert. The frame's *live* location is both
 * cross-origin-unreadable and exactly the value an attacker controls after
 * relocating it, so it is not a substitute.
 *
 * `null` means genuinely unknown (no `src` yet, `srcdoc`, `about:blank`).
 * Callers then fall back to `"*"` and skip the origin half of the guard; the
 * `event.source` identity check still applies. That fallback has to stay
 * reachable — a frame sandboxed without `allow-same-origin` has an OPAQUE
 * origin that cannot be named as a `targetOrigin` at all.
 */
function prototypeOrigin(iframe: HTMLIFrameElement): string | null {
  return originOf(iframe.src)
}

export interface UseEditorCommentBridgeOptions {
  /**
   * Fires when the bridge emits `COMMENT_PIN_CLICKED`. The editor
   * surface uses this to switch the right rail to the Comments
   * tab (context-aware default opening).
   */
  onPinClicked?: (commentId: string) => void
  /**
   * Fires when the bridge emits `NEW_COMMENT_POSITION`. The container
   * uses this to dispatch any side effects beyond the slice updates
   * (e.g. focus the popup's input). Optional.
   */
  onNewCommentPosition?: () => void
  /**
   * When false, the hook stays inert (doesn't listen, doesn't post).
   * Used by the editor surface to keep the hook idle until the
   * iframe is actually mounted.
   */
  enabled?: boolean
}

export interface UseEditorCommentBridgeResult {
  /** Post `ENTER_COMMENT_MODE` to the iframe. */
  enterCommentMode: () => void
  /** Post `EXIT_COMMENT_MODE` to the iframe. */
  exitCommentMode: () => void
  /** Post `HIGHLIGHT_COMMENT` to scroll/focus the pin. If the
   *  comment's page differs from the current iframe URL, sends
   *  `NAVIGATE` first and defers HIGHLIGHT_COMMENT until the next
   *  BRIDGE_READY (matches `useBridge`'s `pendingHighlightRef`
   *  pattern so the highlight lands after the cross-page nav
   *  completes). */
  highlightComment: (commentId: string) => void
  /** Post `SET_SHOW_RESOLVED` to toggle resolved-pin visibility. */
  setShowResolved: (show: boolean) => void
  /** Post `SET_PINS_HIDDEN` to hide all pins. */
  setPinsHidden: (hidden: boolean) => void
  /** Post `SET_COMMENTS` so the bridge re-renders pins. */
  syncComments: (comments: Comment[]) => void
  /**
   * Increments each time the bridge reports BRIDGE_READY. Starts
   * at 0. Consumers that need to re-sync state after an iframe
   * reload (e.g. the container's `syncComments` effect) depend
   * on this rather than a one-shot boolean — without it, a
   * second handshake would not re-trigger the sync.
   */
  bridgeReadyEpoch: number
  /**
   * Comment ids whose `anchorSelector` did not resolve on the current
   * build — either shown at a coordinate fallback or (no coords) with
   * no pin at all. The comments list flags these as "off-target"
   * so a stale anchor is never silently invisible. Reported by the
   * bridge via `COMMENT_ANCHOR_STATUS`.
   */
  offTargetCommentIds: Set<string>
}

export function useEditorCommentBridge(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  options: UseEditorCommentBridgeOptions = {},
): UseEditorCommentBridgeResult {
  const { onPinClicked, onNewCommentPosition, enabled = true } = options

  const setActiveComment = useAppStore((s) => s.setActiveComment)
  const setPopupAnchorRect = useAppStore((s) => s.setPopupAnchorRect)
  const setPendingPosition = useAppStore((s) => s.setPendingPosition)
  // The REACTION path only. Escape during placement is the bridge telling the
  // shell it has already left the tool, so the mode is written straight to the
  // store without asserting anything back. Shell-initiated changes go through
  // `requestToolMode` (`useEditorToolMode`), which is what posts the messages.
  //
  // A PLACED PIN is deliberately not one of these any more. See the
  // NEW_COMMENT_POSITION handler below.
  const setToolMode = useAppStore((s) => s.setToolMode)
  const [bridgeReadyEpoch, setBridgeReadyEpoch] = useState(0)
  const [offTargetCommentIds, setOffTargetCommentIds] = useState<Set<string>>(
    () => new Set(),
  )
  // Deferred highlight target — set when `highlightComment` fires a
  // cross-page NAVIGATE; consumed on the next BRIDGE_READY. Matches
  // `useBridge`'s `pendingHighlightRef` so the highlight lands after
  // the bridge handshakes on the new page.
  const pendingHighlightRef = useRef<string | null>(null)

  // Keep callback refs current without re-binding the window listener
  // when they change.
  const onPinClickedRef = useRef(onPinClicked)
  const onNewCommentPositionRef = useRef(onNewCommentPosition)
  useEffect(() => {
    onPinClickedRef.current = onPinClicked
  }, [onPinClicked])
  useEffect(() => {
    onNewCommentPositionRef.current = onNewCommentPosition
  }, [onNewCommentPosition])

  const send = useCallback(
    (message: ShellToBridgeMessage) => {
      if (!enabled) return
      const iframe = iframeRef.current
      if (!iframe?.contentWindow) return
      // K12: name the prototype's origin. Comment bodies and the
      // `cli:user@host` identity ride this channel — a relocated frame must
      // stop receiving them, and a post that lands nowhere is the correct
      // failure mode.
      iframe.contentWindow.postMessage(message, prototypeOrigin(iframe) ?? "*")
    },
    [enabled, iframeRef],
  )

  // Bridge → Shell window listener for comment-relevant messages. We
  // intentionally don't claim the whole bridge channel — other hooks
  // (editor-surface's ROUTE_CHANGED listener, useShellBridgePoll,
  // etc.) also listen and filter by `type`. Each window message
  // dispatches to all listeners; React-batched setState in each
  // listener is fine.
  useEffect(() => {
    if (!enabled) return
    function onMessage(event: MessageEvent) {
      // S10: the payload's `source` marker is a routing convenience, not a
      // credential — any page in any window can set it. Authenticate on the
      // sending window's identity (and its origin, when we know it) instead.
      if (
        !isBridgeMessage(event, iframeRef, {
          expectedOrigin: originOf(iframeRef.current?.src),
        })
      ) {
        return
      }
      const data = event.data as {
        type?: string
        payload?: Record<string, unknown>
      }

      if (data.type === "BRIDGE_READY") {
        setBridgeReadyEpoch((e) => e + 1)
        // Drain the pending highlight after a cross-page navigation.
        // Use a short timeout so the bridge has a tick to render
        // pins for the new page before we ask it to focus one.
        const pendingId = pendingHighlightRef.current
        if (pendingId) {
          pendingHighlightRef.current = null
          window.setTimeout(() => {
            const iframe = iframeRef.current
            if (!iframe?.contentWindow) return
            iframe.contentWindow.postMessage(
              { type: "HIGHLIGHT_COMMENT", payload: { commentId: pendingId } },
              prototypeOrigin(iframe) ?? "*",
            )
          }, 200)
        }
        return
      }

      if (data.type === "COMMENT_PIN_CLICKED") {
        const payload = data.payload as
          | { commentId?: string; pinRect?: unknown }
          | undefined
        if (typeof payload?.commentId !== "string") return
        setPopupAnchorRect(
          (payload.pinRect ?? null) as Parameters<
            typeof setPopupAnchorRect
          >[0],
        )
        setActiveComment(payload.commentId)
        onPinClickedRef.current?.(payload.commentId)
        return
      }

      // The bridge left placement mode by itself. Today this is Escape during
      // placement (`PlacementOverlay`'s cancel path posts the same message
      // name back up the channel). Without this handler the shell kept
      // claiming comment mode after the user had already backed out of it,
      // which lit the Comment button with nothing behind it.
      if (data.type === "EXIT_COMMENT_MODE") {
        setToolMode("navigate")
        return
      }

      if (data.type === "COMMENT_ANCHOR_STATUS") {
        const payload = data.payload as
          | { unanchored?: unknown; fallback?: unknown }
          | undefined
        const toIds = (v: unknown): string[] =>
          Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
        const next = new Set([
          ...toIds(payload?.unanchored),
          ...toIds(payload?.fallback),
        ])
        setOffTargetCommentIds((prev) => {
          // Avoid a re-render when the set is unchanged (the bridge only
          // posts on change, but be defensive against duplicate events).
          if (prev.size === next.size && [...next].every((id) => prev.has(id))) {
            return prev
          }
          return next
        })
        return
      }

      if (data.type === "NEW_COMMENT_POSITION") {
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
        setPopupAnchorRect(
          (payload.elementRect ?? null) as Parameters<
            typeof setPopupAnchorRect
          >[0],
        )
        // The mode is NOT written here. A placed pin un-arms the bridge's
        // placement overlay, but it does not end the TOOL: comment placement
        // is sticky, the way Figma's comment tool is, so the user can drop
        // several pins in a row. Writing `navigate` here was what ended the
        // tool after one comment.
        //
        // The bridge is re-armed once this comment's composer closes, by
        // `useStickyCommentPlacement`. Until then the tool is Comment while
        // the bridge is deliberately un-armed, which is also what stops a
        // click under the open composer dropping a stray second pin.
        setPendingPosition({
          anchorSelector: payload.anchorSelector,
          page: payload.page,
          anchorX: payload.anchorX,
          anchorY: payload.anchorY,
        })
        onNewCommentPositionRef.current?.()
        return
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [
    enabled,
    iframeRef,
    setActiveComment,
    setPopupAnchorRect,
    setPendingPosition,
    setToolMode,
  ])

  // Both of these are pure senders. They do NOT write `toolMode` — the mode
  // is owned by `useEditorToolMode`, which calls them. Writing it here too
  // would put a second author on the mirror, and one of the two would
  // eventually be the one that is wrong.
  const enterCommentMode = useCallback(() => {
    send({ type: "ENTER_COMMENT_MODE" })
  }, [send])

  const exitCommentMode = useCallback(() => {
    send({ type: "EXIT_COMMENT_MODE" })
  }, [send])

  const highlightComment = useCallback(
    (commentId: string) => {
      // Match `useBridge`'s behavior: if the target comment lives
      // on a different page than the iframe's current URL, send
      // NAVIGATE first and defer the HIGHLIGHT_COMMENT until the
      // next BRIDGE_READY — sending it immediately would race the
      // navigation, and the bridge's pin-render for the new page
      // wouldn't be in place yet.
      const comment = useAppStore
        .getState()
        .comments.find((c) => c.id === commentId)
      const targetPage = comment?.position.page
      const currentRoute = useAppStore.getState().currentDisplayRoute
      const crossPage =
        !!targetPage &&
        !!currentRoute &&
        normalizePage(targetPage) !== normalizePage(currentRoute)
      if (crossPage) {
        pendingHighlightRef.current = commentId
        send({ type: "NAVIGATE", payload: { page: targetPage } })
        return
      }
      send({ type: "HIGHLIGHT_COMMENT", payload: { commentId } })
    },
    [send],
  )

  const setShowResolved = useCallback(
    (show: boolean) => {
      send({ type: "SET_SHOW_RESOLVED", payload: show })
    },
    [send],
  )

  const setPinsHidden = useCallback(
    (hidden: boolean) => {
      send({ type: "SET_PINS_HIDDEN", payload: hidden })
    },
    [send],
  )

  const syncComments = useCallback(
    (comments: Comment[]) => {
      send({ type: "SET_COMMENTS", payload: comments })
    },
    [send],
  )

  // Memoize the return so consumers that depend on the whole bridge
  // object in effect deps (the container's `syncComments` effect)
  // don't re-fire on every container render. Without this wrap the
  // effect re-runs whenever any state in the container changes and
  // re-posts SET_COMMENTS to the bridge — harmless but chatty.
  return useMemo(
    () => ({
      enterCommentMode,
      exitCommentMode,
      highlightComment,
      setShowResolved,
      setPinsHidden,
      syncComments,
      bridgeReadyEpoch,
      offTargetCommentIds,
    }),
    [
      enterCommentMode,
      exitCommentMode,
      highlightComment,
      setShowResolved,
      setPinsHidden,
      syncComments,
      bridgeReadyEpoch,
      offTargetCommentIds,
    ],
  )
}

/**
 * Compare two `CommentPosition['page']` values stripping trailing
 * slashes + query/hash so "/" and "/?foo=1" match for the
 * cross-page-navigation gate.
 */
function normalizePage(page: string): string {
  try {
    const parsed = new URL(page, "http://placeholder")
    return parsed.pathname.replace(/\/+$/, "") || "/"
  } catch {
    return page.split(/[?#]/)[0].replace(/\/+$/, "") || "/"
  }
}
