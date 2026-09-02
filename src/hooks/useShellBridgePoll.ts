"use client"

/**
 * Always-on long-poll loop that handles bridge queries from
 * editor-cli outside of any chat turn. Pairs with editor-cli's
 * `shell-bridge.ts` long-poll queue.
 *
 * Why it exists: the MCP HTTP endpoint (`POST /api/editor/mcp/tool/:name`)
 * needs to ask the shell things like "what's selected?" — but the
 * chat-turn SSE only carries `bridge_request` events while a chat
 * turn is in flight. The local `claude` CLI proxy fires MCP tool
 * calls at any time, so we need a bridge channel that's always live.
 *
 * Mount this hook ONCE per editor mount, passing the same
 * `bridgeHandlers` map you pass to `useEditorChat`. The same handler
 * functions service both paths — no duplication, no per-tool
 * registration.
 *
 * Mechanics:
 *   1. `fetch('/api/editor/shell-bridge/poll')` — editor-cli holds
 *      the request open up to ~30s.
 *   2. 200 + `{ queryId, messageType, payload }` → run the handler →
 *      POST `/api/editor/shell-bridge/reply` → loop back.
 *   3. 204 (no query within the poll window) → loop back immediately.
 *   4. Network error → short backoff, then retry.
 *
 * Aborts on unmount via AbortController.
 */
import { useEffect, useRef } from "react"
import { editorFetch } from "@/lib/editor-fetch"
import type { ChatBridgeHandlers } from "./useEditorChat"

const ERROR_BACKOFF_MS = 1_000

export function useShellBridgePoll(handlers: ChatBridgeHandlers): void {
  // Live ref so the loop always sees the latest handler set without
  // restarting on every parent render. This is the synchronous "latest ref"
  // idiom: the write MUST happen during render, not in an effect — the
  // long-poll loop reads `handlersRef.current` from an async callback, and a
  // post-commit effect would leave a window where a poll response handled
  // before the effect runs answers from stale closures (e.g. chat:get_selection
  // returning the previous selection). Race-free here (no concurrent-render
  // tearing in this shell), so the react-hooks/refs flag is a false positive.
  const handlersRef = useRef(handlers)
  // eslint-disable-next-line react-hooks/refs
  handlersRef.current = handlers

  useEffect(() => {
    const abort = new AbortController()

    void (async () => {
      while (!abort.signal.aborted) {
        try {
          const r = await editorFetch("/api/editor/shell-bridge/poll", {
            method: "GET",
            signal: abort.signal,
          })
          if (abort.signal.aborted) return
          if (r.status === 204) {
            // No query within the poll window — re-poll immediately.
            continue
          }
          if (!r.ok) {
            // Auth failure or unexpected status — back off so we don't
            // hot-loop. Most common cause is editor-cli restarted
            // and bootstrap hasn't refreshed the token yet.
            await sleep(ERROR_BACKOFF_MS, abort.signal)
            continue
          }
          const query = (await r.json()) as {
            queryId: string
            messageType: string
            payload: unknown
          }
          const handler = handlersRef.current[query.messageType]
          let reply: { ok: true; output: unknown } | { ok: false; error: string }
          if (!handler) {
            reply = {
              ok: false,
              error: `No shell handler for '${query.messageType}'`,
            }
          } else {
            try {
              reply = await handler(query.payload, abort.signal)
            } catch (err) {
              reply = { ok: false, error: (err as Error).message }
            }
          }
          // Fire-and-forget — editor-cli's per-query timeout protects
          // against lost replies, and we want to get back to polling
          // ASAP. Errors here mean the query already timed out.
          void editorFetch("/api/editor/shell-bridge/reply", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              queryId: query.queryId,
              ok: reply.ok,
              output: reply.ok ? reply.output : undefined,
              error: reply.ok ? undefined : reply.error,
            }),
            signal: abort.signal,
          }).catch(() => {
            // Suppressed — see comment above.
          })
        } catch {
          if (abort.signal.aborted) return
          // Network error / fetch threw. Back off and retry.
          await sleep(ERROR_BACKOFF_MS, abort.signal)
        }
      }
    })()

    return () => {
      abort.abort()
    }
  }, [])
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      signal.removeEventListener("abort", onAbort)
      resolve()
    }
    signal.addEventListener("abort", onAbort)
  })
}
