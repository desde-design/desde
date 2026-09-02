/**
 * Always-on bridge channel between editor-cli and the browser shell.
 *
 * The chat-handler's bridge is per-turn: it rides on the chat SSE
 * stream so it only exists while a chat turn is in flight. The MCP
 * proxy (`desde-mcp`) needs to issue bridge queries
 * outside any chat turn — e.g. `claude -p "what's selected?"` when no
 * browser-side chat is active.
 *
 * This module is a long-poll bridge: the browser shell holds open one
 * `GET /api/editor/shell-bridge/poll` request at a time. When the
 * MCP HTTP endpoint enqueues a query, the long-poll response wakes up
 * and delivers it; the shell processes the message via the same
 * bridge-handler map it uses for chat-turn `bridge_request` events,
 * then POSTs the reply to `/api/editor/shell-bridge/reply`.
 *
 * Why long-poll vs SSE: the shell already runs a chat-turn SSE that
 * tears down per turn. Adding a second always-on SSE means reconnect
 * lifecycle on the shell. Long-poll is a plain `fetch` loop — no
 * EventSource bookkeeping, automatic reconnect via the next call.
 * Sub-millisecond latency in practice since enqueue immediately
 * resolves any parked poller.
 *
 * Module-scoped state: queries and pollers live in the editor-cli
 * process. Single-tenant CLI — no need for a registry keyed by client.
 */
import type { ServerResponse } from "node:http"
import { randomUUID } from "node:crypto"

/** Default per-query timeout when the caller doesn't specify one. */
const DEFAULT_QUERY_TIMEOUT_MS = 30_000

/**
 * How long a parked poller waits before responding 204. The browser's
 * fetch loop immediately re-polls on 204, so 30s is just a
 * keep-the-connection-fresh interval — short enough that proxies don't
 * close it, long enough that an idle editor doesn't burn requests.
 */
const POLL_PARK_TIMEOUT_MS = 30_000

type PendingQuery = {
  queryId: string
  messageType: string
  payload: unknown
  delivered: boolean
  resolve: (output: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type ParkedPoller = {
  respond: (query: PendingQuery | null) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingQueries = new Map<string, PendingQuery>()
const parkedPollers: ParkedPoller[] = []

/** Test hook: clear all state between tests. */
export function __resetShellBridgeForTest(): void {
  for (const q of pendingQueries.values()) {
    clearTimeout(q.timer)
    q.reject(new Error("reset"))
  }
  pendingQueries.clear()
  for (const p of parkedPollers) {
    clearTimeout(p.timer)
    p.respond(null)
  }
  parkedPollers.length = 0
}

/**
 * Enqueue a bridge query for the shell to run. Resolves with the
 * shell's reply output, rejects on timeout or shell-reported error.
 *
 * If a poller is parked, hands the query off immediately. Otherwise
 * the query waits until the next poll arrives.
 */
export function enqueueShellBridgeQuery(
  messageType: string,
  payload: unknown,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS
  return new Promise<unknown>((resolve, reject) => {
    const queryId = randomUUID()
    let settled = false

    const cleanup = (): void => {
      if (settled) return
      settled = true
      const q = pendingQueries.get(queryId)
      if (q) {
        clearTimeout(q.timer)
        pendingQueries.delete(queryId)
      }
      options.signal?.removeEventListener("abort", onAbort)
    }
    const onAbort = (): void => {
      cleanup()
      reject(new Error("shell-bridge query aborted"))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(
        new Error(
          `shell-bridge query '${messageType}' timed out after ${timeoutMs}ms (shell may not be connected)`,
        ),
      )
    }, timeoutMs)

    const query: PendingQuery = {
      queryId,
      messageType,
      payload,
      delivered: false,
      resolve: (output) => {
        cleanup()
        resolve(output)
      },
      reject: (err) => {
        cleanup()
        reject(err)
      },
      timer,
    }
    pendingQueries.set(queryId, query)

    if (options.signal?.aborted) {
      onAbort()
      return
    }
    options.signal?.addEventListener("abort", onAbort)

    // If a poller is parked, hand the query off immediately.
    const poller = parkedPollers.shift()
    if (poller) {
      clearTimeout(poller.timer)
      query.delivered = true
      poller.respond(query)
    }
  })
}

/**
 * Handle GET /api/editor/shell-bridge/poll.
 *
 * If any undelivered query is queued, respond with it immediately.
 * Otherwise park the response and wait POLL_PARK_TIMEOUT_MS for the
 * next enqueue, then respond 204 so the shell loops back in.
 */
export function handleShellBridgePoll(res: ServerResponse): void {
  // Undelivered first — usually empty since enqueue hands off
  // immediately when a poller is parked, but covers the case where a
  // query arrived between polls.
  for (const q of pendingQueries.values()) {
    if (!q.delivered) {
      q.delivered = true
      respondWithQuery(res, q)
      return
    }
  }

  let settled = false
  const respond = (query: PendingQuery | null): void => {
    if (settled) return
    settled = true
    if (query) {
      respondWithQuery(res, query)
    } else {
      respond204(res)
    }
  }
  const timer = setTimeout(() => {
    // Remove this poller from the queue before responding so a racing
    // enqueue can't pick it up after timeout.
    const idx = parkedPollers.indexOf(entry)
    if (idx !== -1) parkedPollers.splice(idx, 1)
    respond(null)
  }, POLL_PARK_TIMEOUT_MS)
  const entry: ParkedPoller = { respond, timer }
  parkedPollers.push(entry)

  res.on("close", () => {
    if (settled) return
    clearTimeout(timer)
    const idx = parkedPollers.indexOf(entry)
    if (idx !== -1) parkedPollers.splice(idx, 1)
    settled = true
  })
}

function respondWithQuery(res: ServerResponse, query: PendingQuery): void {
  res.statusCode = 200
  res.setHeader("Content-Type", "application/json")
  res.end(
    JSON.stringify({
      queryId: query.queryId,
      messageType: query.messageType,
      payload: query.payload,
    }),
  )
}

function respond204(res: ServerResponse): void {
  res.statusCode = 204
  res.end()
}

export interface ShellBridgeReplyBody {
  queryId: string
  ok: boolean
  output?: unknown
  error?: string
}

/**
 * Handle POST /api/editor/shell-bridge/reply.
 *
 * Resolves the matching `enqueueShellBridgeQuery` promise. Returns 404
 * when the query is unknown (already timed out / aborted / replied to
 * by a prior duplicate) so the shell can log it.
 */
export function applyShellBridgeReply(body: ShellBridgeReplyBody): {
  status: number
  body: { ok: boolean; reason?: string }
} {
  if (!body.queryId) {
    return { status: 400, body: { ok: false, reason: "queryId is required" } }
  }
  const q = pendingQueries.get(body.queryId)
  if (!q) {
    return {
      status: 404,
      body: {
        ok: false,
        reason: "Unknown queryId (already resolved, timed out, or aborted)",
      },
    }
  }
  if (body.ok) {
    q.resolve(body.output)
  } else {
    q.reject(new Error(body.error ?? "shell-bridge reply: not ok"))
  }
  return { status: 200, body: { ok: true } }
}
