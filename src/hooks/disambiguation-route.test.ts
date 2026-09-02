/**
 * The routing table for `MUTATION_AWAITING_DISAMBIGUATION`.
 *
 * The tests that matter here are the PRECEDENCE ones. Each individual branch
 * is easy and was already effectively covered; what had no guard at all was
 * what happens when two predicates are true at once, which is the normal case
 * for a loop row.
 */

import { describe, expect, it } from "vitest"
import { routeAwaitingDisambiguation } from "./disambiguation-route"
import type { PendingMutation } from "@/editor/core/edit"

function pending(over: {
  scope?: PendingMutation["draft"]["scope"]
  candidates?: number
  origins?: number
} = {}): PendingMutation {
  const count = over.candidates ?? 8
  const origins = over.origins ?? 1
  return {
    pendingId: "p1",
    draft: {
      id: "m1",
      kind: "text",
      sourceLoc: "src/pages/Settings.vue:118:10",
      resolutionKind: "direct",
      scope: over.scope ?? "definition",
      callsiteLoc: "src/pages/Settings.vue:118:10",
      selector: "li:nth-of-type(3) > span",
      before: "Rate limiting",
      after: "Rate limits",
    },
    candidates: Array.from({ length: count }, (_, i) => ({
      instancePath: `App>List[${i}]`,
      selector: `li:nth-of-type(${i + 1}) > span`,
      origin: i < origins,
    })),
  }
}

describe("routeAwaitingDisambiguation", () => {
  it("auto-resolves a lone-origin callsite mutation as a per-item edit", () => {
    expect(
      routeAwaitingDisambiguation({
        pending: pending({ scope: "callsite" }),
        originCount: 1,
        iterationRouteAvailable: false,
      }),
    ).toEqual({ kind: "auto-resolve", choice: "this-instance" })
  })

  it("does NOT auto-resolve definition scope, whose save path ignores the choice", () => {
    const route = routeAwaitingDisambiguation({
      pending: pending({ scope: "definition" }),
      originCount: 1,
      iterationRouteAvailable: false,
    })
    expect(route.kind).not.toBe("auto-resolve")
  })

  it("auto-applies the single honest option for a non-loop definition mutation", () => {
    expect(
      routeAwaitingDisambiguation({
        pending: pending({ scope: "definition" }),
        originCount: 1,
        iterationRouteAvailable: false,
      }),
    ).toEqual({ kind: "auto-apply", choice: "all-instances" })
  })

  it("queues the dialog when there is a real two-way choice", () => {
    // `callsite` scope with more than one origin: `offeredDisambiguationChoices`
    // offers both "this item only" and "all items", so there IS a decision.
    expect(
      routeAwaitingDisambiguation({
        pending: pending({ scope: "callsite", origins: 2 }),
        originCount: 2,
        iterationRouteAvailable: false,
      }),
    ).toEqual({ kind: "queue-dialog" })
  })

  /**
   * The regression this module exists for.
   *
   * Both predicates match a loop row. If the single-choice branch were checked
   * first, the row would silently auto-apply "change all N items" with a
   * success toast, and the per-row text lane (patch-text into the data array)
   * would become unreachable with nothing thrown and nothing logged.
   */
  describe("precedence", () => {
    it("routes a loop row to the iteration dialog, NOT to auto-apply", () => {
      const input = {
        pending: pending({ scope: "definition" }),
        originCount: 1,
        iterationRouteAvailable: true,
      }
      // Both are genuinely eligible: prove it rather than assuming.
      expect(
        routeAwaitingDisambiguation({ ...input, iterationRouteAvailable: false }),
      ).toEqual({ kind: "auto-apply", choice: "all-instances" })
      // With the iteration route available it must win.
      expect(routeAwaitingDisambiguation(input)).toEqual({
        kind: "iteration-dialog",
      })
    })

    it("still prefers the callsite auto-resolve over the iteration dialog", () => {
      // Callsite scope already reaches a per-item edit with no dialog at all,
      // which is strictly better than asking. Ordering holds at the top too.
      expect(
        routeAwaitingDisambiguation({
          pending: pending({ scope: "callsite" }),
          originCount: 1,
          iterationRouteAvailable: true,
        }),
      ).toEqual({ kind: "auto-resolve", choice: "this-instance" })
    })

    it("never auto-applies while the iteration route is available, at any candidate count", () => {
      for (const candidates of [1, 2, 8, 40]) {
        expect(
          routeAwaitingDisambiguation({
            pending: pending({ scope: "definition", candidates }),
            originCount: 1,
            iterationRouteAvailable: true,
          }).kind,
        ).toBe("iteration-dialog")
      }
    })
  })
})
