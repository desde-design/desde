"use client"

import { useCallback } from "react"
import { toast } from "sonner"
import type { FrameworkAdapter } from "@/editor/core"
import {
  orchestrateVerification,
  type ExpectationInput,
  type VerificationResult,
} from "@/editor/verification"
import { useEditorStore } from "@/stores/editor-only"

/**
 * Tier-2 edit verification (P1) — the thin React wrapper around the
 * React-free `orchestrateVerification`. Returns a stable `verifyEdit(input)`
 * the editing hook calls right after a deterministic edit dispatches.
 *
 * What it wires:
 *  - the verifier's DOM reader → `adapter.readRenderedValue` (bridge query),
 *  - begin/complete records → the editor store (Checks-tab strip),
 *  - a *subtle inline cue* → a sonner toast, but only on failure (decision 4).
 *
 * There is no automatic direct-manip repair loop today — a failed
 * verification surfaces via the store record + toast only. (An earlier
 * `escalated` flag that claimed to mark failures for an LLM repair lane was
 * decorative — nothing read it — and was removed 2026-08-04. See
 * `tasks/editor-edit-verification.md` for the corrected status and the
 * backlog note on when a direct-manip repair loop is worth building.)
 *
 * Correctness note (load-bearing): editor applies an instant live DOM
 * *override* for feedback, then HMR re-renders from source. `confirmStableMs`
 * (set here, > typical HMR) makes the verifier wait out HMR so a failing
 * (bound/shadowed) edit can't false-pass via the transient override. See
 * `verify-render.ts` and tasks/editor-edit-verification.md.
 *
 * Best-effort throughout: a missing adapter or a reader error degrades to a
 * silent skip — verification must never break the edit flow.
 */

/** Delay before the first DOM read (let the file write + HMR begin). */
const SETTLE_MS = 250
/** A match must survive this window to count as a pass (outlasts HMR). */
const CONFIRM_STABLE_MS = 600
/** Total L2 budget. */
const TIMEOUT_MS = 3_000

/**
 * Coarse outcome bucket handed back to the caller (WS3 closed-loop —
 * tasks/edit-pipeline-rearchitecture.md). Collapses `VerificationResult`'s
 * `status` plus the "no oracle could be derived" / "adapter can't read"
 * cases the hook already declines silently, so a caller like
 * `useEditorEditing` can resolve a bridge override without importing the
 * verification module's internal types:
 *  - `'verified'`  — the DOM read back the expected value (status `'pass'`).
 *  - `'didnt-take'` — the write landed on disk but the DOM never reflected
 *    it (status `'fail'`) — e.g. shadowed by a binding.
 *  - `'skipped'`   — no oracle (no manifest dom-hint), unsupported bridge,
 *    or a reader error. Not a signal either way.
 */
export type VerificationOutcome = "verified" | "didnt-take" | "skipped"

function outcomeFromStatus(status: VerificationResult["status"]): VerificationOutcome {
  if (status === "pass") return "verified"
  if (status === "fail") return "didnt-take"
  return "skipped"
}

/**
 * `verifyEdit`'s request surface. Extends the pure oracle's
 * `ExpectationInput` (unchanged — `src/editor/verification` stays
 * React-free and has no notion of "superseded") with a hook-level escape
 * hatch: a lazy check, read at verification-complete time, for whether a
 * *newer* dispatch has already superseded this one (e.g. the user kept
 * typing while this verification's settle/confirm window ran). When it
 * reports true, the failure toast is suppressed — the stale check would
 * otherwise false-positive "Edit didn't take effect" mid-typing. Outcome
 * bookkeeping (store record, `onOutcome`) is unaffected either way; only
 * the toast is gated on it.
 */
export interface VerifyEditInput extends ExpectationInput {
  isSuperseded?: () => boolean
}

export interface UseEditVerificationResult {
  /**
   * `onOutcome` (optional, WS3): invoked exactly once per call with the
   * coarse result — synchronously when the hook declines up front
   * (unsupported bridge / feature gate), otherwise once the verification
   * settles (or is skipped for lack of a derivable oracle). Best-effort:
   * a caller that doesn't need the result can omit it and nothing changes
   * from pre-WS3 behavior.
   */
  verifyEdit: (
    input: VerifyEditInput,
    onOutcome?: (outcome: VerificationOutcome) => void,
  ) => void
}

export function useEditVerification(
  getAdapter: () => FrameworkAdapter | null,
): UseEditVerificationResult {
  const verifyEdit = useCallback(
    (input: VerifyEditInput, onOutcome?: (outcome: VerificationOutcome) => void) => {
      const { isSuperseded, ...expectationInput } = input
      // Deliver the coarse outcome AT MOST ONCE, and never let a throwing
      // callback escape (M7). Callers may use `onOutcome` to resolve a bridge
      // override, where a second delivery is a double-resolve and a missing
      // one is a stuck preview — so "exactly once per verifyEdit call" is a
      // contract, not a best effort.
      let outcomeDelivered = false
      const deliver = (outcome: VerificationOutcome): void => {
        if (outcomeDelivered) return
        outcomeDelivered = true
        try {
          onOutcome?.(outcome)
        } catch {
          // Caller's problem, not ours — verification never breaks the edit flow.
        }
      }
      const adapter = getAdapter()
      // Adapter must support the bridge read; otherwise opt out silently.
      if (!adapter?.readRenderedValue) {
        deliver("skipped")
        return
      }
      // Feature-gate on the live bridge version. An older bridge silently drops
      // READ_RENDERED_VALUE, so reads would time out → null → a *false* L2
      // failure on a successful edit. Skip verification entirely in that case.
      if (
        adapter.supportsRenderedValueRead &&
        !adapter.supportsRenderedValueRead()
      ) {
        deliver("skipped")
        return
      }
      const readRenderedValue = adapter.readRenderedValue.bind(adapter)

      // Cascade lane (style/token edits) needs the provenance walk. Gate on the
      // bridge version for the same reason the value read does: an unsupported
      // bridge resolves empty, which would read as "nobody owns this property"
      // — a false failure on a successful edit. Leaving the dep undefined makes
      // `verifyRender` report `skipped` instead.
      const canReadProvenance =
        !!adapter.getStyleProvenance &&
        (!adapter.supportsStyleProvenance || adapter.supportsStyleProvenance())
      const readStyleProvenance = canReadProvenance
        ? adapter.getStyleProvenance!.bind(adapter)
        : undefined

      void orchestrateVerification(
        expectationInput,
        {
          begin: (editId, label, startedAt, commitSha) =>
            useEditorStore
              .getState()
              .beginVerification(editId, label, startedAt, commitSha),
          complete: (editId, result: VerificationResult) => {
            // Bookkeeping (store record) and `onOutcome` run unconditionally
            // — only the toast is gated. A superseded dispatch (the user
            // typed more keystrokes during this verification's settle/
            // confirm window) still needs its outcome recorded so the
            // Checks tab / override resolution stay correct; it's just not
            // worth interrupting a still-typing user with a stale warning.
            //
            // `complete` MUST NOT throw (M7): anything escaping here lands in
            // `orchestrateVerification`'s catch, which calls `complete` a
            // SECOND time with a synthetic `skipped`. `deliver`'s once-only
            // guard already makes that harmless for the caller; isolating the
            // store write + toast keeps it from double-recording too.
            try {
              useEditorStore.getState().completeVerification(editId, result)
              if (result.status === "fail" && !isSuperseded?.()) {
                toast.warning("Edit didn't take effect", {
                  description: result.detail,
                })
              }
            } catch {
              // Surfacing failed; the outcome below still gets delivered.
            }
            deliver(outcomeFromStatus(result.status))
          },
        },
        {
          readRenderedValue,
          readStyleProvenance,
          settleMs: SETTLE_MS,
          confirmStableMs: CONFIRM_STABLE_MS,
          timeoutMs: TIMEOUT_MS,
          // L1 source check is omitted in P1's first cut (needs a server
          // read endpoint); L2 is the load-bearing check and classification
          // degrades gracefully to DOM-only signals without it.
        },
      )
        .then((result) => {
          // `null` ⇒ deriveExpectation declined (no oracle) — `complete` never
          // fired, so this is the only place that outcome reaches the caller.
          if (result === null) deliver("skipped")
        })
        // M7: `callbacks.begin` runs OUTSIDE `orchestrateVerification`'s try
        // block, so a throwing store write there rejects this promise with
        // `complete` never having fired — leaving a caller that gates on
        // `onOutcome` waiting forever. Degrade to a skip instead. (`deliver`
        // is once-only, so this can't double-fire after a normal completion.)
        .catch(() => deliver("skipped"))
    },
    [getAdapter],
  )

  return { verifyEdit }
}
