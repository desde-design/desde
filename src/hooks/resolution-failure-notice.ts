"use client"

import { toast } from "sonner"

/**
 * Surfacing for `MUTATION_RESOLUTION_FAILED` — the bridge refusing to map an
 * edit to a source position.
 *
 * ## Why this exists at all
 *
 * The bridge has always written a careful reason string for this case (the
 * isolation-view explanation, the ancestor-only-anchor explanation) and always
 * sent it; the adapter has always dispatched it to `onResolutionFailed`. Nothing
 * subscribed. So the one signal the user needed — "this change will not persist,
 * and here is why" — was built end-to-end and then dropped on the floor. Paired
 * with the bridge fix that releases the unowned preview (`dom-edit-mode.ts`,
 * `releaseUnownedPreview`), the user now sees the change come back off AND is
 * told why, instead of watching an edit stick that exists in no source file.
 *
 * ## Why a toast, and not the Checks tab
 *
 * A resolution failure is PRE-dispatch: no mutation was emitted, nothing was
 * written, nothing was verified. The Checks tab's verification strip records
 * `VerificationResult`s keyed by the id of an edit that actually ran, so putting
 * this there would mean synthesizing a verification record for an edit that never
 * happened — a "failed check" for work never attempted. It is also immediately
 * actionable (exit isolation view; pick a different element), which is what a
 * toast is for, matching the `toast.warning("Edit didn't take effect")` precedent
 * in `useEditVerification`.
 *
 * Extracted rather than inlined into `useEditorEditing`'s subscription effect
 * so it can be unit-tested (same pattern as `disambiguation-choices`,
 * `edit-outcome`, `editor-mutation-coalesce`).
 */

/** The bridge's `MUTATION_RESOLUTION_FAILED` payload, as the adapter delivers it. */
export interface ResolutionFailure {
  id: string
  reason: string
  selector: string
}

export const RESOLUTION_FAILURE_TITLE = "Edit couldn't be mapped to source"

/**
 * Fallback description. The bridge always sends a reason today, but a shell that
 * silently showed a title-only toast would be a worse version of the bug this
 * closes — the user must always learn that the change will not persist.
 */
export const RESOLUTION_FAILURE_FALLBACK =
  "The prototype couldn't tell which source location this element came from, so the change wasn't saved."

/**
 * Stable per-element toast id. Repeat attempts on the same element are the norm,
 * not the exception (in isolation view EVERY style click fails identically), so
 * sonner should replace the existing toast rather than stack a fresh one per
 * click. Keyed on the selector, not the mutation id, which is fresh each time.
 */
export function resolutionFailureToastId(failure: ResolutionFailure): string {
  return `mutation-resolution-failed:${failure.selector}`
}

export function notifyResolutionFailure(failure: ResolutionFailure): void {
  toast.warning(RESOLUTION_FAILURE_TITLE, {
    id: resolutionFailureToastId(failure),
    description: failure.reason.trim() || RESOLUTION_FAILURE_FALLBACK,
  })
}

/**
 * The complete shell-side response to a resolution failure: tell the user, and
 * tell the inspector to re-read.
 *
 * The settle half is not optional bookkeeping. This path has the same shape as
 * `cancelDisambiguation` — no mutation is emitted, so no override is ever
 * registered, so no `resolveOverride` can fire and `resolveOverrideSettled`
 * never runs. The bridge reverts its own preview (`releaseUnownedPreview`,
 * `src/bridge/dom-edit-mode.ts`), which means the DOM changes underneath a
 * shell that was told nothing. The inspector's style rows show a PROVISIONAL
 * value while the inline `!important` shim is stamped on the element and
 * re-read only when the settle nonce bumps, so without this they keep naming
 * the shim's colour after the element has already gone back to its real one —
 * the same stale-swatch failure `cancelDisambiguation` documents from a live
 * run (the swatch held the discarded `bg-amber-500` while the badge had
 * reverted to `rgb(249,250,251)`).
 *
 * `settle` is injected rather than reaching for `useEditorStore` here so this
 * module stays a pure notification module and the pairing stays testable
 * without standing up the store. Production passes
 * `useEditorStore.getState().notePreviewSettled`.
 *
 * Notify-then-settle: the toast is the user-visible half and must not be lost
 * if a settle subscriber throws.
 */
export function handleResolutionFailure(
  failure: ResolutionFailure,
  settle: () => void,
): void {
  notifyResolutionFailure(failure)
  settle()
}
