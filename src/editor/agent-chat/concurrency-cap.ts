/**
 * Phase 5 of tasks/editor-detached-sessions.md — per-project
 * concurrency cap with FIFO queueing.
 *
 * Why it exists: Phase 3 made detached chat sessions actually work
 * end-to-end (the codex round-1 #1 fix in commit `d4d466f`). Users
 * can now spawn 10 parallel detached sessions and each would
 * independently load the Anthropic API. The cap protects against
 * runaway parallel turn fan-out: at most N turns in flight per
 * project; submissions beyond the cap queue up FIFO and drain as
 * existing turns complete.
 *
 * Separation of concerns: this module only manages the cap + queue.
 * Same-session re-entry (two concurrent turns on the SAME sessionId)
 * is still enforced by the existing `activeTurns: Set<lockKey>` in
 * each route — that contract is unchanged. The cap layers ON TOP:
 *
 *   1. Caller computes `lockKey = projectId:sessionId`
 *   2. Caller checks `activeTurns.has(lockKey)` → 409 if so (unchanged)
 *   3. Caller adds `lockKey` to `activeTurns` (same-session 409 fires
 *      upstream of the cap; a same-session second submit must NEVER
 *      queue against its own already-running turn)
 *   4. Caller calls `acquireSlot({ projectId, sessionId, signal, onQueued })`
 *      → awaits if the project is at cap, resolves with `release`
 *   5. Caller runs the orchestrator
 *   6. On finally: caller deletes `lockKey` from `activeTurns` AND calls
 *      `release()` so the next queued waiter drains
 *
 * Abort semantics: callers MUST pass their AbortSignal so a client
 * disconnect while queued cleanly removes the entry from the queue
 * and lets the slot stay open for the next waiter. Without that,
 * an aborted-while-queued submission would hold a phantom slot
 * forever.
 *
 * Per-project keying: the cap is per `projectId`. Two distinct
 * prototypes share the process (uncommon but possible — multiple
 * Next.js dev servers in CI) and each gets its own cap quota.
 *
 * Note on persistence: in-process only. A editor-cli restart loses
 * the queue, which is the right behavior — restart-cleanup (Phase 5
 * follow-up) marks the affected sessions cancelled. If we ever ran
 * multiple Node processes against the same worktree, this would
 * need an OS-level coordination layer (advisory lockfile, similar
 * to FileLockManager's note). Not the current model.
 */

/** Default cap when callers don't specify. Spec target: 3-4. */
export const DEFAULT_CONCURRENCY_CAP = 3

export interface AcquireSlotOptions {
  /** Stable per-project id (`projectIdForRepoRoot(repoRoot)`). */
  projectId: string
  /**
   * The session attempting to acquire. Recorded on the queue entry
   * so the caller can correlate `onQueued` events back to the
   * intended session and so future Phase 5 introspection (drawer
   * "queued" status) can report which session is waiting.
   */
  sessionId: string
  /**
   * The request's AbortSignal. If the request is aborted while
   * queued, the queue entry is removed and the next waiter (if any)
   * drains naturally — the abort doesn't burn a slot.
   */
  signal: AbortSignal
  /**
   * Fires exactly once if the acquire actually waits in the queue —
   * i.e. the project was at cap on entry. Receives the queue
   * position (1-indexed) at enqueue time. Callers wire this to an
   * SSE `queued` event so the client can render "waiting in line".
   * Not fired when the acquire is immediate.
   */
  onQueued?: (queuePosition: number) => void
  /**
   * Optional cap override. Defaults to `DEFAULT_CONCURRENCY_CAP`.
   * Per-call rather than per-manager so a hypothetical future
   * "settings UI" can plumb the user's preference through without
   * having to mutate the singleton.
   */
  cap?: number
}

export interface AcquireSlotResult {
  /**
   * Release the slot. MUST be called from a `finally` block so a
   * thrown orchestrator releases the slot too. Idempotent — calling
   * release twice is a no-op (second call doesn't drain a second
   * waiter).
   */
  release: () => void
  /**
   * True iff the acquire actually waited in the queue. Lets callers
   * distinguish "ran immediately" from "was queued then drained"
   * for telemetry / UI.
   */
  wasQueued: boolean
}

interface QueueEntry {
  /**
   * Codex round-1 fix #3: cap is recorded ON THE WAITER so drain
   * uses the head waiter's cap, not the releasing slot's cap. With
   * inconsistent per-call caps this matters — the waiter's
   * requested limit is what should be honored when deciding whether
   * to drain it.
   */
  cap: number
  sessionId: string
  resolve: () => void
  reject: (err: Error) => void
  /** Listener installed on the caller's signal; removed on settle. */
  onAbort: () => void
  signal: AbortSignal
}

interface ProjectState {
  /** sessionIds currently holding a slot. */
  inFlight: Set<string>
  /** Waiters in arrival order. */
  queue: QueueEntry[]
}

export interface ConcurrencyCap {
  acquireSlot(opts: AcquireSlotOptions): Promise<AcquireSlotResult>
  /**
   * Test/observability accessor. Returns a snapshot of which sessions
   * hold slots per project and how many are queued. Production code
   * shouldn't call this; tests use it to assert state without
   * waiting for asynchronous queue drain.
   */
  inspect(projectId: string): { inFlight: string[]; queueDepth: number }
}

export function createConcurrencyCap(): ConcurrencyCap {
  const projects = new Map<string, ProjectState>()

  function getProjectState(projectId: string): ProjectState {
    let state = projects.get(projectId)
    if (!state) {
      state = { inFlight: new Set(), queue: [] }
      projects.set(projectId, state)
    }
    return state
  }

  function drainQueueAfterRelease(state: ProjectState): void {
    // The just-released slot opens room for the next waiter. Drain
    // exactly one — additional drains happen as each newly-active
    // turn releases.
    //
    // Codex round-1 fix #3: the cap to honor at drain time is the
    // *head waiter's* cap, NOT the releasing slot's cap. If the
    // releasing slot used cap=5 but the head waiter is queued under
    // cap=1, we must respect cap=1; otherwise the waiter would drain
    // even though its requested limit is exceeded.
    //
    // Codex round-1 fix #2: when we encounter a queued waiter whose
    // signal is already aborted (the abort listener race in the
    // original implementation could leave such entries on the queue),
    // we MUST reject its promise. The previous `continue` left the
    // promise hanging forever, which leaks the caller's await and the
    // upstream `activeTurns` lock.
    while (state.queue.length > 0) {
      const next = state.queue[0]
      if (next.signal.aborted) {
        // Stale aborted entry — pop it, clean up the listener, and
        // reject so the caller's await unblocks.
        state.queue.shift()
        next.signal.removeEventListener("abort", next.onAbort)
        next.reject(new DOMException("Aborted", "AbortError"))
        continue
      }
      // Live waiter — check its cap. If the project is already at
      // (or above) the waiter's cap, leave the queue alone; this
      // release didn't free enough slots for THIS waiter, so don't
      // skip ahead to a more lenient one.
      if (state.inFlight.size >= next.cap) return
      // Drain.
      state.queue.shift()
      next.signal.removeEventListener("abort", next.onAbort)
      // The session re-enters in-flight before we resolve so a
      // concurrent acquire sees the correct slot count immediately.
      state.inFlight.add(next.sessionId)
      next.resolve()
      // Loop to drain additional waiters whose caps are still
      // satisfied (rare in practice — happens if a waiter with a
      // higher cap is at the head).
    }
  }

  async function acquireSlot(
    opts: AcquireSlotOptions,
  ): Promise<AcquireSlotResult> {
    const cap = opts.cap ?? DEFAULT_CONCURRENCY_CAP
    const state = getProjectState(opts.projectId)

    if (opts.signal.aborted) {
      throw new DOMException("Aborted", "AbortError")
    }

    if (state.inFlight.size < cap) {
      // Slot available — run immediately. No queue interaction at all
      // so this hot path is allocation-light.
      state.inFlight.add(opts.sessionId)
      return {
        wasQueued: false,
        release: makeRelease(state, opts.sessionId),
      }
    }

    // Cap hit — enqueue. Codex round-1 fix #1: register the queue
    // entry + abort listener BEFORE calling onQueued. If the
    // callback synchronously aborts the signal (or schedules a
    // release that drains immediately), the listener / queue state
    // must already be in place so the abort doesn't fall on the
    // floor and the drain isn't operating on a queue missing this
    // waiter. Then re-check abort state AFTER the callback to
    // surface a synchronous abort cleanly.
    return new Promise<AcquireSlotResult>((resolve, reject) => {
      // Forward-declared so the abort handler can self-reference.
      const entry: QueueEntry = {
        cap,
        sessionId: opts.sessionId,
        signal: opts.signal,
        onAbort: () => {
          // Remove from queue (may already be gone if drain raced).
          const idx = state.queue.indexOf(entry)
          if (idx >= 0) state.queue.splice(idx, 1)
          opts.signal.removeEventListener("abort", entry.onAbort)
          reject(new DOMException("Aborted", "AbortError"))
        },
        resolve: () => {
          // Drain code already added sessionId to inFlight and
          // removed the abort listener. Just hand back the release.
          resolve({
            wasQueued: true,
            release: makeRelease(state, opts.sessionId),
          })
        },
        reject,
      }
      state.queue.push(entry)
      opts.signal.addEventListener("abort", entry.onAbort, { once: true })

      // 1-indexed position at enqueue time.
      const position = state.queue.length
      try {
        opts.onQueued?.(position)
      } catch {
        // Telemetry must never break acquire. Mirrors the
        // FileLockManager's onEvent guard.
      }

      // Re-check: if the callback (or anything else running
      // synchronously between enqueue and here) aborted the signal
      // or freed a slot that drained the queue, the entry may have
      // already settled. `onAbort` and `resolve` both run via the
      // listener / drain paths, which have already removed the
      // entry from the queue — so a stale entry shouldn't sit
      // around. But if the signal aborted AFTER enqueue but the
      // listener was somehow already removed (defense in depth),
      // we manually unblock here.
      if (opts.signal.aborted) {
        const idx = state.queue.indexOf(entry)
        if (idx >= 0) {
          state.queue.splice(idx, 1)
          opts.signal.removeEventListener("abort", entry.onAbort)
          reject(new DOMException("Aborted", "AbortError"))
        }
      }
    })
  }

  function makeRelease(state: ProjectState, sessionId: string): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      state.inFlight.delete(sessionId)
      drainQueueAfterRelease(state)
    }
  }

  function inspect(projectId: string): { inFlight: string[]; queueDepth: number } {
    const state = projects.get(projectId)
    if (!state) return { inFlight: [], queueDepth: 0 }
    return {
      inFlight: Array.from(state.inFlight),
      queueDepth: state.queue.length,
    }
  }

  return { acquireSlot, inspect }
}

/**
 * Process-wide shared ConcurrencyCap. Production callers MUST go
 * through this — two factory-fresh instances would split-brain the
 * project's quota across them, defeating the cap. The factory stays
 * exported for tests that need a fresh manager per case.
 */
let sharedInstance: ConcurrencyCap | null = null
export function getSharedConcurrencyCap(): ConcurrencyCap {
  if (!sharedInstance) sharedInstance = createConcurrencyCap()
  return sharedInstance
}

/** Test-only escape hatch. Resets the singleton between tests. */
export function __resetSharedConcurrencyCapForTests(): void {
  sharedInstance = null
}

/** Test-only injection point. Mirrors FileLockManager's pattern. */
export function __setSharedConcurrencyCapForTests(cap: ConcurrencyCap): void {
  sharedInstance = cap
}
