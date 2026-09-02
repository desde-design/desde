"use client"

/**
 * Shell transport for the bridge's semantic-target capabilities
 * (editor-screenshot-flows.md Phase 2): `RESOLVE_TARGET` → `TARGET_RESOLVED`
 * and `PERFORM_INTERACT` → `INTERACT_PERFORMED`, correlated by requestId.
 * Built on the shared `useIframeBridgeRequest` round-trip primitive (Task 17,
 * editor-audit-fixes-plan) — both request kinds share ONE requestId map +
 * message listener (replies are matched purely by requestId, so pooling them
 * is safe; this is why `useIframeBridgeRequest` accepts more than one reply
 * type per config).
 *
 * Used by the deterministic screenshot-plan replay (to resolve + act on
 * `interact` steps) and available to the Phase-3 agent `interact` tool.
 */

import { useCallback } from "react"
import { useIframeBridgeRequest } from "./useIframeBridgeRequest"

const ROUND_TRIP_TIMEOUT_MS = 15_000

export interface ResolveTargetInput {
  role?: string
  name?: string
  text?: string
  /** Last-known-good selector (replay cache); the bridge tries it first. */
  selector?: string
}

export interface ResolvedTarget {
  found: boolean
  selector?: string
  role?: string
  name?: string
}

export interface PerformInteractInput {
  selector: string
  action: "click" | "fill" | "select"
  value?: string
}

export interface InteractOutcome {
  ok: boolean
  error?: string
}

export interface IframeSemanticTarget {
  resolveTarget: (
    target: ResolveTargetInput,
    signal?: AbortSignal,
  ) => Promise<ResolvedTarget | null>
  performInteract: (
    input: PerformInteractInput,
    signal?: AbortSignal,
  ) => Promise<InteractOutcome | null>
}

export function useIframeSemanticTarget(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
): IframeSemanticTarget {
  // requestId → settler. Two reply types share this round trip (ids are unique).
  const request = useIframeBridgeRequest<unknown>(iframeRef, {
    replyTypes: ["TARGET_RESOLVED", "INTERACT_PERFORMED"],
    timeoutMs: ROUND_TRIP_TIMEOUT_MS,
    extractPayload: (data) => data.payload ?? null,
    onNoIframe: () => null,
    onTimeout: () => null,
    onAbort: () => null,
  })

  const resolveTarget = useCallback(
    (target: ResolveTargetInput, signal?: AbortSignal) =>
      request("RESOLVE_TARGET", { target }, signal) as Promise<ResolvedTarget | null>,
    [request],
  )

  const performInteract = useCallback(
    (input: PerformInteractInput, signal?: AbortSignal) =>
      request("PERFORM_INTERACT", input, signal) as Promise<InteractOutcome | null>,
    [request],
  )

  return { resolveTarget, performInteract }
}
