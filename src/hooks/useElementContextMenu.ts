"use client"

/**
 * Editor-scoped hook for the element right-click menu.
 *
 * Listens for `ELEMENT_CONTEXT_MENU` events from the bridge's inspector
 * overlay, translates iframe-local anchor coordinates into shell-viewport
 * space, and exposes a controlled `{ menu, dismiss }` pair the menu
 * component consumes.
 *
 * Mirrors `useTableEdgeMenu` — same listener shape, same coord
 * translation, same `active`-gating pattern so the menu doesn't open
 * while the iframe isn't the foreground view (e.g. while the in-app
 * editor or canvas is overlaid).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { RefObject } from "react"
import type { ElementContextMenuPayload } from "@/types/bridge"
import { isBridgeMessage, originOf } from "./bridge-message-guard"

export interface ElementContextMenuState {
  payload: ElementContextMenuPayload
  shellAnchor: { x: number; y: number }
}

export interface UseElementContextMenuOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>
  /**
   * When false, incoming menu events are dropped and any open menu is
   * dismissed — used while the iframe is hidden behind the file-editor
   * or canvas overlay (the right-click can't be coming from the
   * prototype in that case).
   */
  active: boolean
}

export interface UseElementContextMenuReturn {
  menu: ElementContextMenuState | null
  dismiss: () => void
}

export function useElementContextMenu(
  opts: UseElementContextMenuOptions,
): UseElementContextMenuReturn {
  const { iframeRef, active } = opts
  const [menu, setMenu] = useState<ElementContextMenuState | null>(null)
  const iframeRefRef = useRef(iframeRef)
  useEffect(() => {
    iframeRefRef.current = iframeRef
  }, [iframeRef])
  const activeRef = useRef(active)
  useEffect(() => {
    activeRef.current = active
  }, [active])

  // Leaving foreground dismisses any open menu (mirrors useTableEdgeMenu).
  const [wasActive, setWasActive] = useState(active)
  if (wasActive !== active) {
    setWasActive(active)
    if (!active && menu) setMenu(null)
  }

  useEffect(() => {
    function handle(event: MessageEvent) {
      // S10: same reasoning as `useTableEdgeMenu` — the payload's `source`
      // marker is forgeable, and a forged ELEMENT_CONTEXT_MENU renders a real
      // menu wherever the sender asks. The listener is bound once (empty deps)
      // and reaches the ref through `iframeRefRef`, so read it here rather than
      // closing over a possibly-stale `iframeRef`. The expected origin comes
      // from the iframe's shell-written `src` attribute; unknown → the
      // `event.source` identity check alone.
      const currentIframeRef = iframeRefRef.current
      if (
        !isBridgeMessage(event, currentIframeRef, {
          expectedOrigin: originOf(currentIframeRef.current?.src),
        })
      ) {
        return
      }
      const data = event.data as {
        type?: string
        payload?: ElementContextMenuPayload
      }
      if (data.type !== "ELEMENT_CONTEXT_MENU") return
      if (!activeRef.current) return
      const payload = data.payload
      if (!payload) return
      const iframe = currentIframeRef.current
      if (!iframe) return
      const rect = iframe.getBoundingClientRect()
      setMenu({
        payload,
        shellAnchor: {
          x: rect.left + payload.menuAnchor.x,
          y: rect.top + payload.menuAnchor.y,
        },
      })
    }
    window.addEventListener("message", handle)
    return () => window.removeEventListener("message", handle)
  }, [])

  const dismiss = useCallback(() => setMenu(null), [])

  return useMemo(() => ({ menu, dismiss }), [menu, dismiss])
}
