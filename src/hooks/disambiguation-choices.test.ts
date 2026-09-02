/**
 * Tests for `offeredDisambiguationChoices` — the pure honesty-gate helper
 * behind the v-for mutation-disambiguation dialog.
 *
 * The load-bearing rule (from a prior codex P1, see the comment above
 * `onMutationAwaitingDisambiguation` in useEditorEditing.ts): for
 * `scope === "definition"` mutations, the save path ALWAYS rewrites the
 * shared template line — a "this row only" choice would silently lie.
 * The helper must never offer `this-instance` for anything but
 * `scope === "callsite"`.
 */

import { describe, expect, it } from "vitest"
import type { PendingMutation } from "@/editor/core/edit"
import { offeredDisambiguationChoices } from "./disambiguation-choices"

function makePending(
  overrides: Partial<PendingMutation["draft"]> = {},
  candidates: PendingMutation["candidates"] = [
    { instancePath: "[0]", selector: "[data-testid=row-0]", origin: true },
    { instancePath: "[1]", selector: "[data-testid=row-1]", origin: false },
    { instancePath: "[2]", selector: "[data-testid=row-2]", origin: false },
  ],
): PendingMutation {
  return {
    pendingId: "pending-1",
    draft: {
      id: "m-1",
      kind: "text",
      sourceLoc: "src/App.vue:12:4",
      resolutionKind: "direct",
      scope: "callsite",
      callsiteLoc: null,
      selector: "[data-testid=row-0]",
      before: "Hello",
      after: "Hi",
      ...overrides,
    },
    candidates,
  }
}

describe("offeredDisambiguationChoices", () => {
  it("offers both this-instance and all-instances for callsite scope", () => {
    const result = offeredDisambiguationChoices(makePending({ scope: "callsite" }))
    expect(result.choices.map((c) => c.choice)).toEqual([
      "this-instance",
      "all-instances",
    ])
  })

  it("offers ONLY all-instances for definition scope (honesty rule)", () => {
    const result = offeredDisambiguationChoices(makePending({ scope: "definition" }))
    expect(result.choices.map((c) => c.choice)).toEqual(["all-instances"])
  })

  it("offers ONLY all-instances for unknown scope (fails safe, not open)", () => {
    const result = offeredDisambiguationChoices(makePending({ scope: "unknown" }))
    expect(result.choices.map((c) => c.choice)).toEqual(["all-instances"])
  })

  it("explains the shared-template reason when definition-scoped", () => {
    const result = offeredDisambiguationChoices(makePending({ scope: "definition" }))
    const allInstances = result.choices.find((c) => c.choice === "all-instances")
    expect(allInstances?.hint).toMatch(/written once in the code/i)
    expect(allInstances?.hint).toMatch(/shared/i)
  })

  it("explains the this-row vs. template distinction when callsite-scoped", () => {
    const result = offeredDisambiguationChoices(makePending({ scope: "callsite" }))
    const thisInstance = result.choices.find((c) => c.choice === "this-instance")
    const allInstances = result.choices.find((c) => c.choice === "all-instances")
    expect(thisInstance?.hint).toBeTruthy()
    expect(allInstances?.hint).toBeTruthy()
    expect(thisInstance?.hint).not.toEqual(allInstances?.hint)
  })

  it("derives rowCount from candidates.length", () => {
    const result = offeredDisambiguationChoices(
      makePending({}, [
        { instancePath: "[0]", selector: "a", origin: true },
        { instancePath: "[1]", selector: "b", origin: false },
      ]),
    )
    expect(result.rowCount).toBe(2)
  })

  it("passes through scope, before, and after verbatim when short", () => {
    const result = offeredDisambiguationChoices(
      makePending({ scope: "callsite", before: "Hello", after: "Hi" }),
    )
    expect(result.scope).toBe("callsite")
    expect(result.before).toBe("Hello")
    expect(result.after).toBe("Hi")
  })

  it("truncates long before/after values for display", () => {
    const longBefore = "x".repeat(200)
    const longAfter = "y".repeat(200)
    const result = offeredDisambiguationChoices(
      makePending({ before: longBefore, after: longAfter }),
    )
    expect(result.before.length).toBeLessThan(longBefore.length)
    expect(result.after.length).toBeLessThan(longAfter.length)
    expect(result.before.endsWith("…")).toBe(true)
    expect(result.after.endsWith("…")).toBe(true)
  })
})
