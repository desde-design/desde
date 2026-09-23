import { afterEach, describe, expect, it, vi } from "vitest"
import { deriveRateLimitResetsAt } from "./useEditorChat"

/**
 * `deriveRateLimitResetsAt` is the one place `useEditorChat` calls
 * `Date.now()` to turn a `rate_limit_warning` event's timing fields into the
 * absolute timestamp `RateLimitWarningBanner` renders. Tested as a pure
 * function, with the clock mocked, rather than by driving a full turn
 * through the hook: the live message this produces is transient by design —
 * `runSubmit`'s turn-end backstop strips every `rate_limit_warning` /
 * `api_retry` message on EVERY completion path (happy, error, or abort), so
 * there is no way to observe it via `result.current.messages` after a
 * `submit()` call resolves. This is the seam that actually needs pinning.
 */
describe("deriveRateLimitResetsAt", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("derives an absolute resetsAt from retryAfterSeconds when there is no resetsAt", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000)
    expect(deriveRateLimitResetsAt({ retryAfterSeconds: 7 })).toBe(1_000_000 + 7_000)
  })

  it("prefers a real resetsAt over deriving one from retryAfterSeconds", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000)
    expect(
      deriveRateLimitResetsAt({ resetsAt: 5_000_000, retryAfterSeconds: 7 }),
    ).toBe(5_000_000)
  })

  it("returns undefined when the event carries neither field", () => {
    expect(deriveRateLimitResetsAt({})).toBeUndefined()
  })
})
