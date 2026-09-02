/**
 * The Activity panel's ledger-row-to-verification join (Task 4b).
 *
 * Extracted from `activity-panel.tsx` so the join itself is testable
 * without mounting React — the defect this fixes (`row.id ===
 * verification.editId`, comparing two disjoint id spaces — a server-minted
 * `randomUUID()` against the client's own edit id) shipped because nothing
 * exercised the join in isolation.
 *
 * The correct join key is `LedgerRow.correlationId`: the client's edit id,
 * sent to the server as an opaque value on `POST /api/editor/edit`
 * (`build-edit-request.ts`) and echoed back verbatim on the resulting
 * ledger row (`src/editor/ledger/entry.ts`'s `LedgerEditEntry.correlationId`).
 * It is absent whenever the writing client didn't send one — an older
 * client, or the chat/SDK-tool write lanes, which don't go through that
 * request path at all. Absence must read as "no pill," not as a match.
 */

import type { VerificationRecord } from "@/stores/editor-slice"

/**
 * Look up the verification record for a ledger row's correlation id.
 *
 * Guards explicitly against the "two absent ids" hazard rather than
 * relying on `Map`'s incidental behavior: `correlationId` is refused
 * up front when falsy, so this function can never reach `Map.get` with
 * anything but a real, non-empty string. This matters because
 * `undefined === undefined` is `true` in JS — a naive
 * `row.correlationId === verification.editId` comparison (or an
 * unguarded `map.get(row.correlationId)` against a map that happened to
 * carry an entry keyed by an empty/absent id) would match EVERY pair of
 * id-less rows and records, not just the zero it should. This branch
 * already shipped one bug of exactly that shape (a HEAD fingerprint
 * comparison where two failed reads compared equal and read as "nothing
 * moved") — this is the same hazard, guarded the same way: refuse before
 * comparing, don't rely on the comparison itself to come out safe.
 */
export function verificationForLedgerRow(
  correlationId: string | undefined,
  verificationByEditId: ReadonlyMap<string, VerificationRecord>,
): VerificationRecord | undefined {
  if (!correlationId) return undefined
  return verificationByEditId.get(correlationId)
}
