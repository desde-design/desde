/**
 * Tests for the shared structural-edit outcome-description core extracted
 * from the eleven duplicated `applyEditWithChatHandoff(...).then(...)`
 * call sites in `useEditorEditing` (share-readiness Phase 3 Batch B).
 *
 * See tasks/share-readiness-plan.md.
 */

import { describe, expect, it } from "vitest"
import type { EditResult } from "@/editor/core"
import { describeEditOutcome } from "./edit-outcome"

const applied: EditResult = { kind: "applied", appliedEditId: "e-1", affectedTargetIds: ["t-1"] }
const failed = (reason: string): EditResult => ({ kind: "failed", reason })

describe("describeEditOutcome", () => {
  it("applied: success with no message", () => {
    expect(describeEditOutcome("Move", applied, { attempted: false, started: false })).toEqual({ kind: "success", message: null })
  })

  it("refused and handed to chat: says so", () => {
    expect(describeEditOutcome("Delete", failed("root"), { attempted: true, started: true, originalReason: "root" })).toEqual({
      kind: "handed-off",
      message: "Delete needs a decision. Sent to chat.",
    })
  })

  it("refused, hand-off declined: failed, and says the edit did not reach chat", () => {
    expect(describeEditOutcome("Move", failed("cycle detected"), { attempted: true, started: false, originalReason: "cycle detected" })).toEqual({
      kind: "failed",
      message: "Move failed: cycle detected. The edit could not be sent to chat, so nothing was changed.",
    })
  })

  it("refused with no hand-off possible: plain failure", () => {
    expect(describeEditOutcome("Move", failed("cycle detected"), { attempted: false, started: false, originalReason: "cycle detected" })).toEqual({
      kind: "failed",
      message: "Move failed: cycle detected",
    })
  })
})
