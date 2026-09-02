import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { render, screen, fireEvent, act } from "@testing-library/react"
import { ResizableVerticalSplit } from "./resizable-vertical-split"

// localStorage polyfill lives in src/test-setup.ts.

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
})

function getRatio(): number {
  const el = screen.getByTestId("resizable-vertical-split")
  const value = el.getAttribute("data-ratio")
  return value ? parseFloat(value) : NaN
}

describe("ResizableVerticalSplit targetRatio", () => {
  it("uses targetRatio over defaultRatio when nothing is stored", () => {
    render(
      <ResizableVerticalSplit
        top={<div>top</div>}
        bottom={<div>bottom</div>}
        defaultRatio={0.5}
        targetRatio={0.7}
        storageKey="test.split.target-vs-default"
      />,
    )
    expect(getRatio()).toBeCloseTo(0.7, 3)
  })

  it("falls back to defaultRatio when targetRatio is undefined", () => {
    render(
      <ResizableVerticalSplit
        top={<div>top</div>}
        bottom={<div>bottom</div>}
        defaultRatio={0.6}
        storageKey="test.split.default-fallback"
      />,
    )
    expect(getRatio()).toBeCloseTo(0.6, 3)
  })

  it("ignores targetRatio when a stored manual override exists", () => {
    window.localStorage.setItem("test.split.manual-override", "0.4")
    render(
      <ResizableVerticalSplit
        top={<div>top</div>}
        bottom={<div>bottom</div>}
        defaultRatio={0.5}
        targetRatio={0.8}
        storageKey="test.split.manual-override"
      />,
    )
    expect(getRatio()).toBeCloseTo(0.4, 3)
  })

  it("re-applies a new targetRatio when no manual override is recorded", () => {
    const { rerender } = render(
      <ResizableVerticalSplit
        top={<div>top</div>}
        bottom={<div>bottom</div>}
        defaultRatio={0.5}
        targetRatio={0.3}
        storageKey="test.split.dynamic-target"
      />,
    )
    expect(getRatio()).toBeCloseTo(0.3, 3)

    rerender(
      <ResizableVerticalSplit
        top={<div>top</div>}
        bottom={<div>bottom</div>}
        defaultRatio={0.5}
        targetRatio={0.7}
        storageKey="test.split.dynamic-target"
      />,
    )
    expect(getRatio()).toBeCloseTo(0.7, 3)
  })

  it("manual drag persists and supersedes future targetRatio changes", () => {
    // Stub the container's bounding rect so pointer coords map to a
    // predictable ratio.
    const { rerender } = render(
      <ResizableVerticalSplit
        top={<div>top</div>}
        bottom={<div>bottom</div>}
        defaultRatio={0.5}
        targetRatio={0.3}
        storageKey="test.split.drag-wins"
      />,
    )
    expect(getRatio()).toBeCloseTo(0.3, 3)

    const container = screen.getByTestId("resizable-vertical-split")
    // Stub getBoundingClientRect: 100px tall starting at y=0.
    Object.defineProperty(container, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 0, left: 0, height: 100, width: 200, bottom: 100, right: 200, x: 0, y: 0, toJSON: () => "" }),
    })

    const handle = screen.getByTestId("resizable-vertical-split-handle")
    fireEvent.pointerDown(handle, { pointerId: 1 })
    // Pointer capture retargets pointermove/up to the handle itself
    // (that's the fix for the iframe swallowing document-level mouse
    // events), so the drag dispatches directly on the handle, not
    // `document`. Drag to 60% of the container height.
    act(() => {
      handle.dispatchEvent(
        new PointerEvent("pointermove", { pointerId: 1, clientY: 60 }),
      )
    })
    act(() => {
      handle.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }))
    })

    expect(getRatio()).toBeCloseTo(0.6, 2)
    expect(window.localStorage.getItem("test.split.drag-wins")).not.toBeNull()

    // Now change targetRatio — should be ignored because the user
    // has dragged.
    rerender(
      <ResizableVerticalSplit
        top={<div>top</div>}
        bottom={<div>bottom</div>}
        defaultRatio={0.5}
        targetRatio={0.8}
        storageKey="test.split.drag-wins"
      />,
    )
    expect(getRatio()).toBeCloseTo(0.6, 2)
  })

  it("ends the drag on pointercancel (e.g. the iframe steals the gesture)", () => {
    render(
      <ResizableVerticalSplit
        top={<div>top</div>}
        bottom={<div>bottom</div>}
        defaultRatio={0.5}
        storageKey="test.split.pointercancel"
      />,
    )
    const handle = screen.getByTestId("resizable-vertical-split-handle")
    fireEvent.pointerDown(handle, { pointerId: 1 })
    act(() => {
      handle.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }))
    })
    // A stuck `dragging` flag would keep tracking pointer position with the
    // button up; firing another pointermove after cancel must be a no-op.
    const before = getRatio()
    act(() => {
      handle.dispatchEvent(
        new PointerEvent("pointermove", { pointerId: 1, clientY: 90 }),
      )
    })
    expect(getRatio()).toBeCloseTo(before, 3)
  })

  it("clamps targetRatio outside the [0.15, 0.85] band", () => {
    render(
      <ResizableVerticalSplit
        top={<div>top</div>}
        bottom={<div>bottom</div>}
        targetRatio={0.95}
        storageKey="test.split.clamp-target"
      />,
    )
    expect(getRatio()).toBeCloseTo(0.85, 3)
  })
})
