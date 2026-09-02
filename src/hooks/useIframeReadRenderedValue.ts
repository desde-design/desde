/**
 * Shell-side rendered-value read over the prototype iframe — Phase 1 of the
 * edit→see→self-correct loop (tasks/editor-self-correct-loop-plan.md). Drives
 * the bridge's EXISTING `READ_RENDERED_VALUE` → `RENDERED_VALUE_READ` round-trip
 * (DOM read in the bridge), so this is client-side only — no bridge change.
 *
 * Thin wrapper over the shared `useIframeBridgeRequest` round-trip primitive
 * (Task 17, editor-audit-fixes-plan) — was the sibling `useIframeScreenshotCapture`
 * mirrored; the requestId-correlated round trip is now the shared machinery,
 * this hook supplies only the message pair + payload shape.
 *
 * The `chat:read_rendered_value` handler in the chat bridge-handler map calls
 * this; the agent's `verify_edit` tool reaches it via the bridge_request
 * round-trip. Resolves `null` on no-iframe / timeout / read failure — callers
 * surface that as "value not found" rather than throwing into a turn.
 */
import { useCallback } from "react"
import { useIframeBridgeRequest } from "./useIframeBridgeRequest"

/** A DOM read is near-instant; keep a short ceiling well under the agent-side
 *  bridge_request timeout so this resolves first with a clean null. */
const READ_TIMEOUT_MS = 5000

/** How to read the value back off the matched element (mirrors the bridge accessor). */
export interface RenderAccessor {
  kind: "text" | "attr" | "style"
  /** Attribute name (`kind: 'attr'`) or CSS property (`kind: 'style'`). */
  name?: string
}

export interface ReadRenderedValueOptions {
  selector: string
  accessor: RenderAccessor
}

export type ReadRenderedValueFn = (
  opts: ReadRenderedValueOptions,
  /** Abort signal (the turn's) — aborting resolves the read as null promptly. */
  signal?: AbortSignal,
) => Promise<string | null>

export function useIframeReadRenderedValue(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
): ReadRenderedValueFn {
  const request = useIframeBridgeRequest<string | null>(iframeRef, {
    replyTypes: ["RENDERED_VALUE_READ"],
    timeoutMs: READ_TIMEOUT_MS,
    extractPayload: (data) => (data.payload as { value?: string | null } | null)?.value ?? null,
    onNoIframe: () => null,
    onTimeout: () => null,
    onAbort: () => null,
  })

  return useCallback(
    (opts: ReadRenderedValueOptions, signal?: AbortSignal) =>
      request(
        "READ_RENDERED_VALUE",
        { selector: opts.selector, accessor: opts.accessor },
        signal,
      ),
    [request],
  )
}
