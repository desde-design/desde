/**
 * Tests for the shared structural-edit outcome-description core extracted
 * from the eleven duplicated `applyEditWithLLMFallback(...).then(...)`
 * call sites in `useEditorEditing` (share-readiness Phase 3 Batch B).
 *
 * See tasks/share-readiness-plan.md.
 */

import { describe, expect, it } from "vitest"
import type { EditResult } from "@/editor/core"
import type { StructuralFallbackOutcome } from "./apply-edit-with-llm-fallback"
import { describeEditOutcome } from "./edit-outcome"

const applied: EditResult = {
  kind: "applied",
  appliedEditId: "e-1",
  affectedTargetIds: ["t-1"],
}

const failed = (reason: string): EditResult => ({ kind: "failed", reason })

const noFallback: StructuralFallbackOutcome = { attempted: false, applied: false }

describe("describeEditOutcome", () => {
  it("deterministic success, no AI repair attempted: success with no message", () => {
    const outcome = describeEditOutcome("Move", applied, noFallback)
    expect(outcome).toEqual({ kind: "success", message: null })
  })

  it("deterministic failure, AI repair never attempted: failed message with no tail", () => {
    const outcome = describeEditOutcome("Move", failed("cycle detected"), noFallback)
    expect(outcome).toEqual({
      kind: "failed",
      message: "Move failed: cycle detected",
    })
  })

  it("deterministic failure, AI repair attempted and also failed: failed message WITH tail", () => {
    const fallback: StructuralFallbackOutcome = {
      attempted: true,
      applied: false,
      fallbackError: "LLM fallback threw: network error",
    }
    const outcome = describeEditOutcome("Swap", failed("cycle detected"), fallback)
    expect(outcome).toEqual({
      kind: "failed",
      message:
        "Swap failed: cycle detected (AI repair also unavailable: LLM fallback threw: network error)",
    })
  })

  it("deterministic failure, AI repair attempted but fallbackError missing: tail says 'unknown'", () => {
    const fallback: StructuralFallbackOutcome = { attempted: true, applied: false }
    const outcome = describeEditOutcome("Detach", failed("no editTarget"), fallback)
    expect(outcome.kind).toBe("failed")
    expect(outcome.message).toBe(
      "Detach failed: no editTarget (AI repair also unavailable: unknown)",
    )
  })

  it("AI repair applied WITH an explanation: success message names the label + explanation", () => {
    const fallback: StructuralFallbackOutcome = {
      attempted: true,
      applied: true,
      explanation: "rewrote the parent container",
    }
    const outcome = describeEditOutcome("Insert", applied, fallback)
    expect(outcome).toEqual({
      kind: "success",
      message: "Insert applied via AI repair: rewrote the parent container",
    })
  })

  it("AI repair applied WITHOUT an explanation: generic success message", () => {
    const fallback: StructuralFallbackOutcome = { attempted: true, applied: true }
    const outcome = describeEditOutcome("Unwrap", applied, fallback)
    expect(outcome).toEqual({
      kind: "success",
      message: "Unwrap applied via AI repair.",
    })
  })

  it("every label plugs into both the failed and applied-via-AI-repair templates", () => {
    for (const label of [
      "Move",
      "Swap",
      "Icon swap",
      "Detach",
      "Insert",
      "Delete",
      "Unwrap",
      "Flatten",
    ]) {
      expect(describeEditOutcome(label, failed("x"), noFallback).message).toBe(
        `${label} failed: x`,
      )
      expect(
        describeEditOutcome(label, applied, { attempted: true, applied: true }).message,
      ).toBe(`${label} applied via AI repair.`)
    }
  })
})
