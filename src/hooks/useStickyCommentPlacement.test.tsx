import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useEditorCommentBridge } from "./useEditorCommentBridge"
import { useEditorToolMode } from "./useEditorToolMode"
import { useStickyCommentPlacement } from "./useStickyCommentPlacement"
import { changeToolMode } from "@/components/editor/change-tool-mode"
import { useAppStore } from "@/stores"

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))

/**
 * Sticky comment placement, driven through the SAME chain `EditorSurface`
 * wires: the real comment bridge listening to a real `NEW_COMMENT_POSITION`
 * message, the real tool-mode hook, and the sticky hook on top. A harness that
 * re-implemented any of the three would prove nothing about the feature.
 *
 * The only stub is the wire itself: `setEditorActive` / `enterCommentMode` /
 * `exitCommentMode` are spies, so "the bridge is armed" is checkable as
 * "ENTER_COMMENT_MODE went out".
 */

function makeIframeRef(): {
  ref: { current: HTMLIFrameElement | null }
  contentWindow: object
} {
  const contentWindow = { postMessage: vi.fn() }
  const ref = {
    current: { contentWindow, src: undefined } as unknown as HTMLIFrameElement,
  }
  return { ref, contentWindow }
}

function emitBridgeMessage(
  source: object,
  type: string,
  payload: Record<string, unknown>,
): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: "desde-bridge", type, payload },
      source: source as Window,
    }),
  )
}

function setup() {
  const { ref, contentWindow } = makeIframeRef()
  const wire = {
    enterCommentMode: vi.fn<() => void>(),
    exitCommentMode: vi.fn<() => void>(),
  }

  const { result } = renderHook(() => {
    useEditorCommentBridge(ref)
    const toolMode = useEditorToolMode({
      setEditorActive: async () => {},
      enterCommentMode: wire.enterCommentMode,
      exitCommentMode: wire.exitCommentMode,
    })
    useStickyCommentPlacement(toolMode.syncToolModeToBridge)
    return toolMode
  })

  return {
    wire,
    /** Pick the Comment tool, the way the toolbar's picker does. */
    pickComment: () => act(() => result.current.requestToolMode("comment")),
    pickNavigate: () => act(() => result.current.requestToolMode("navigate")),
    /**
     * Leave the tool the way the workspace does it, through the policy
     * `EditorSurface` hands to the toolbar's picker, the Comments panel's
     * button and the hide-chrome button alike. Entering focus mode is this
     * call plus `setChromeHidden(true)`.
     */
    leaveTool: () =>
      act(() => {
        changeToolMode("navigate", {
          resolving: false,
          resolveFailed: false,
          setToolMode: result.current.requestToolMode,
          closeNewCommentComposer: () =>
            useAppStore.getState().setPendingPosition(null),
        })
      }),
    /** The user clicks in the prototype and the bridge reports a pin. */
    placePin: (selector: string) =>
      act(() => {
        emitBridgeMessage(contentWindow, "NEW_COMMENT_POSITION", {
          anchorSelector: selector,
          page: "/login",
        })
      }),
    /** The composer closes: submitted, dismissed, or clicked away from. */
    closeComposer: () =>
      act(() => {
        useAppStore.getState().setPendingPosition(null)
      }),
    /** Escape during placement — the bridge tells the shell it has left. */
    pressEscapeInPrototype: () =>
      act(() => {
        emitBridgeMessage(contentWindow, "EXIT_COMMENT_MODE", {})
      }),
    mode: () => useAppStore.getState().toolMode,
    pending: () => useAppStore.getState().pendingPosition,
  }
}

const CLEAN = {
  toolMode: "navigate" as const,
  pendingPosition: null,
  activeCommentId: null,
  popupAnchorRect: null,
  activeNoteId: null,
  pendingNotePosition: null,
}

beforeEach(() => useAppStore.setState(CLEAN))
afterEach(() => useAppStore.setState(CLEAN))

describe("sticky comment placement", () => {
  // The feature. Figma keeps the comment tool selected so you can drop
  // several pins in a row; this is that, end to end.
  it("re-arms the bridge when the composer closes, so a second pin lands without touching the control", () => {
    const t = setup()

    t.pickComment()
    expect(t.wire.enterCommentMode).toHaveBeenCalledTimes(1)

    t.placePin(".first")
    // The bridge un-armed itself when the pin landed, so nothing is re-armed
    // while the user is typing.
    expect(t.pending()).toMatchObject({ anchorSelector: ".first" })
    expect(t.wire.enterCommentMode).toHaveBeenCalledTimes(1)

    t.closeComposer()
    expect(t.wire.enterCommentMode).toHaveBeenCalledTimes(2)

    // A SECOND pin, with no trip back to the toolbar in between.
    t.placePin(".second")
    expect(t.pending()).toMatchObject({ anchorSelector: ".second" })
    expect(t.mode()).toBe("comment")

    t.closeComposer()
    expect(t.wire.enterCommentMode).toHaveBeenCalledTimes(3)
  })

  // The regression this replaced: the shell mirrored the bridge's own
  // un-arming into `navigate`, which ended the TOOL after one comment.
  it("placing a pin does not leave the tool, and the mode holds while the composer is open", () => {
    const t = setup()

    t.pickComment()
    t.placePin(".btn")

    expect(t.mode()).toBe("comment")
    expect(t.wire.exitCommentMode).not.toHaveBeenCalled()
  })

  // Escape still means "put the tool down", not "put it down for one pin".
  it("Escape during placement exits to navigate", () => {
    const t = setup()

    t.pickComment()
    t.pressEscapeInPrototype()

    expect(t.mode()).toBe("navigate")
  })

  // The window the sticky design opens: the user can leave the tool while the
  // composer is still open. Re-arming then would drag them back into a tool
  // they had just put down.
  it("does not re-arm when the user left the tool while the composer was open", () => {
    const t = setup()

    t.pickComment()
    t.placePin(".btn")
    t.pickNavigate()
    const armedBefore = t.wire.enterCommentMode.mock.calls.length

    t.closeComposer()

    expect(t.wire.enterCommentMode).toHaveBeenCalledTimes(armedBefore)
    expect(t.mode()).toBe("navigate")
  })

  // The unbounded-window defect. `CommentThreadPopup` mounts inside the right
  // rail, and focus mode unmounts the rail AND the picker, so a pin landing
  // there left `toolMode` on `comment` against an un-armed bridge with nothing
  // in existence able to clear `pendingPosition`. Entering focus mode now runs
  // this exact call first, so the bridge is disarmed and no pin can land.
  //
  // Every assertion here fails if the tool is only "cleared" rather than put
  // down through the normal path: without `exitCommentMode` the bridge stays
  // armed, and without the composer close a stale one springs open when the
  // chrome comes back.
  it("leaving the tool disarms the bridge and takes the open composer with it", () => {
    const t = setup()

    t.pickComment()
    t.placePin(".btn")
    expect(t.pending()).not.toBeNull()
    const armedBefore = t.wire.enterCommentMode.mock.calls.length

    t.leaveTool()

    expect(t.mode()).toBe("navigate")
    expect(t.wire.exitCommentMode).toHaveBeenCalled()
    expect(t.pending()).toBeNull()
    // And the composer closing must not re-arm on the way out.
    expect(t.wire.enterCommentMode).toHaveBeenCalledTimes(armedBefore)
  })

  // Not every clear of `pendingPosition` is a close. The note slice clears it
  // for mutual exclusion, so opening a note SWAPS the composer out: the user
  // now has a note form where the comment form was. Re-arming there would put
  // comment placement live behind that form, which is the stray-pin condition
  // the whole shape exists to avoid. Notes are dormant, so this guards a door
  // rather than fixing a live bug.
  it("does not re-arm when a note popup replaced the composer", () => {
    const t = setup()

    t.pickComment()
    t.placePin(".btn")
    const armedBefore = t.wire.enterCommentMode.mock.calls.length

    act(() => useAppStore.getState().setActiveNote("note-1"))

    expect(t.pending()).toBeNull()
    expect(t.wire.enterCommentMode).toHaveBeenCalledTimes(armedBefore)
  })

  // Only the closing edge. A composer that was never open is not a close, and
  // mounting in comment mode must not fire a second arm on its own.
  it("does not re-arm on mount, or on the composer opening", () => {
    const t = setup()

    t.pickComment()
    const afterPick = t.wire.enterCommentMode.mock.calls.length

    t.placePin(".btn")

    expect(t.wire.enterCommentMode).toHaveBeenCalledTimes(afterPick)
  })
})
