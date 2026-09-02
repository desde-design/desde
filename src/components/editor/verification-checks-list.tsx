/**
 * Verification state vocabulary — shared classification for per-edit
 * verification records (`EditorSlice.verifications`, written by
 * `useEditVerification`).
 *
 * This used to also render a standalone "Checks" list, a strip stacked
 * above the Activity panel's file list. That strip was removed (see
 * `activity-panel.tsx`'s module doc comment): it repeated every verified
 * or failed row a second time, which was the exact "two stacked sections"
 * complaint the panel rebuild exists to fix. What remains here is the pure
 * classification the panel's row pill and `ActivityDetailDialog`'s
 * verification section both read from, so the two surfaces can never
 * drift into two different readings of the same `VerificationRecord`.
 *
 * Four states, deliberately distinct:
 *   running → "Checking…"        info dot, pulsing
 *   pass    → "Verified"         success dot
 *   fail    → "Didn't take effect"  destructive dot (the actionable one)
 *   skipped → "Not checked"      MUTED dot, never a checkmark
 *
 * The last one is load-bearing: a skip rendered as success would be a UI
 * that lies in the one place this feature exists to be honest.
 */

import type { StatusTone } from "@/components/blocks"
import type { VerificationRecord } from "@/stores/editor-slice"

/**
 * The coarse state a record renders as — one per visually distinct
 * treatment. Exported (with `stateOf`/`describeState` below) so
 * `activity-row.tsx` and `activity-detail-dialog.tsx` can reuse the SAME
 * classification instead of each inventing its own reading of
 * `VerificationRecord`.
 */
export type CheckState = "running" | "pass" | "fail" | "skipped"

export function stateOf(record: VerificationRecord): CheckState {
  if (record.phase === "running") return "running"
  // A `done` record with no result can't claim anything; "not checked" is the
  // honest reading, and it is the only safe default here.
  if (!record.result) return "skipped"
  return record.result.status
}

const SKIP_REASON_LABEL: Record<
  NonNullable<
    NonNullable<VerificationRecord["result"]>["skipReason"]
  >,
  string
> = {
  unmeasurable: "Not checked: nothing measurable",
  unreadable: "Not checked: couldn't read the element",
  // Deliberately NOT worded as a benign skip: the check failed to run for an
  // infrastructure reason, which is actionable (see VerificationResult).
  "translate-error": "Check failed to run",
}

export function describeState(record: VerificationRecord): {
  tone: StatusTone
  label: string
  pulse: boolean
} {
  switch (stateOf(record)) {
    case "running":
      return { tone: "info", label: "Checking…", pulse: true }
    case "pass":
      return { tone: "success", label: "Verified", pulse: false }
    case "fail":
      return { tone: "destructive", label: "Didn't take effect", pulse: false }
    case "skipped": {
      const reason = record.result?.skipReason
      return {
        // `translate-error` is a failure to check, not a benign skip — warn.
        tone: reason === "translate-error" ? "warning" : "muted",
        label: reason ? SKIP_REASON_LABEL[reason] : "Not checked",
        pulse: false,
      }
    }
  }
}
