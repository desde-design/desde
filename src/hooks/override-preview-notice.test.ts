/**
 * Tests for the shell's `PROP_OVERRIDE_RESULT` / `ATTR_OVERRIDE_RESULT`
 * failure surface.
 *
 * The defect these pin: the bridge reported every live-preview poke's outcome
 * and the shell had no switch case for either message, so `ok: false` was
 * dropped on arrival — the designer moved a control, the iframe didn't change,
 * and nothing said why. These assert the bridge's reason reaches the user
 * verbatim, that the notice never claims the edit was lost (it isn't — it still
 * goes to source), and that a slider drag's worth of identical failures
 * collapses to one toast.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import type { OverridePreviewFailure } from "@/editor/core"
import {
  OVERRIDE_PREVIEW_FAILURE_CONSEQUENCE,
  OVERRIDE_PREVIEW_FAILURE_FALLBACK,
  OVERRIDE_PREVIEW_FAILURE_TITLE,
  notifyOverridePreviewFailure,
  overridePreviewFailureToastId,
  shouldNotifyOverridePreviewFailure,
} from "./override-preview-notice"

vi.mock("sonner", () => ({
  toast: {
    warning: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}))

const NO_INSTANCE_REASON =
  "The prototype exposes no component instance for this element, so the value couldn't be previewed live. Select the component itself rather than markup outside it."

function failure(
  overrides: Partial<OverridePreviewFailure> = {},
): OverridePreviewFailure {
  return {
    kind: "prop",
    selector: "div.ui-card > button",
    name: "appearance",
    reason: NO_INSTANCE_REASON,
    cause: "no-component-instance",
    ...overrides,
  }
}

describe("notifyOverridePreviewFailure", () => {
  beforeEach(() => {
    vi.mocked(toast.warning).mockClear()
  })

  it("surfaces the bridge's own reason string", () => {
    notifyOverridePreviewFailure(failure())

    expect(toast.warning).toHaveBeenCalledTimes(1)
    const [title, options] = vi.mocked(toast.warning).mock.calls[0]
    expect(title).toBe(OVERRIDE_PREVIEW_FAILURE_TITLE)
    // Verbatim: only the bridge knows WHICH failure it was (stale selector vs
    // no component instance vs refused assignment).
    expect(options?.description).toContain(NO_INSTANCE_REASON)
  })

  it("always says the edit survives — a missing preview is not a lost change", () => {
    notifyOverridePreviewFailure(failure())

    const [, options] = vi.mocked(toast.warning).mock.calls[0]
    expect(options?.description).toContain(OVERRIDE_PREVIEW_FAILURE_CONSEQUENCE)
    // The alarming reading is the wrong one here: unlike a resolution failure,
    // the buffered edit still dispatches to the working tree.
    expect(options?.description).not.toMatch(/wasn't saved|not be saved/i)
  })

  it("de-duplicates a drag's worth of identical failures into one toast", () => {
    // Every slider tick is its own poke against the same prop.
    notifyOverridePreviewFailure(failure())
    notifyOverridePreviewFailure(failure())
    notifyOverridePreviewFailure(failure())

    const ids = vi.mocked(toast.warning).mock.calls.map(([, o]) => o?.id)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(1)
    expect(ids[0]).toBe(overridePreviewFailureToastId(failure()))
  })

  it("keeps separate targets separate", () => {
    const base = failure()
    expect(overridePreviewFailureToastId(base)).not.toBe(
      overridePreviewFailureToastId(failure({ name: "size" })),
    )
    expect(overridePreviewFailureToastId(base)).not.toBe(
      overridePreviewFailureToastId(failure({ selector: "#other" })),
    )
    // A typed prop and a fallthrough attr of the same name are two different
    // things the user can hit independently.
    expect(overridePreviewFailureToastId(base)).not.toBe(
      overridePreviewFailureToastId(failure({ kind: "attr" })),
    )
  })

  it("still explains itself when the bridge sent no reason", () => {
    notifyOverridePreviewFailure(failure({ reason: undefined }))

    const [, options] = vi.mocked(toast.warning).mock.calls[0]
    expect(options?.description).toContain(OVERRIDE_PREVIEW_FAILURE_FALLBACK)
    expect(options?.description).toContain(OVERRIDE_PREVIEW_FAILURE_CONSEQUENCE)
  })

  it("treats a whitespace-only reason as absent", () => {
    notifyOverridePreviewFailure(failure({ reason: "   " }))

    const [, options] = vi.mocked(toast.warning).mock.calls[0]
    expect(options?.description).toContain(OVERRIDE_PREVIEW_FAILURE_FALLBACK)
  })
})

/**
 * The capability-gap filter.
 *
 * The defect these pin: the preview write path reads Vue dev-mode instance
 * metadata, so on a React substrate every prop/attr poke reports `ok: false`
 * while the source write beside it succeeds. Warning on every edit that WORKED is
 * a false alarm, and de-duplication only makes it a permanent one — it teaches
 * the user to ignore the genuine failures the surface exists for.
 */
describe("notifyOverridePreviewFailure — capability gap vs real failure", () => {
  beforeEach(() => {
    vi.mocked(toast.warning).mockClear()
  })

  it("says nothing when the substrate simply cannot preview", () => {
    notifyOverridePreviewFailure(
      failure({
        cause: "unsupported-substrate",
        reason:
          "Live prop and attribute preview needs the component-instance data a Vue development build exposes, and this prototype doesn't expose any — so the new value couldn't be shown instantly.",
      }),
    )

    expect(toast.warning).not.toHaveBeenCalled()
    expect(
      shouldNotifyOverridePreviewFailure(
        failure({ cause: "unsupported-substrate" }),
      ),
    ).toBe(false)
  })

  it("still toasts every cause that describes a real, actionable failure", () => {
    // Each of these is per-target and fixable by the user (re-select; select the
    // component itself; the component refused the value) — unlike the substrate
    // gap, none of them fires on an edit that worked.
    for (const cause of [
      "selector-unresolvable",
      "no-component-instance",
      "assignment-refused",
    ] as const) {
      vi.mocked(toast.warning).mockClear()
      notifyOverridePreviewFailure(failure({ cause }))
      expect(toast.warning, `expected a toast for ${cause}`).toHaveBeenCalledTimes(1)
    }
  })

  it("toasts a failure whose cause the bridge didn't send", () => {
    // An older bundle sends no `kind`. Defaulting to silence would be a new,
    // quieter version of the swallowed-failure defect, so absent means surface.
    notifyOverridePreviewFailure(failure({ cause: undefined }))

    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  it("toasts a cause this build has never heard of", () => {
    // The filter is a deny-set of one, not an allow-list, so a future bridge
    // failure mode can't be swallowed by a shell that predates it.
    notifyOverridePreviewFailure(
      failure({
        cause: "some-future-cause" as OverridePreviewFailure["cause"],
      }),
    )

    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  it("keeps de-duplicating the failures it does surface", () => {
    notifyOverridePreviewFailure(failure({ cause: "selector-unresolvable" }))
    notifyOverridePreviewFailure(failure({ cause: "selector-unresolvable" }))

    const ids = vi.mocked(toast.warning).mock.calls.map(([, o]) => o?.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(1)
  })
})
