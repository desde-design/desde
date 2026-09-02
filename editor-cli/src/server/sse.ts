/**
 * SSE response helper for the editor-cli HTTP server.
 *
 * Used by the chat endpoint (Phase 1) to stream tool calls, text deltas,
 * and edit proposals back to the shell as they happen. Keeps the
 * wire format simple: one JSON value per `data:` line per event.
 *
 * Lifecycle:
 *   1. Caller invokes `openSseStream(res)` to set headers and return a
 *      `SseStream` handle. The handle exposes `send(event)` and `close()`.
 *   2. Caller emits events as they happen.
 *   3. Caller calls `close()` when the stream is finished. If the client
 *      disconnects first (`req.on('close')`), the handle's `aborted`
 *      promise resolves so the producer can stop work.
 *
 * The helper deliberately keeps the event shape generic (`unknown`) —
 * Phase 1 will define the `ChatStreamEvent` discriminated union and
 * funnel it through here. Phase 0 ships the plumbing only.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export interface SseStream {
  /**
   * Emit one event to the client. The event is JSON-serialized and
   * framed as a single `data:` line (per the EventSource format).
   *
   * Return semantics:
   *   - `false` if the stream is already closed OR `JSON.stringify`
   *     threw (cyclic data, BigInt, etc.) — the event was not sent,
   *     stop trying.
   *   - `false` if the underlying `res.write()` reports backpressure
   *     (kernel send buffer full). The event WAS queued; callers
   *     should await `drain()` before sending the next event to
   *     prevent unbounded memory growth on a slow consumer.
   *   - `true` if the event was written and the socket has capacity.
   */
  send: (event: unknown) => boolean
  /**
   * Emit a comment line (heartbeat). Useful for keeping intermediaries
   * from timing the connection out during long tool calls. Same return
   * semantics as `send()`.
   */
  heartbeat: () => boolean
  /**
   * Resolves when the underlying socket has flushed its send buffer.
   * Callers should `await drain()` after `send()` returns false (other
   * than for serialization/closed reasons) before sending the next
   * event. Resolves immediately if the socket is currently drained or
   * the stream is closed.
   */
  drain: () => Promise<void>
  /** Closes the stream. Idempotent. */
  close: () => void
  /**
   * Resolves when the client disconnects (socket 'close'). Callers
   * should race this against their work and cancel work on disconnect.
   */
  readonly aborted: Promise<void>
}

export interface OpenSseStreamOptions {
  /**
   * If true (default), set the standard `no-cache` + `keep-alive`
   * headers SSE clients expect. Disable only for tests that introspect
   * the headers directly.
   */
  setHeaders?: boolean
}

/**
 * Wires `onClose` to the authoritative "client went away" signal for a
 * request/response pair, and returns a disposer that removes the
 * listener(s). Shared by `openSseStream`'s `aborted` promise and by
 * {@link watchClientDisconnect} so there is exactly one place that decides
 * which event actually means "the client disconnected."
 *
 * Prefers the underlying socket's `close` event: `IncomingMessage`'s own
 * `close` fires when the request stream is destroyed — which on Node can
 * happen as soon as the request body finishes being read, even though the
 * socket (and the response we may still be streaming on) is still alive.
 * Listening on `req` directly would misfire on that body-end close, so it's
 * used only as a fallback when no socket is available (mock/test contexts
 * mostly). `res`'s own `close` is also wired as a fallback for the case
 * where the response is torn down before the socket (e.g. an upstream
 * framework wrapping us).
 */
function attachDisconnectListener(
  req: IncomingMessage,
  res: ServerResponse,
  onClose: () => void,
): () => void {
  const socket = req.socket
  if (socket) {
    socket.once('close', onClose)
  } else {
    req.once('close', onClose)
  }
  res.once('close', onClose)
  return () => {
    socket?.off('close', onClose)
    req.off('close', onClose)
    res.off('close', onClose)
  }
}

/**
 * Watches a request/response pair for a genuine client disconnect and
 * exposes it as a standard `AbortSignal` — for callers that need to cancel
 * in-flight work (e.g. a paid LLM call) on disconnect but aren't otherwise
 * using `openSseStream` (a non-streaming JSON route), or that need the
 * signal available before deciding whether to stream at all.
 *
 * Uses the SAME disconnect detection as `openSseStream`'s `aborted` promise
 * (socket `close` preferred, `req`/`res` `close` as fallback) — but, unlike
 * `aborted`, this signal is driven ONLY by the client-disconnect listener:
 * nothing in this module resolves it as a side effect of the caller's own
 * response completing. Callers MUST call `dispose()` once the work they're
 * guarding has finished (success or failure) — ideally before their own
 * `res.end()` / `stream.close()` — so that a normal completion's own
 * response-close event can't be misread as a disconnect after the fact.
 */
export function watchClientDisconnect(
  req: IncomingMessage,
  res: ServerResponse,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const onClose = (): void => {
    controller.abort()
  }
  const detach = attachDisconnectListener(req, res, onClose)
  let disposed = false
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return
      disposed = true
      detach()
    },
  }
}

export function openSseStream(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenSseStreamOptions = {},
): SseStream {
  if (opts.setHeaders !== false) {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    // Disable nginx buffering (defense in depth; the CLI doesn't sit
    // behind nginx, but a future reverse proxy might).
    res.setHeader('X-Accel-Buffering', 'no')
  }

  let closed = false
  let abortResolve: () => void = () => {}
  const aborted = new Promise<void>((resolve) => {
    abortResolve = resolve
  })

  const onClose = (): void => {
    if (closed) return
    closed = true
    abortResolve()
  }
  attachDisconnectListener(req, res, onClose)

  // Flush headers immediately so the client sees the open connection
  // before the first event arrives. Without this, some clients delay
  // the EventSource `open` event until the first payload byte.
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders()
  }

  return {
    send(event) {
      if (closed) return false
      let payload: string
      try {
        // SSE frames: `data: <json>\n\n`. `JSON.stringify` either
        // returns a string or throws (cyclic refs / BigInt). It can
        // ALSO return `undefined` for top-level `undefined` / function /
        // symbol — coerce those to a string "undefined" rather than
        // sending the literal word, which is not valid JSON.
        const json = JSON.stringify(event)
        if (json === undefined) return false
        payload = json
      } catch {
        return false
      }
      try {
        const ok = res.write(`data: ${payload}\n\n`)
        return ok
      } catch {
        closed = true
        abortResolve()
        return false
      }
    },
    heartbeat() {
      if (closed) return false
      try {
        return res.write(`: heartbeat\n\n`)
      } catch {
        closed = true
        abortResolve()
        return false
      }
    },
    drain() {
      if (closed) return Promise.resolve()
      // Node's writable stream emits 'drain' when its internal buffer
      // empties. We listen once. If the stream is destroyed before
      // drain, we still resolve (callers stop streaming on aborted).
      return new Promise<void>((resolve) => {
        const cleanup = (): void => {
          res.off('drain', onDrain)
          res.off('close', onCloseDuringDrain)
        }
        const onDrain = (): void => {
          cleanup()
          resolve()
        }
        const onCloseDuringDrain = (): void => {
          cleanup()
          resolve()
        }
        res.once('drain', onDrain)
        res.once('close', onCloseDuringDrain)
      })
    },
    close() {
      if (closed) return
      closed = true
      abortResolve()
      try {
        res.end()
      } catch {
        // Already closed by the client — nothing to do.
      }
    },
    aborted,
  }
}
