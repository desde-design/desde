/**
 * Tests for the shell's `MUTATION_RESOLUTION_FAILED` surface.
 *
 * The defect these pin: the bridge refused to map an edit to source and the
 * user was told nothing, then (2026-09-21) told in bridge-debugging prose while
 * the typed text stayed on the page and nothing offered the agent. These assert
 * which refusals go to chat, that the words are the product's plain ones, that a
 * repeat attempt replaces its notice instead of stacking, and the settle order.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import type { MutationResolutionFailure } from "@/types/bridge"
import {
  RESOLUTION_FAILURE_TITLE,
  TEXT_HANDOFF_REFUSED_DESCRIPTION,
  handleResolutionFailure,
  notifyResolutionFailure,
  notifyTextHandOffRefused,
  resolutionFailureDescription,
  resolutionFailureToastId,
  shouldHandOffToChat,
} from "./resolution-failure-notice"

vi.mock("sonner", () => ({
  toast: {
    warning: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}))

/** The measured case: a date on a Webflow-export page, no stamp on it. */
const DATE_EDIT: MutationResolutionFailure = {
  id: "dom-mut-4",
  code: "ancestor-only",
  kind: "text",
  before: "May 2022 - present",
  after: "May 2022 - Dec 2026",
  selector: "div.text-block-3.resume-date",
  page: "/",
  anchorLoc: "components/ScrollTimeline.tsx:47:9",
}

describe("shouldHandOffToChat", () => {
  it("hands a refused text edit to chat, with or without an ancestor stamp", () => {
    expect(shouldHandOffToChat(DATE_EDIT)).toBe(true)
    expect(shouldHandOffToChat({ ...DATE_EDIT, code: "no-anchor", anchorLoc: null })).toBe(true)
  })

  it("keeps isolation view a notice: there is no usage there to edit", () => {
    expect(shouldHandOffToChat({ ...DATE_EDIT, code: "isolation-view" })).toBe(false)
  })

  it("keeps non-text kinds a notice: there is no text to search for", () => {
    for (const kind of ["attr", "class", "style"] as const) {
      expect(shouldHandOffToChat({ ...DATE_EDIT, kind })).toBe(false)
    }
  })

  it("never hands off a no-op", () => {
    expect(shouldHandOffToChat({ ...DATE_EDIT, after: DATE_EDIT.before })).toBe(false)
  })
})

describe("the words", () => {
  const ALL = [
    RESOLUTION_FAILURE_TITLE,
    TEXT_HANDOFF_REFUSED_DESCRIPTION,
    ...(["isolation-view", "ancestor-only", "no-anchor"] as const).map((code) =>
      resolutionFailureDescription({ ...DATE_EDIT, code }),
    ),
  ]

  it("never leak the bridge's internals", () => {
    for (const s of ALL) {
      expect(s).not.toMatch(/data-desde|ancestor|anchor|source-location|map this edit/i)
    }
  })

  it("follow the copy rules: no em dash, no me or my", () => {
    for (const s of ALL) {
      expect(s).not.toContain("—")
      expect(s).not.toMatch(/\b(me|my)\b/i)
    }
  })
})

describe("notifyResolutionFailure", () => {
  beforeEach(() => {
    vi.mocked(toast.warning).mockClear()
  })

  it("names the change as not saved, with the code's own description", () => {
    notifyResolutionFailure({ ...DATE_EDIT, kind: "class" })

    expect(toast.warning).toHaveBeenCalledTimes(1)
    const [title, options] = vi.mocked(toast.warning).mock.calls[0]
    expect(title).toBe(RESOLUTION_FAILURE_TITLE)
    expect(options?.description).toBe(resolutionFailureDescription(DATE_EDIT))
  })

  it("keys the toast on the element, so repeat attempts replace rather than stack", () => {
    notifyResolutionFailure(DATE_EDIT)
    // A second attempt on the same element mints a FRESH mutation id — the toast
    // id must not follow it, or every swatch click stacks another toast.
    notifyResolutionFailure({ ...DATE_EDIT, id: "dom-mut-5" })

    const ids = vi.mocked(toast.warning).mock.calls.map(([, options]) => options?.id)
    expect(ids).toEqual([resolutionFailureToastId(DATE_EDIT), resolutionFailureToastId(DATE_EDIT)])
  })

  it("distinguishes different elements", () => {
    expect(resolutionFailureToastId({ selector: "#one" })).not.toBe(
      resolutionFailureToastId({ selector: "#two" }),
    )
  })
})

describe("notifyTextHandOffRefused", () => {
  beforeEach(() => {
    vi.mocked(toast.warning).mockClear()
    vi.mocked(toast.success).mockClear()
  })

  it("says the change was not saved, on the element's toast id", () => {
    notifyTextHandOffRefused(DATE_EDIT)

    expect(toast.success).not.toHaveBeenCalled()
    const [title, options] = vi.mocked(toast.warning).mock.calls[0]
    expect(title).toBe(RESOLUTION_FAILURE_TITLE)
    expect(options?.description).toBe(TEXT_HANDOFF_REFUSED_DESCRIPTION)
    expect(options?.id).toBe(resolutionFailureToastId(DATE_EDIT))
  })
})

/**
 * The settle half. No mutation was emitted, so there is no registered override
 * and no `resolveOverride` to carry the usual settle signal. If the shell
 * doesn't bump the nonce here, the inspector goes on naming the value the
 * bridge has already taken back off the element.
 */
describe("handleResolutionFailure", () => {
  const FAILURE: MutationResolutionFailure = { ...DATE_EDIT, kind: "style", code: "isolation-view" }

  beforeEach(() => {
    vi.mocked(toast.warning).mockClear()
    vi.mocked(toast.warning).mockImplementation(() => "toast-id")
  })

  it("settles the preview so the inspector re-reads, not just toasts", () => {
    const settle = vi.fn()

    handleResolutionFailure(FAILURE, settle)

    expect(settle).toHaveBeenCalledTimes(1)
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  it("settles once per failure, so repeat attempts each re-read", () => {
    const settle = vi.fn()

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
    expect(order).toEqual(["toast", "settle"])
  })
})
