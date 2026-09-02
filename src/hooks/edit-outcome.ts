/**
 * Pure outcome-description core for the eleven `applyEditWithLLMFallback(edit,
 * adapter).then(({ result, fallback }) => { ... })` call sites in
 * `useEditorEditing` (handleLayerMove, handleDragMove, handleSwapConfirm,
 * handlePickIcon, handleDetach, handleLayerInsert, handleInsertAtPoint,
 * dispatchDeleteEdit, handleLayerUnwrap, handleLayerFlattenConditional,
 * handleLayerDetach) — share-readiness Phase 3 Batch B.
 *
 * Every site computed the SAME "what should the status banner say" shape
 * from a `{ result, fallback }` pair, parameterized only by a human label
 * ("Move", "Swap", "Detach", …). `describeEditOutcome` is that shared
 * decision; the hook's callbacks now just call it and hand the message to
 * `setSaveStatus`.
 *
 * One site — `handleInsertAtPoint` — deviates from the common shape: on a
 * successful AI-repair it does NOT surface an "applied via AI repair: …"
 * message (the other ten do). That deviation is real, not an oversight to
 * normalize away — the caller preserves it by only consuming the `"failed"`
 * branch's message. See the call site in useEditorEditing.ts.
 *
 * See tasks/share-readiness-plan.md.
 */

import type { EditResult } from "@/editor/core"
import type { StructuralFallbackOutcome } from "./apply-edit-with-llm-fallback"

export type EditOutcomeMessage =
  | { kind: "failed"; message: string }
  | { kind: "success"; message: string | null }

/**
 * Describe the status-banner outcome of an `applyEditWithLLMFallback` call.
 *
 * - `result.kind === "failed"` → `{ kind: "failed", message: "<Label> failed:
 *   <reason>[ (AI repair also unavailable: <fallbackError>)]" }`.
 * - Otherwise (the deterministic apply OR the AI-repair overwrite
 *   succeeded) → `{ kind: "success", message }`, where `message` is
 *   `"<Label> applied via AI repair[: <explanation>]."` when the AI-repair
 *   lane is what actually applied it (`fallback.applied`), or `null` when
 *   the deterministic lane succeeded outright (nothing worth announcing
 *   beyond the edit itself landing).
 */
export function describeEditOutcome(
  kindLabel: string,
  result: EditResult,
  fallback: StructuralFallbackOutcome,
): EditOutcomeMessage {
  if (result.kind === "failed") {
    const tail = fallback.attempted
      ? ` (AI repair also unavailable: ${fallback.fallbackError ?? "unknown"})`
      : ""
    return {
      kind: "failed",
      message: `${kindLabel} failed: ${result.reason}${tail}`,
    }
  }
  if (!fallback.applied) {
    return { kind: "success", message: null }
  }
  return {
    kind: "success",
    message: fallback.explanation
      ? `${kindLabel} applied via AI repair: ${fallback.explanation}`
      : `${kindLabel} applied via AI repair.`,
  }
}
