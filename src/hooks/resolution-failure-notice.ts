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
 * ## Text edits try one deterministic step, then go to chat
 *
 * A refused TEXT edit never dead-ends (Mo's rule from 2026-09-08: an edit the
 * direct path cannot make goes to chat). The bridge refuses because no stamp
 * places the element, but the text itself is still searchable. MEASURED
 * 2026-09-21: a date on a Webflow-export page lived in `content/home.json` and
 * nowhere a stamp could point.
 *
 * So the shell first asks the server to find that exact text in the project's
 * own files and replace it, but only where it appears exactly once
 * (`docs/superpowers/specs/2026-09-21-unique-text-edit-design.md`). That
 * succeeds in about a second and toasts which file changed. Anything else
 * goes to a new chat session, where the agent can search, weigh several
 * matches and ask. Other kinds stay a notice: a class or style change has no
 * text to search for.
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

/** The unique-text step found the text, replaced it, and the page shows it. */
export const UNIQUE_TEXT_APPLIED_TITLE = "Text updated"

/**
 * Which file the change landed in, named outright.
 *
 * The step searches the whole project and takes the one file the text appears
 * in, which may not be the file the designer would have guessed: on a site
 * whose pages are data it is a JSON or Markdown file rather than a component.
 * Naming it is what makes a surprising answer visible at the moment it
 * happens, and it is why the design settled on "replace, then verify" instead
 * of a list of paths to be suspicious of.
 *
 * `file` is optional for one reason: a CLI older than this feature answers a
 * write without naming a file. That CLI refuses the kind outright today, so
 * the fallback is unreachable in practice and exists so the toast cannot read
 * "Changed in undefined".
 */
export function uniqueTextAppliedDescription(file: string | undefined, confirmed: boolean): string {
  const where = file ? `Changed in ${file}` : "The text was changed in the project's files"
  // "Not confirmed" is the truth of a skipped check: no handshake came back,
  // or another page answered. The write stays; the toast does not claim a
  // page showed it (Fable pass, 2026-09-21).
  return confirmed ? where : `${where}. The page could not confirm it.`
}

/**
 * The success notice for a unique-text write the page then showed.
 *
 * On the SAME toast id as the two warnings above, so a retry after a refusal
 * replaces that refusal rather than leaving a stale "Change not saved" beside
 * the confirmation that it now is.
 */
export function notifyUniqueTextApplied(
  failure: Pick<MutationResolutionFailure, "selector">,
  file: string | undefined,
  confirmed: boolean,
): void {
  toast.success(UNIQUE_TEXT_APPLIED_TITLE, {
    id: resolutionFailureToastId(failure),
    description: uniqueTextAppliedDescription(file, confirmed),
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

/**
 * The same notice for a STAMPED text edit the unique-text rung placed by
 * search (route 2), keyed by file: there is no refusal to replace here, and
 * two rung writes to one file within a few seconds are one fact.
 */
export function notifyUniqueTextPlaced(file: string, confirmed: boolean): void {
  toast.success(UNIQUE_TEXT_APPLIED_TITLE, {
    id: `unique-text-placed:${file}`,
    description: uniqueTextAppliedDescription(file, confirmed),
  })
}
