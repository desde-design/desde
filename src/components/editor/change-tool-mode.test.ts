import { describe, expect, it, vi } from "vitest"
import { changeToolMode } from "./change-tool-mode"

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))

function deps(overrides: Partial<Parameters<typeof changeToolMode>[1]> = {}) {
  return {
    resolving: false,
    resolveFailed: false,
    setToolMode: vi.fn(),
    closeNewCommentComposer: vi.fn(),
    ...overrides,
  }
}

describe("changeToolMode", () => {
  it("asks the wire for the tool it was given", () => {
    const d = deps()
    expect(changeToolMode("select", d)).toBe(true)
    expect(d.setToolMode).toHaveBeenCalledWith("select")
  })

  // The click that leaves the Comment tool has to do both halves of what it
  // looks like it does. Before the picker was raised above the composer's
  // dismiss backdrop, this click hit the backdrop instead: the composer closed
  // and the tool stayed on Comment, so "stop commenting" left the user armed
  // to comment. With the picker reachable, the same click must still close the
  // composer, or the form is left open under a different tool.
  it.each(["navigate", "select"] as const)(
    "closes an open new-comment composer when the tool becomes %s",
    (next) => {
      const d = deps()
      changeToolMode(next, d)
      expect(d.closeNewCommentComposer).toHaveBeenCalledTimes(1)
    },
  )

  // The mode has to be written first. `useStickyCommentPlacement` re-arms on
  // the composer's closing edge and reads the tool at that instant, so
  // closing the composer before the mode is written would re-arm comment
  // placement on the way out of the tool.
  it("writes the mode before it closes the composer", () => {
    const order: string[] = []
    changeToolMode("navigate", {
      resolving: false,
      resolveFailed: false,
      setToolMode: () => order.push("mode"),
      closeNewCommentComposer: () => order.push("composer"),
    })
    expect(order).toEqual(["mode", "composer"])
  })

  it("routes a request for Comment through the refusal", () => {
    const d = deps({ resolving: true })
    expect(changeToolMode("comment", d)).toBe(false)
    expect(d.setToolMode).not.toHaveBeenCalled()
  })

  // Entering Comment must NOT clear the composer: on this path there is no
  // composer to clear, and clearing one would throw away a pin the user is
  // still writing.
  it("does not touch the composer when entering Comment", () => {
    const d = deps()
    expect(changeToolMode("comment", d)).toBe(true)
    expect(d.setToolMode).toHaveBeenCalledWith("comment")
    expect(d.closeNewCommentComposer).not.toHaveBeenCalled()
  })
})
