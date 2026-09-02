/**
 * Unit tests for the press → threshold → drag → commit/cancel state machine
 * shared by drag-move-overlay and resize-overlay. jsdom has no pointer capture
 * and no real drag, so we dispatch synthetic PointerEvents on `document` (the
 * same capture-phase channel the gesture listens on) and assert the callbacks
 * and the trailing-click swallow.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { PointerDragGesture } from "./pointer-drag-gesture"

type Calls = {
  armed: number
  start: number
  move: number
  commit: number
  cancel: string[]
  reset: number
}

function setup(overrides: Partial<Parameters<typeof makeOpts>[1]> = {}) {
  const calls: Calls = { armed: 0, start: 0, move: 0, commit: 0, cancel: [], reset: 0 }
  const target = document.createElement("div")
  document.body.appendChild(target)
  const gesture = new PointerDragGesture<{ tag: string }>(makeOpts(calls, overrides))
  gesture.attach()
  return { calls, gesture, target }
}

function makeOpts(
  calls: Calls,
  overrides: {
    threshold?: number
    distance?: (dx: number, dy: number) => number
    swallowClickOnPointerCancel?: boolean
    arm?: boolean
  },
) {
  return {
    threshold: overrides.threshold ?? 5,
    ...(overrides.distance ? { distance: overrides.distance } : {}),
    ...(overrides.swallowClickOnPointerCancel !== undefined
      ? { swallowClickOnPointerCancel: overrides.swallowClickOnPointerCancel }
      : {}),
    onArm: () => {
      if (overrides.arm === false) return null
      calls.armed++
      return { data: { tag: "t" }, captureEl: null }
    },
    onDragStart: () => {
      calls.start++
    },
    onDragMove: () => {
      calls.move++
    },
    onCommit: () => {
      calls.commit++
    },
    onCancel: (_d: { tag: string }, reason: string) => {
      calls.cancel.push(reason)
    },
    onReset: () => {
      calls.reset++
    },
  }
}

function pointer(type: string, init: PointerEventInit & { target?: Element } = {}) {
  const { target, ...rest } = init
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, ...rest }) as PointerEvent
  Object.defineProperty(e, "pointerId", { value: rest.pointerId ?? 1 })
  ;(target ?? document.body).dispatchEvent(e)
  return e
}

afterEach(() => {
  document.body.innerHTML = ""
  vi.restoreAllMocks()
})

describe("PointerDragGesture", () => {
  it("ignores non-primary buttons", () => {
    const { calls } = setup()
    pointer("pointerdown", { button: 2, clientX: 0, clientY: 0 })
    expect(calls.armed).toBe(0)
  })

  it("does not start dragging below the threshold", () => {
    const { calls, gesture } = setup({ threshold: 5 })
    pointer("pointerdown", { button: 0, clientX: 0, clientY: 0 })
    expect(calls.armed).toBe(1)
    pointer("pointermove", { clientX: 3, clientY: 0 })
    expect(gesture.dragging).toBe(false)
    expect(calls.start).toBe(0)
    expect(calls.move).toBe(0)
  })

  it("crosses the threshold once, then moves and commits", () => {
    const { calls, gesture } = setup({ threshold: 5 })
    pointer("pointerdown", { button: 0, clientX: 0, clientY: 0 })
    pointer("pointermove", { clientX: 10, clientY: 0 })
    expect(gesture.dragging).toBe(true)
    expect(calls.start).toBe(1)
    expect(calls.move).toBe(1)
    pointer("pointermove", { clientX: 20, clientY: 0 })
    expect(calls.start).toBe(1)
    expect(calls.move).toBe(2)
    pointer("pointerup", { clientX: 20, clientY: 0 })
    expect(calls.commit).toBe(1)
    expect(calls.reset).toBe(1)
    expect(gesture.dragging).toBe(false)
    expect(gesture.data).toBeNull()
  })

  it("a press that never passes the threshold commits nothing", () => {
    const { calls } = setup({ threshold: 5 })
    pointer("pointerdown", { button: 0, clientX: 0, clientY: 0 })
    pointer("pointerup", { clientX: 1, clientY: 1 })
    expect(calls.commit).toBe(0)
    expect(calls.reset).toBe(1)
  })

  it("honours a custom distance metric (width-only axis)", () => {
    const { calls, gesture } = setup({ threshold: 3, distance: (dx) => Math.abs(dx) })
    pointer("pointerdown", { button: 0, clientX: 0, clientY: 0 })
    // 100px of vertical travel is irrelevant on a horizontal-only axis.
    pointer("pointermove", { clientX: 1, clientY: 100 })
    expect(gesture.dragging).toBe(false)
    pointer("pointermove", { clientX: 5, clientY: 100 })
    expect(gesture.dragging).toBe(true)
    expect(calls.move).toBe(1)
  })

  it("ignores a second pointer mid-drag", () => {
    const { calls } = setup()
    pointer("pointerdown", { button: 0, clientX: 0, clientY: 0, pointerId: 1 })
    pointer("pointermove", { clientX: 20, clientY: 0, pointerId: 2 })
    expect(calls.move).toBe(0)
    pointer("pointerup", { clientX: 20, clientY: 0, pointerId: 2 })
    expect(calls.commit).toBe(0)
    pointer("pointermove", { clientX: 20, clientY: 0, pointerId: 1 })
    expect(calls.move).toBe(1)
  })

  it("Escape cancels the drag and swallows the trailing click", () => {
    const { calls } = setup()
    pointer("pointerdown", { button: 0, clientX: 0, clientY: 0 })
    pointer("pointermove", { clientX: 20, clientY: 0 })
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    expect(calls.cancel).toEqual(["escape"])
    expect(calls.commit).toBe(0)
    expect(calls.reset).toBe(1)

    const click = new MouseEvent("click", { bubbles: true, cancelable: true })
    document.body.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)

    // Exactly one click is swallowed.
    const next = new MouseEvent("click", { bubbles: true, cancelable: true })
    document.body.dispatchEvent(next)
    expect(next.defaultPrevented).toBe(false)
  })

  it("Escape before the threshold does nothing", () => {
    const { calls } = setup()
    pointer("pointerdown", { button: 0, clientX: 0, clientY: 0 })
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    expect(calls.cancel).toEqual([])
    expect(calls.reset).toBe(0)
  })

  it("swallows the post-drop click after a commit", () => {
    setup()
    pointer("pointerdown", { button: 0, clientX: 0, clientY: 0 })
    pointer("pointermove", { clientX: 20, clientY: 0 })
    pointer("pointerup", { clientX: 20, clientY: 0 })
    const click = new MouseEvent("click", { bubbles: true, cancelable: true })
    document.body.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
  })

  it("pointercancel aborts, and only swallows the click when opted in", () => {
    const optedIn = setup({ swallowClickOnPointerCancel: true })
    pointer("pointerdown", { button: 0, clientX: 0, clientY: 0 })
    pointer("pointermove", { clientX: 20, clientY: 0 })
    pointer("pointercancel", {})
    expect(optedIn.calls.cancel).toEqual(["pointercancel"])
    expect(optedIn.calls.commit).toBe(0)
    const swallowed = new MouseEvent("click", { bubbles: true, cancelable: true })
    document.body.dispatchEvent(swallowed)
    expect(swallowed.defaultPrevented).toBe(true)
    optedIn.gesture.detach()

    const optedOut = setup({ swallowClickOnPointerCancel: false })
    pointer("pointerdown", { button: 0, clientX: 0, clientY: 0 })
    pointer("pointermove", { clientX: 20, clientY: 0 })
    pointer("pointercancel", {})
    expect(optedOut.calls.cancel).toEqual(["pointercancel"])
    const live = new MouseEvent("click", { bubbles: true, cancelable: true })
    document.body.dispatchEvent(live)
    expect(live.defaultPrevented).toBe(false)
    optedOut.gesture.detach()
  })

  it("detach stops listening and clears a pending swallow", () => {
    const { calls, gesture } = setup()
    pointer("pointerdown", { button: 0, clientX: 0, clientY: 0 })
    pointer("pointermove", { clientX: 20, clientY: 0 })
    gesture.detach()
    expect(calls.reset).toBe(1)
    const click = new MouseEvent("click", { bubbles: true, cancelable: true })
    document.body.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(false)
    pointer("pointerdown", { button: 0, clientX: 0, clientY: 0 })
    expect(calls.armed).toBe(1)
  })

  it("a refused arm never starts a gesture", () => {
    const { calls, gesture } = setup({ arm: false })
    pointer("pointerdown", { button: 0, clientX: 0, clientY: 0 })
    pointer("pointermove", { clientX: 50, clientY: 50 })
    expect(gesture.dragging).toBe(false)
    expect(calls.move).toBe(0)
  })

  it("releases pointer capture on reset", () => {
    const calls: Calls = { armed: 0, start: 0, move: 0, commit: 0, cancel: [], reset: 0 }
    const captureEl = document.createElement("div")
    const setCapture = vi.fn()
    const release = vi.fn()
    ;(captureEl as unknown as { setPointerCapture: unknown }).setPointerCapture = setCapture
    ;(captureEl as unknown as { releasePointerCapture: unknown }).releasePointerCapture = release
    document.body.appendChild(captureEl)
    const gesture = new PointerDragGesture<{ tag: string }>({
      ...makeOpts(calls, {}),
      onArm: () => ({ data: { tag: "t" }, captureEl }),
    })
    gesture.attach()
    pointer("pointerdown", { button: 0, clientX: 0, clientY: 0, pointerId: 7 })
    expect(setCapture).toHaveBeenCalledWith(7)
    pointer("pointerup", { clientX: 0, clientY: 0, pointerId: 7 })
    expect(release).toHaveBeenCalledWith(7)
    gesture.detach()
  })
})
