/**
 * HTTP client for the CLI's `/api/editor/comments` routes.
 * Implements the `CommentStore` interface so client-side code (shell
 * panels, hooks) can be written against the same abstraction the
 * server-side local-file store satisfies.
 */

import type { Comment } from "@/types/bridge"
import type {
  CommentCreateInput,
  CommentReplyInput,
  CommentStore,
  CommentUpdatePatch,
} from "@/editor/core"
import {
  artifactFetch,
  assertSafeId,
  isArray,
  isMissingArtifactError,
  isObject,
  requireField,
} from "./shared"

const ROUTE = "/api/editor/comments"

/**
 * Poll cadence for {@link createHttpCommentStore}'s `subscribe`. The
 * HTTP transport has no server push, so realtime is approximated by
 * re-listing on an interval and emitting only when the list changed.
 * A few seconds is a fine floor for human-paced annotation. (An earlier
 * version of this comment deferred the "realtime that matters" to a
 * Firestore store with native `onSnapshot`; there is no Firestore store
 * anymore. The viewer pushes comment changes over SSE from its own
 * change-bus, and Editor reaches it through the CLI's viewer-proxy.)
 */
const POLL_INTERVAL_MS = 3000

const isComment = (v: unknown): v is Comment => isObject(v)
const isCommentArray = (v: unknown): v is Comment[] =>
  isArray(v) && v.every(isComment)

export function createHttpCommentStore(
  options: { pollIntervalMs?: number } = {},
): CommentStore {
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
  const store: CommentStore = {
    async list() {
      const resp = await artifactFetch<unknown>(ROUTE)
      return requireField<Comment[]>(resp, "comments", isCommentArray)
    },
    async get(id) {
      assertSafeId(id, "commentId")
      try {
        const resp = await artifactFetch<unknown>(`${ROUTE}/${encodeURIComponent(id)}`)
        return requireField<Comment>(resp, "comment", isComment)
      } catch (err) {
        if (isMissingArtifactError(err)) return null
        throw err
      }
    },
    async create(input: CommentCreateInput) {
      const resp = await artifactFetch<unknown>(ROUTE, {
        method: "POST",
        body: input,
      })
      return requireField<Comment>(resp, "comment", isComment)
    },
    async update(id: string, patch: CommentUpdatePatch) {
      assertSafeId(id, "commentId")
      const resp = await artifactFetch<unknown>(
        `${ROUTE}/${encodeURIComponent(id)}`,
        { method: "PATCH", body: patch },
      )
      return requireField<Comment>(resp, "comment", isComment)
    },
    async delete(id: string) {
      assertSafeId(id, "commentId")
      await artifactFetch(`${ROUTE}/${encodeURIComponent(id)}`, {
        method: "DELETE",
      })
    },
    async addReply(id: string, reply: CommentReplyInput) {
      assertSafeId(id, "commentId")
      const resp = await artifactFetch<unknown>(
        `${ROUTE}/${encodeURIComponent(id)}/replies`,
        { method: "POST", body: reply },
      )
      return requireField<Comment>(resp, "comment", isComment)
    },
    subscribe(listener, onError) {
      let active = true
      let timer: ReturnType<typeof setTimeout> | undefined
      // Emit only when the serialized list changes, so idle polls
      // don't churn the UI. `undefined` = "nothing emitted yet".
      let lastSerialized: string | undefined

      const poll = async () => {
        if (!active) return
        try {
          const list = await store.list()
          if (!active) return
          const serialized = JSON.stringify(list)
          if (serialized !== lastSerialized) {
            lastSerialized = serialized
            listener(list)
          }
        } catch (err) {
          // Don't tear down the subscription — the next tick retries.
          // Surface it so the consumer can show a retry banner (offline
          // / server-down is expected in local mode and self-heals).
          if (active) onError?.(err)
        } finally {
          if (active) timer = setTimeout(poll, pollIntervalMs)
        }
      }

      // Full-snapshot contract: fire the first poll immediately.
      void poll()
      return () => {
        active = false
        if (timer) clearTimeout(timer)
      }
    },
  }
  return store
}
