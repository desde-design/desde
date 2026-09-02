/**
 * Which of four routes an incoming `MUTATION_AWAITING_DISAMBIGUATION` takes.
 *
 * Extracted from `onMutationAwaitingDisambiguation` in `useEditorEditing.ts`
 * for one reason: **the ORDER of these branches is load-bearing and nothing
 * tested it.** Three of the four are guarded by predicates that overlap, and
 * two of them return, so the routing was correct only by the sequence the `if`
 * statements happened to be written in. There is no `useEditorEditing` test
 * file, and the pieces each have their own suite while the composition had
 * none.
 *
 * ## The collision, concretely
 *
 * `offeredDisambiguationChoices` returns exactly ONE choice for every
 * `definition`-scope prompt, and `classifyMutationScope` fails safe to
 * `definition` whenever it cannot prove a 1:1 candidate→callsite mapping. So
 * the single-choice predicate matches essentially every loop row. The
 * iteration route's predicate matches loop rows too.
 *
 * Both are true at once for a loop row typed directly in the page. If
 * `single-choice` were checked first, that row would silently auto-apply
 * "change all N items" and show a success toast, and the per-row text lane
 * (patch-text writing the row's entry in the data array) would become
 * unreachable. Nothing would throw. Nothing would log. A capability would just
 * stop existing.
 *
 * That is why `iteration` sits above `single-choice` here, and why
 * `disambiguation-route.test.ts` asserts the precedence directly rather than
 * asserting each branch in isolation. Flagged in cross-session review before
 * it could regress, not after.
 *
 * ## Why the inputs are pre-computed booleans
 *
 * `iterationRouteAvailable` folds together the selection's `iterationContext`,
 * the source-position match against the mutation's own anchor, and whether the
 * interceptor is mounted. Those read Zustand state and refs, which is exactly
 * what would drag a store and a bridge adapter into this module's tests. The
 * predicate's *contents* are the call site's business; its *precedence* is
 * this module's, and precedence is the part that was unguarded.
 */

import type { DisambiguationChoice, PendingMutation } from "@/editor/core/edit"
import { offeredDisambiguationChoices } from "@/hooks/disambiguation-choices"

export type DisambiguationRoute =
  /** Resolve straight through as a per-item edit. Callsite scope only. */
  | { kind: "auto-resolve"; choice: DisambiguationChoice }
  /**
   * Hand off to the iteration-scope dialog, which can offer a REAL two-way
   * choice for a loop row (this row via the data array, or all rows).
   */
  | { kind: "iteration-dialog" }
  /**
   * Apply the single honest option and report the blast radius in a notice.
   * A one-radio group above a Save button is not a decision.
   */
  | { kind: "auto-apply"; choice: DisambiguationChoice }
  /** Queue the two-option dialog. */
  | { kind: "queue-dialog" }

export interface DisambiguationRouteInput {
  pending: PendingMutation
  /** Candidates the bridge flagged as the element that received the edit. */
  originCount: number
  /**
   * Whether the iteration-scope dialog can take this prompt: a text mutation
   * on a loop row whose selection still describes the same source position,
   * with the interceptor mounted. Computed by the caller — see module doc.
   */
  iterationRouteAvailable: boolean
}

export function routeAwaitingDisambiguation(
  input: DisambiguationRouteInput,
): DisambiguationRoute {
  const { pending, originCount, iterationRouteAvailable } = input

  // 1. Callsite scope is the only scope whose save path actually honours a
  //    this-instance choice, so a lone origin candidate needs no question.
  if (originCount === 1 && pending.draft.scope === "callsite") {
    return { kind: "auto-resolve", choice: "this-instance" }
  }

  // 2. MUST stay above the single-choice branch. See module doc: a loop row
  //    satisfies both, and the iteration dialog is the only one of the two
  //    that can still reach a per-row edit.
  if (iterationRouteAvailable) {
    return { kind: "iteration-dialog" }
  }

  // 3. Everything left that has one honest option: definition-scope mutations
  //    that are NOT loop rows, where "change all N" genuinely is the only
  //    thing that can happen.
  const offered = offeredDisambiguationChoices(pending)
  const only = offered.choices.length === 1 ? offered.choices[0] : undefined
  if (only) {
    return { kind: "auto-apply", choice: only.choice }
  }

  return { kind: "queue-dialog" }
}
