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
import { validateIterationContext } from "@/editor/adapters/bridge/inspection-conversion"
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
  /**
   * The document the shell has handshaked with, or null when no page is
   * connected. `useEditorEditing` publishes it as `bridgeDocumentId`.
   *
   * This hook does not go through the adapter's message dispatch, so the
   * adapter's own foreign-message drop does not cover it. Two things are done
   * with the id here. A band menu event from another document is ignored, and
   * an open menu is dismissed the moment this value moves.
   *
   * Why the shell's value and not `adapter.bridgeDocumentId`: the adapter
   * announces a change through `onDocumentChanged` only for an UNSOLICITED
   * ready. A page that the shell handshaked with itself (an iframe `load` with
   * no ready of its own, or a re-attach) moves the id with no such event, so a
   * menu would survive it. `useEditorEditing` writes this value in
   * `enterDocument`, which is on both paths.
   */
  documentId: string | null
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
  const { iframeRef, submitChat, active, documentId } = opts
  const [menu, setMenu] = useState<TableEdgeMenuState | null>(null)

  // The page changing dismisses any open band menu. The band it belongs to is
  // gone with the document that drew it, and its selectors name elements
  // nobody can see. Done during render via the previous-value pattern, the
  // same way `active` is handled below, so there is no extra commit.
  const [lastDocumentId, setLastDocumentId] = useState(documentId)
  if (lastDocumentId !== documentId) {
    setLastDocumentId(documentId)
    if (menu) setMenu(null)
  }

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

  // The live document id, for `runAction` below. It has to be a ref and not
  // the closed-over `documentId`: the menu component holds the `runAction` it
  // was given when the menu opened, and a callback rebuilt on the page change
  // is not the one it is holding. Both halves of that stale closure name the
  // OLD page, so comparing them to each other always agrees.
  const documentIdRef = useRef(documentId)
  useEffect(() => {
    documentIdRef.current = documentId
  }, [documentId])

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
      const raw = data.payload as TableEdgeContextMenuPayload
      // From the page on screen, or not at all. A right-click posted just
      // before a navigation is read after it, and the menu it would open
      // names rows in a document that has gone. `documentId` being null means
      // no page is connected, so there is nothing this could be from.
      if (documentId === null || raw?.documentId !== documentId) return
      const iframe = iframeRef.current
      if (!iframe) return
      const rect = iframe.getBoundingClientRect()
      // Same gate the inspection and layers boundaries apply: an iteration
      // context that fails the shape check is DROPPED, so the instruction says
      // "none" rather than carrying page-written numbers and expressions into
      // a chat turn. Unlike an edit, nothing here routes on the context (it is
      // a hint for the agent), so dropping it is the whole refusal.
      const checked = validateIterationContext(raw.iterationContext)
      const payload: TableEdgeContextMenuPayload = checked.ok
        ? { ...raw, iterationContext: checked.value }
        : { ...raw, iterationContext: undefined }
      setMenu({
        payload,
        shellAnchor: {
          x: rect.left + raw.menuAnchor.x,
          y: rect.top + raw.menuAnchor.y,
        },
      })
    }
    window.addEventListener("message", handle)
    return () => window.removeEventListener("message", handle)
  }, [iframeRef, active, documentId])

  const dismiss = useCallback(() => setMenu(null), [])

  const runAction = useCallback(
    (action: TableEdgeAction) => {
      const current = menu
      if (!current) return
      // The last gate, and not a duplicate of the dismissal above. The
      // dismissal runs on the next render; a click handled in the same event
      // turn as the page change would otherwise submit an instruction built
      // from the departed page's selectors, and that instruction reaches a
      // chat turn that can write files.
      if (current.payload.documentId !== documentIdRef.current) {
        setMenu(null)
        return
      }
      const instruction = buildTableEdgeInstruction(action, current.payload)
      setMenu(null)
      void submitChatRef.current(instruction)
    },
    [menu],
  )

  return useMemo(() => ({ menu, dismiss, runAction }), [menu, dismiss, runAction])
}
