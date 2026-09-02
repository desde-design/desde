"use client"

/**
 * Phase 3 of tasks/editor-detached-sessions.md — shell-side state
 * holder for the detached chat sessions UI.
 *
 * Responsibilities:
 *   1. Track the active chat sessionId (the one future submits target).
 *      While enabled, the hook mints one on mount so this is never
 *      `null` — see "Mount: open into a new chat" below for why that
 *      matters. When disabled it stays `null`, which the server reads
 *      as the project's single default session (legacy single-chat
 *      behaviour).
 *   2. Maintain a cached list of `ChatSessionSummary` rows for the
 *      session picker dropdown. Refetched on mount + after every turn
 *      completes (a single round-trip; no polling).
 *   3. Expose `selectSession` / `newSession` mutators for the picker
 *      to call. `selectSession` switches future submits to that
 *      sessionId; `newSession` clears the active id so the next
 *      submit mints a fresh one.
 *
 * Intentionally decoupled from useEditorChat — the chat hook calls
 * `getChatSessionId()` (from this hook) on submit and fires
 * `onSessionEvent()` back into here when the server returns the
 * resolved sessionId. Keeps the two hooks composable without one
 * depending on the other's lifecycle.
 *
 * No global state — the parent component owns the instance. The session
 * id and listing are local React state; multiple EditorSurface
 * instances would each have their own picker.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { editorFetch } from "@/lib/editor-fetch"
import type { ChatSessionSummary } from "@/editor/agent-chat/session-store"
import {
  detectSessionStatusTransitions,
  latestPromptFromSummary,
  type SessionStatusTransition,
} from "@/editor/agent-chat/session-status-transitions"

/**
 * Mint a client-side detached-session id. Codex round-1 finding #1:
 * `newSession()` previously left `currentSessionId === null`, which
 * the server treats as "use the project default session" — so "New
 * chat" actually resumed the legacy default. Minting a real UUID
 * here forces the server down its "first turn of a NEW session"
 * path. Pattern matches `/^[A-Za-z0-9_-]{1,64}$/` which both routes
 * validate against; `crypto.randomUUID()` returns 36 chars of
 * hex+hyphens — well inside that.
 */
function mintDetachedSessionId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `det-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export interface UseChatSessionsOptions {
  /**
   * Gate the hook on whether detached-session mode is on. When false,
   * the hook is inert — `getChatSessionId` returns null, `selectSession`
   * and `newSession` are no-ops, and the listing isn't fetched. Lets
   * the caller mount the hook unconditionally and toggle behavior via
   * the gate. Default: true.
   */
  enabled?: boolean
  /**
   * Phase 5 of tasks/editor-detached-sessions.md — fires when one or
   * more background sessions complete (status transitions from
   * `in-flight` to `idle` or `failed`). Receives the batched
   * transitions accumulated within `transitionDebounceMs` so 3 sessions
   * finishing in quick succession surface as ONE toast call, not three.
   *
   * Caller is responsible for the UI surface (sonner toast, etc.).
   * Keeping the surface out of the hook keeps it test-friendly +
   * decoupled from the toast library.
   *
   * The callback may receive the same set of sessionIds across
   * separate fires if the user clears `enabled` while a flush is
   * pending — pending transitions are dropped on disable to avoid
   * leaking stale callbacks across mode toggles.
   */
  onSessionTransition?: (transitions: SessionStatusTransition[]) => void
  /**
   * Window (ms) during which transitions accumulate before flushing
   * to `onSessionTransition`. The spec calls for "debounce/collapse
   * multiples within 1s" — defaulting to 1000ms matches that. Tests
   * can lower this with `vi.useFakeTimers`.
   */
  transitionDebounceMs?: number
}

export interface UseChatSessionsReturn {
  /**
   * Whether multi-session tracking is live (mirrors the `enabled` option).
   * Consumers gate the tab strip / draft cache / new-chat affordance on this
   * rather than re-deriving it from the edit-session state, so branch mode
   * (which has no worktree `session`) can still show the chat tabs.
   */
  enabled: boolean
  /** Cached session list, most-recent-first. Empty while loading. */
  sessions: ChatSessionSummary[]
  /** True while a refetch is in flight. */
  loading: boolean
  /** Last fetch error, or null. Cleared on the next successful fetch. */
  error: string | null
  /**
   * Active sessionId — what future chat submits resume. Never null
   * while `enabled`: the hook mints one on mount. Null only when the
   * hook is disabled, where the server resolves the project's single
   * default session.
   */
  currentSessionId: string | null
  /**
   * True when `currentSessionId` was minted by this client (the mount
   * mint, or "+ New") and has no record on disk yet. Such a session has
   * no model choice of its own and no transcript to hydrate.
   *
   * It goes FALSE as soon as a refetched listing contains that id,
   * which is the proof the session has been persisted. That matters
   * because the flag's consumers use it to mean "this chat may inherit
   * the project's model choice", and a persisted session is exactly the
   * case that must not be offered one. Switching to any other session
   * flips it false too, since it is derived from the minted id matching
   * the current one.
   *
   * Consumers should still only use it to fill a value that is EMPTY,
   * never to overwrite one: the window between a session's first turn
   * and the refetch that observes it is short but real.
   */
  currentSessionIsNew: boolean
  /**
   * Pass this to useEditorChat as `getChatSessionId`. Returns the
   * current sessionId so the next submit either resumes it or, when
   * null (hook disabled), lets the server resolve its default session.
   */
  getChatSessionId: () => string | null
  /**
   * Pass this to useEditorChat as `onSessionEvent`. Records the
   * server-resolved sessionId so subsequent submits land on the same
   * session, and queues a refetch so the listing reflects the new
   * turn count immediately.
   */
  onSessionEvent: (sessionId: string, projectId: string) => void
  /**
   * Pass this to useEditorChat as `onStreamComplete` — NOT
   * `onTurnComplete`. Refetches the listing so per-row counts
   * (`turnCount`, `conflictCount`, `lastTurnError`) reflect the
   * just-saved turn. Codex round-1 finding #4: refetching from the
   * `turn_complete` SSE event raced the server's `saveSession` call
   * (which runs after the orchestrator returns but before the stream
   * closes), so the listing could come back missing the just-
   * completed turn. The stream-close hook is the correct point.
   */
  onStreamComplete: () => void
  /**
   * Switch the active session to `sessionId`. Subsequent submits
   * resume it. Returns immediately; the caller should also reset
   * chat messages so the panel doesn't show the prior session's
   * stream.
   */
  selectSession: (sessionId: string) => void
  /**
   * Clear the active sessionId so the next submit mints a fresh
   * session server-side. Equivalent to "+ new chat" in the picker.
   */
  newSession: () => void
  /** Force-refetch the listing. The picker can wire this to its
   * dropdown-open event for "always-fresh" state. */
  refetch: () => Promise<void>
}

export function useChatSessions(
  opts: UseChatSessionsOptions = {},
): UseChatSessionsReturn {
  const enabled = opts.enabled ?? true
  const transitionDebounceMs = opts.transitionDebounceMs ?? 1000
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  // The last id `newSession()` minted, for as long as it names a
  // session with no file on disk. Compared against `currentSessionId`
  // to answer "is the active session one this client just made up and
  // the server has never saved?" — see `currentSessionIsNew` in the
  // return type. Cleared in `refetch` the moment the listing proves the
  // session was persisted.
  const [mintedSessionId, setMintedSessionId] = useState<string | null>(null)
  // Read inside `refetch`, whose deps deliberately exclude this state
  // (it must not re-create the callback and re-run the mount effect).
  const mintedRef = useRef<string | null>(null)
  mintedRef.current = mintedSessionId

  // Held in a ref so getChatSessionId always returns the latest
  // without re-creating the callback on every render. useEditorChat
  // reads through a stable ref of its own; this matches that pattern.
  const currentRef = useRef<string | null>(null)
  currentRef.current = currentSessionId

  // Codex round-1 findings #5 + #6 fix: monotonically increasing
  // request id so out-of-order fetch completions can't overwrite
  // fresh state with stale, and so completions whose enabled snapshot
  // doesn't match the current value are silently dropped. Without
  // this:
  //   - Two concurrent refetches (e.g. mount + dropdown-open) can
  //     return in reverse arrival order; the older one wins the
  //     final setSessions().
  //   - `enabled: true → false` during an in-flight fetch lets the
  //     completion still mutate state even though the hook is now
  //     supposed to be inert.
  //
  // Declared up here (before the transition helpers below) so the
  // flushPendingTransitions closure's `enabledRef.current` read can
  // never hit the TDZ — strictly we'd be fine because the closure
  // doesn't run until setTimeout fires, but the order is clearer
  // when the ref's declaration precedes its only readers.
  const fetchGenRef = useRef(0)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  // Phase 5 — toast-on-completion bookkeeping. The hook is the only
  // place that knows when the listing changes; detecting transitions
  // here keeps the parent component out of the diffing business.
  //
  //   - `prevSessionsRef`  — snapshot of the LAST sessions array we
  //     handed off to the detector. NOT the React state — comparing
  //     to React state would race with batched updates.
  //   - `localInFlightRef` — sessionIds the client knows are in-flight
  //     because IT just submitted a turn (via `onSessionEvent`), even
  //     if the on-disk `status` hasn't caught up yet. Closes codex
  //     round-1 finding #1: brand-new sessions and idle-then-resumed
  //     sessions never appear as `in-flight` in the listing baseline
  //     because the only refetch that happens between submit and
  //     stream-complete is the one fired BY stream-complete — which
  //     observes the FINAL status, not the in-flight one. Holding a
  //     local "we expect this to be in-flight" set lets the detector
  //     fire on absent/idle → idle/failed when we know we submitted
  //     it ourselves. Cleared the moment the listing first observes a
  //     terminal status for that session, so a second turn on the
  //     same id re-arms via the next `onSessionEvent`.
  //   - `pendingSessionIdsRef` — sessionIds that have flipped since the
  //     last flush. At flush time we look up each id's CURRENT status
  //     in `prevSessionsRef.current` and resolve the toast from
  //     ground truth. Codex round-1 finding #3: storing the
  //     transition payload at queue time meant a retry that succeeded
  //     within the debounce window would still fire the stale
  //     "Failed" toast (because the retry's success refetch is
  //     failed→idle, which the detector suppresses, so the pending
  //     entry is never overwritten). Deferring resolution to flush
  //     time picks up the listing's final truth.
  //   - `transitionTimerRef`  — the debounce timer. Reset on every
  //     transition arrival; flushes once the window elapses without
  //     new arrivals.
  //   - `onTransitionRef`    — caller callback held in a ref so we
  //     don't re-create refetch / flush closures when the parent
  //     re-renders with a new function reference. Codex round-1
  //     finding #4: assigned during render (not in a passive effect)
  //     so a timer that fires between render and commit still sees
  //     the latest callback. Same pattern as `currentRef` above.
  const prevSessionsRef = useRef<ChatSessionSummary[]>([])
  const localInFlightRef = useRef<Set<string>>(new Set())
  const pendingSessionIdsRef = useRef<Set<string>>(new Set())
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onTransitionRef = useRef(opts.onSessionTransition)
  onTransitionRef.current = opts.onSessionTransition

  // Cancel any pending flush. Used on disable + on unmount so a stale
  // toast doesn't fire after the picker is gone.
  const cancelPendingTransitionFlush = useCallback((): void => {
    if (transitionTimerRef.current !== null) {
      clearTimeout(transitionTimerRef.current)
      transitionTimerRef.current = null
    }
    pendingSessionIdsRef.current.clear()
  }, [])

  const flushPendingTransitions = useCallback((): void => {
    transitionTimerRef.current = null
    if (!enabledRef.current) {
      // Caller disabled the hook during the debounce window — drop
      // pending transitions silently. The status change is still on
      // disk; if/when the caller re-enables, the next fetch will see
      // it but won't fire a toast (the listing's first refetch
      // suppresses transitions).
      pendingSessionIdsRef.current.clear()
      return
    }
    // Resolve each pending sessionId AT FLUSH TIME by looking up the
    // current state in the latest listing. This is codex round-1
    // finding #3's fix: a session that transitioned in-flight→failed
    // and then was retried successfully within the debounce window
    // ends up with `prev.status === 'idle'` when we look it up here
    // — and we emit "idle" instead of the stale "failed" payload
    // that was queued earlier.
    const listing = prevSessionsRef.current
    const byId = new Map<string, ChatSessionSummary>()
    for (const s of listing) byId.set(s.sessionId, s)
    const transitions: SessionStatusTransition[] = []
    for (const sessionId of pendingSessionIdsRef.current) {
      const summary = byId.get(sessionId)
      if (!summary) continue // cancelled / removed
      // Only fire for terminal-for-the-turn states. If the user
      // retried the session and the retry's `in-flight` write made
      // it to disk before flush, we suppress here — the next
      // stream-complete refetch will pick up the retry's terminal
      // state.
      if (summary.status !== "idle" && summary.status !== "failed") continue
      transitions.push({
        sessionId,
        preview: latestPromptFromSummary(summary),
        toStatus: summary.status,
        ...(summary.statusReason ? { statusReason: summary.statusReason } : {}),
        ...(summary.status === "failed" && summary.statusFailureKind
          ? { failureKind: summary.statusFailureKind }
          : {}),
        ...(summary.status === "failed" &&
        summary.statusRetryAfterSeconds !== undefined
          ? { retryAfterSeconds: summary.statusRetryAfterSeconds }
          : {}),
      })
    }
    pendingSessionIdsRef.current.clear()
    if (transitions.length === 0) return
    const cb = onTransitionRef.current
    if (cb) {
      try {
        cb(transitions)
      } catch {
        // Toast handlers shouldn't throw, but if they do we can't let
        // it bubble into the React refetch path. Swallow.
      }
    }
  }, [])

  const enqueuePendingTransitions = useCallback(
    (sessionIds: Iterable<string>): void => {
      let added = false
      for (const id of sessionIds) {
        if (!pendingSessionIdsRef.current.has(id)) {
          pendingSessionIdsRef.current.add(id)
          added = true
        } else {
          added = true // reset timer even on duplicates so the window restarts
        }
      }
      if (!added) return
      if (!onTransitionRef.current) {
        // No subscriber. Clear what we just added so re-subscribers
        // (parent re-mounts with a callback) don't inherit a stale
        // queue.
        pendingSessionIdsRef.current.clear()
        return
      }
      if (transitionTimerRef.current !== null) {
        clearTimeout(transitionTimerRef.current)
      }
      transitionTimerRef.current = setTimeout(
        flushPendingTransitions,
        transitionDebounceMs,
      )
    },
    [flushPendingTransitions, transitionDebounceMs],
  )

  const refetch = useCallback(async (): Promise<void> => {
    if (!enabled) return
    const gen = ++fetchGenRef.current
    setLoading(true)
    try {
      const res = await editorFetch("/api/editor/chat/sessions", {
        method: "GET",
      })
      // Stale-completion guards: drop this completion if a newer
      // refetch has been started, or if the hook has been disabled
      // since the request went out.
      if (gen !== fetchGenRef.current || !enabledRef.current) return
      if (!res.ok) {
        setError(`Failed to load chat sessions: HTTP ${res.status}`)
        return
      }
      const body = (await res.json()) as
        | { ok: true; sessions: ChatSessionSummary[] }
        | { ok: false; reason: string }
      if (gen !== fetchGenRef.current || !enabledRef.current) return
      if (!body.ok) {
        setError(`Failed to load chat sessions: ${body.reason}`)
        return
      }
      // Detect status transitions (in-flight → idle/failed) BEFORE
      // we update prevSessionsRef, so the next refetch's diff baseline
      // is the listing we just rendered, not the one before it. The
      // detector itself is pure; the hook owns the prev/next ref
      // bookkeeping + debounce so concurrent refetches don't double-
      // count completions.
      const transitions = detectSessionStatusTransitions(
        prevSessionsRef.current,
        body.sessions,
      )
      // Also fold in transitions for sessions WE submitted (codex
      // round-1 finding #1): the listing baseline only contains an
      // `in-flight` row if a PRIOR refetch observed that state. For
      // a brand-new session, or an idle session whose retry started
      // and completed between two refetches, the detector misses
      // the transition because prev has no `in-flight` row to
      // transition FROM. The local in-flight set bridges the gap:
      // any sessionId we know we just submitted (via
      // `onSessionEvent`) that now shows up with a terminal status
      // counts as a transition. Cleared so a second turn on the
      // same id has to be re-armed by the next `onSessionEvent`.
      const localPendingIds: string[] = []
      if (localInFlightRef.current.size > 0) {
        for (const s of body.sessions) {
          if (
            localInFlightRef.current.has(s.sessionId) &&
            (s.status === "idle" || s.status === "failed")
          ) {
            localPendingIds.push(s.sessionId)
            localInFlightRef.current.delete(s.sessionId)
          }
        }
      }
      prevSessionsRef.current = body.sessions
      setSessions(body.sessions)
      setError(null)
      // A minted session that now appears in the listing has been
      // persisted, so it is no longer "new". Leaving the flag set was a
      // real defect: `currentSessionIsNew` is what tells the model chip
      // "this chat may inherit the project's choice", and a session
      // that has already run turns must not be offered one.
      //
      // The listing is the right proof rather than the turn-start
      // signal, because "has a file on disk" is exactly what the flag
      // claims. The functional update compares the id again at commit
      // time so a "+ New" that lands while this fetch is in flight
      // cannot have ITS id cleared by an older completion.
      const minted = mintedRef.current
      if (minted && body.sessions.some((s) => s.sessionId === minted)) {
        setMintedSessionId((prev) => (prev === minted ? null : prev))
      }
      if (transitions.length > 0 || localPendingIds.length > 0) {
        // Collect all sessionIds with transitions and let
        // `enqueuePendingTransitions` resolve them from the freshly-
        // written `prevSessionsRef.current` at flush time.
        const ids = new Set<string>()
        for (const t of transitions) ids.add(t.sessionId)
        for (const id of localPendingIds) ids.add(id)
        enqueuePendingTransitions(ids)
      }
    } catch (err) {
      if (gen !== fetchGenRef.current || !enabledRef.current) return
      setError(`Failed to load chat sessions: ${(err as Error).message}`)
    } finally {
      // Only the latest fetch clears loading. Older completions that
      // raced to the finish line have already returned above; they'd
      // otherwise spuriously flip loading off while the newer fetch
      // is still in flight.
      if (gen === fetchGenRef.current) setLoading(false)
    }
  }, [enabled, enqueuePendingTransitions])

  useEffect(() => {
    if (!enabled) return
    void refetch()
  }, [enabled, refetch])

  // Disable cleanup: when the hook flips to disabled (e.g. session
  // ends, mode toggle off), drop any pending transition timer. Without
  // this, a flush could fire after the picker is unmounted and toast
  // about sessions the user no longer cares about.
  //
  // Codex round-1 finding #2: also bump `fetchGenRef` so any
  // in-flight fetch resolution can't sneak through after the disable
  // and write `prevSessionsRef`. Without this, a true→false→true
  // toggle that lands before the pre-disable fetch resolves would
  // let the stale fetch pass both guards on resolution (gen still
  // matches, enabled is true again) and write a baseline based on
  // the OLD enabled session. Bumping the gen invalidates that
  // request unconditionally.
  useEffect(() => {
    if (!enabled) {
      cancelPendingTransitionFlush()
      // Reset the prev-baseline so re-enabling starts cleanly: the
      // first post-re-enable refetch will see prev=[] and skip
      // toasts on already-idle sessions. Without this, the prev
      // captured BEFORE the disable would still drive transitions
      // detected on the next enable.
      prevSessionsRef.current = []
      // Drop local in-flight expectations — we don't want a toast
      // for a session we submitted to "fire" after a disable cycle.
      localInFlightRef.current.clear()
      // Invalidate any in-flight fetch — see comment above.
      fetchGenRef.current++
    }
  }, [enabled, cancelPendingTransitionFlush])

  // Unmount cleanup: same idea — kill the timer so a flush after
  // unmount doesn't call into a torn-down React subtree's toast.
  useEffect(() => {
    return () => {
      cancelPendingTransitionFlush()
    }
  }, [cancelPendingTransitionFlush])

  const getChatSessionId = useCallback(
    () => (enabled ? currentRef.current : null),
    [enabled],
  )

  const onSessionEvent = useCallback(
    (sessionId: string) => {
      if (!enabled) return
      // If the server returned the same id we already had, this is a
      // no-op on state. If it returned a fresh id (we started with
      // null), record it so the next submit resumes the same session.
      if (currentRef.current !== sessionId) {
        setCurrentSessionId(sessionId)
      }
      // Codex round-1 finding #1: the `session` SSE event is the
      // shell's authoritative signal that a turn is starting on
      // `sessionId`. Stash it so the next refetch — typically the
      // post-stream-complete one — counts a missing-or-idle-prev →
      // terminal-next as a transition, not as "session appeared
      // already done." Cleared the moment the refetch observes
      // terminal status.
      localInFlightRef.current.add(sessionId)
    },
    [enabled],
  )

  const onStreamComplete = useCallback((): void => {
    if (!enabled) return
    void refetch()
  }, [enabled, refetch])

  const selectSession = useCallback(
    (sessionId: string): void => {
      if (!enabled) return
      setCurrentSessionId(sessionId)
    },
    [enabled],
  )

  const newSession = useCallback((): void => {
    if (!enabled) return
    // Codex round-1 #1 fix: mint a real UUID so the next submit creates
    // a fresh server-side session. Setting to `null` would resume the
    // legacy project-default session (server treats omitted sessionId
    // as `sessionId = projectId`), which is NOT what "New chat" means.
    const id = mintDetachedSessionId()
    // Sync-update the ref so a chat submit dispatched on the SAME tick
    // (e.g. auto-fork-when-busy from a table-edge action) reads the new
    // id via getChatSessionId before React flushes setCurrentSessionId.
    // The render-time `currentRef.current = currentSessionId` line is
    // idempotent on this write.
    currentRef.current = id
    // Same sync-write reason as `currentRef`: an in-flight `refetch`
    // resolving before React commits must see the id it is allowed to
    // clear, not the previous one.
    mintedRef.current = id
    setCurrentSessionId(id)
    setMintedSessionId(id)
  }, [enabled])

  // ---------------------------------------------------------------
  // Mount: open into a NEW chat.
  //
  // Opening a project used to land on whichever session was touched
  // last, because the rail adopted `sessions[0]` and hydrated the pane
  // from it. That adoption existed to close a real bug, and the bug is
  // still real — so the fix is to mint here, not to drop the guard.
  //
  // The bug: `currentSessionId === null` LOOKS like "no session yet",
  // but the server reads a missing sessionId as the project's PERMANENT
  // default session (`chat-handler.ts`: `body.sessionId ?? projectId`),
  // which carries its own `sdkSessionId`. So a blank pane would
  // silently resume weeks of conversation the moment the user typed one
  // word — MEASURED on the dogfood prototype, whose default session was
  // created 2026-07-13 and was still resuming on 2026-08-11.
  //
  // `newSession()` mints a real UUID and sets it as `currentSessionId`,
  // which is byte-for-byte the state "+ New" produces, so the server
  // takes its "first turn of a NEW session" path. Prior sessions stay
  // listed and clickable in the session menu.
  //
  // It lives in the hook and not in a consumer because the hook owns
  // `currentSessionId`: minting here closes the null window for EVERY
  // consumer, including the surface's two `currentSessionId !== null`
  // checks, rather than for whichever component remembered to do it.
  //
  // Gated on `enabled` — with detached sessions off, null → the project
  // default IS the correct legacy single-chat behaviour, and there is
  // no session menu to reach anything else from.
  //
  // Idempotent: the latch ref means a re-run (a new `newSession`
  // identity, an `enabled` toggle) can never mint a second time and
  // throw away the session the user picked in between.
  const mintedOnMountRef = useRef(false)
  useEffect(() => {
    if (!enabled || mintedOnMountRef.current) return
    if (currentRef.current !== null) {
      // Something already chose a session before this ran. Latch and
      // leave it alone.
      mintedOnMountRef.current = true
      return
    }
    mintedOnMountRef.current = true
    newSession()
  }, [enabled, newSession])

  // Memoized for the same reason as `useEditorChat`'s return: the whole
  // object is passed down as a single prop (`EditorRightRail`'s
  // `chatSessions`), so a fresh literal per render would re-render every
  // consumer on unrelated surface renders.
  return useMemo(
    () => ({
      enabled,
      sessions,
      loading,
      error,
      currentSessionId,
      currentSessionIsNew:
        currentSessionId !== null && currentSessionId === mintedSessionId,
      getChatSessionId,
      onSessionEvent,
      onStreamComplete,
      selectSession,
      newSession,
      refetch,
    }),
    [
      enabled,
      sessions,
      loading,
      error,
      currentSessionId,
      mintedSessionId,
      getChatSessionId,
      onSessionEvent,
      onStreamComplete,
      selectSession,
      newSession,
      refetch,
    ],
  )
}
