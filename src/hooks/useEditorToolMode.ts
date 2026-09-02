"use client"

/**
 * The one place that turns a tool mode into bridge messages.
 *
 * The shell's `toolMode` (`src/stores/tool-mode-slice.ts`) is the user's
 * choice of tool. It is NOT a mirror of the bridge — read that file before
 * relying on the two agreeing. It used to be described as a mirror here, and
 * sticky comment placement (2026-08-14) made that false on purpose: after a
 * pin lands, the tool is still Comment while the bridge is deliberately not
 * armed.
 *
 * Keeping the bridge in step is still harder than it sounds, because the
 * bridge leaves comment placement on its own in several situations and only
 * tells the shell about one of them:
 *
 * 1. `ACTIVATE_INSPECTOR` calls `pins.exitPlacementMode()`
 *    (`src/bridge/comment-bridge.ts`). Turning Select on ends comment
 *    placement, silently.
 * 2. `ENTER_EDITOR_MODE` does the same, one case further down the same
 *    switch. The adapter sends both in one batch from `setActive(true)`, so
 *    they usually fire together, but either one alone is enough.
 * 3. `ENTER_NOTE_MODE` does the same again. Adding a note ends comment
 *    placement, silently.
 * 4. Escape during placement. The bridge DOES post `EXIT_COMMENT_MODE` back
 *    to the shell here, but nothing was listening for it, so the effect was
 *    the same as the silent cases.
 * 5. An iframe reload. The bridge IIFE re-runs with a fresh placement
 *    overlay, so whatever was armed before is gone.
 * 6. A PLACED PIN. `AnchorPinsManager` un-arms itself before posting
 *    `NEW_COMMENT_POSITION`. This is now the most common of the six, and it
 *    is the one case where the shell deliberately does NOT follow the bridge
 *    down: the tool stays Comment.
 *
 * Cases 1 to 3 are why `applyToolMode` ASSERTS the target mode rather than
 * diffing against the mode the shell used to hold. A diff assumes the bridge
 * is where the shell last left it, and that assumption is exactly what broke.
 * Every bridge call it makes is idempotent (`PlacementOverlay.activate` and
 * `deactivate` both return early when already in that state, and the adapter
 * just re-sends its activation set), so re-asserting costs a few postMessages
 * and buys the ability to re-assert at any moment, including case 5.
 *
 * Cases 4 to 6 are handled by three consumers:
 * - `useEditorCommentBridge` listens for the bridge's `EXIT_COMMENT_MODE` and
 *   drops the mode (case 4).
 * - `EditorSurface` calls `syncToolModeToBridge` on every bridge handshake
 *   (case 5). It skips that while a new-comment composer is open, so a reload
 *   mid-compose cannot arm placement under the form.
 * - `useStickyCommentPlacement` calls `syncToolModeToBridge` when that
 *   composer closes (case 6).
 *
 * So "the Comment segment is lit but clicking drops no pin" is a DESIGNED
 * state, not a corrupt store, for as long as a composer is open.
 *
 * Deliberately NOT built on `SET_TOOL_MODE`. That message is documented in
 * docs/bridge-protocol.md with a 'default' | 'inspecting' | 'commenting'
 * payload and has zero senders and zero handlers in the repo. It is spec, not
 * mechanism. The live mechanism is ENTER_COMMENT_MODE / EXIT_COMMENT_MODE
 * plus the adapter's `setEditorActive`.
 */

import { useCallback, useEffect, useRef } from "react"
import { useAppStore } from "@/stores"
import type { EditorToolMode } from "@/stores/tool-mode-slice"

export interface ToolModeBridge {
  /**
   * Drives the bridge's inspector overlay through the framework adapter.
   * Optional because the adapter is not attached until the bridge
   * handshakes.
   */
  setEditorActive?: (active: boolean) => Promise<void>
  /** Posts `ENTER_COMMENT_MODE`. */
  enterCommentMode: () => void
  /** Posts `EXIT_COMMENT_MODE`. */
  exitCommentMode: () => void
}

/**
 * Put the bridge into `mode`, stating the whole target rather than the
 * difference from some previous state.
 *
 * Order matters when entering comment mode: the inspector teardown goes out
 * first, so the bridge is out of Select before the placement overlay arms.
 * The reverse order would let `ACTIVATE_INSPECTOR` land after
 * `ENTER_COMMENT_MODE` and cancel the placement we just asked for.
 */
export function applyToolMode(mode: EditorToolMode, bridge: ToolModeBridge): void {
  bridge.setEditorActive?.(mode === "select")?.catch(() => {})
  if (mode === "comment") bridge.enterCommentMode()
  else bridge.exitCommentMode()
}

export interface EditorToolModeApi {
  /** The picked tool. Select is `select`; comment placement is `comment`. */
  toolMode: EditorToolMode
  /**
   * Change the mode from the shell: writes the store AND asserts the new
   * mode onto the bridge. This is the only way a user action should move the
   * mode.
   */
  requestToolMode: (next: EditorToolMode) => void
  /**
   * Re-assert the current mode onto the bridge. For the handshake: a
   * reloaded iframe has a brand new bridge that knows nothing about the mode
   * the user is in.
   */
  syncToolModeToBridge: () => void
}

export function useEditorToolMode(bridge: ToolModeBridge): EditorToolModeApi {
  const toolMode = useAppStore((s) => s.toolMode)

  // The deps object is rebuilt every render by the caller. Holding it in a
  // ref keeps both callbacks stable, which matters because they are handed
  // to the memoized Comments panel and to the toolbar. Updated in an effect
  // rather than during render: the only readers are event handlers and the
  // handshake effect, both of which run after commit.
  const bridgeRef = useRef(bridge)
  useEffect(() => {
    bridgeRef.current = bridge
  })

  const requestToolMode = useCallback((next: EditorToolMode) => {
    useAppStore.getState().setToolMode(next)
    applyToolMode(next, bridgeRef.current)
  }, [])

  const syncToolModeToBridge = useCallback(() => {
    applyToolMode(useAppStore.getState().toolMode, bridgeRef.current)
  }, [])

  return { toolMode, requestToolMode, syncToolModeToBridge }
}
