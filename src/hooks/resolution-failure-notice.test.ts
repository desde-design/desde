/**
 * Tests for the shell's `MUTATION_RESOLUTION_FAILED` surface.
 *
 * The defect these pin: the bridge wrote a careful reason string for an edit it
 * couldn't map to source and sent it on every such edit, the adapter dispatched
 * it to `onResolutionFailed`, and NOTHING shell-side subscribed — so the user saw
 * a change appear (and, before the paired bridge fix, stick) with no indication it
 * would never persist. These assert the reason reaches the user verbatim, that a
 * repeat attempt on the same element replaces its notice instead of stacking, and
 * that a reason-less payload still says the change wasn't saved.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import {
  RESOLUTION_FAILURE_FALLBACK,
  RESOLUTION_FAILURE_TITLE,
  handleResolutionFailure,
  notifyResolutionFailure,
  resolutionFailureToastId,
} from "./resolution-failure-notice"

vi.mock("sonner", () => ({
  toast: {
    warning: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}))

const ISOLATION_REASON =
  "Editing isn't supported in isolation view — this is a Storybook-style preview of a packaged component. To customize the appearance, exit isolation view (top toolbar) and edit a real instance in your prototype; the change will scope to that callsite via a CSS override."

describe("notifyResolutionFailure", () => {
  beforeEach(() => {
    vi.mocked(toast.warning).mockClear()
  })

  it("surfaces the bridge's own reason string as the description", () => {
    notifyResolutionFailure({
      id: "dom-mut-4",
      reason: ISOLATION_REASON,
      selector: "div.ui-card > span",
    })

    expect(toast.warning).toHaveBeenCalledTimes(1)
    const [title, options] = vi.mocked(toast.warning).mock.calls[0]
    expect(title).toBe(RESOLUTION_FAILURE_TITLE)
    // Verbatim: the bridge's wording is the only place that knows WHY (isolation
    // view vs ancestor-only anchor), and it names the way out.
    expect(options?.description).toBe(ISOLATION_REASON)
  })

  it("keys the toast on the element, so repeat attempts replace rather than stack", () => {
    const failure = {
      id: "dom-mut-5",
      reason: "No source-location ancestor — cannot map this edit to source.",
      selector: "#row-3 .title",
    }
    notifyResolutionFailure(failure)
    // A second attempt on the same element mints a FRESH mutation id — the toast
    // id must not follow it, or every swatch click stacks another toast.
    notifyResolutionFailure({ ...failure, id: "dom-mut-6" })

    const ids = vi.mocked(toast.warning).mock.calls.map(([, options]) => options?.id)
    expect(ids).toEqual([
      resolutionFailureToastId(failure),
      resolutionFailureToastId(failure),
    ])
    expect(new Set(ids).size).toBe(1)
  })

  it("distinguishes different elements", () => {
    expect(
      resolutionFailureToastId({ id: "a", reason: "r", selector: "#one" }),
    ).not.toBe(resolutionFailureToastId({ id: "a", reason: "r", selector: "#two" }))
  })

  it("still tells the user the change wasn't saved when no reason came through", () => {
    notifyResolutionFailure({ id: "dom-mut-7", reason: "   ", selector: "#x" })

    const [, options] = vi.mocked(toast.warning).mock.calls[0]
    expect(options?.description).toBe(RESOLUTION_FAILURE_FALLBACK)
  })
})

/**
 * The settle half.
 *
 * Telling the user was only half the fix: the bridge reverts its own preview on
 * this path (`releaseUnownedPreview`), and because no mutation was emitted there
 * is no registered override and therefore no `resolveOverride` to carry the
 * usual settle signal. If the shell doesn't bump the nonce here, the inspector's
 * style rows go on naming the shim's colour after the element has already
 * reverted — the stale swatch `cancelDisambiguation` hit on a live run.
 */
describe("handleResolutionFailure", () => {
  const FAILURE = {
    id: "dom-mut-8",
    reason: "No source-location ancestor — cannot map this edit to source.",
    selector: "#row-3 .title",
  }

  beforeEach(() => {
    vi.mocked(toast.warning).mockClear()
  })

  it("settles the preview so the inspector re-reads, not just toasts", () => {
    const settle = vi.fn()

    handleResolutionFailure(FAILURE, settle)

    expect(settle).toHaveBeenCalledTimes(1)
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  it("settles once per failure, so repeat attempts each re-read", () => {
    const settle = vi.fn()

    // Every style click in isolation view fails identically. The toast dedupes
    // by design (same id), but the settle must NOT — each attempt stamps a fresh
    // shim that the bridge then reverts, and each revert needs its own re-read.
    handleResolutionFailure(FAILURE, settle)
    handleResolutionFailure({ ...FAILURE, id: "dom-mut-9" }, settle)

    expect(settle).toHaveBeenCalledTimes(2)
  })

  it("tells the user before settling, so a throwing subscriber can't eat the notice", () => {
    const order: string[] = []
    vi.mocked(toast.warning).mockImplementation(() => {
      order.push("toast")
      return "toast-id"
    })
    const settle = vi.fn(() => {
      order.push("settle")
      throw new Error("subscriber blew up")
    })

    expect(() => handleResolutionFailure(FAILURE, settle)).toThrow("subscriber blew up")
    // The user still learned the edit won't persist — the one thing this whole
    // path exists to say.
    expect(order).toEqual(["toast", "settle"])
  })
})
