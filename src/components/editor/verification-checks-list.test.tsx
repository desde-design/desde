/**
 * `stateOf` / `describeState` — the shared verification-state vocabulary.
 *
 * This used to test a standalone `VerificationChecksList` component; that
 * component was deleted when the Activity panel's "Checks" strip was
 * removed (see `activity-panel.tsx`'s module doc comment — it repeated
 * every verified/failed row a second time). `stateOf`/`describeState`
 * themselves are still load-bearing: `activity-row.tsx`'s pill and
 * `activity-detail-dialog.tsx`'s verification section both classify
 * through these two functions, so these tests pin the classification
 * directly rather than through either consumer's DOM.
 *
 * The regression gate that matters most is the `skipped` one: a skip
 * classified as a pass would make both consumers lie in the one place the
 * verification work exists to be honest.
 */
import { describe, expect, it } from "vitest"
import { describeState, stateOf } from "./verification-checks-list"
import type { VerificationRecord } from "@/stores/editor-slice"
import type { VerificationResult } from "@/editor/verification"

function result(over: Partial<VerificationResult> = {}): VerificationResult {
  return {
    editId: "e1",
    status: "pass",
    expectedValue: "#22c55e",
    escalatable: false,
    detail: "verified",
    durationMs: 12,
    ...over,
  }
}

function record(over: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    editId: "e1",
    label: 'background-color = "#22c55e"',
    phase: "done",
    startedAt: 1,
    result: result(),
    ...over,
  }
}

describe("stateOf", () => {
  it("reads a running record as running regardless of any stale result", () => {
    expect(stateOf(record({ phase: "running", result: undefined }))).toBe("running")
  })

  it("reads a done record with no result as skipped — not checked, the only safe default", () => {
    expect(stateOf(record({ phase: "done", result: undefined }))).toBe("skipped")
  })

  it("reads a done record's result status directly for pass/fail/skipped", () => {
    expect(stateOf(record({ result: result({ status: "pass" }) }))).toBe("pass")
    expect(stateOf(record({ result: result({ status: "fail" }) }))).toBe("fail")
    expect(stateOf(record({ result: result({ status: "skipped" }) }))).toBe("skipped")
  })
})

describe("describeState", () => {
  it("gives each of the four states a distinct tone and label", () => {
    const running = describeState(record({ phase: "running", result: undefined }))
    const pass = describeState(record({ result: result({ status: "pass" }) }))
    const fail = describeState(record({ result: result({ status: "fail" }) }))
    const skipped = describeState(record({ result: result({ status: "skipped" }) }))

    expect(running).toEqual({ tone: "info", label: "Checking…", pulse: true })
    expect(pass).toEqual({ tone: "success", label: "Verified", pulse: false })
    expect(fail).toEqual({ tone: "destructive", label: "Didn't take effect", pulse: false })
    expect(skipped).toEqual({ tone: "muted", label: "Not checked", pulse: false })

    // Every state carries a DIFFERENT tone — the four are not distinguished
    // by wording alone.
    const tones = [running.tone, pass.tone, fail.tone, skipped.tone]
    expect(new Set(tones).size).toBe(4)
  })

  // THE gate: `skipped` must never read as success.
  it("never describes a skipped check as Verified or with a success tone", () => {
    const skipped = describeState(record({ result: result({ status: "skipped" }) }))
    expect(skipped.label).not.toBe("Verified")
    expect(skipped.tone).not.toBe("success")
  })

  it("says WHY a check was skipped when a skipReason is present", () => {
    expect(
      describeState(
        record({ result: result({ status: "skipped", skipReason: "unmeasurable" }) }),
      ).label,
    ).toBe("Not checked: nothing measurable")
    expect(
      describeState(
        record({ result: result({ status: "skipped", skipReason: "unreadable" }) }),
      ).label,
    ).toBe("Not checked: couldn't read the element")
  })

  it("treats a translate-error skip as an actionable failure to run, not a benign skip", () => {
    const described = describeState(
      record({ result: result({ status: "skipped", skipReason: "translate-error" }) }),
    )
    expect(described.label).toBe("Check failed to run")
    expect(described.tone).toBe("warning")
  })
})
