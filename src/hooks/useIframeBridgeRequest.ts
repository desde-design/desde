"use client"

/**
 * Shared machinery behind the shell's iframe↔bridge request/reply round trips
 * (Task 17, editor-audit-fixes-plan). Five hooks — `useIframeReadMeasurements`,
 * `useIframeReadRenderedValue`, `useIframeScreenshotCapture`,
 * `useIframeStyleProvenance`, `useIframeSemanticTarget` — hand-rolled the same
 * pendingRef map keyed by `crypto.randomUUID()` requestId, the same
 * BRIDGE_SOURCE-filtered `message` listener, the same setTimeout ceiling, the
 * same abort-signal wiring, and the same idempotent `settle()`. This factory
 * generalizes that machinery (it's a straight generalization of the internal
 * `roundTrip<T>` that used to live in `useIframeSemanticTarget.ts`); each hook
 * above is now a thin typed wrapper that supplies its request/reply message
 * type(s), its payload extraction, and what to resolve on the no-iframe /
 * timeout / abort paths. The *semantics* stay per-hook — only the plumbing is
 * shared.
 *
 * NOT used by `chat:navigate` (now in `useEditorBridgeHandlers.ts`). Task 21
 * evaluated that migration and DECLINED it: navigate posts no request message
 * (it writes `iframe.src`), waits on a `ROUTE_CHANGED` BROADCAST that carries
 * no `requestId`, gates acceptance on a DOM `load` event, and has a second
 * timer that settles SUCCESSFULLY — none of which this primitive models.
 * Covering it would take four extension points threaded through the five
 * wrappers above; see that hook's header for the full rationale.
 *
 * `config` is read via a "latest ref" written synchronously during render
 * (mirrors `useShellBridgePoll`'s `handlersRef` idiom) — the message listener
 * is registered ONCE via an empty-deps effect, so re-renders (new inline
 * config objects, new closures capturing fresh props) never cause it to
 * re-subscribe or race a reply against a stale closure.
 */
import { useCallback, useEffect, useRef } from "react"

/** Marker the bridge stamps on every shell-bound message (`sendToShell`).
 * Required so prototype/third-party scripts in the iframe that also post to
 * `window` can't spoof a reply and make a caller act on a forged result. */
const BRIDGE_SOURCE = "desde-bridge"

export interface IframeBridgeRequestConfig<TResult> {
  /**
   * Reply message type(s) this round trip accepts. Usually one; a hook may
   * share a single requestId map + listener across more than one request
   * kind when replies are matched purely by requestId (e.g. semantic-target's
   * `RESOLVE_TARGET`/`PERFORM_INTERACT` pair sharing one config) — list every
   * reply type it can receive.
   */
  replyTypes: readonly string[]
  /** Round-trip timeout ceiling, in ms — kept well under the agent-side
   *  `bridge_request` timeout so this resolves first with a clean default. */
  timeoutMs: number
  /** Extract the settled result from a matching reply's raw postMessage data. */
  extractPayload: (data: { type: string; payload: unknown }) => TResult
  /** Value to resolve when there's no iframe window to post to. */
  onNoIframe: () => TResult
  /** Value to resolve when the round trip times out. */
  onTimeout: () => TResult
  /** Value to resolve when the caller's AbortSignal fires — also used for the
   *  already-aborted pre-check and for draining in-flight requests on
   *  unmount (every existing hook resolves the same value for all three). */
  onAbort: () => TResult
}

export type IframeBridgeRequestFn<TResult> = (
  requestType: string,
  payload: unknown,
  signal?: AbortSignal,
) => Promise<TResult>

interface PendingRequest<TResult> {
  /** Resolve the request once and clean up (idempotent). */
  settle: (value: TResult) => void
}

/**
 * Returns a stable `request(requestType, payload, signal)` function that
 * posts `{ type: requestType, payload, requestId }` to the iframe's
 * `contentWindow` and resolves with `config.extractPayload(...)` applied to
 * the first bridge-sourced reply whose `type` is in `config.replyTypes` and
 * whose `requestId` matches.
 */
export function useIframeBridgeRequest<TResult>(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  config: IframeBridgeRequestConfig<TResult>,
): IframeBridgeRequestFn<TResult> {
  // Latest-ref idiom (see useShellBridgePoll.ts:35-48): written during
  // render, not in an effect, so the always-on message listener (registered
  // once below) never answers off a stale closure.
  const configRef = useRef(config)
  // eslint-disable-next-line react-hooks/refs
  configRef.current = config

  const pendingRef = useRef<Map<string, PendingRequest<TResult>>>(new Map())

  // Resolve requests when the bridge replies (matched by requestId).
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data as
        | { source?: string; type?: string; requestId?: string; payload?: unknown }
        | null
      if (!data || data.source !== BRIDGE_SOURCE) return
      if (event.source !== iframeRef.current?.contentWindow) return
      if (typeof data.type !== "string" || !configRef.current.replyTypes.includes(data.type)) {
        return
      }
      const reqId = data.requestId
      if (!reqId) return
      const pending = pendingRef.current.get(reqId)
      if (!pending) return
      pending.settle(configRef.current.extractPayload({ type: data.type, payload: data.payload }))
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
    // iframeRef itself (the ref object, not `.current`) is stable across
    // renders for every caller (each constructs it once via useRef), so
    // listing it here doesn't cause the always-on listener to re-subscribe.
  }, [iframeRef])

  // Drain pending requests on unmount so callers never hang.
  useEffect(() => {
    const pending = pendingRef.current
    return () => {
      for (const p of [...pending.values()]) p.settle(configRef.current.onAbort())
      pending.clear()
    }
  }, [])

  return useCallback(
    (requestType: string, payload: unknown, signal?: AbortSignal) =>
      new Promise<TResult>((resolve) => {
        const cfg = configRef.current
        if (signal?.aborted) {
          resolve(cfg.onAbort())
          return
        }
        const win = iframeRef.current?.contentWindow
        if (!win) {
          resolve(cfg.onNoIframe())
          return
        }
        const requestId = crypto.randomUUID()
        let done = false
        // Single idempotent settle — reply, timeout, abort, and unmount all
        // funnel here, so the promise resolves exactly once and always cleans up.
        const settle = (value: TResult) => {
          if (done) return
          done = true
          pendingRef.current.delete(requestId)
          clearTimeout(timer)
          if (signal) signal.removeEventListener("abort", onAbort)
          resolve(value)
        }
        const onAbort = () => settle(cfg.onAbort())
        const timer = setTimeout(() => settle(cfg.onTimeout()), cfg.timeoutMs)
        if (signal) signal.addEventListener("abort", onAbort, { once: true })
        pendingRef.current.set(requestId, { settle })
        win.postMessage({ type: requestType, payload, requestId }, "*")
      }),
    [iframeRef],
  )
}
