/**
 * Per-file async lock with optional snapshot/restore semantics. Phase 0 of
 * the detached-chat-sessions initiative (tasks/editor-detached-sessions.md).
 *
 * Why this exists: the edit pipeline originally assumed one in-flight chat
 * turn per project. When the orchestrator became multi-session, two sessions
 * may attempt to write the
 * same SFC concurrently. A per-file lock keyed by absolute path lets unrelated
 * files proceed in parallel while same-file edits serialize without
 * last-write-wins corruption.
 *
 * The snapshot/restore wrapper (`withWriteLock`) covers the case where a write
 * throws mid-execution. The existing pipeline at editor-cli/src/server/
 * edit-handler.ts:835 already creates timestamped backups before writing, so
 * snapshot/restore is belt-and-suspenders for the deterministic lane and the
 * primitive that future write paths (incremental streamed writes, multi-file
 * transactions) can rely on.
 *
 * Scope: this is a Phase 0 primitive. Wiring it into applyEdit() is Phase 2.
 * The module is consumed by the spike harness (scripts/editor-detached-
 * sessions-spike.ts) and exercised by file-lock-manager.test.ts.
 *
 * Not re-entrant. A second `withLock` call from the same sessionId on the same
 * path throws synchronously — a reentrant request is a caller bug, not
 * something the manager should silently allow into a deadlock.
 */

import * as fs from "node:fs/promises"
import { realpathSync } from "node:fs"
import * as path from "node:path"

import { getChatSessionScope } from "./chat-session-context"
import { appendLockEvent } from "./lock-event-persistence"

export type LockEvent =
  | { type: "acquire-attempt"; absPath: string; sessionId: string; queueLength: number; t: number }
  | { type: "acquired"; absPath: string; sessionId: string; waitedMs: number; t: number }
  | { type: "released"; absPath: string; sessionId: string; heldMs: number; t: number }
  | {
      type: "snapshot-captured"
      absPath: string
      sessionId: string
      existed: boolean
      bytes: number
      t: number
    }
  | { type: "snapshot-restored"; absPath: string; sessionId: string; reason: string; t: number }
  | { type: "snapshot-discarded"; absPath: string; sessionId: string; t: number }
  | {
      type: "snapshot-restore-failed"
      absPath: string
      sessionId: string
      originalError: string
      restoreError: string
      t: number
    }

export interface LockOptions {
  sessionId?: string
}

export interface FileLockManager {
  /**
   * Run `fn` while holding the lock for `absPath`. Releases on return or throw.
   * Does not touch the filesystem itself — caller is responsible for any I/O
   * inside `fn`.
   */
  withLock<T>(absPath: string, fn: () => Promise<T>, opts?: LockOptions): Promise<T>
  /**
   * Like `withLock`, plus: read the current contents of `absPath` into an
   * in-memory snapshot before `fn` runs, and restore them if `fn` throws. If
   * the file did not exist beforehand, a thrown `fn` will best-effort `unlink`
   * any file `fn` may have created.
   */
  withWriteLock<T>(absPath: string, fn: () => Promise<T>, opts?: LockOptions): Promise<T>
  /**
   * Test/observability accessor. Returns a snapshot of which sessions currently
   * hold which paths and how deep each waiter queue is.
   */
  inspect(): { heldBy: Map<string, string>; queueDepths: Map<string, number> }
}

interface Waiter {
  sessionId: string
  resolve: () => void
}

interface LockState {
  heldBy: string
  queue: Waiter[]
}

export interface CreateFileLockManagerOptions {
  /**
   * Optional callback fired for every lock-lifecycle event. Used by the spike
   * harness for structured logs and by tests for contention assertions. Errors
   * thrown from the callback are swallowed so telemetry can't break the lock.
   */
  onEvent?: (event: LockEvent) => void
  /**
   * Optional escalation hook for when `onEvent` itself throws. The primitive
   * still swallows the error so the lock can't be wedged by faulty telemetry,
   * but this callback gives the host a chance to log the failure. If
   * `onEventError` also throws, the secondary error is silently dropped.
   */
  onEventError?: (err: unknown, event: LockEvent) => void
}

/**
 * Resolve `absPath` to a canonical key that collapses symlinks and `..`
 * segments so two callers writing to the same physical file via different
 * paths serialize on the same lock. Synchronous on purpose: keeping the
 * resolution synchronous preserves the race-free "no-existing-lock"
 * acquire path. The realpath I/O cost is microseconds for files we'd
 * realistically lock.
 *
 * For paths that don't exist yet (new-file creation), we realpath the
 * parent and reattach the basename — that's what `fs.writeFile` will
 * resolve to.
 */
function canonicalKeySync(absPath: string): string {
  const resolved = path.resolve(absPath)
  try {
    return realpathSync(resolved)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== "ENOENT") return resolved
    const parent = path.dirname(resolved)
    const base = path.basename(resolved)
    try {
      return path.join(realpathSync(parent), base)
    } catch {
      return resolved
    }
  }
}

export function createFileLockManager(
  opts: CreateFileLockManagerOptions = {}
): FileLockManager {
  const locks = new Map<string, LockState>()
  let anonCounter = 0
  const emit = (event: LockEvent): void => {
    if (!opts.onEvent) return
    try {
      opts.onEvent(event)
    } catch (err) {
      if (!opts.onEventError) return
      try {
        opts.onEventError(err, event)
      } catch {
        // Telemetry must never break the lock.
      }
    }
  }

  function resolveSessionId(opt: string | undefined): string {
    if (typeof opt === "string" && opt.length > 0) return opt
    // Every anonymous call gets a unique owner id, so two unrelated anonymous
    // callers contending on the same file queue normally instead of tripping
    // reentrancy detection.
    return `__anon_${++anonCounter}__`
  }

  async function acquire(absPath: string, sessionId: string): Promise<() => void> {
    const key = canonicalKeySync(absPath)
    const tAttempt = Date.now()
    const existing = locks.get(key)

    if (!existing) {
      emit({ type: "acquire-attempt", absPath: key, sessionId, queueLength: 0, t: tAttempt })
      locks.set(key, { heldBy: sessionId, queue: [] })
      emit({ type: "acquired", absPath: key, sessionId, waitedMs: 0, t: Date.now() })
      return makeRelease(key, sessionId, Date.now())
    }

    if (existing.heldBy === sessionId) {
      throw new Error(
        `FileLockManager: reentrant acquire by session "${sessionId}" on "${key}". ` +
          `Locks are non-reentrant: restructure the caller to release before re-acquiring.`
      )
    }

    emit({
      type: "acquire-attempt",
      absPath: key,
      sessionId,
      queueLength: existing.queue.length + 1,
      t: tAttempt,
    })
    await new Promise<void>((resolve) => {
      existing.queue.push({ sessionId, resolve })
    })
    const tAcquired = Date.now()
    emit({
      type: "acquired",
      absPath: key,
      sessionId,
      waitedMs: tAcquired - tAttempt,
      t: tAcquired,
    })
    return makeRelease(key, sessionId, tAcquired)
  }

  function makeRelease(key: string, sessionId: string, acquiredAt: number): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const state = locks.get(key)
      if (!state) return
      emit({
        type: "released",
        absPath: key,
        sessionId,
        heldMs: Date.now() - acquiredAt,
        t: Date.now(),
      })
      const next = state.queue.shift()
      if (next) {
        state.heldBy = next.sessionId
        next.resolve()
      } else {
        locks.delete(key)
      }
    }
  }

  async function withLock<T>(
    absPath: string,
    fn: () => Promise<T>,
    o: LockOptions = {}
  ): Promise<T> {
    const sessionId = resolveSessionId(o.sessionId)
    const release = await acquire(absPath, sessionId)
    try {
      return await fn()
    } finally {
      release()
    }
  }

  async function withWriteLock<T>(
    absPath: string,
    fn: () => Promise<T>,
    o: LockOptions = {}
  ): Promise<T> {
    const sessionId = resolveSessionId(o.sessionId)
    const key = canonicalKeySync(absPath)
    const release = await acquire(absPath, sessionId)
    let snapshot: Buffer | null = null
    let existed = false
    try {
      try {
        snapshot = await fs.readFile(absPath)
        existed = true
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err
      }
      emit({
        type: "snapshot-captured",
        absPath: key,
        sessionId,
        existed,
        bytes: snapshot?.byteLength ?? 0,
        t: Date.now(),
      })
      try {
        const result = await fn()
        emit({ type: "snapshot-discarded", absPath: key, sessionId, t: Date.now() })
        return result
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        let restoreError: Error | null = null
        try {
          if (existed && snapshot) {
            await fs.writeFile(absPath, snapshot)
            emit({ type: "snapshot-restored", absPath: key, sessionId, reason, t: Date.now() })
          } else {
            try {
              await fs.unlink(absPath)
              emit({
                type: "snapshot-restored",
                absPath: key,
                sessionId,
                reason: `${reason} (unlinked new file)`,
                t: Date.now(),
              })
            } catch (unlinkErr) {
              const unlinkCode = (unlinkErr as NodeJS.ErrnoException)?.code
              if (unlinkCode === "ENOENT") {
                // The file was never created. Nothing to roll back.
              } else {
                restoreError = unlinkErr as Error
              }
            }
          }
        } catch (writeErr) {
          restoreError = writeErr as Error
        }
        if (restoreError) {
          emit({
            type: "snapshot-restore-failed",
            absPath: key,
            sessionId,
            originalError: reason,
            restoreError: restoreError.message,
            t: Date.now(),
          })
          throw new AggregateError(
            [err, restoreError],
            `withWriteLock restore failed after fn threw for "${key}": fn=${reason}; restore=${restoreError.message}`
          )
        }
        throw err
      }
    } finally {
      release()
    }
  }

  function inspect(): { heldBy: Map<string, string>; queueDepths: Map<string, number> } {
    const heldBy = new Map<string, string>()
    const queueDepths = new Map<string, number>()
    for (const [k, v] of locks) {
      heldBy.set(k, v.heldBy)
      queueDepths.set(k, v.queue.length)
    }
    return { heldBy, queueDepths }
  }

  return { withLock, withWriteLock, inspect }
}

/**
 * Process-wide shared FileLockManager. Production callers MUST go through
 * this — two `createFileLockManager()` instances are split-brain and lose
 * all same-file serialization across lanes. The factory remains exported
 * for tests that need a fresh manager per case.
 *
 * Note: this lock is per-process. If multiple Editor CLI processes ever
 * write the same repo concurrently (not the current model), they would
 * each have their own manager and serialize only within themselves. Branch
 * mode already assumes one CLI per repo (all chat sessions share the SAME
 * working tree — see CLAUDE.md § "Session" now means chat session only),
 * but if that invariant ever loosens, an OS-level advisory lockfile becomes
 * required.
 */
let sharedInstance: FileLockManager | null = null
export function getSharedFileLockManager(): FileLockManager {
  if (!sharedInstance) {
    sharedInstance = createFileLockManager({
      onEvent: (event) => {
        // Phase 3 follow-up of tasks/editor-detached-sessions.md:
        // when a chat-session scope is active (the orchestrator
        // wrapped its turn with `runWithChatSession`), persist
        // every lock event to that session's
        // `lock-events.jsonl` so the detail panel's
        // "Lock contention timeline" section can render it.
        // Events fired OUTSIDE any session scope are dropped —
        // they have no session to attribute to.
        //
        // We don't await: persistence runs on its own promise
        // chain inside `appendLockEvent` and serializes per-
        // session writes there. Holding up the lock release on
        // disk I/O would defeat the point of the primitive.
        const scope = getChatSessionScope()
        if (!scope) return
        void appendLockEvent(scope.repoRoot, scope.sessionId, event, {
          onError: (err) => {
            console.warn(
              `[FileLockManager] lock-event persistence failed for session=${scope.sessionId} event=${event.type}: ` +
                (err instanceof Error ? err.message : String(err)),
            )
          },
        })
      },
      onEventError: (err, event) => {
        // Default: surface telemetry failures via console.warn once per process.
        // Production wiring can override this by replacing the shared instance.
        console.warn(
          `[FileLockManager] onEvent threw for event=${event.type} path=${event.absPath}: ` +
            (err instanceof Error ? err.message : String(err))
        )
      },
    })
  }
  return sharedInstance
}

/**
 * Test-only escape hatch. Resets the shared singleton so tests don't leak
 * state across test runs in the same process.
 */
export function __resetSharedFileLockManagerForTests(): void {
  sharedInstance = null
}

/**
 * Test-only injection point. Lets a test install an instrumented
 * `FileLockManager` (e.g. with an `onEvent` capture) before exercising
 * production code that calls `getSharedFileLockManager()`. Production
 * code never calls this.
 */
export function __setSharedFileLockManagerForTests(mgr: FileLockManager): void {
  sharedInstance = mgr
}
