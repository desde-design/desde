// @vitest-environment jsdom

/**
 * The rail's view-state controls, on the wire.
 *
 * These exist because the surface gallery CANNOT check them. Its fake
 * prototype page never sends `BRIDGE_READY`, so `bridgeReadyEpoch` stays 0
 * and every outbound message in `review-shell.tsx` is gated off — clicking
 * "Hide comment pins" or "Show resolved" there flips the button and posts
 * nothing at all. MEASURED while adding the pins toggle on 2026-08-20: zero
 * messages left the shell for either control, which looks identical to a
 * broken control.
 *
 * So the gallery proves these buttons LOOK right and this file proves they
 * SAY anything. `setShowResolved` is asserted alongside `setPinsHidden` on
 * purpose: it was already shipping, so it is the control that tells a future
 * failure here apart from a change in the hook's shared plumbing.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import { useViewerBridge } from "../use-viewer-bridge"
import { BRIDGE_READY, frameRef, LOOPBACK_EMBED, makeFakeFrame } from "./fake-bridge-frame"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("useViewerBridge — view state out", () => {
  it("posts SET_PINS_HIDDEN with the flag, both ways", () => {
    const frame = makeFakeFrame()
    const { result } = renderHook(() => useViewerBridge(frameRef(frame), LOOPBACK_EMBED))

    act(() => result.current.setPinsHidden(true))
    act(() => result.current.setPinsHidden(false))

    const pins = frame.posted.filter((m) => m.type === "SET_PINS_HIDDEN")
    expect(pins.map((m) => m.payload)).toEqual([true, false])
  })

  it("posts SET_SHOW_RESOLVED with the flag, both ways", () => {
    const frame = makeFakeFrame()
    const { result } = renderHook(() => useViewerBridge(frameRef(frame), LOOPBACK_EMBED))

    act(() => result.current.setShowResolved(true))
    act(() => result.current.setShowResolved(false))

    const resolved = frame.posted.filter((m) => m.type === "SET_SHOW_RESOLVED")
    expect(resolved.map((m) => m.payload)).toEqual([true, false])
  })

  /**
   * Hiding the pins must not disturb the rail's list. The two are separate
   * concerns wired to the same panel, and the whole point of the control is
   * that you keep reading comments while the overlay is out of the way.
   */
  it("does not touch the comment list when pins are hidden", () => {
    const frame = makeFakeFrame()
    const { result } = renderHook(() => useViewerBridge(frameRef(frame), LOOPBACK_EMBED))
    act(() => {
      frame.emit(BRIDGE_READY)
    })
    frame.posted.length = 0

    act(() => result.current.setPinsHidden(true))

    expect(frame.posted.map((m) => m.type)).toEqual(["SET_PINS_HIDDEN"])
  })
})
