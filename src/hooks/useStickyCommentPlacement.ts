"use client"

/**
 * Sticky comment placement: the Comment tool stays picked across pins, so the
 * user can drop several in a row without going back to the toolbar. This is
 * the Figma behaviour Mo asked for.
 *
 * ## Why this is only a re-arm, and needs no bridge change
 *
 * The bridge already un-arms itself after every pin. `AnchorPinsManager`
 * (`src/bridge/anchor-pins.ts`) calls `exitPlacementMode()` BEFORE it posts
 * `NEW_COMMENT_POSITION`. The shell used to mirror that by writing `navigate`
 * into `toolMode`, and THAT mirror is what ended the tool after one comment.
 * Dropping it leaves the tool picked, and this hook puts the bridge back in
 * step. Nothing under `src/bridge/` moves, which also keeps notes out of it:
 * `AnchorPinsManager` is shared by both surfaces.
 *
 * That ordering is now a contract the shell depends on, so it is written down
 * in `docs/bridge-protocol.md` § "New comment flow" as well as here. It is not
 * covered by a test on either side — see that note for why the shell cannot
 * observe it.
 *
 * ## Why re-arming on the composer CLOSING is the safe shape
 *
 * While the new-comment composer is open, the bridge is not armed, so a click
 * anywhere while the user is typing cannot drop a stray second pin under the
 * open form. Waiting for the composer to close buys that rather than costing
 * an extra suppression rule.
 *
 * This hook does not own that property on its own, and saying it did was
 * wrong. The bridge un-arms itself and this hook declines to re-arm, but two
 * OTHER shell paths could have armed it inside that window, so both were
 * closed to make the claim true:
 *
 * - The bridge handshake in `editor-surface.tsx` re-states the whole mode on
 *   every `BRIDGE_READY`. An iframe reload mid-compose is a handshake, so it
 *   now skips the re-state while `pendingPosition` is non-null.
 * - Focus mode unmounted the composer with the tool still armed. Hiding the
 *   chrome now drops to Navigate, so no pin can land there at all.
 *
 * What is NOT the mechanism: the composer's full-viewport dismiss backdrop
 * (`comment-thread-popup.tsx`). It happens to swallow a click over the iframe,
 * but it is a dismiss affordance, not a safety device, and the toolbar now
 * sits above it. Do not let it become the thing this claim rests on.
 *
 * ## Why an effect rather than a call at the clear site
 *
 * The composer's lifetime is `pendingPosition` on the comment slice, and it is
 * cleared from five places: the submit path, the X, the click-away backdrop
 * (all three in `src/components/comments/comment-thread-popup.tsx`), leaving
 * the Comment tool (`handleToolModeChange` in `editor-surface.tsx`, which also
 * covers hiding the chrome), and the note slice's mutual-exclusion writes. The
 * popup is a shared component that knows nothing about the bridge, and adding
 * a re-arm to each site is five places to remember. One effect on the
 * set-to-null transition covers every exit, including ones added later.
 *
 * The note exit is the one that is different in KIND, which is why it gets a
 * guard below rather than being counted as covered.
 */

import { useEffect, useRef } from "react"
import { useAppStore } from "@/stores"

/**
 * Re-arm comment placement when the new-comment composer closes, if the
 * Comment tool is still the picked one.
 *
 * @param syncToolModeToBridge `useEditorToolMode`'s "state the current mode
 * onto the bridge" call. Using it rather than a bare `enterCommentMode` keeps
 * one function responsible for what a mode implies on the wire, and it is
 * idempotent, so a re-assert costs a few postMessages and nothing else.
 */
export function useStickyCommentPlacement(
  syncToolModeToBridge: () => void,
): void {
  const pendingPosition = useAppStore((s) => s.pendingPosition)
  const composerOpenRef = useRef(false)

  useEffect(() => {
    const open = pendingPosition !== null
    const wasOpen = composerOpenRef.current
    composerOpenRef.current = open
    // Only the closing edge. Mount with no composer is not a close, and the
    // opening edge is where the bridge is meant to be un-armed.
    if (open || !wasOpen) return
    // Read the mode at the moment of the transition rather than depending on
    // it: the user may have left the tool while the composer was open (picked
    // Navigate, pressed Escape), and re-arming then would take them back into
    // a tool they had just put down.
    const state = useAppStore.getState()
    if (state.toolMode !== "comment") return
    // A note popup swapped the composer out rather than closing it. The note
    // slice clears `pendingPosition` for mutual exclusion (`setActiveNote`,
    // `setPendingNotePosition`), so this reads as a close, but the user now
    // has a note form open where the comment form was. Re-arming here would
    // put comment placement live behind that form, which is the exact stray-pin
    // condition the shape above exists to avoid. Not reachable while
    // EDITOR_NOTES is dormant; guarded so it does not become reachable by
    // someone flipping a flag.
    if (state.activeNoteId !== null || state.pendingNotePosition !== null) return
    syncToolModeToBridge()
  }, [pendingPosition, syncToolModeToBridge])
}
