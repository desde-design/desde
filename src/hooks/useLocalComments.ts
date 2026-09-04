"use client"

/**
 * The Editor's comment hook. Talks to the CLI's `/api/editor/comments`
 * routes via `createHttpCommentStore()`. Loads on mount, owns the action
 * handlers the `<CommentPanel>` + `<CommentThreadPopup>` UI needs.
 *
 * Persistence model is "optimistic write + reconcile". Each action
 * (create / addReply / update / delete) pushes a local change into
 * the Zustand slice immediately for snappy UX, then calls the HTTP
 * store, then refetches and replaces with the server's truth.
 * Failures roll the optimistic change back and surface a toast.
 *
 * `comment-slice.ts` itself does no persistence — it's a pure in-memory
 * cache (`comments: Comment[]` plus UI-state setters). This hook is the
 * only thing that writes through to the CLI; the slice just holds what
 * it's told.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { useAppStore } from "@/stores"
import { createHttpCommentStore } from "@/services/artifact-stores"
import { isArtifactStoreError } from "@/services/artifact-stores/shared"
import { getActiveCliUser } from "@/lib/cli-user-identity"
import { extractMentionIds } from "@/components/annotations/mention-encoding"
import type {
  Comment,
  CommentAuthor,
  CommentPosition,
} from "@/types/bridge"
import type { CommentStore } from "@/editor/core"

/**
 * Fallback author for environments where the CLI bootstrap didn't
 * populate a real user identity (web `/compose` page, dev). Real
 * CLI runs override this via `__DESDE_CLI__.user`.
 */
export const FALLBACK_COMMENT_AUTHOR: CommentAuthor = {
  uid: "cli-local",
  displayName: "Local user",
  email: "",
  photoURL: "",
}

export interface UseLocalCommentsResult {
  /**
   * First fetch in flight. The Comments panel can render a
   * skeleton while this is true.
   */
  loading: boolean
  /** Last fetch / write error, if any. Cleared on next success. */
  error: string | null
  /** Refetch the full list and replace the slice. */
  refresh: () => Promise<void>
  /** Add a new comment at `position` with body `body`. */
  addComment: (
    body: string,
    position: CommentPosition,
    author?: CommentAuthor,
  ) => Promise<Comment | null>
  /** Reply to an existing comment. */
  addReply: (
    commentId: string,
    body: string,
    author?: CommentAuthor,
  ) => Promise<Comment | null>
  /** Toggle the `resolved` flag. */
  toggleResolved: (commentId: string) => Promise<void>
  /** Delete a comment. */
  deleteComment: (commentId: string) => Promise<void>
}

export interface UseLocalCommentsOptions {
  /** Override the store impl (used by tests). */
  store?: CommentStore
  /** Override the fallback author (CLI bootstrap injects this). */
  author?: CommentAuthor
  /**
   * When false, the hook stays inert. Used by the surface to avoid
   * fetching on the `/compose` web page where the CLI endpoints
   * aren't available.
   */
  enabled?: boolean
}

export function useLocalComments(
  options: UseLocalCommentsOptions = {},
): UseLocalCommentsResult {
  // Author resolution order:
  //   1. explicit `options.author` (tests, future contexts)
  //   2. CLI bootstrap identity from `setActiveCliUser` (real CLI runs)
  //   3. FALLBACK_COMMENT_AUTHOR placeholder (web /compose, dev)
  const { enabled = true } = options
  const author =
    options.author ?? getActiveCliUser() ?? FALLBACK_COMMENT_AUTHOR
  // Memoize the default store so the hook doesn't recreate it on
  // every render and trigger downstream effects.
  const store = useMemo<CommentStore>(
    () => options.store ?? createHttpCommentStore(),
    [options.store],
  )

  const setComments = useAppStore((s) => s.setComments)
  const [loading, setLoading] = useState<boolean>(enabled)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!enabled) return
    try {
      const list = await store.list()
      if (!mountedRef.current) return
      setComments(list)
      setError(null)
    } catch (err) {
      if (!mountedRef.current) return
      const message = (err as Error).message
      setError(`Failed to load comments: ${message}`)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [enabled, store, setComments])

  // Apply a full-list snapshot from `store.subscribe`, preserving any
  // in-flight optimistic records (id-prefixed `optimistic-`) that the
  // snapshot doesn't yet include — so a realtime/poll snapshot landing
  // between an optimistic insert and its write-success can't briefly
  // drop the just-added comment.
  const applySnapshot = useCallback(
    (snapshot: Comment[]) => {
      if (!mountedRef.current) return
      const current = useAppStore.getState().comments
      const pendingOptimistic = current.filter(
        (c) =>
          c.id.startsWith("optimistic-") &&
          !snapshot.some((s) => s.id === c.id),
      )
      setComments([...snapshot, ...pendingOptimistic])
      setError(null)
      setLoading(false)
    },
    [setComments],
  )

  // Subscribe instead of a one-shot fetch — both the local and the
  // viewer-synced HTTP stores implement `subscribe` as a poll (no server
  // push). Re-subscribes when the store swaps (e.g. linking + signing in
  // to a viewer flips local→viewer-synced, see useEditorCommentStore.ts).
  // `subscribe` fires once immediately, so this also covers the initial
  // load; `onError` surfaces a failed load so the panel can show a retry
  // banner.
  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    const unsubscribe = store.subscribe(applySnapshot, (err) => {
      if (!mountedRef.current) return
      setError(`Failed to load comments: ${(err as Error).message}`)
      setLoading(false)
    })
    return unsubscribe
  }, [enabled, store, applySnapshot])

  // Targeted mutate helpers — replace the full-refetch reconcile
  // pattern, which races under rapid mutations (a second write's
  // optimistic insert can be clobbered by the first write's
  // refresh, and a rollback to a stale `before` can drop unrelated
  // in-flight optimistic records). Each helper updates just the
  // records it touches.
  const replaceCommentInSlice = useCallback(
    (targetId: string, replacement: Comment | null) => {
      const current = useAppStore.getState().comments
      if (replacement === null) {
        setComments(current.filter((c) => c.id !== targetId))
        return
      }
      // Remember where the target sat so we can keep list order.
      const idx = current.findIndex((c) => c.id === targetId)
      // Drop BOTH the target (e.g. the optimistic placeholder) AND any
      // record that already carries the replacement's id. The realtime
      // Firestore `onSnapshot` can insert the real comment BEFORE this
      // optimistic→real swap runs — without this dedup the two coexist
      // as a duplicate (the bug that showed 2 comments as 4).
      const filtered = current.filter(
        (c) => c.id !== targetId && c.id !== replacement.id,
      )
      if (idx >= 0) {
        const insertAt = Math.min(idx, filtered.length)
        setComments([
          ...filtered.slice(0, insertAt),
          replacement,
          ...filtered.slice(insertAt),
        ])
      } else {
        // Target already gone (a snapshot cleared the optimistic between
        // insert and write-success) — append the server's truth so a
        // successful write never vanishes.
        setComments([...filtered, replacement])
      }
    },
    [setComments],
  )

  const addComment = useCallback(
    async (
      body: string,
      position: CommentPosition,
      authorOverride?: CommentAuthor,
    ): Promise<Comment | null> => {
      const useAuthor = authorOverride ?? author
      // The picker writes `@[Name](id)` straight into the body, and the
      // Viewer's comment routes read the recipients off this array, NEVER
      // off the body text — so a mention that is not extracted here notifies
      // nobody, however it renders.
      const mentions = extractMentionIds(body)
      const optimisticId = `optimistic-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)}`
      const optimistic: Comment = {
        id: optimisticId,
        number: optimisticNumber(),
        position,
        body,
        author: useAuthor,
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
        mentions,
        participantEmails: [useAuthor.email].filter(Boolean),
      }
      // Optimistic insert.
      setComments([...useAppStore.getState().comments, optimistic])
      try {
        const created = await store.create({ position, body, author: useAuthor, mentions })
        // Replace just the optimistic record with the server's truth.
        replaceCommentInSlice(optimisticId, created)
        return created
      } catch (err) {
        // Remove just the optimistic record — preserve other records
        // that may have arrived (concurrent writes, real-time loads)
        // since we inserted.
        replaceCommentInSlice(optimisticId, null)
        const message = surfaceError("Failed to add comment", err)
        setError(message)
        return null
      }
    },
    [author, store, setComments, replaceCommentInSlice],
  )

  const addReply = useCallback(
    async (
      commentId: string,
      body: string,
      authorOverride?: CommentAuthor,
    ): Promise<Comment | null> => {
      const useAuthor = authorOverride ?? author
      // Same reasoning as `create` above: replies carry their own mention
      // array, and it is the only thing the Viewer notifies from.
      const mentions = extractMentionIds(body)
      const beforeTarget = useAppStore
        .getState()
        .comments.find((c) => c.id === commentId)
      if (!beforeTarget) {
        const message = `Cannot reply: comment ${commentId} not found`
        setError(message)
        toast.error(message)
        return null
      }
      const optimisticReplyId = `optimistic-reply-${Date.now()}`
      const optimisticReply = {
        id: optimisticReplyId,
        body,
        author: useAuthor,
        createdAt: new Date().toISOString(),
        mentions,
      }
      // Targeted optimistic update: insert the reply on the target
      // comment only; leave every other comment alone.
      const withOptimistic: Comment = {
        ...beforeTarget,
        replies: [...beforeTarget.replies, optimisticReply],
      }
      replaceCommentInSlice(commentId, withOptimistic)
      try {
        const updated = await store.addReply(commentId, {
          body,
          author: useAuthor,
          mentions,
        })
        // Server returns the full updated comment — swap it in.
        replaceCommentInSlice(commentId, updated)
        return updated
      } catch (err) {
        // Roll the target comment back to its pre-write state.
        replaceCommentInSlice(commentId, beforeTarget)
        const message = surfaceError("Failed to add reply", err)
        setError(message)
        return null
      }
    },
    [author, store, replaceCommentInSlice],
  )

  const toggleResolved = useCallback(
    async (commentId: string): Promise<void> => {
      const beforeTarget = useAppStore
        .getState()
        .comments.find((c) => c.id === commentId)
      if (!beforeTarget) return
      const next = !beforeTarget.resolved
      replaceCommentInSlice(commentId, { ...beforeTarget, resolved: next })
      try {
        const updated = await store.update(commentId, { resolved: next })
        replaceCommentInSlice(commentId, updated)
      } catch (err) {
        replaceCommentInSlice(commentId, beforeTarget)
        const message = surfaceError("Failed to update comment", err)
        setError(message)
      }
    },
    [store, replaceCommentInSlice],
  )

  const deleteComment = useCallback(
    async (commentId: string): Promise<void> => {
      const beforeTarget = useAppStore
        .getState()
        .comments.find((c) => c.id === commentId)
      if (!beforeTarget) return
      // Snapshot the original position so a failure can restore it.
      const beforeIndex = useAppStore
        .getState()
        .comments.findIndex((c) => c.id === commentId)
      replaceCommentInSlice(commentId, null)
      try {
        await store.delete(commentId)
        // Server confirms — nothing more to do.
      } catch (err) {
        // Re-insert at the original index.
        const current = useAppStore.getState().comments
        const restored = [...current]
        const safeIndex = Math.max(0, Math.min(beforeIndex, restored.length))
        restored.splice(safeIndex, 0, beforeTarget)
        setComments(restored)
        const message = surfaceError("Failed to delete comment", err)
        setError(message)
      }
    },
    [store, replaceCommentInSlice, setComments],
  )

  return {
    loading,
    error,
    refresh,
    addComment,
    addReply,
    toggleResolved,
    deleteComment,
  }
}

function optimisticNumber(): number {
  // Best-effort: the server is the canonical source for comment
  // numbers. The optimistic record is replaced on refresh, so this
  // value is only seen for the brief flash between insert and
  // server reconciliation. Use max + 1 of current to look right
  // during that window.
  const current = useAppStore.getState().comments
  return current.length === 0
    ? 1
    : Math.max(...current.map((c) => c.number), 0) + 1
}

function surfaceError(prefix: string, err: unknown): string {
  let message = prefix
  if (isArtifactStoreError(err)) {
    message = `${prefix}: ${err.reason}`
  } else if (err instanceof Error) {
    message = `${prefix}: ${err.message}`
  }
  toast.error(message)
  return message
}
