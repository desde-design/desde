/**
 * Tests for the shared settle/advance reconciliation decision extracted
 * from the three worktree auto-commit dispatch machines in
 * `useEditorEditing` (share-readiness Phase 3 Batch B).
 *
 * See tasks/share-readiness-plan.md.
 */

import { describe, expect, it } from "vitest"
import { reconcileDispatchedValue } from "./dispatch-reconcile"

describe("reconcileDispatchedValue", () => {
  it("returns no-entry when the buffered entry is gone, regardless of values", () => {
    expect(reconcileDispatchedValue(false, "Hello", "Hello")).toBe("no-entry")
    expect(reconcileDispatchedValue(false, "Hello", "Goodbye")).toBe("no-entry")
  })

  it("returns settled when the current value still matches what was dispatched (string)", () => {
    expect(reconcileDispatchedValue(true, "Hello", "Hello")).toBe("settled")
  })

  it("returns advanced when the current value has moved past what was dispatched (string)", () => {
    expect(reconcileDispatchedValue(true, "Hello", "Hello world")).toBe("advanced")
  })

  it("works for non-string PropControlValue types (number, boolean)", () => {
    expect(reconcileDispatchedValue(true, 3, 3)).toBe("settled")
    expect(reconcileDispatchedValue(true, 3, 4)).toBe("advanced")
    expect(reconcileDispatchedValue(true, true, true)).toBe("settled")
    expect(reconcileDispatchedValue(true, true, false)).toBe("advanced")
  })

  it("treats two NaNs as settled (Object.is semantics, unlike ===)", () => {
    expect(reconcileDispatchedValue(true, NaN, NaN)).toBe("settled")
  })

  it("treats +0 and -0 as advanced (Object.is semantics, unlike ===)", () => {
    expect(reconcileDispatchedValue(true, 0, -0)).toBe("advanced")
  })
})
