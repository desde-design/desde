/**
 * Tests for `useEditVerification`'s toast-gating on `isSuperseded`.
 *
 * Bug: while the user types, `dispatchBranchTextMutation` fires
 * `verifyEdit` fire-and-forget with `expectedValue` snapshotted at dispatch
 * time. Verification settles 0.85-3s later; by then a newer keystroke has
 * typically re-rendered the DOM, so the stale check "fails" and
 * `toast.warning("Edit didn't take effect", …)` fires — a false positive
 * mid-typing.
 *
 * Fix: `verifyEdit`'s request surface grew an optional lazy
 * `isSuperseded?: () => boolean`, checked ONLY in the `complete` callback's
 * toast branch. Outcome bookkeeping (store record, `onOutcome`) must still
 * run unconditionally — only the toast is gated.
 *
 * `orchestrateVerification` is mocked so these tests exercise exactly the
 * hook's own `complete` callback logic (the toast-gating boundary), not the
 * DOM-settle/confirm timing machinery already covered by
 * `src/editor/verification/verification.test.ts`.
 */

import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import type { FrameworkAdapter } from "@/editor/core"
import type {
  ExpectationInput,
  VerificationResult,
} from "@/editor/verification"
import { useEditorStore } from "@/stores/editor-only"

vi.mock("sonner", () => ({
  toast: {
    warning: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}))

type OrchestrateCallbacks = {
  begin: (editId: string, label: string, startedAt: number, commitSha?: string) => void
  complete: (editId: string, result: VerificationResult) => void
}

const orchestrateVerificationMock =
  vi.fn<
    (
      input: ExpectationInput,
      callbacks: OrchestrateCallbacks,
      deps: unknown,
    ) => Promise<VerificationResult | null>
  >()

vi.mock("@/editor/verification", async () => {
  const actual = await vi.importActual<typeof import("@/editor/verification")>(
    "@/editor/verification",
  )
  return {
    ...actual,
    orchestrateVerification: (
      input: ExpectationInput,
      callbacks: OrchestrateCallbacks,
      deps: unknown,
    ) => orchestrateVerificationMock(input, callbacks, deps),
  }
})

// Imported AFTER the mocks above so the hook picks up the mocked module.
const { useEditVerification } = await import("./useEditVerification")

function baseResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    editId: "e1",
    status: "fail",
    expectedValue: "Submit",
    escalatable: false,
    detail: "DOM shows \"Cancel\", expected \"Submit\"",
    durationMs: 900,
    ...overrides,
  }
}

function makeAdapter(): FrameworkAdapter {
  return {
    readRenderedValue: vi.fn().mockResolvedValue("Cancel"),
    supportsRenderedValueRead: () => true,
  } as unknown as FrameworkAdapter
}

/** Drive the mocked `orchestrateVerification` to synchronously resolve with `result`. */
function resolveWith(result: VerificationResult) {
  orchestrateVerificationMock.mockImplementation(async (input, callbacks) => {
    callbacks.begin(input.editId, "label", Date.now())
    callbacks.complete(input.editId, result)
    return result
  })
}

beforeEach(() => {
  orchestrateVerificationMock.mockReset()
  vi.mocked(toast.warning).mockClear()
  useEditorStore.getState().clearVerifications()
})

describe("useEditVerification — toast gating on isSuperseded", () => {
  it("fail + isSuperseded() === true: no toast, outcome still recorded", async () => {
    const failResult = baseResult()
    resolveWith(failResult)
    const adapter = makeAdapter()
    const { result: hookResult } = renderHook(() => useEditVerification(() => adapter))

    const onOutcome = vi.fn()
    await act(async () => {
      hookResult.current.verifyEdit(
        {
          editId: "e1",
          selector: "#submit",
          expectedValue: "Submit",
          editKind: "dom-text",
          isSuperseded: () => true,
        },
        onOutcome,
      )
      await Promise.resolve()
    })

    expect(toast.warning).not.toHaveBeenCalled()
    expect(onOutcome).toHaveBeenCalledWith("didnt-take")
    const record = useEditorStore
      .getState()
      .verifications.find((v) => v.editId === "e1")
    expect(record?.phase).toBe("done")
    expect(record?.result).toEqual(failResult)
  })

  it("fail + isSuperseded() === false: toast fires", async () => {
    const failResult = baseResult()
    resolveWith(failResult)
    const adapter = makeAdapter()
    const { result: hookResult } = renderHook(() => useEditVerification(() => adapter))

    const onOutcome = vi.fn()
    await act(async () => {
      hookResult.current.verifyEdit(
        {
          editId: "e1",
          selector: "#submit",
          expectedValue: "Submit",
          editKind: "dom-text",
          isSuperseded: () => false,
        },
        onOutcome,
      )
      await Promise.resolve()
    })

    expect(toast.warning).toHaveBeenCalledTimes(1)
    expect(toast.warning).toHaveBeenCalledWith(
      "Edit didn't take effect",
      expect.objectContaining({ description: failResult.detail }),
    )
    expect(onOutcome).toHaveBeenCalledWith("didnt-take")
  })

  it("fail + no isSuperseded provided: toast fires (default behavior unchanged)", async () => {
    const failResult = baseResult()
    resolveWith(failResult)
    const adapter = makeAdapter()
    const { result: hookResult } = renderHook(() => useEditVerification(() => adapter))

    await act(async () => {
      hookResult.current.verifyEdit({
        editId: "e1",
        selector: "#submit",
        expectedValue: "Submit",
        editKind: "dom-text",
      })
      await Promise.resolve()
    })

    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  it("pass: unaffected by isSuperseded either way — never toasts", async () => {
    const passResult = baseResult({ status: "pass", detail: "matched" })
    resolveWith(passResult)
    const adapter = makeAdapter()
    const { result: hookResult } = renderHook(() => useEditVerification(() => adapter))

    const onOutcome = vi.fn()
    await act(async () => {
      hookResult.current.verifyEdit(
        {
          editId: "e1",
          selector: "#submit",
          expectedValue: "Submit",
          editKind: "dom-text",
          isSuperseded: () => true,
        },
        onOutcome,
      )
      await Promise.resolve()
    })

    expect(toast.warning).not.toHaveBeenCalled()
    expect(onOutcome).toHaveBeenCalledWith("verified")
    const record = useEditorStore
      .getState()
      .verifications.find((v) => v.editId === "e1")
    expect(record?.result).toEqual(passResult)
  })
})
