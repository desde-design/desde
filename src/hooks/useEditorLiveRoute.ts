"use client"

/**
 * Editor's live-route listener.
 *
 * Editor doesn't go through `useBridge`, so nothing else writes the current
 * iframe URL into the current-page slice. Without this, chat turns issued
 * after a SPA nav inside the iframe would send the shell's stale
 * `prototypeUrl` prop to the agent (typically the initial root URL the user
 * opened editor with). We listen for the bridge's `ROUTE_CHANGED` directly
 * and mirror `useBridge`'s slice update so `getCurrentSnapshot` /
 * `chat:get_page_info` see the real route. Source file resolution stays
 * simple: the Vue source-tag plugin stamps `data-page-source`, so the bridge
 * generally includes `sourceFile` in the payload; the non-Vue fallback that
 * useBridge does via the repo file tree isn't needed here.
 *
 * This hook READS the iframe's route. It never drives the iframe. Until
 * 2026-09-16 it also carried the "re-anchor" half of the detached-sessions
 * design: picking a chat in the session menu set the iframe's `src` to the
 * page that chat's last turn was pinned to, and re-selected the pinned
 * element once the bridge acked the navigation. That was a full reload of
 * the prototype as an unannounced side effect of switching chats (the menu
 * shows no route, so nothing warned the user), and the detail-panel "View in
 * iframe" button that was its explicit twin had already been removed. A
 * chat switch now changes the chat pane and nothing else.
 */

import { useEffect } from "react"
import type { RefObject } from "react"
import { useAppStore } from "@/stores"
import { mirrorLiveRouteToShellUrl } from "@/lib/editor-deeplink"
import { isBridgeMessage, originOf } from "./bridge-message-guard"

export interface EditorLiveRouteOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>
  /** The iframe's canonical/seeded URL (the `prototypeUrl` prop). */
  prototypeUrl: string
}

export function useEditorLiveRoute({
  iframeRef,
  prototypeUrl,
}: EditorLiveRouteOptions): void {
  const setCurrentPageInfo = useAppStore((s) => s.setCurrentPageInfo)

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
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [setCurrentPageInfo, prototypeUrl, iframeRef])
}
