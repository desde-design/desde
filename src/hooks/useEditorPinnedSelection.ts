"use client"

/**
 * Editor's live-route listener + pinned-selection re-anchor machinery
 * (Task 21, editor-audit-fixes-plan) — extracted verbatim from
 * `editor-surface.tsx`.
 *
 * Two responsibilities ride on ONE `ROUTE_CHANGED` listener, deliberately:
 *
 *  1. **Live-route mirroring.** Editor doesn't go through `useBridge`, so
 *     nothing else writes the current iframe URL into the current-page slice.
 *     Without this, chat turns issued after a SPA nav inside the iframe would
 *     send the shell's stale `prototypeUrl` prop to the agent (typically the
 *     initial root URL the user opened editor with). We listen for the
 *     bridge's `ROUTE_CHANGED` directly and mirror `useBridge`'s slice update
 *     so `getCurrentSnapshot` / `chat:get_page_info` see the real route. Source
 *     file resolution stays simple: the Vue source-tag plugin stamps
 *     `data-page-source`, so the bridge generally includes `sourceFile` in the
 *     payload; the non-Vue fallback that useBridge does via the repo file tree
 *     isn't needed here (editor is Vue-only today).
 *
 *  2. **Pinned-selection restoration** (Phase 3 follow-up of
 *     `tasks/editor-detached-sessions.md`). The detail-panel "View in iframe"
 *     button can ask us to land on a specific page AND re-select a specific
 *     element on that page. The iframe navigates first; once the bridge
 *     confirms the navigation via `ROUTE_CHANGED`, we fire `INSPECT_SELECTOR`
 *     via the adapter's selectBySelector path. The pending selection survives
 *     in a ref between the re-anchor click and the `ROUTE_CHANGED` ack.
 *
 * They share a listener because (1) is the ack (2) waits on — splitting them
 * into two subscriptions would reorder dispatch for no benefit.
 */

import { useCallback, useEffect, useRef } from "react"
import type { RefObject } from "react"
import type { ChatSessionSummary } from "@/editor/agent-chat/session-store"
import { useAppStore } from "@/stores"
import { mirrorLiveRouteToShellUrl } from "@/lib/editor-deeplink"
import { isBridgeMessage, originOf } from "./bridge-message-guard"

/**
 * If the navigation never completes (bridge didn't ack, user dismissed the
 * panel, etc.), clear the pending selection after this window so we don't fire
 * a stale selector against a wildly different page (e.g. the user manually
 * navigated elsewhere in the meantime).
 */
const PENDING_SELECTION_TIMEOUT_MS = 8_000

export interface EditorPinnedSelectionOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>
  /** The iframe's canonical/seeded URL (the `prototypeUrl` prop). */
  prototypeUrl: string
  /** `editing.handleLayerSelect` — dispatches INSPECT_SELECTOR for a selector. */
  selectBySelector: ((selector: string) => void | Promise<void>) | undefined
}

export interface EditorPinnedSelection {
  /** Re-anchor the iframe (and optionally the selection) to a session's pin. */
  onReAnchorToSession: (summary: ChatSessionSummary) => void
}

export function useEditorPinnedSelection({
  iframeRef,
  prototypeUrl,
  selectBySelector,
}: EditorPinnedSelectionOptions): EditorPinnedSelection {
  const setCurrentPageInfo = useAppStore((s) => s.setCurrentPageInfo)

  const pendingPinnedSelectionRef = useRef<{
    selector: string
    targetUrl: string
    timer: ReturnType<typeof setTimeout>
  } | null>(null)

  // Latest-ref idiom (see useShellBridgePoll.ts:35-48): `handleLayerSelect`
  // changes identity whenever the layers tree does, and the ROUTE_CHANGED
  // listener below must NOT re-subscribe for that. Written during render so a
  // ROUTE_CHANGED handled before the next commit never fires a stale selector
  // dispatcher.
  const selectBySelectorRef = useRef(selectBySelector)
  // eslint-disable-next-line react-hooks/refs
  selectBySelectorRef.current = selectBySelector

  const clearPendingPinnedSelection = useCallback(() => {
    const pending = pendingPinnedSelectionRef.current
    if (!pending) return
    clearTimeout(pending.timer)
    pendingPinnedSelectionRef.current = null
  }, [])

  useEffect(() => {
    return () => clearPendingPinnedSelection()
  }, [clearPendingPinnedSelection])

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // S10: this listener writes `currentPageUrl` / `currentSourceFile` (which
      // flow verbatim into the agent's `get_page_info`) and the shell's own
      // address bar, so it must not accept a forged ROUTE_CHANGED from an
      // arbitrary window. Gate on the sending window's identity plus the
      // canonical prototype origin — `prototypeUrl` is frozen by
      // `editor-page.tsx`, so it is a stable, bridge-uninfluenceable expectation.
      if (
        !isBridgeMessage(event, iframeRef, {
          expectedOrigin: originOf(prototypeUrl),
        })
      ) {
        return
      }
      const data = event.data as { type?: string; payload?: unknown }
      if (data.type !== "ROUTE_CHANGED") return
      const payload = data.payload as
        | { url?: string; sourceFile?: string }
        | undefined
      if (!payload?.url) return
      setCurrentPageInfo(payload.sourceFile ?? null, payload.url)
      // Mirror the live prototype route into the shell address bar so the URL
      // deeplinks to the current page and survives a hard refresh (main.tsx
      // restores the iframe from `?url=` on reload). The canonical (seeded)
      // dev-server origin is kept and only the live path/search/hash adopted —
      // `payload.url` may carry a per-session worktree origin that won't exist
      // after a reload. replaceState keeps it out of the history stack; the
      // frozen `prototypeUrl` prop (editor-page.tsx) ensures it never feeds
      // back into the iframe src. See mirrorLiveRouteToShellUrl (NEXT.md §9).
      const mirrored = mirrorLiveRouteToShellUrl(
        prototypeUrl,
        payload.url,
        window.location.href,
      )
      if (mirrored) {
        window.history.replaceState(window.history.state, "", mirrored)
      }
      // pinnedSelection follow-up: when the new route matches what
      // we asked for, fire the deferred selection. Url match is
      // exact-string — the panel passed us the same string the
      // bridge captured on the original turn, so equality is
      // reliable. If the routes diverge (user manually navigates
      // mid-flight), the pending selection is discarded silently;
      // the timeout covers the never-acked case too.
      const pending = pendingPinnedSelectionRef.current
      if (pending && pending.targetUrl === payload.url) {
        clearTimeout(pending.timer)
        pendingPinnedSelectionRef.current = null
        // Defer to a microtask so the bridge's post-navigation
        // setup (componentTree refresh, hover-event re-binding)
        // completes before INSPECT_SELECTOR queries the DOM. The
        // adapter handles its own retry / unresolved cases so we
        // don't need a poll-loop here.
        const { selector } = pending
        void Promise.resolve().then(() => {
          selectBySelectorRef.current?.(selector)
        })
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [setCurrentPageInfo, prototypeUrl, iframeRef])

  // Phase 3 — re-anchor the iframe to the picked session's pinned page.
  //
  // Codex 2026-05-26: the original implementation only called
  // setCurrentPageInfo() and assumed some listener would re-route the iframe.
  // Nothing does — currentPageUrl is read for chat context only. The iframe's
  // src is bound to `prototypeUrl` which doesn't change here. So we
  // imperatively set iframeRef.current.src for the actual navigation, then the
  // bridge's ROUTE_CHANGED handshake on the new page updates the current-page
  // slice + fires the pending pinned selection. React doesn't fight back
  // because prototypeUrl is stable across the re-anchor.
  const onReAnchorToSession = useCallback(
    (summary: ChatSessionSummary) => {
      if (!summary.pinnedPage) return
      const targetUrl = summary.pinnedPage.url
      // pinnedSelection restoration: when the session pinned a specific
      // element, queue an INSPECT_SELECTOR round-trip to fire after the
      // navigation settles (handled in the ROUTE_CHANGED listener above). When
      // the user is ALREADY on the target page (no navigation needed, no
      // ROUTE_CHANGED), fire the selection immediately via a microtask so the
      // click handler stays synchronous.
      clearPendingPinnedSelection()
      const liveUrl = useAppStore.getState().currentPageUrl
      const alreadyOnPage = liveUrl === targetUrl
      if (summary.pinnedSelection?.selector) {
        const { selector } = summary.pinnedSelection
        if (alreadyOnPage) {
          void Promise.resolve().then(() => {
            selectBySelectorRef.current?.(selector)
          })
        } else {
          const timer = setTimeout(() => {
            // Drop the pending selection if the bridge never acks the
            // navigation. Prevents firing a stale selector against an
            // unrelated page (user could manually navigate during the window).
            pendingPinnedSelectionRef.current = null
          }, PENDING_SELECTION_TIMEOUT_MS)
          pendingPinnedSelectionRef.current = {
            selector,
            targetUrl,
            timer,
          }
        }
      }
      if (!alreadyOnPage) {
        setCurrentPageInfo(summary.pinnedPage.sourceFile ?? null, targetUrl)
        // Drive the iframe — the load triggers the bridge's ROUTE_CHANGED
        // handshake which picks up pendingPinnedSelectionRef and dispatches
        // INSPECT_SELECTOR if a selector was queued.
        if (iframeRef.current) {
          iframeRef.current.src = targetUrl
        }
      }
    },
    [clearPendingPinnedSelection, iframeRef, setCurrentPageInfo],
  )

  return { onReAnchorToSession }
}
