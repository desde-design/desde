"use client"

import { toast } from "sonner"
import type { OfferedDisambiguationChoices } from "@/hooks/disambiguation-choices"

/**
 * Surfacing for the auto-resolved disambiguation — the case where
 * `offeredDisambiguationChoices` has exactly one honest choice.
 *
 * ## Why this exists
 *
 * `disambiguation-choices.ts` enforces an honesty rule: a per-item option is
 * offered ONLY for `scope === 'callsite'`, because that is the only scope whose
 * save path honours it. Every other scope — `definition`, and `unknown` — is
 * left with a single option, "change the shared code".
 *
 * The dialog then rendered a radio group containing one radio, pre-selected,
 * above a Save button. That is not a decision; it is a modal asking the user to
 * agree with the only thing that can happen. And it is not the edge case it
 * looks like: `classifyMutationScope` returns `definition` whenever it CANNOT
 * PROVE a 1:1 candidate→callsite mapping, so the single-option shape is the
 * fallback, not the exception.
 *
 * So the shell auto-resolves it and reports afterwards instead.
 *
 * ## Why a notice and not silence
 *
 * The blast radius is genuinely larger than what the user did. They typed in
 * one item; the write lands on the code that renders all of them, which also
 * covers items added later. That asymmetry is worth one line of prose — it is
 * the same reason the two-option iteration dialog spells out its all-items
 * consequence rather than just naming a count.
 *
 * What made dropping the modal safe is that the consequence is now visible and
 * reversible without it: HMR repaints every affected item within a moment of
 * the write, and toolbar Undo (git-backed, `undo-redo-controls.tsx`, shipped
 * 2026-08-14) reverses the edit in one click. A confirm dialog buys nothing
 * that a visible result plus a real undo does not already buy.
 *
 * ## Why this states INTENT and not OUTCOME
 *
 * The first version said "Changed all 8 items" and added "Undo is in the
 * toolbar". Both were wrong, caught in cross-session review.
 *
 * This notice fires from the RESOLVE, and resolving only posts
 * `RESOLVE_MUTATION_DISAMBIGUATION` to the bridge. The bridge promotes the
 * pending mutation to `MUTATION_CAPTURED`, and the source write is a DEBOUNCED
 * dispatch after that which can still throw (`dispatchBranchTextMutation`'s
 * catch sets "Inline text edit threw"). So a failed edit would have received a
 * past-tense success notice.
 *
 * The Undo line was the sharper bug. At the moment this fires there is no undo
 * entry yet, so a user who read the toast and reacted immediately would have
 * reverted their PREVIOUS commit instead. A toast must never name an
 * affordance it is racing.
 *
 * Present tense fixes both without needing to correlate this notice to a
 * dispatch result: "this edit changes all 8 items" is true when it is said,
 * whatever happens next, and failure has its own notice already. If this is
 * ever moved to fire from the dispatch success path, past tense becomes correct
 * again and the Undo line may come back.
 *
 * ## Copy note — kind-neutral on purpose
 *
 * The dialog's hint said "This text is written once…" for every mutation kind,
 * but `Mutation.kind` is `text | attr | class | style`. A class edit being
 * described as text was wrong in the dialog and would be wrong here.
 *
 * Extracted rather than inlined into `useEditorEditing`'s subscription effect so
 * the copy is unit-testable, matching `resolution-failure-notice` and
 * `override-preview-notice`.
 */

export interface SingleChoiceDisambiguationMessage {
  title: string
  description: string
}

/**
 * Stable toast id, keyed on the shared source position rather than the
 * mutation id (which is fresh per keystroke-commit). Editing the same shared
 * line repeatedly is the norm, so sonner should replace rather than stack.
 */
export function singleChoiceDisambiguationToastId(sourceLoc: string): string {
  return `disambiguation-auto-resolved:${sourceLoc}`
}

export function singleChoiceDisambiguationMessage(
  offered: Pick<OfferedDisambiguationChoices, "rowCount">,
): SingleChoiceDisambiguationMessage {
  // `rowCount` is `candidates.length`, which can legitimately be 1: a single
  // candidate that still failed the callsite proof. "Changed all 1 items" is
  // the kind of sentence that makes a user distrust the rest of the product.
  if (offered.rowCount < 2) {
    return {
      title: "This edit changes the shared code",
      description:
        "This is written once in the code that renders the item, so the change goes there.",
    }
  }
  return {
    title: `This edit changes all ${offered.rowCount} items`,
    description:
      "This is written once in the code that renders every item, so there is no single item to change on its own. Items added later are affected too.",
  }
}

export function notifySingleChoiceDisambiguation(
  offered: Pick<OfferedDisambiguationChoices, "rowCount">,
  sourceLoc: string,
): void {
  const { title, description } = singleChoiceDisambiguationMessage(offered)
  toast.info(title, {
    id: singleChoiceDisambiguationToastId(sourceLoc),
    description,
  })
}
