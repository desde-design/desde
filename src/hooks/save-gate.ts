/**
 * What Save may do, given what is unsaved. Pure, so the decision can be tested
 * without mounting `useEditorEditing`.
 *
 * A "parked" edit is one the deterministic pipeline could not route on its own:
 * it sits in `pendingDisambiguations` waiting for the designer to answer "this
 * instance or all instances". It is unsaved work, and it is the only unsaved
 * work Save cannot write.
 *
 * The bug this exists to prevent: the parked check used to live INSIDE the
 * "there is nothing to apply" branch, so it only ran when both mutation arrays
 * were empty. With one writable mutation present, Save applied that mutation,
 * reported success, and left the parked edit exactly where it was. The designer
 * was told everything was saved while the edit they had just made was still
 * waiting on a question nobody had answered.
 */
export type SaveGateDecision =
  /** A parked edit is unresolved. Apply NOTHING; the whole Save refuses. */
  | "blocked-parked"
  /** Nothing to apply and nothing parked. Trivially ok. */
  | "nothing"
  /** There is writable work and nothing is parked. */
  | "proceed"

export function saveGate(args: {
  /** How many edits are waiting on a scope choice. */
  pendingDisambiguations: number
  /** Direct (non-class) DOM mutations, which go out as an llm-patch bundle. */
  mutations: number
  /** Class mutations that route through the scoped-css-override lane. */
  scoped: number
}): SaveGateDecision {
  // FIRST, before anything is applied. A partial Save that also reports
  // success is worse than a refusal: the refusal is visible and the designer
  // can answer the question, while the success is a claim about work that is
  // still sitting in a dialog.
  if (args.pendingDisambiguations > 0) return "blocked-parked"
  if (args.mutations === 0 && args.scoped === 0) return "nothing"
  return "proceed"
}

/**
 * The status line for a Save refused by a parked edit.
 *
 * Says the count, names the dialog, and says what dismissing it does, because
 * dismissing discards rather than resolves and that is not guessable.
 */
export function parkedSaveRefusal(count: number): string {
  return `Cannot save: ${count} edit${count === 1 ? "" : "s"} still need a scope choice. Resolve the "Resolve ambiguous edit" dialog, or dismiss it to discard, before saving.`
}
