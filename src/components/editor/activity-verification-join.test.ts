/**
 * `verificationForLedgerRow` — the Activity panel's ledger-row-to-
 * verification join (Task 4b). See the module doc comment for the defect
 * this replaces: `row.id === verification.editId` compared two disjoint
 * id spaces and could never match a real edit.
 */

import { describe, expect, it } from "vitest"
import { verificationForLedgerRow } from "./activity-verification-join"
import type { VerificationRecord } from "@/stores/editor-slice"

function record(editId: string): VerificationRecord {
  return { editId, label: "test", phase: "running", startedAt: Date.now() }
}

describe("verificationForLedgerRow", () => {
  it("joins a row's correlationId to the verification with the same editId", () => {
    const verification = record("client-edit-1")
    const map = new Map([["client-edit-1", verification]])
    expect(verificationForLedgerRow("client-edit-1", map)).toBe(verification)
  })

  it("returns undefined when the correlationId matches nothing in the map", () => {
    const map = new Map([["client-edit-1", record("client-edit-1")]])
    expect(verificationForLedgerRow("client-edit-2", map)).toBeUndefined()
  })

  it("returns undefined — never a match — when the row has no correlationId", () => {
    const map = new Map([["client-edit-1", record("client-edit-1")]])
    expect(verificationForLedgerRow(undefined, map)).toBeUndefined()
  })

  it("an empty-string correlationId also refuses rather than matching", () => {
    // Defense in depth: `edit.id` is never really an empty string
    // (`makeEditId()` always mints a real UUID or a `edit-<ts>-<rand>`
    // fallback), but the guard is `if (!correlationId)`, not
    // `if (correlationId === undefined)` — pin that an empty string is
    // ALSO refused, not just `undefined`.
    const map = new Map([["", record("")]])
    expect(verificationForLedgerRow("", map)).toBeUndefined()
  })

  it(
    "two rows with no correlationId do not both resolve to the same phantom " +
      "verification, even when the map literally holds an `undefined` key — " +
      "the exact 'undefined === undefined' shape a prior bug on this branch " +
      "shipped (a HEAD-fingerprint comparison where two failed reads compared " +
      "equal and read as 'nothing moved')",
    () => {
      // Round-2 review finding: the FIRST version of this test used `""` as
      // the map's falsy key while the row's correlationId was `undefined`.
      // `Map.get(undefined)` never matches a `""`-keyed entry regardless of
      // the guard, so that test passed for the wrong reason — the reviewer
      // mutated the guard away and only the empty-string sibling test above
      // went red. This version forces a LITERAL `undefined` key into the
      // map (bypassing the `Map<string, …>` type — the whole point is to
      // reproduce the exact runtime shape the guard defends against, not a
      // shape the type system would itself prevent a real caller from
      // producing). Without the `if (!correlationId) return undefined`
      // guard, `map.get(undefined)` genuinely returns `phantom` here; with
      // it, the check short-circuits before `.get` is ever called.
      const phantom = record("phantom-with-no-real-editId")
      const map = new Map([[undefined, phantom]]) as unknown as ReadonlyMap<
        string,
        VerificationRecord
      >
      const rowA = verificationForLedgerRow(undefined, map)
      const rowB = verificationForLedgerRow(undefined, map)
      expect(rowA).toBeUndefined()
      expect(rowB).toBeUndefined()
    },
  )

  it("an empty map never matches a defined correlationId", () => {
    expect(verificationForLedgerRow("client-edit-1", new Map())).toBeUndefined()
  })
})
