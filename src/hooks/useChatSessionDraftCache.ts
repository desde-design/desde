"use client"

/**
 * Per-session draft + scroll-stickiness cache for the editor chat
 * panel. Backs the tab UI so switching sessions preserves the
 * textarea value and bottom-stick flag instead of resetting them.
 *
 * Keyed by sessionId, with a special "new" bucket for the "next
 * submit will mint a fresh sessionId" state (chatSessions.currentSessionId
 * === null). When the server returns a real sessionId on first submit
 * the caller calls `promoteNewBucket(id)` so the in-progress draft
 * carries over to the persisted-session entry without a flash.
 *
 * Lifetime: in-memory per surface mount. Not persisted across reloads
 * in v1 — adds complexity for a low-value case (a user reloading the
 * page hasn't asked to keep their in-flight draft for an arbitrary
 * stale session). Re-evaluate if usage shows otherwise.
 *
 * Capacity: bounded LRU at MAX_ENTRIES so a power user creating 100
 * sessions in a session doesn't grow the map unbounded. Entries are
 * touched on every read/write; the oldest are evicted past capacity.
 * 32 is overkill for the tab strip (which displays ~6 visible tabs)
 * but cheap to hold.
 */

import { useCallback, useRef } from "react"

const NEW_BUCKET = "__new__"
const MAX_ENTRIES = 32

interface CacheEntry {
  draft: string
  atBottom: boolean
  /** Monotonic counter for LRU eviction. */
  touchedAt: number
}

export interface ChatSessionDraftCache {
  getDraft: (sessionId: string | null) => string
  setDraft: (sessionId: string | null, draft: string) => void
  getAtBottom: (sessionId: string | null) => boolean
  setAtBottom: (sessionId: string | null, atBottom: boolean) => void
  /**
   * Move the "__new__" bucket's contents under a real sessionId.
   * Called when the server returns the resolved id from the first
   * submit. No-op if the new bucket is empty.
   */
  promoteNewBucket: (sessionId: string) => void
  /** Drop a session's entry. Called when a tab is closed. */
  forget: (sessionId: string) => void
}

export function useChatSessionDraftCache(): ChatSessionDraftCache {
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map())
  const tickRef = useRef(0)

  const keyFor = (sessionId: string | null) =>
    sessionId === null ? NEW_BUCKET : sessionId

  const touch = (key: string, mutate: (entry: CacheEntry) => void) => {
    const cache = cacheRef.current
    const existing = cache.get(key)
    const entry: CacheEntry = existing
      ? { ...existing, touchedAt: ++tickRef.current }
      : { draft: "", atBottom: true, touchedAt: ++tickRef.current }
    mutate(entry)
    cache.set(key, entry)
    if (cache.size > MAX_ENTRIES) evictOldest(cache)
  }

  // Codex round-1 minor #1: reads promote the entry too so a
  // frequently-revisited but unedited draft doesn't fall out of the
  // LRU window. Pure read semantics — value returned is unchanged;
  // only the eviction order shifts.
  const promoteOnRead = (key: string) => {
    const cache = cacheRef.current
    const existing = cache.get(key)
    if (!existing) return
    existing.touchedAt = ++tickRef.current
  }

  const getDraft = useCallback((sessionId: string | null) => {
    const key = keyFor(sessionId)
    promoteOnRead(key)
    return cacheRef.current.get(key)?.draft ?? ""
  }, [])

  const setDraft = useCallback((sessionId: string | null, draft: string) => {
    touch(keyFor(sessionId), (e) => {
      e.draft = draft
    })
  }, [])

  const getAtBottom = useCallback((sessionId: string | null) => {
    const key = keyFor(sessionId)
    promoteOnRead(key)
    return cacheRef.current.get(key)?.atBottom ?? true
  }, [])

  const setAtBottom = useCallback(
    (sessionId: string | null, atBottom: boolean) => {
      touch(keyFor(sessionId), (e) => {
        e.atBottom = atBottom
      })
    },
    [],
  )

  const promoteNewBucket = useCallback((sessionId: string) => {
    const cache = cacheRef.current
    const pending = cache.get(NEW_BUCKET)
    if (!pending) return
    cache.delete(NEW_BUCKET)
    cache.set(sessionId, { ...pending, touchedAt: ++tickRef.current })
  }, [])

  const forget = useCallback((sessionId: string) => {
    cacheRef.current.delete(sessionId)
  }, [])

  return {
    getDraft,
    setDraft,
    getAtBottom,
    setAtBottom,
    promoteNewBucket,
    forget,
  }
}

function evictOldest(cache: Map<string, CacheEntry>): void {
  let oldestKey: string | null = null
  let oldestTouched = Number.POSITIVE_INFINITY
  for (const [k, v] of cache) {
    if (v.touchedAt < oldestTouched) {
      oldestTouched = v.touchedAt
      oldestKey = k
    }
  }
  if (oldestKey !== null) cache.delete(oldestKey)
}
