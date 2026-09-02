/**
 * Shell-side measurement read over the prototype iframe — Tier-2 edit
 * verification P2 (tasks/editor-edit-verification.md). Drives the bridge's
 * `READ_MEASUREMENTS` → `MEASUREMENTS_READ` round-trip (geometry + a computed-
 * style subset read in the bridge), so this is client-side only.
 *
 * Thin wrapper over the shared `useIframeBridgeRequest` round-trip primitive
 * (Task 17, editor-audit-fixes-plan) — was a near-verbatim sibling of
 * `useIframeReadRenderedValue`; the requestId-correlated round trip is now the
 * shared machinery, this hook supplies only the message pair + payload shape.
 * This is the L3a predicate verifier's reader (`verifyGoal`'s
 * `readMeasurements` dep).
 *
 * Resolves `null` on no-iframe / timeout / read failure — callers surface that
 * as "not measurable" (the verifier reports `skipped`) rather than throwing.
 */
import { useCallback } from "react"
import type { Measurements } from "@/types/bridge"
import { useIframeBridgeRequest } from "./useIframeBridgeRequest"

/** A handful of synchronous DOM reads; keep a short ceiling well under the
 *  agent-side bridge_request timeout so this resolves first with a clean null. */
const READ_TIMEOUT_MS = 5000

export type ReadMeasurementsFn = (
  selector: string,
  /** Abort signal (the turn's) — aborting resolves the read as null promptly. */
  signal?: AbortSignal,
) => Promise<Measurements | null>

export function useIframeReadMeasurements(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
): ReadMeasurementsFn {
  const request = useIframeBridgeRequest<Measurements | null>(iframeRef, {
    replyTypes: ["MEASUREMENTS_READ"],
    timeoutMs: READ_TIMEOUT_MS,
    extractPayload: (data) =>
      (data.payload as { measurements?: Measurements | null } | null)?.measurements ?? null,
    onNoIframe: () => null,
    onTimeout: () => null,
    onAbort: () => null,
  })

  return useCallback(
    (selector: string, signal?: AbortSignal) =>
      request("READ_MEASUREMENTS", { selector }, signal),
    [request],
  )
}
