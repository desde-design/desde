"use client"

/**
 * Editor-scoped hook for the table-edge context menu.
 *
 * Activates the bridge's hover-band affordance (Google-Docs-style
 * row/column edge hover) for the iframe pointed at by `iframeRef`,
 * listens for `TABLE_EDGE_CONTEXT_MENU` events, and exposes the
 * current menu state plus a dispatcher that submits a structured
 * instruction into Editor chat.
 *
 * Lives outside `useBridge.ts` because that hook is wired to the
 * platform's shared app-store (comments / notes / inspector). The
 * table-edge feature is editor-only, so its state belongs in the
 * editor surface, not the global store.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { RefObject } from "react"
import type { TableEdgeContextMenuPayload } from "@/types/bridge"
import { buildTableEdgeInstruction, type TableEdgeAction } from "@/lib/table-edge-instruction"
import { isBridgeMessage, originOf } from "./bridge-message-guard"

export interface TableEdgeMenuState {
  /** The bridge payload describing the targeted row/column. */
  payload: TableEdgeContextMenuPayload
  /**
   * Anchor coordinates in *shell* viewport space. The bridge sends
   * iframe-local clientX/Y; we translate by the iframe's bounding rect
   * so the menu opens at the user's cursor in the shell, not at the
   * iframe origin.
   */
  shellAnchor: { x: number; y: number }
}

export interface UseTableEdgeMenuOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>
  /** Editor chat submitter — receives the structured instruction string. */
  submitChat: (message: string) => void | Promise<void>
  /**
   * Table-edge bands are a Select-mode affordance. When false (Navigate
   * mode), the overlay is deactivated in the bridge and any open menu is
   * dismissed — so the sky-blue row/column band never draws while the
   * user is just navigating the prototype.
   */
  active: boolean
}

export interface UseTableEdgeMenuReturn {
  menu: TableEdgeMenuState | null
  /** Close the menu without dispatching anything. */
  dismiss: () => void
  /** Submit the chosen action and close the menu. */
  runAction: (action: TableEdgeAction) => void
}

export function useTableEdgeMenu(
  opts: UseTableEdgeMenuOptions,
): UseTableEdgeMenuReturn {
  const { iframeRef, submitChat, active } = opts
  const [menu, setMenu] = useState<TableEdgeMenuState | null>(null)

  // Leaving Select mode dismisses any open band menu — it belongs to a
  // band that no longer draws. Done during render via the previous-value
  // pattern (not an effect) so there's no extra commit and no
  // set-state-in-effect lint violation.
  const [wasActive, setWasActive] = useState(active)
  if (wasActive !== active) {
    setWasActive(active)
    if (!active && menu) setMenu(null)
  }

  // Latest submitChat reference so the message-handler closure doesn't
  // go stale if the parent re-renders with a new identity. Sync via
  // effect so we don't mutate the ref during render.
  const submitChatRef = useRef(submitChat)
  useEffect(() => {
    submitChatRef.current = submitChat
  }, [submitChat])

  // Listen for the band's context-menu event and translate it into shell
  // menu state. Activation of the band overlay itself is owned by the
  // Vue3 adapter's Select-mode signal (it sends ACTIVATE/DEACTIVATE_
  // TABLE_EDGE_MENU alongside the inspector), so this hook no longer posts
  // activation — it only reacts. The `active` gate is defensive: if the
  // bridge ever delivers a menu while we're out of Select mode (a race on
  // a route reload before DEACTIVATE lands), we drop it.
  useEffect(() => {
    function handle(event: MessageEvent) {
      // S10: the payload's `source` marker is forgeable by any window, and this
      // handler renders a real, functional menu at attacker-chosen coordinates
      // — prime clickjacking bait. Authenticate on the sending window's
      // identity, plus the origin the shell pointed the frame at. That origin
      // comes from the iframe's own `src` attribute (shell-written, never
      // bridge-supplied); this hook receives no `prototypeUrl`, and the frame's
      // live location is both unreadable cross-origin and attacker-controlled
      // once relocated. Unknown `src` → source-identity check alone.
      if (
        !isBridgeMessage(event, iframeRef, {
          expectedOrigin: originOf(iframeRef.current?.src),
        })
      ) {
        return
      }
      const data = event.data as { type?: string; payload?: unknown }
      if (data.type !== "TABLE_EDGE_CONTEXT_MENU") return
      if (!active) return
      const payload = data.payload as TableEdgeContextMenuPayload
      const iframe = iframeRef.current
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
  }, [iframeRef, active])

  const dismiss = useCallback(() => setMenu(null), [])

  const runAction = useCallback(
    (action: TableEdgeAction) => {
      const current = menu
      if (!current) return
      const instruction = buildTableEdgeInstruction(action, current.payload)
      setMenu(null)
      void submitChatRef.current(instruction)
    },
    [menu],
  )

  return useMemo(() => ({ menu, dismiss, runAction }), [menu, dismiss, runAction])
}
