"use client"

import { toast } from "sonner"
import type { MutationResolutionFailure, MutationResolutionFailureCode } from "@/types/bridge"

/**
 * Surfacing for `MUTATION_RESOLUTION_FAILED` — the bridge refusing to map an
 * edit to a source position.
 *
 * ## Why this exists at all
 *
 * The bridge always reported this case, the adapter always dispatched it, and
 * for a long time nothing subscribed, so the user watched an edit stick that
 * existed in no source file. The bridge now puts the element back
 * (`dom-edit-mode.ts`, `failResolution`), and this module says what happened.
 *
 * ## Text edits go to chat
 *
 * A refused TEXT edit is handed to a new chat session instead of dead-ending
 * (Mo's rule from 2026-09-08: an edit the direct path cannot make goes to
 * chat). The bridge refuses because no stamp places the element, but the
 * agent can search for the text. MEASURED 2026-09-21: a date on a Webflow-export
 * page lived in `content/home.json` and nowhere a stamp could point. Other
 * kinds stay a notice: a class or style change has no text to search for.
 *
 * ## Why a toast, and not the Checks tab
 *
 * A resolution failure is PRE-dispatch: nothing was written and nothing was
 * verified, so a Checks entry would be a "failed check" for work never
 * attempted. It is also immediately actionable, which is what a toast is for.
 *
 * ## The words live here
 *
 * The bridge sends a code, not a sentence. Only the shell knows whether the
 * edit went to chat, and its old prose ("no data-desde-src ... ancestor") was
 * written for the person debugging the bridge, not the person editing a page.
 */

export const RESOLUTION_FAILURE_TITLE = "Change not saved"

const DESCRIPTIONS: Record<MutationResolutionFailureCode, string> = {
  "isolation-view":
    "Components shown on their own can't be edited here. Leave this view and edit the component where a page uses it.",
  "ancestor-only": "The Editor couldn't find where this is in the code.",
  "no-anchor": "The Editor couldn't find where this is in the code.",
}

/**
 * Deliberately says nothing about WHY chat did not take it. A refusal can be a
 * busy chat, a missing AI key or a failed turn, and the chat surface reports
 * its own reason (MEASURED: a missing key showed "Chat session failed ... needs
 * an Anthropic API key" beside this toast). Guessing "try again when Chat is
 * free" was wrong in that case.
 */
export const TEXT_HANDOFF_REFUSED_DESCRIPTION =
  "The Editor couldn't find where this text is in the code, and couldn't send it to Chat either."

/** The notice for a failure that is not handed to chat. */
export function resolutionFailureDescription(failure: MutationResolutionFailure): string {
  return DESCRIPTIONS[failure.code]
}

/**
 * Whether this refusal goes to chat. Text only, never from isolation view
 * (there is no usage to edit there), and never a no-op.
 */
export function shouldHandOffToChat(failure: MutationResolutionFailure): boolean {
  return (
    failure.kind === "text" &&
    failure.code !== "isolation-view" &&
    failure.before !== failure.after
  )
}

/**
 * Stable per-element toast id. Repeat attempts on the same element are the norm,
 * not the exception (in isolation view EVERY style click fails identically), so
 * sonner should replace the existing toast rather than stack a fresh one per
 * click. Keyed on the selector, not the mutation id, which is fresh each time.
 */
export function resolutionFailureToastId(failure: Pick<MutationResolutionFailure, "selector">): string {
  return `mutation-resolution-failed:${failure.selector}`
}

export function notifyResolutionFailure(failure: MutationResolutionFailure): void {
  toast.warning(RESOLUTION_FAILURE_TITLE, {
    id: resolutionFailureToastId(failure),
    description: resolutionFailureDescription(failure),
  })
}

/**
 * A text hand-off chat did not take. Nothing is said when it DID take: the
 * shell's own escalation handler already toasts "Sent this edit to chat" for
 * every accepted hand-off, and the chat message explains why this one went
 * there. MEASURED 2026-09-21: a second "Sent to Chat" toast here stacked on it.
 */
export function notifyTextHandOffRefused(failure: MutationResolutionFailure): void {
  toast.warning(RESOLUTION_FAILURE_TITLE, {
    id: resolutionFailureToastId(failure),
    description: TEXT_HANDOFF_REFUSED_DESCRIPTION,
  })
}

/**
 * The shell-side response to a refusal that is NOT handed to chat: tell the
 * user, and tell the inspector to re-read.
 *
 * The settle half is not optional bookkeeping. No mutation was emitted, so no
 * override was registered and no `resolveOverride` will ever carry the usual
 * settle signal, while the bridge has already put the element back. Without
 * this the inspector keeps naming the value it no longer shows (the stale
 * swatch `cancelDisambiguation` documents from a live run).
 *
 * `settle` is injected so this module stays pure. Production passes
 * `useEditorStore.getState().notePreviewSettled`.
 *
 * Notify-then-settle: the toast is the user-visible half and must not be lost
 * if a settle subscriber throws.
 */
export function handleResolutionFailure(
  failure: MutationResolutionFailure,
  settle: () => void,
): void {
  notifyResolutionFailure(failure)
  settle()
}
