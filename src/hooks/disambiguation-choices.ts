/**
 * Pure helper behind the v-for mutation-disambiguation dialog. Derives the
 * HONEST set of choices for a `PendingMutation` — extracted so the
 * scope-gating rule is unit-testable without mounting `useEditorEditing`
 * (which depends on the bridge adapter, several Zustand stores, and refs).
 *
 * **Load-bearing honesty rule** (prior codex P1 — see the comment above
 * `onMutationAwaitingDisambiguation` in useEditorEditing.ts): for
 * `scope === "definition"` mutations, the save path ALWAYS rewrites the
 * shared v-for template line, regardless of `disambiguationChoice`. Offering
 * "this row only" there would silently lie — the designer would believe
 * only their row changed while every row did. So `this-instance` is offered
 * ONLY for `scope === "callsite"`, whose save path actually honors it (the
 * fast-path swaps `sourceLoc` → `callsiteLoc` for the splice target). Every
 * other scope — including `"unknown"`, captured before scope was
 * determined — fails safe to the single honest option: rewrite the
 * template, or discard.
 */

import type { DisambiguationChoice, PendingMutation } from "@/editor/core/edit"

const MAX_PREVIEW_LENGTH = 80

function truncate(value: string): string {
  if (value.length <= MAX_PREVIEW_LENGTH) return value
  return `${value.slice(0, MAX_PREVIEW_LENGTH - 1)}…`
}

export interface DisambiguationChoiceOption {
  choice: DisambiguationChoice
  title: string
  hint: string
}

export interface OfferedDisambiguationChoices {
  /** How many v-for siblings share the ambiguous `sourceLoc`. */
  rowCount: number
  scope: PendingMutation["draft"]["scope"]
  /** Truncated for display; use the raw `draft.before/after` for logic. */
  before: string
  after: string
  /** Honest choice set — see module doc. Always non-empty. */
  choices: readonly DisambiguationChoiceOption[]
}

const ALL_INSTANCES_HINT_BY_SCOPE: Record<
  PendingMutation["draft"]["scope"],
  string
> = {
  callsite:
    "Rewrites the shared code, so every item shows the new value.",
  definition:
    "This text is written once in the code shared by every item, so there is no single item to change on its own.",
  unknown:
    "This text is written once in the code shared by every item, so there is no single item to change on its own.",
}

export function offeredDisambiguationChoices(
  pending: PendingMutation,
): OfferedDisambiguationChoices {
  const rowCount = pending.candidates.length
  const scope = pending.draft.scope

  const allInstances: DisambiguationChoiceOption = {
    choice: "all-instances",
    title: rowCount > 1 ? `Change all ${rowCount} items` : "Change the shared code",
    hint: ALL_INSTANCES_HINT_BY_SCOPE[scope],
  }

  const choices: DisambiguationChoiceOption[] =
    scope === "callsite"
      ? [
          {
            choice: "this-instance",
            title: "This item only",
            hint: "Changes only the code that produced this item. The other items stay as they are.",
          },
          allInstances,
        ]
      : [allInstances]

  return {
    rowCount,
    scope,
    before: truncate(pending.draft.before),
    after: truncate(pending.draft.after),
    choices,
  }
}
