/**
 * Tests for ResizableRail's drag mechanics, focused on the pointer-events
 * conversion: the handle must capture the pointer on pointerdown so
 * pointermove/pointerup route to it directly (fixes the rail stalling /
 * getting stuck armed when the drag crosses the prototype iframe, which
 * swallows plain mousemove/mouseup).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent, act } from "@testing-library/react"
import { ResizableRail } from "./resizable-rail"

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
})

function getRail(): HTMLElement {
  return screen.getByTestId("resizable-rail-handle").nextElementSibling as HTMLElement
}

function getWidth(): number {
  return parseFloat(getRail().style.width)
}

/** jsdom's viewport is 1024 wide and not writable by assignment. */
function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true,
  })
}

describe("ResizableRail default width", () => {
  afterEach(() => {
    setViewportWidth(1024)
  })

  it("defaults to 20% of the viewport when nothing is stored", () => {
    setViewportWidth(2560)
    render(
      <ResizableRail storageKey="test.rail.default">
        <div>content</div>
      </ResizableRail>,
    )
    expect(getWidth()).toBe(512)
  })

  it("clamps the viewport default to [minWidth, maxWidth]", () => {
    setViewportWidth(1024)
    const { unmount } = render(
      <ResizableRail storageKey="test.rail.default">
        <div>content</div>
      </ResizableRail>,
    )
    // 20% of 1024 is 205, under the 280 floor.
    expect(getWidth()).toBe(280)
    unmount()
    setViewportWidth(4000)
    render(
      <ResizableRail storageKey="test.rail.default">
        <div>content</div>
      </ResizableRail>,
    )
    // 20% of 4000 is 800, over the 640 ceiling.
    expect(getWidth()).toBe(640)
  })

  it("prefers a stored width over the viewport default", () => {
    setViewportWidth(2560)
    window.localStorage.setItem("test.rail.default", "300")
    render(
      <ResizableRail storageKey="test.rail.default">
        <div>content</div>
      </ResizableRail>,
    )
    expect(getWidth()).toBe(300)
  })

  it("honours a fixed defaultWidth", () => {
    setViewportWidth(2560)
    render(
      <ResizableRail storageKey="test.rail.default" defaultWidth={320}>
        <div>content</div>
      </ResizableRail>,
    )
    expect(getWidth()).toBe(320)
  })
})

describe("ResizableRail drag", () => {

  it("captures the pointer on pointerdown so the drag survives an iframe underneath", () => {
    render(
      <ResizableRail storageKey="test.rail.capture" defaultWidth={320}>
        <div>content</div>
      </ResizableRail>,
    )
    const handle = screen.getByTestId("resizable-rail-handle")
    const captureSpy = vi.spyOn(handle, "setPointerCapture")
    fireEvent.pointerDown(handle, { pointerId: 7, clientX: 500 })
    expect(captureSpy).toHaveBeenCalledWith(7)
  })

  it("widens when dragging left and persists the new width", () => {
    render(
      <ResizableRail storageKey="test.rail.widen" defaultWidth={320}>
        <div>content</div>
      </ResizableRail>,
    )
    const handle = screen.getByTestId("resizable-rail-handle")
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 500 })
    // Pointer capture retargets subsequent events to the handle — dispatch
    // there directly (mirrors real capture behavior; jsdom's polyfill is a
    // no-op, so this is what actually exercises the listener).
    act(() => {
      handle.dispatchEvent(
        new PointerEvent("pointermove", { pointerId: 1, clientX: 460 }),
      )
    })
    // Moving left by 40px widens the rail by 40px (320 -> 360).
    expect(getWidth()).toBe(360)
    expect(window.localStorage.getItem("test.rail.widen")).toBe("360")

    act(() => {
      handle.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }))
    })
    // Further movement after pointerup must be ignored.
    act(() => {
      handle.dispatchEvent(
        new PointerEvent("pointermove", { pointerId: 1, clientX: 300 }),
      )
    })
    expect(getWidth()).toBe(360)
  })

  it("clamps to [minWidth, maxWidth]", () => {
    render(
      <ResizableRail
        storageKey="test.rail.clamp"
        defaultWidth={320}
        minWidth={280}
        maxWidth={640}
      >
        <div>content</div>
      </ResizableRail>,
    )
    const handle = screen.getByTestId("resizable-rail-handle")
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 500 })
    act(() => {
      // Drag far right (narrows well past the min).
      handle.dispatchEvent(
        new PointerEvent("pointermove", { pointerId: 1, clientX: 5000 }),
      )
    })
    expect(getWidth()).toBe(280)
  })

  it("ends the drag on pointercancel (e.g. the iframe steals the gesture)", () => {
    render(
      <ResizableRail storageKey="test.rail.cancel" defaultWidth={320}>
        <div>content</div>
      </ResizableRail>,
    )
    const handle = screen.getByTestId("resizable-rail-handle")
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 500 })
    act(() => {
      handle.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }))
    })
    const before = getWidth()
    // A stuck `dragging` flag (the bug being fixed) would keep tracking
    // pointer position with the button up; this must now be a no-op.
    act(() => {
      handle.dispatchEvent(
        new PointerEvent("pointermove", { pointerId: 1, clientX: 100 }),
      )
    })
    expect(getWidth()).toBe(before)
  })

  it("ends the drag on lostpointercapture as a safety net", () => {
    render(
      <ResizableRail storageKey="test.rail.lost-capture" defaultWidth={320}>
        <div>content</div>
      </ResizableRail>,
    )
    const handle = screen.getByTestId("resizable-rail-handle")
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 500 })
    act(() => {
      handle.dispatchEvent(
        new PointerEvent("lostpointercapture", { pointerId: 1 }),
      )
    })
    const before = getWidth()
    act(() => {
      handle.dispatchEvent(
        new PointerEvent("pointermove", { pointerId: 1, clientX: 100 }),
      )
    })
    expect(getWidth()).toBe(before)
  })
})
