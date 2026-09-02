/**
 * Shell-side screenshot capture over the prototype iframe — Phase 2 of the
 * visualizer (tasks/editor-visualizer.md). Drives the bridge's EXISTING
 * `CAPTURE_ELEMENT_SCREENSHOT` → `ELEMENT_SCREENSHOT_CAPTURED` round-trip
 * (html2canvas in the bridge), so this is client-side only — no bridge change.
 *
 * Thin wrapper over the shared `useIframeBridgeRequest` round-trip primitive
 * (Task 17, editor-audit-fixes-plan) — was the requestId-correlated pattern
 * the other iframe round-trip hooks mirrored; the round trip itself is now the
 * shared machinery, this hook supplies only the message pair, the success/
 * failure payload shape, and the per-reason default messages.
 *
 * The capture handler in the chat bridge-handler map calls this; the agent's
 * `capture_screenshot` tool (Phase 4) reaches it via the bridge_request
 * round-trip. On failure it resolves a tagged `{ ok: false, reason }` rather
 * than a bare null, so callers (and the agent) can tell a selector miss apart
 * from a hidden element, a renderer crash, or a real timeout — the prototype
 * iframe is cross-origin, so only the bridge can report whether the selector
 * actually matched anything.
 */
import { useCallback } from "react"
import { useIframeBridgeRequest } from "./useIframeBridgeRequest"

/** html2canvas on a large page can take several seconds; keep well under the
 *  agent-side bridge_request timeout so this resolves first with a clean result. */
const CAPTURE_TIMEOUT_MS = 15000

export interface CapturedScreenshot {
  /** PNG data URL (`data:image/png;base64,…`). */
  dataUrl: string
  width: number
  height: number
}

export interface CaptureScreenshotOptions {
  /** CSS selector for the target element; omitted → the bridge captures `body`. */
  selector?: string
}

/**
 * Why a capture didn't produce an image. Reported by the bridge for the
 * in-iframe cases (`no-match` / `empty-element` / `render-failed`) and by this
 * hook for the shell-side cases (`no-iframe` / `timeout` / `aborted`).
 */
export type CaptureFailureReason =
  | "no-iframe"
  | "no-match"
  | "empty-element"
  | "render-failed"
  | "timeout"
  | "aborted"

export type CaptureScreenshotResult =
  | { ok: true; shot: CapturedScreenshot }
  | { ok: false; reason: CaptureFailureReason; message: string }

function defaultMessageForReason(reason: CaptureFailureReason): string {
  switch (reason) {
    case "no-iframe":
      return "No prototype iframe is mounted."
    case "no-match":
      return "No element matches the selector on the current page."
    case "empty-element":
      return "The selector matched an element with no rendered size (it may be hidden or on a different step/route)."
    case "render-failed":
      return "The screenshot renderer (html2canvas) failed on this element."
    case "timeout":
      return `Capture timed out after ${Math.round(CAPTURE_TIMEOUT_MS / 1000)}s.`
    case "aborted":
      return "Capture was aborted."
    default:
      return "Capture failed."
  }
}

export type CaptureScreenshotFn = (
  opts?: CaptureScreenshotOptions,
  /** Abort signal (the turn's) — aborting resolves the capture promptly as a failure. */
  signal?: AbortSignal,
) => Promise<CaptureScreenshotResult>

export function useIframeScreenshotCapture(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
): CaptureScreenshotFn {
  const request = useIframeBridgeRequest<CaptureScreenshotResult>(iframeRef, {
    replyTypes: ["ELEMENT_SCREENSHOT_CAPTURED"],
    timeoutMs: CAPTURE_TIMEOUT_MS,
    extractPayload: (data) => {
      const payload = data.payload as
        | { png?: string; width?: number; height?: number; error?: string; message?: string }
        | null
      if (payload && typeof payload.png === "string") {
        return {
          ok: true,
          shot: {
            dataUrl: payload.png,
            width: payload.width ?? 0,
            height: payload.height ?? 0,
          },
        }
      }
      // Failure: the bridge tags it (`no-match` / `empty-element` /
      // `render-failed`). An older bridge or an unexpected shape (null payload)
      // falls back to `render-failed` — still better than swallowing the reason.
      const reason = (payload?.error ?? "render-failed") as CaptureFailureReason
      return {
        ok: false,
        reason,
        message: payload?.message ?? defaultMessageForReason(reason),
      }
    },
    onNoIframe: () => ({
      ok: false,
      reason: "no-iframe",
      message: defaultMessageForReason("no-iframe"),
    }),
    onTimeout: () => ({
      ok: false,
      reason: "timeout",
      message: defaultMessageForReason("timeout"),
    }),
    onAbort: () => ({
      ok: false,
      reason: "aborted",
      message: defaultMessageForReason("aborted"),
    }),
  })

  return useCallback(
    (opts?: CaptureScreenshotOptions, signal?: AbortSignal) =>
      request("CAPTURE_ELEMENT_SCREENSHOT", { selector: opts?.selector }, signal),
    [request],
  )
}
