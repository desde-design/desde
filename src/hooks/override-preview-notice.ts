"use client"

import { toast } from "sonner"
import type { OverridePreviewFailure } from "@/editor/core"
import type { PreviewFailureKind } from "@/types/bridge"

/**
 * Surfacing for `PROP_OVERRIDE_RESULT` / `ATTR_OVERRIDE_RESULT` with
 * `ok: false` — a live-preview poke the substrate could not apply.
 *
 * ## Why this exists at all
 *
 * The bridge has always reported the outcome of every prop/attr preview poke,
 * and the shell had no switch case for either message, so `ok: false` was
 * discarded on arrival. The designer moved a control, the iframe didn't change,
 * and nothing said why — the same silent-failure shape as the unsubscribed
 * `MUTATION_RESOLUTION_FAILED` (see `resolution-failure-notice`).
 *
 * ## Why this is NOT the same notice as a resolution failure
 *
 * A resolution failure is terminal: the edit will never reach source, so its
 * title says the edit "couldn't be mapped to source". A failed preview is not
 * terminal — the buffered edit still dispatches to the working tree on save,
 * and HMR renders it for real. What's lost is only the instant feedback. Saying
 * "the change wasn't saved" here would be a lie in the more alarming direction,
 * which is why this is a sibling module rather than a second caller of
 * `notifyResolutionFailure`: the payloads differ (no mutation id; a prop/attr
 * name instead) and, more importantly, the two mean opposite things about
 * whether the user's work survives.
 *
 * The bridge owns the reason (which of "selector no longer resolves" / "no
 * component instance" / "no props object" / "assignment refused" it was — the
 * shell cannot tell); this module owns the consequence sentence, so the
 * reassurance is stated once here instead of being appended to four bridge
 * strings.
 *
 * ## Why one cause is deliberately silent
 *
 * The live-preview write path reads Vue's dev-mode instance metadata, so on a
 * React substrate (or a Vue production build) EVERY prop and attr poke reports
 * `ok: false` — while the source write beside it succeeds and HMR renders the
 * change for real. Toasting that is a warning on an edit that worked, on every
 * edit, forever: a false alarm, and de-duplication only makes it a permanent one
 * instead of a stack. A surface that cries wolf on working edits teaches the user
 * to ignore the genuine failures it exists to deliver, so `unsupported-substrate`
 * is filtered here (the bridge still reports it, and logs it once to the iframe
 * console — see `hasVuePreviewSupport` in `src/bridge/override-preview.ts`).
 *
 * The filter is a whitelist of ONE cause rather than a list of causes to show:
 * an unrecognized or absent cause toasts, so a new bridge failure mode — or an
 * older bundle that sends no cause at all — can never be silently swallowed.
 */

export const OVERRIDE_PREVIEW_FAILURE_TITLE = "Change not shown in the preview"

/**
 * The consequence half, always appended. The point of the notice is that the
 * missing preview is NOT a lost edit — without this the user's rational move is
 * to click the control again, or to assume editor is broken and stop.
 */
export const OVERRIDE_PREVIEW_FAILURE_CONSEQUENCE =
  // "still buffered" was ours, not theirs (Mo, 2026-08-18: "I don't know what
  // buffered means in this case"). It named an internal holding state; what
  // the reader needs is that the edit is not lost and the file still gets it.
  "Your change is not lost. It is still being written to the file."

/**
 * Fallback for a bridge that reported the failure without a reason (any bundle
 * older than `2026-08-06h`). A title-only toast would leave the user guessing, so
 * the generic wording still says what happened and what it means.
 */
export const OVERRIDE_PREVIEW_FAILURE_FALLBACK =
  "The prototype couldn't apply this value to the live component."

/**
 * Stable per-target toast id. Every keystroke / slider tick is its own poke, so
 * an id keyed on anything per-edit would stack a wall of identical toasts
 * during one drag. Keyed on the element + the prop or attribute name — the
 * narrowest thing the user can act on separately — and on `kind` so a prop and
 * a fallthrough attr that happen to share a name stay distinct.
 */
export function overridePreviewFailureToastId(
  failure: OverridePreviewFailure,
): string {
  return `override-preview-failed:${failure.kind}:${failure.selector}:${failure.name}`
}

export function overridePreviewFailureDescription(
  failure: OverridePreviewFailure,
): string {
  const reason = failure.reason?.trim() || OVERRIDE_PREVIEW_FAILURE_FALLBACK
  return `${reason} ${OVERRIDE_PREVIEW_FAILURE_CONSEQUENCE}`
}

/**
 * Causes that are NOT worth telling the user about, because they don't describe
 * anything the user did or can change — they describe the substrate. Kept as an
 * explicit deny-set of one so the default for everything else, including a cause
 * this build has never heard of, stays "surface it".
 */
const SILENT_CAUSES: ReadonlySet<PreviewFailureKind> = new Set([
  "unsupported-substrate",
])

/**
 * Would this failure reach the user? Exported so the suppression rule is
 * assertable directly, rather than only through a not-called-toast side effect.
 */
export function shouldNotifyOverridePreviewFailure(
  failure: OverridePreviewFailure,
): boolean {
  return failure.cause === undefined || !SILENT_CAUSES.has(failure.cause)
}

export function notifyOverridePreviewFailure(
  failure: OverridePreviewFailure,
): void {
  if (!shouldNotifyOverridePreviewFailure(failure)) return
  toast.warning(OVERRIDE_PREVIEW_FAILURE_TITLE, {
    id: overridePreviewFailureToastId(failure),
    description: overridePreviewFailureDescription(failure),
  })
}
