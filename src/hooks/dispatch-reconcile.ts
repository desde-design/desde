/**
 * Pure reconciliation-decision core for the branch-mode dispatch machines
 * in `useEditorEditing` — `dispatchBranchTextMutation`,
 * `dispatchBranchPropEdit`, `dispatchBranchClassMutation` — extracted
 * share-readiness Phase 3 Batch B. Each dispatch lands the edit directly on
 * the working tree as an ordinary uncommitted change (no auto-commit —
 * branch mode never commits on the agent's/editor's behalf; the user
 * commits everything at once via the top-bar Commit).
 *
 * Each machine debounces a captured mutation/prop-edit to a network
 * dispatch (`adapter.applyEdit`), and on a SUCCESSFUL response needs to
 * decide: did the live buffer settle at the value we just dispatched (drop
 * the buffered entry — nothing more to do), or did the designer keep
 * editing while the dispatch was in flight (keep the entry and re-fire a
 * follow-up dispatch)? All three machines make this decision the same
 * way — compare the value snapshotted at dispatch time against the
 * buffer's CURRENT value for that identity — so this module is that
 * shared piece.
 *
 * What's NOT shared, and stays in each per-kind wrapper in the hook:
 *  - the debounce timer bookkeeping (`Map<key, Timeout>` + refs) and the
 *    in-flight-guard `Set` — these are stateful scheduling concerns, not
 *    decisions;
 *  - the network call itself (`adapter.applyEdit`);
 *  - FAILURE-branch handling, which genuinely diverges per kind: the text
 *    lane queues fuzzy edits for the AI lane (`needsChat`), the prop lane
 *    escalates to chat AND has a one-shot stale-target auto-recovery
 *    retry, and the class lane has no chat-fallback path at all
 *    (scoped-css-override / jsx-style are deterministic-only). Forcing
 *    these into one shape would either lose behavior or bloat the
 *    "shared" core with kind-specific branches, so this module covers
 *    only the settle/advance decision below — never called on failure;
 *  - the specific REBASE fields to write when advancing (the text lane
 *    rebases `before` + `sourceVersion`; the prop lane rebases
 *    `editTarget.fileHash`) — kind-specific shapes the caller computes
 *    after consulting this decision.
 *
 * See tasks/share-readiness-plan.md.
 */

export type ReconcileDecision = "no-entry" | "settled" | "advanced"

/**
 * Decide what a branch-mode dispatch machine should do with its buffered
 * entry once a dispatch resolves successfully.
 *
 * - `"no-entry"` — the buffered entry this dispatch was for is gone from
 *   the live buffer by the time the response came back (rare; every
 *   caller today treats this as a no-op — leave the buffer untouched).
 * - `"settled"` — the buffer's current value for this identity still
 *   equals the value snapshotted at dispatch time: no edits arrived while
 *   the request was in flight. Drop the entry.
 * - `"advanced"` — the buffer's current value has moved past what was
 *   dispatched (the designer kept editing during the round trip). Keep
 *   the entry, rebase it, and schedule a follow-up dispatch.
 */
export function reconcileDispatchedValue<T>(
  entryExists: boolean,
  dispatchedValue: T,
  currentValue: T,
): ReconcileDecision {
  if (!entryExists) return "no-entry"
  return Object.is(dispatchedValue, currentValue) ? "settled" : "advanced"
}
