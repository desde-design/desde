import { type StateCreator } from "zustand"

/**
 * Which tool owns a click in the prototype iframe. ONE field, three values,
 * because the iframe genuinely has one active tool at a time.
 *
 * - `navigate` — clicks drive the prototype. No inspector overlay, no pin
 *   placement.
 * - `select` — Select. The bridge's inspector overlay is armed and a click
 *   selects an element.
 * - `comment` — comment placement. The bridge's placement overlay is armed
 *   and a click drops a pin.
 *
 * This used to be two booleans: a local `iframeMode` state in `EditorSurface`
 * and `commentMode` on the comment slice. They were only exclusive in one
 * direction. Entering comment mode dropped Select, but entering Select left
 * `commentMode` true while the bridge had already torn the placement overlay
 * down, so the toolbar's Comment button stayed lit and the next click on it
 * tried to exit a mode nobody was in. Two flags that must never both be true
 * is the shape that produced that bug, so there is now one flag that cannot
 * express the invalid state.
 *
 * ## What this field means: WHICH TOOL IS SELECTED
 *
 * It is the user's choice of tool, not a readout of the bridge. The bridge's
 * armed-ness is DERIVED from it: `applyToolMode`
 * (`src/hooks/useEditorToolMode.ts`) states the whole target mode onto the
 * bridge, and re-states it whenever the bridge could have drifted.
 *
 * This used to be documented as a mirror of the bridge. That stopped being
 * exactly true when comment placement became sticky (2026-08-14), so the
 * window where the two differ is written down here rather than left to be
 * rediscovered.
 *
 * ## The one window where the field and the bridge disagree
 *
 * Placing a comment pin un-arms the bridge by itself: `AnchorPinsManager`
 * (`src/bridge/anchor-pins.ts`) calls `exitPlacementMode()` BEFORE it posts
 * `NEW_COMMENT_POSITION`. The shell no longer follows it down to `navigate`.
 * So between a pin landing and its composer closing, this field says `comment`
 * while the bridge is deliberately not armed.
 *
 * That gap is the feature, not a leak. It is what Figma does: the comment tool
 * stays selected while you type. `useStickyCommentPlacement`
 * (`src/hooks/useStickyCommentPlacement.ts`) re-arms the bridge when the
 * composer closes.
 *
 * A click while the composer is open also cannot drop a stray second pin. That
 * is a consequence of the gap, but it is NOT free and it is not this file's to
 * promise: two other shell paths could have armed the bridge inside the window
 * and had to be closed for it to hold. Both are named in the hook's header.
 * Read that before changing either of them.
 *
 * This is not the bug the old two-boolean design had. That was two flags that
 * could contradict each other, in either direction, for an unbounded time, with
 * no single owner. This is ONE flag, one owner, and a lag that is deliberate,
 * closed by a named hook, and bounded because a composer is always mounted
 * when a pin can land.
 *
 * That last clause is a precondition, not an observation. It held only after
 * focus mode was fixed (2026-08-14). `CommentThreadPopup` mounts inside the
 * right rail, the right rail unmounts in focus mode, and hiding the chrome
 * used to leave the bridge armed — so a pin could land with no composer in
 * existence, nothing could clear `pendingPosition`, and the window was
 * unbounded. Hiding the chrome now puts the tool down. If some future surface
 * hides the rail while leaving a tool armed, this sentence stops being true
 * and the window comes back.
 *
 * ## Writers
 *
 * Most writers either assert the mode onto the bridge (`requestToolMode`) or
 * react to the bridge having already moved (Escape during placement posts
 * `EXIT_COMMENT_MODE`, and the shell drops to `navigate`). There are exactly
 * two store-only writes, and both are legitimate because there is no bridge to
 * talk to at that instant:
 *
 * - `EditorSurface`'s mount effect resets to `navigate`. The freshly mounted
 *   iframe has no bridge yet; the handshake effect states the mode once there
 *   is one.
 * - `useEditorNoteBridge`'s `enterNoteMode`. The bridge's `ENTER_NOTE_MODE`
 *   handler drops comment placement itself, so asking it to would be asking
 *   for something it is already doing.
 *
 * Both are predictions about the bridge rather than reactions to it, which is
 * the risky shape. Adding a third means proving the same thing again, so add
 * it to this list rather than leaving the next person to find the precedent.
 */
export type EditorToolMode = "navigate" | "select" | "comment"

export interface ToolModeSlice {
  toolMode: EditorToolMode
  /**
   * Write the mode WITHOUT touching the bridge. This is the reaction path:
   * use it when the bridge has already left a mode and the shell is catching
   * up (an Escape out of placement, a mode the bridge refused).
   *
   * A placed pin is NOT one of those cases any more. The bridge un-arms
   * itself there, but the TOOL is still Comment, so nothing writes the mode
   * and `useStickyCommentPlacement` re-arms the bridge instead.
   *
   * To CHANGE the mode from the shell, go through `requestToolMode` from
   * `useEditorToolMode` instead. That one posts the bridge messages the new
   * mode implies, which is the half this setter deliberately does not do.
   */
  setToolMode: (next: EditorToolMode) => void
}

export const createToolModeSlice: StateCreator<
  ToolModeSlice,
  [],
  [],
  ToolModeSlice
> = (set) => ({
  toolMode: "navigate",
  setToolMode: (next) => set({ toolMode: next }),
})

/**
 * "Is the Comment tool picked", for controls that draw a boolean rather than
 * the whole mode. One caller today: the Comments panel's `CommentModeButton`.
 * The toolbar's picker reads `toolMode` itself, because it draws all three
 * values. Both come off this one field, so they cannot drift from each other
 * or from Select.
 */
export const selectCommentMode = (s: ToolModeSlice): boolean =>
  s.toolMode === "comment"

/**
 * The same for the Select tool. The doubled word is the price of the value
 * being named `select`: the first is the Zustand selector prefix its sibling
 * above uses, the second is the tool. It was `selectInspectMode` until
 * 2026-08-14, which was the last place in the code that still called the
 * middle tool Inspect.
 */
export const selectSelectMode = (s: ToolModeSlice): boolean =>
  s.toolMode === "select"
