import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { applyToolMode, useEditorToolMode } from "./useEditorToolMode"
import { useAppStore } from "@/stores"
import {
  selectCommentMode,
  selectSelectMode,
  type EditorToolMode,
} from "@/stores/tool-mode-slice"

function bridge() {
  return {
    setEditorActive: vi.fn(async () => {}),
    enterCommentMode: vi.fn(),
    exitCommentMode: vi.fn(),
  }
}

beforeEach(() => useAppStore.setState({ toolMode: "navigate" }))
afterEach(() => useAppStore.setState({ toolMode: "navigate" }))

describe("applyToolMode", () => {
  it("arms the inspector and leaves comment placement for Inspect", () => {
    const b = bridge()
    applyToolMode("select", b)
    expect(b.setEditorActive).toHaveBeenCalledWith(true)
    expect(b.exitCommentMode).toHaveBeenCalledTimes(1)
    expect(b.enterCommentMode).not.toHaveBeenCalled()
  })

  it("drops the inspector BEFORE arming comment placement", () => {
    const b = bridge()
    applyToolMode("comment", b)
    expect(b.setEditorActive).toHaveBeenCalledWith(false)
    expect(b.enterCommentMode).toHaveBeenCalledTimes(1)
    expect(b.exitCommentMode).not.toHaveBeenCalled()
    // Order is load-bearing. The bridge's ACTIVATE_INSPECTOR handler calls
    // `pins.exitPlacementMode()`, so an inspector message arriving after
    // ENTER_COMMENT_MODE would cancel the placement we just asked for.
    expect(b.setEditorActive.mock.invocationCallOrder[0]).toBeLessThan(
      b.enterCommentMode.mock.invocationCallOrder[0],
    )
  })

  it("turns both off for Navigate", () => {
    const b = bridge()
    applyToolMode("navigate", b)
    expect(b.setEditorActive).toHaveBeenCalledWith(false)
    expect(b.exitCommentMode).toHaveBeenCalledTimes(1)
  })

  it("survives a bridge with no adapter attached yet", () => {
    const b = { ...bridge(), setEditorActive: undefined }
    expect(() => applyToolMode("select", b)).not.toThrow()
  })

  it("swallows a rejected setEditorActive instead of leaving it unhandled", async () => {
    const b = {
      ...bridge(),
      setEditorActive: vi.fn(async () => {
        throw new Error("iframe gone")
      }),
    }
    expect(() => applyToolMode("select", b)).not.toThrow()
    await Promise.resolve()
  })
})

describe("useEditorToolMode", () => {
  it("requestToolMode writes the mode and states it to the bridge", () => {
    const b = bridge()
    const { result } = renderHook(() => useEditorToolMode(b))

    act(() => result.current.requestToolMode("comment"))
    expect(useAppStore.getState().toolMode).toBe("comment")
    expect(b.enterCommentMode).toHaveBeenCalledTimes(1)

    act(() => result.current.requestToolMode("select"))
    expect(useAppStore.getState().toolMode).toBe("select")
    expect(b.setEditorActive).toHaveBeenLastCalledWith(true)
    expect(b.exitCommentMode).toHaveBeenCalledTimes(1)
  })

  // DROP PATH 1 and 2. Turning Select on makes the bridge leave comment
  // placement by itself: `ACTIVATE_INSPECTOR` and `ENTER_EDITOR_MODE` both
  // call `pins.exitPlacementMode()`. The shell used to keep `commentMode`
  // true through that, so the Comment button stayed lit over a mode nobody
  // was in, and the next click on it tried to exit that mode and did
  // nothing visible.
  it("entering Select leaves comment mode, in the store and on the wire", () => {
    const b = bridge()
    const { result } = renderHook(() => useEditorToolMode(b))
    act(() => result.current.requestToolMode("comment"))

    act(() => result.current.requestToolMode("select"))

    expect(useAppStore.getState().toolMode).toBe("select")
    expect(selectCommentMode(useAppStore.getState())).toBe(false)
    expect(b.exitCommentMode).toHaveBeenCalledTimes(1)
  })

  it("entering comment mode leaves Select, the direction that already worked", () => {
    const b = bridge()
    const { result } = renderHook(() => useEditorToolMode(b))
    act(() => result.current.requestToolMode("select"))

    act(() => result.current.requestToolMode("comment"))

    expect(useAppStore.getState().toolMode).toBe("comment")
    expect(selectSelectMode(useAppStore.getState())).toBe(false)
    expect(b.setEditorActive).toHaveBeenLastCalledWith(false)
  })

  // DROP PATH 3. An iframe reload brings up a brand new bridge with no
  // placement overlay and no inspector overlay. The handshake is where the
  // mode the user is still looking at has to be stated again.
  it("syncToolModeToBridge re-states the live mode after a reload", () => {
    const b = bridge()
    const { result } = renderHook(() => useEditorToolMode(b))
    act(() => result.current.requestToolMode("comment"))
    b.enterCommentMode.mockClear()
    b.setEditorActive.mockClear()

    act(() => result.current.syncToolModeToBridge())

    expect(b.enterCommentMode).toHaveBeenCalledTimes(1)
    expect(b.setEditorActive).toHaveBeenCalledWith(false)
    expect(useAppStore.getState().toolMode).toBe("comment")
  })

  // The invariant the old two-boolean shape could not hold. There is one
  // field, so "Select and Comment are both on" is not a state that exists.
  it("cannot report Select and Comment on at the same time", () => {
    const modes: EditorToolMode[] = ["navigate", "select", "comment"]
    for (const mode of modes) {
      useAppStore.setState({ toolMode: mode })
      const state = useAppStore.getState()
      expect(selectSelectMode(state) && selectCommentMode(state)).toBe(false)
    }
  })
})
