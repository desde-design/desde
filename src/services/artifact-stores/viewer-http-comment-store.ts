/**
 * HTTP+SSE client for the OSS viewer's `/api/v1/projects/:id/comments`
 * routes (Task 2). Implements the same `CommentStore` interface as
 * `http-comment-store.ts` (the editor-cli client) so review-page code
 * can be written against the shared abstraction; the two clients differ
 * only in transport (viewer has server push via SSE, editor polls) and
 * route shape (viewer routes are project-scoped, editor's are not).
 *
 * `fetchImpl` / `eventSourceFactory` are injectable so tests can drive
 * the real store logic against an in-memory fake backend instead of a
 * live server.
 *
 * `authToken` (optional) attaches `Authorization: Bearer <token>` to every
 * HTTP request this store makes. When it's set the store also skips SSE
 * and polls instead — a browser `EventSource` has no API for sending
 * custom headers, so an authenticated store can't authenticate a stream
 * connection. This is a real transport limitation, not a stopgap.
 */

import type { Comment } from "@/types/bridge"
import type {
  CommentCreateInput,
  CommentReplyInput,
  CommentStore,
  CommentUpdatePatch,
} from "@/editor/core"

export interface EventSourceLike {
  onmessage: ((ev: { data: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
  close(): void
}

export interface ViewerHttpCommentStoreOptions {
  baseUrl: string
  projectId: string
  fetchImpl?: typeof fetch
  eventSourceFactory?: (url: string) => EventSourceLike
  pollIntervalMs?: number
  /**
   * When set, sent as `Authorization: Bearer <authToken>` on every request
   * (reads, writes, and the polling fallback). Also forces the store to
   * poll instead of opening an `EventSource` — see the module doc comment.
   * When unset, the store's requests are unchanged from before this option
   * existed (no `Authorization` header at all; the browser's own review
   * page relies on this to fall back to the ambient session cookie).
   */
  authToken?: string
  /**
   * Set when the stream endpoint is credential-gated by something this store
   * cannot put on an `EventSource` — today, the Editor CLI's viewer proxy,
   * which requires the CLI's own bearer. The store then skips the stream and
   * polls instead of opening a connection guaranteed to be rejected.
   *
   * Separate from `authToken` on purpose: the proxy case is authenticated
   * WITHOUT the store holding a token, so `authToken` alone reads that case
   * as "unauthenticated, safe to stream" — which is exactly backwards.
   */
  streamRequiresAuth?: boolean
}

/**
 * Poll cadence used only as a fallback when the SSE connection errors —
 * normal operation is server-pushed via EventSource, unlike the
 * editor-cli client which always polls.
 */
const DEFAULT_POLL_INTERVAL_MS = 5000

function isCommentArray(v: unknown): v is Comment[] {
  return Array.isArray(v)
}

/**
 * Returns `init` with `Authorization: Bearer <authToken>` merged into its
 * headers, or `init` ITSELF — the exact same reference, untouched — when
 * `authToken` is unset, so an unauthenticated store's requests are
 * byte-for-byte what they were before this option existed.
 *
 * `HeadersInit` is a union of three shapes — a plain object, a `Headers`
 * instance, and an array of `[name, value]` entries — and all three are
 * legal for any caller to pass. The original implementation spread
 * `init.headers as Record<string, string>`, a cast that is only correct for
 * the first: spreading a `Headers` yields an EMPTY object (its entries live
 * behind an iterator, not own properties) and spreading an entry array
 * yields numeric keys, so in both cases the caller's headers were silently
 * dropped and replaced with garbage while the cast suppressed any type
 * error. Every call site in this file passes an object literal today, so
 * that was latent rather than live — but a cast that's only correct for the
 * shapes we happen to pass is a trap for the next caller, so all three are
 * normalized explicitly.
 *
 * Exported for its own unit tests: the store never passes a `Headers` or an
 * entry array internally, so the non-object branches are unreachable
 * through the public `CommentStore` surface and could only be pinned here.
 */
export function attachBearer(
  init: RequestInit | undefined,
  authToken: string | undefined,
): RequestInit | undefined {
  if (!authToken) return init
  const merged: Record<string, string> = {}
  const provided = init?.headers
  if (typeof Headers !== "undefined" && provided instanceof Headers) {
    provided.forEach((value, name) => {
      merged[name] = value
    })
  } else if (Array.isArray(provided)) {
    for (const [name, value] of provided) merged[name] = value
  } else if (provided) {
    Object.assign(merged, provided as Record<string, string>)
  }
  // Drop any pre-existing Authorization under ANY casing before setting
  // ours — header names are case-insensitive, so leaving a caller's
  // `authorization` in place alongside our `Authorization` would send two
  // conflicting values rather than overriding.
  for (const name of Object.keys(merged)) {
    if (name.toLowerCase() === "authorization") delete merged[name]
  }
  merged.Authorization = `Bearer ${authToken}`
  return { ...init, headers: merged }
}

export function createViewerHttpCommentStore(
  options: ViewerHttpCommentStoreOptions,
): CommentStore {
  const { baseUrl, projectId, authToken, streamRequiresAuth } = options
  const fetchImpl = options.fetchImpl ?? fetch
  const eventSourceFactory: (url: string) => EventSourceLike =
    options.eventSourceFactory ??
    ((url: string) => new EventSource(url) as unknown as EventSourceLike)
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  const commentsUrl = `${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/comments`
  const commentUrl = (id: string) => `${commentsUrl}/${encodeURIComponent(id)}`
  const streamUrl = `${commentsUrl}/stream`

  // See `attachBearer` above — kept as a one-line closure so the single
  // fetch call site below reads the same as it always did.
  const withAuth = (init: RequestInit | undefined): RequestInit | undefined => attachBearer(init, authToken)

  // `expectBody: false` (delete) tolerates an empty 2xx body; everything
  // else (list/create/update/replies) always contracts a JSON body back,
  // so an empty 2xx body there is treated as a server-shape error rather
  // than silently resolving to `undefined`. This is stricter than the
  // editor-cli `http-comment-store.ts`, which has no equivalent check —
  // harmless there today because its only bodiless response is DELETE's
  // 204, which is handled by a dedicated branch before any "was there a
  // body" question comes up, same as here.
  //
  // This is also the single fetch call site for the whole store — every
  // read/write/poll request (`requestJson`, `list`, `delete` all call
  // this) routes through `withAuth` above, so it's the one place the auth
  // header needs attaching.
  async function request<T>(
    url: string,
    init?: RequestInit,
    opts: { expectBody?: boolean } = {},
  ): Promise<T> {
    const method = init?.method ?? "GET"
    const res = await fetchImpl(url, withAuth(init))
    const text = await res.text().catch(() => "")
    if (!res.ok) {
      throw new Error(`Comment API ${method} ${res.status}: ${text}`)
    }
    if (res.status === 204) return undefined as T
    if (text.length === 0) {
      if (opts.expectBody === false) return undefined as T
      throw new Error(`Comment API ${method} ${res.status}: empty response body`)
    }
    return JSON.parse(text) as T
  }

  function requestJson<T>(url: string, method: string, body: unknown): Promise<T> {
    return request<T>(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  const store: CommentStore = {
    async list() {
      const resp = await request<{ comments: unknown }>(commentsUrl)
      const comments = resp?.comments
      if (!isCommentArray(comments)) {
        throw new Error("Comment API GET: response missing 'comments' array")
      }
      return comments
    },
    async get(id) {
      const list = await store.list()
      return list.find((c) => c.id === id) ?? null
    },
    async create(input: CommentCreateInput) {
      return requestJson<Comment>(commentsUrl, "POST", input)
    },
    async update(id: string, patch: CommentUpdatePatch) {
      return requestJson<Comment>(commentUrl(id), "PATCH", patch)
    },
    async delete(id: string) {
      await request<void>(commentUrl(id), { method: "DELETE" }, { expectBody: false })
    },
    async addReply(id: string, reply: CommentReplyInput) {
      return requestJson<Comment>(`${commentUrl(id)}/replies`, "POST", reply)
    },
    subscribe(listener, onError) {
      let active = true
      // Emit only when the serialized list changes, so idle ticks (SSE
      // heartbeats, redundant poll ticks) don't churn the UI. `undefined`
      // = "nothing emitted yet".
      let lastSerialized: string | undefined
      let pollTimer: ReturnType<typeof setTimeout> | undefined

      // `subscribe` can dispatch multiple concurrent `list()` refetches:
      // the immediate initial fetch races the server's `connected` SSE
      // frame (EventSource fires `onmessage` for every data frame, and
      // every message triggers a refetch), and two close-together writes
      // can each trigger their own SSE message. These are independent
      // HTTP round-trips that can resolve out of dispatch order — if an
      // older fetch resolves after a newer one, the plain "did the
      // serialization change" dedup below does not catch it (the older
      // list still differs from the already-advanced `lastSerialized`)
      // and stale data would clobber fresh data on the UI. `fetchSeq` is
      // a monotonic dispatch token: a result is only applied if no newer
      // `emitIfChanged` call was dispatched while it was in flight.
      let fetchSeq = 0

      const emitIfChanged = async () => {
        if (!active) return
        const seq = ++fetchSeq
        try {
          const list = await store.list()
          if (!active || seq !== fetchSeq) return
          const serialized = JSON.stringify(list)
          if (serialized !== lastSerialized) {
            lastSerialized = serialized
            listener(list)
          }
        } catch (err) {
          if (active && seq === fetchSeq) onError?.(err)
        }
      }

      const stopPoll = () => {
        if (pollTimer !== undefined) {
          clearTimeout(pollTimer)
          pollTimer = undefined
        }
      }

      // Polling fallback for when the SSE stream errors out (proxy
      // hiccup, server restart). Stops as soon as a stream message
      // arrives again.
      const startPoll = () => {
        if (!active || pollTimer !== undefined) return
        const tick = () => {
          if (!active) return
          void emitIfChanged().finally(() => {
            if (active) pollTimer = setTimeout(tick, pollIntervalMs)
          })
        }
        pollTimer = setTimeout(tick, pollIntervalMs)
      }

      // `EventSource` has no API for custom headers, so it can't carry
      // `Authorization`. A stream that will be rejected is never opened —
      // it would 401/404 and degrade to a confusing silent-no-updates
      // state. Such a store goes straight to the same polling fallback an
      // errored stream uses (`startPoll` below): one fallback path, not two.
      //
      // The gate is `streamRequiresAuth`, NOT `authToken`. Those came apart
      // when Editor↔viewer sync started routing through the CLI proxy
      // (`useEditorCommentStore` sets `baseUrl: "/api/editor/viewer"` and
      // passes no `authToken`, because the CLI injects the viewer PAT
      // itself). The store held no token, so it looked unauthenticated and
      // opened a stream — against a bearer-gated proxy that rejects it.
      let source: EventSourceLike | undefined
      if (authToken || streamRequiresAuth) {
        startPoll()
      } else {
        source = eventSourceFactory(streamUrl)
        source.onmessage = () => {
          stopPoll()
          void emitIfChanged()
        }
        source.onerror = (err) => {
          // Close before falling back. `EventSource` reconnects on its own
          // after an error (a few seconds, forever), so leaving it open
          // means an endless loop of failing requests racing the polling
          // that has already taken over. The subscription's own teardown
          // closes it too, but that only runs on unsubscribe.
          source?.close()
          if (active) onError?.(err)
          startPoll()
        }
      }

      // Full-snapshot contract: fire the first emission immediately.
      void emitIfChanged()

      return () => {
        active = false
        stopPoll()
        source?.close()
      }
    },
  }
  return store
}
