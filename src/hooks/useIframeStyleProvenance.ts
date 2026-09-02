/**
 * Shell-side style-provenance read over the prototype iframe — Layer 2 of the
 * inspector style-provenance feature (tasks/inspector-style-provenance.md).
 * Drives the bridge's `GET_STYLE_PROVENANCE` → `STYLE_PROVENANCE_RESULT`
 * round-trip (cascade walk in the bridge), so this is client-side only.
 *
 * Thin wrapper over the shared `useIframeBridgeRequest` round-trip primitive
 * (Task 17, editor-audit-fixes-plan) — was a direct sibling of
 * `useIframeReadRenderedValue`; the requestId-correlated round trip is now the
 * shared machinery, this hook supplies only the message pair + payload shape,
 * plus its own selector/properties validation (hook-specific, not shared).
 * Resolves `{}` (empty origins) on no-iframe / timeout / failure, so the
 * inspector degrades to today's class-edit behavior rather than throwing.
 */
import { useCallback } from "react"
import type { StyleOrigin } from "@/types/bridge"
import { useIframeBridgeRequest } from "./useIframeBridgeRequest"

/** Cascade walk is lazy + cheap; keep a short ceiling so the inspector never hangs. */
const PROVENANCE_TIMEOUT_MS = 5000

export type StyleProvenanceMap = Record<string, StyleOrigin>

export type FetchStyleProvenanceFn = (
  selector: string,
  properties: readonly string[],
  signal?: AbortSignal,
) => Promise<StyleProvenanceMap>

export function useIframeStyleProvenance(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
): FetchStyleProvenanceFn {
  const request = useIframeBridgeRequest<StyleProvenanceMap>(iframeRef, {
    replyTypes: ["STYLE_PROVENANCE_RESULT"],
    timeoutMs: PROVENANCE_TIMEOUT_MS,
    extractPayload: (data) =>
      (data.payload as { origins?: StyleProvenanceMap } | null)?.origins ?? {},
    onNoIframe: () => ({}),
    onTimeout: () => ({}),
    onAbort: () => ({}),
  })

  return useCallback(
    (selector: string, properties: readonly string[], signal?: AbortSignal) => {
      if (signal?.aborted || !selector || properties.length === 0) {
        return Promise.resolve({})
      }
      return request("GET_STYLE_PROVENANCE", { selector, properties: [...properties] }, signal)
    },
    [request],
  )
}
