import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))

import { toast } from "sonner"
import { requestCommentMode } from "./request-comment-mode"

function deps(flags: { resolving?: boolean; resolveFailed?: boolean } = {}) {
  return {
    resolving: false,
    resolveFailed: false,
    ...flags,
    setToolMode: vi.fn(),
  }
}

beforeEach(() => vi.clearAllMocks())

describe("requestCommentMode", () => {
  it("asks for the comment tool mode", () => {
    const d = deps()
    expect(requestCommentMode(d)).toBe(true)
    expect(d.setToolMode).toHaveBeenCalledTimes(1)
    expect(d.setToolMode).toHaveBeenCalledWith("comment")
  })

  it("refuses while the viewer-auth status is still in flight", () => {
    const d = deps({ resolving: true })
    expect(requestCommentMode(d)).toBe(false)
    // Refusing must not move the mode either: a refused request should
    // leave Select exactly as the user had it.
    expect(d.setToolMode).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalledWith(
      expect.stringContaining("Checking the viewer connection"),
    )
  })

  it("says something different when the status request FAILED", () => {
    const d = deps({ resolving: true, resolveFailed: true })
    expect(requestCommentMode(d)).toBe(false)
    expect(toast.info).toHaveBeenCalledWith(
      expect.stringContaining("Reload to retry"),
    )
  })
})
