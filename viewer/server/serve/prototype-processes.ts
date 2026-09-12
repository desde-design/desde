import { spawn, type ChildProcess } from "node:child_process"
import { connect as netConnect, createServer } from "node:net"
import { mkdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { buildEnv } from "../build/exec"
import { checkoutDirFor } from "../build/checkouts"
import { createKeyedLock } from "../keyed-lock"
import {
  chooseVictim,
  newRecord,
  retryable,
  transition,
  BUDGET_REFUSAL,
  RETIRED_REFUSAL,
  type Limits,
  type ProcessEvent,
  type ProcessRecord,
  type TransitionResult,
} from "./process-state"
import type { Deployment } from "../storage/types"

/**
 * Runs a server prototype's own server as a child process, on demand.
 *
 * One process per deployment, started by the first request that needs it
 * and stopped when idle, at the cap, on prune, or at shutdown. The spawn
 * discipline is `build/exec.ts`'s: an env ALLOWLIST (the Viewer's secrets
 * never reach the child), `detached` so the whole tree dies together, and
 * a loopback bind only. See the server-prototypes spec, "Process manager".
 *
 * This file is the RUNTIME. Every rule about when a start, stop, reap or
 * eviction is allowed lives in the pure machine next door
 * (`process-state.ts`); this file drives that machine under one lock per
 * deployment id and executes the effects it returns. See the rework spec,
 * "The process manager becomes an explicit state machine"
 * (`docs/superpowers/specs/2026-09-11-server-prototypes-rework-design.md`).
 */
export type ProcessStatus =
  | { state: "stopped" }
  | {
      state: "starting"
      /**
       * The generation of the child that is coming up. Same counter, and the
       * same purpose, as the one on `running` below.
       *
       * It is on this state too because a cold start is ONE new child: the
       * page keys its frame on the generation, so `starting` and the
       * `running` that follows it must agree, or the frame is thrown away
       * and remounted the moment the app it was waiting for finishes
       * loading.
       */
      generation: number
    }
  | {
      state: "running"
      port: number
      since: string
      /**
       * Increments on every spawn for this deployment.
       *
       * The one public fact the state machine added. The review page keys
       * the iframe on it, so a restart remounts the frame without any
       * epoch bookkeeping of its own in the shell.
       */
      generation: number
    }
  | {
      state: "crashed"
      exitCode: number | null
      restarts: number
      reason: string
      /**
       * Whether the NEXT `ensure` would try again.
       *
       * `false` for a missing checkout, a malformed id, and while the restart
       * budget is spent; `true` otherwise. It exists so the review page does
       * not turn one transient exit into a dead end: a retryable crash is
       * embedded, and the iframe's own request restarts the process in
       * seconds, where the crashed panel offers only a multi-minute rebuild.
       *
       * It states the manager's own budget rather than inviting a second
       * copy of that rule to be written on the page.
       *
       * COMPUTED when the status is read, not frozen when the crash
       * happened. The budget is "at most 3 restarts in 5 minutes", so the
       * answer changes with time on its own: a crash that has aged out of
       * that window would be retried, and a status that still said `false`
       * an hour later would send the page on offering a rebuild nobody
       * needs. The two reasons that no amount of waiting fixes (the checkout
       * is gone, the id is malformed) stay `false` regardless.
       */
      retryable: boolean
      /**
       * The generation of the child that crashed. The review page keys its
       * frame on `generation + 1` for a retryable crash, so the remount that
       * restarts the child and the `starting`/`running` that follow share
       * one key: one restart, one remount.
       */
      generation: number
    }

export class PrototypeProcessError extends Error {
  readonly name = "PrototypeProcessError"
  constructor(
    public readonly status: ProcessStatus,
    message: string,
    /**
     * Set when the refusal is expected to clear on its own (every slot busy
     * right now). The serve router turns it into a `Retry-After` header
     * and a page that reloads itself, because the record is left `stopped`
     * and nothing else would ever ask again (codex round 26).
     */
    public readonly retryAfterSeconds?: number,
  ) {
    super(message)
  }
}

export interface PrototypeProcesses {
  ensure(deployment: Pick<Deployment, "id" | "serverStart">): Promise<{ port: number }>
  touch(deploymentId: string): void
  /**
   * Runs `fn` with a request lease held against this deployment's process,
   * so neither the idle reaper nor eviction can stop it while `fn` is still
   * running.
   *
   * The lease is a SCOPE, not a pair of calls: it is taken synchronously,
   * before this function's first await, and released in a `finally` however
   * `fn` settles. The serve router wraps the whole of "ensure the process,
   * then proxy to it" in one of these, so the lease covers the cold start
   * AND the response (codex rounds 2 and 11). The two defects the pair-of-
   * calls shape kept producing were a release that never ran (the client
   * gave up before `res.once("close", release)` was registered) and a window
   * at the start of a request with no lease at all, during which a
   * concurrent cold start could evict the just-ready process.
   *
   * Safe for a deployment the manager has never seen: the record is created
   * on demand, and a lease on an idle record only decides whether a FUTURE
   * reap or eviction skips it.
   */
  withLease<T>(deploymentId: string, fn: () => Promise<T>): Promise<T>
  stop(deploymentId: string): Promise<void>
  /**
   * `stop`, and then forget the deployment entirely — its status, its log,
   * its restart history.
   *
   * For a deployment that will never be asked for again: the project was
   * deleted, so its checkout is about to be removed too. `stop` alone would
   * leave the entry in the map forever, still reporting a crash reason for
   * something that no longer exists.
   */
  forget(deploymentId: string): Promise<void>
  /**
   * Stops the process, like `forget`, but does NOT drop the entry —
   * instead it leaves a permanent, non-retryable `crashed` status behind,
   * so every `ensure` for this id is refused until a later `forget` (project
   * delete) or a fresh id (a new build).
   *
   * For a deployment whose checkout `pruneSupersededCheckouts` is about to
   * delete: between stopping the process and removing the directory, a
   * request can still land and call `ensure`. `stop` alone would leave the
   * entry `stopped`, which `ensure` treats as "safe to start again" — that
   * is exactly the race (a fresh child spawned into a directory that is
   * mid-delete). `retire` closes it by making the SAME entry refuse, before
   * the directory is ever touched.
   */
  retire(deploymentId: string): Promise<void>
  /**
   * The proxy's own signal that a `running` entry lied: the child gave no
   * response at all — the connection could not be made, or failed before any
   * status line came back (`proxy-to-process.ts`'s `onUnreachable`).
   *
   * If the entry is `running`, this stops the child and records a `crashed`
   * status with `reason: "The server stopped answering."` — a RETRYABLE
   * crash (an ordinary entry in the attempt list, the same as an exit or a
   * timeout), so the next `ensure` restarts it under the normal budget.
   *
   * `stop()` was the wrong call for this (codex round 5, Fix 2): it leaves
   * the entry `stopped`, which says the viewer put the child away on purpose.
   * It did not — the child stopped answering. The reader's frame is showing a
   * 502 page that makes no further request on its own, so the difference is
   * what the review page tells them: a `crashed` status carries a reason and
   * a `retryable` verdict, where `stopped` carries neither.
   *
   * If the entry is already `crashed` (the exit handler beat the proxy to
   * it, or a previous `markUnreachable` already ran), this leaves the status
   * and its reason exactly as they are — the proxy's failure is not new
   * information once the manager already knows the child is down, and
   * overwriting a more specific reason with this generic one would be a
   * regression. If the entry is `starting` or `stopped`, this does nothing:
   * neither state claims the child is up, so there is nothing to correct.
   * All four of those rows are the machine's, not this file's.
   */
  markUnreachable(deploymentId: string): Promise<void>
  status(deploymentId: string): ProcessStatus
  serverLog(deploymentId: string): string
  /**
   * Calls `listener` with the new status every time this deployment's
   * status CHANGES, and returns the unsubscribe.
   *
   * Same shape as `build-change-bus.ts`, except that the status rides the
   * call: a subscriber (the prototype-origin SSE stream) would otherwise
   * have to read it back and could miss a transition that was reversed in
   * between. A transition that leaves the exposed status identical (the
   * `spawned` acknowledgement, a touch) fires nothing.
   */
  subscribe(deploymentId: string, listener: (status: ProcessStatus) => void): () => void
  startReaper(): () => void
  /** How many deployment records the manager holds. For tests and diagnostics; a forgotten deployment must not count. */
  recordCount(): number
  shutdown(): Promise<void>
}

export const MAX_RUNNING_SERVER_PROTOTYPES = 4
/** The log ring buffer is measured in characters (`string.slice`), not bytes. */
const LOG_CHARS = 64 * 1024
/**
 * At most this many FAILED ATTEMPTS inside `RESTART_WINDOW_MS`.
 *
 * The product rule is "at most 3 restarts in 5 minutes", and the first
 * attempt is not a restart — so the budget is four recorded attempts, and
 * the fifth is the one refused. The machine refuses `start-requested` once
 * the window already holds this many attempts, which is the same line the
 * hand-written check drew when it read `recent.length > 3`.
 */
const RESTART_BUDGET_ATTEMPTS = 4
const RESTART_WINDOW_MS = 5 * 60_000

/**
 * The public `reason` for a failure to even START the child — before spawn
 * (a `pickPort`/`substitutePort`/`mkdir` throw) or at spawn itself (a
 * `child.once("error", …)`, e.g. ENOENT).
 *
 * Both call sites used to build `reason` from the raw Node error's own
 * message, and that message routinely carries the checkout's absolute path
 * and the deployment id — exactly the kind of detail the crashed panel and
 * the 503 body must not leak, since both reach every reader including a
 * public-link one with no sign-in (codex round 7, Fix 4). The raw error is
 * logged with `console.error` at each site instead — the manager's own
 * server log, never the reader-visible one.
 */
const SETUP_FAILED_REASON = "The server could not be started. See the viewer's log."

/**
 * The public `reason` for a checkout that is not on disk, or a deployment id
 * that cannot name one. Fixed and generic on purpose: `checkoutDirFor`'s own
 * message echoes the id, which is not safe to hand back as a crash reason.
 */
const MISSING_CHECKOUT_REASON = "The checkout for this deployment is missing. Rebuild it."

/**
 * The public message for a failure to reserve a slot at the concurrency cap
 * because every running entry is actively answering a request.
 *
 * Reader-visible (it reaches the proxy's 503 body via `PrototypeProcessError`,
 * same as `SETUP_FAILED_REASON`), so it is a plain sentence with nothing
 * deployment-specific in it — there is nothing deployment-specific TO leak
 * here, since this is never that deployment's own fault. A reload retries the
 * `ensure` and nothing else is needed on the client (codex round 8, Fix 2).
 */
const BUSY_MESSAGE = "Every prototype server is busy. Try again in a moment."

/** The refusal when a start ends with no more specific reason on record. */
const DID_NOT_START_REASON = "The server did not start."

export interface PrototypeProcessesDeps {
  checkoutsRoot: string
  now?: () => number
  readyTimeoutMs?: number
  idleMs?: number
  reapIntervalMs?: number
  maxRunning?: number
  pickPort?: () => Promise<number>
  /**
   * Extra env merged into every spawned child, BEFORE `NODE_ENV`/`PORT`/
   * `HOSTNAME`/`HOST` so it can never override them.
   *
   * This exists only so tests can drive the fixture child's own knobs
   * (`FAKE_DELAY_MS`, `FAKE_EXIT_CODE`) without a second env channel riding
   * inside the recorded argv, which a real deployment's `serverStart` never
   * carries. Never wire this to anything request- or user-derived.
   */
  spawnEnv?: Record<string, string>
}

/** Binds an ephemeral loopback port and releases it, so the child can take it. */
export async function pickLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const s = createServer()
    s.once("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const address = s.address()
      const port = typeof address === "object" && address ? address.port : 0
      s.close(() => (port ? resolve(port) : reject(new Error("no port"))))
    })
  })
}

/**
 * Substitutes `$PORT` in each argv entry. The first entry is the executable.
 *
 * A bare `"node"` first entry (codex round 4, Fix 3 — a standalone Next
 * build's recorded `start`, see `frameworks/next.ts`) is resolved to
 * `process.execPath`, THIS manager's own currently-running Node binary,
 * rather than left for a PATH lookup at spawn time. The checkout has no
 * `node` of its own to invoke, and the adapter deliberately records the bare
 * string rather than an absolute path baked in at build time: resolving it
 * HERE, fresh on every spawn, means a Viewer image upgrade (Node moving to a
 * new absolute path in a later version) is picked up for every existing
 * deployment automatically, instead of every deployment's `serverStart` row
 * going stale until it happens to be rebuilt. Checked with `===`, not
 * `startsWith`, so `node_modules/.bin/next` (the generic `next start` case's
 * own first entry) is never mistaken for it.
 */
export function substitutePort(argv: string[], port: number): { file: string; args: string[] } {
  const substituted = argv.map((a) => a.replaceAll("$PORT", String(port)))
  const [file, ...args] = substituted
  if (!file) throw new Error("serverStart is empty")
  return { file: file === "node" ? process.execPath : file, args }
}

/**
 * Everything the runtime holds for one deployment that the pure record does
 * not: the child handle, the log ring buffer, and the in-flight cold start.
 */
interface Entry {
  record: ProcessRecord
  child: ChildProcess | null
  log: string
  /**
   * The cold start currently under way, or `null`.
   *
   * Two jobs. A second `ensure` for the same id joins it instead of starting
   * a second child, and a concurrent cold start on ANOTHER id waits on it
   * when the cap leaves nothing to evict (see the room-making loop). Set in
   * the same lock hold as the `start-requested` transition, so a record that
   * is `starting` always has one.
   */
  opening: Promise<{ port: number }> | null
  /**
   * Whether this record's cold start has passed `makeRoom` — it holds a slot
   * against `maxRunning` and is on its way to `running`.
   *
   * True only while the record is `starting`: `applySync` clears it the
   * moment the record leaves that state, whichever way it left (ready,
   * crashed, stopped, retired). A start that is still INSIDE `makeRoom`
   * occupies nothing, which is the whole of codex round 14, Fix 2 — see the
   * room-making loop.
   */
  admitted: boolean
}

export function createPrototypeProcesses(deps: PrototypeProcessesDeps): PrototypeProcesses {
  const now = deps.now ?? (() => Date.now())
  const readyTimeoutMs = deps.readyTimeoutMs ?? 60_000
  const idleMs = deps.idleMs ?? 30 * 60_000
  const reapIntervalMs = deps.reapIntervalMs ?? 5 * 60_000
  const maxRunning = deps.maxRunning ?? MAX_RUNNING_SERVER_PROTOTYPES
  const pickPort = deps.pickPort ?? pickLoopbackPort
  const limits: Limits = { restartBudget: RESTART_BUDGET_ATTEMPTS, restartWindowMs: RESTART_WINDOW_MS }
  const entries = new Map<string, Entry>()
  /**
   * Kept OUTSIDE the entry, so a `forget` (which drops the record) does not
   * silently drop the SSE stream watching that deployment with it.
   */
  const listeners = new Map<string, Set<(status: ProcessStatus) => void>>()
  /**
   * One lock per deployment id. Every mutating operation on a record runs
   * under it, so the await gaps that codex rounds 1, 3, 4, 5 and 11 found
   * cannot interleave: a child ignoring SIGTERM holds its own id's lock for
   * up to five seconds and other operations on THAT id wait, which is
   * correct. Different ids never wait on each other.
   *
   * The lock is not reentrant (see `keyed-lock.ts`), so no `run` call for an
   * id ever nests inside another one for the same id. The two places that
   * reach across ids — eviction taking the victim's lock, and the leader-wait
   * awaiting another id's cold start — are safe because a `starting` record
   * is never an eviction victim and never holds its own lock while waiting.
   */
  const lock = createKeyedLock()
  /**
   * Set by `shutdown()` before it kills anything, and never cleared.
   *
   * `index.ts` awaits `shutdown()` BEFORE the listeners and the main server
   * close, so a request can still land in that window. Without this it would
   * call `ensure`, spawn a DETACHED child, and the process would then exit
   * leaving that child holding a port with nobody to stop it.
   */
  let closed = false

  /**
   * The clock the machine sees: `now()`, but never twice the same value.
   *
   * `lastUsedAt` is what `chooseVictim` orders eviction by, and under the
   * real clock `now()` has 1ms resolution: two records touched inside one
   * millisecond tie, and the tie breaks on Map insertion order instead of
   * use, evicting whichever was CREATED first. (MEASURED: this happened in
   * the LRU test on this machine, which is why the record this replaced
   * carried a separate `recency` counter.) Nudging the value forward by 1ms
   * when the clock has not moved keeps the order exact. The drift it can
   * introduce is one millisecond per applied event under a FROZEN clock,
   * against a five-minute budget window and a thirty-minute idle bound.
   *
   * Reads (`retryable`, the reaper's `now`) use `now()` directly: they must
   * not move a clock they only inspect.
   */
  let lastStamp = 0
  const tick = (): number => {
    const t = now()
    lastStamp = t > lastStamp ? t : lastStamp + 1
    return lastStamp
  }

  const entryFor = (id: string): Entry => {
    let e = entries.get(id)
    if (!e) {
      e = { record: newRecord(tick()), child: null, log: "", opening: null, admitted: false }
      entries.set(id, e)
    }
    return e
  }
  const append = (e: Entry, text: string): void => {
    e.log = (e.log + text).slice(-LOG_CHARS)
  }
  const killTree = (child: ChildProcess, sig: NodeJS.Signals): void => {
    try {
      if (child.pid) process.kill(-child.pid, sig)
    } catch {
      /* already gone */
    }
  }

  /**
   * The record as callers see it: the machine's state, plus the computed
   * `retryable` on a crash.
   *
   * The single place `retryable` is decided, and it is decided at READ time
   * on purpose — see `ProcessStatus`. A `retired` record reports the same
   * shape a permanent crash does, because that is what it is to a reader:
   * this deployment will not start again until it is rebuilt.
   */
  const exposedStatus = (record: ProcessRecord): ProcessStatus => {
    switch (record.state.kind) {
      case "idle":
        return { state: "stopped" }
      case "starting":
        return { state: "starting", generation: record.state.generation }
      case "running":
        return {
          state: "running",
          port: record.state.port,
          since: new Date(record.state.since).toISOString(),
          generation: record.state.generation,
        }
      case "crashed": {
        const canRetry = retryable(record, now(), limits)
        return {
          state: "crashed",
          exitCode: record.state.exitCode,
          restarts: record.attempts.length,
          // While the budget is spent the reader is told the server kept
          // exiting, which names the log as the way out; once the window
          // passes and a retry is worth it, the last crash's own reason
          // returns. A permanent failure always keeps its own reason.
          reason: !record.state.permanent && !canRetry ? BUDGET_REFUSAL : record.state.reason,
          retryable: canRetry,
          generation: record.generation,
        }
      }
      case "retired":
        return {
          state: "crashed",
          exitCode: null,
          restarts: record.attempts.length,
          reason: RETIRED_REFUSAL,
          retryable: false,
          generation: record.generation,
        }
    }
  }
  const statusOf = (id: string): ProcessStatus => {
    const e = entries.get(id)
    return e ? exposedStatus(e.record) : { state: "stopped" }
  }
  /**
   * Compared by value, not by identity: `exposedStatus` builds a fresh
   * object every call, and only a CHANGE is worth waking a subscriber for.
   * Every status is a flat object of primitives built in one place above, so
   * the key order is stable and this is a faithful equality.
   */
  const sameStatus = (a: ProcessStatus, b: ProcessStatus): boolean => JSON.stringify(a) === JSON.stringify(b)
  const notify = (id: string, status: ProcessStatus): void => {
    for (const listener of listeners.get(id) ?? []) {
      try {
        listener(status)
      } catch (error) {
        // A subscriber that throws is its own bug, and must not leave a
        // transition half-applied (an unawaited kill, a lock held).
        console.error("[viewer] prototype process subscriber failed:", error)
      }
    }
  }

  /**
   * Applies one event: run the pure machine, store the record, perform the
   * synchronous half of each effect, and notify subscribers when the exposed
   * status changed.
   *
   * The `kill` effect's own wait (SIGTERM, then SIGKILL after five seconds)
   * is returned rather than performed, so the only async step is the
   * caller's. `apply` is that caller, and it hands the child to
   * `killAndWaitTracked`, which is what keeps the slot counted until the
   * process is actually gone. The `spawn` effect is NOT performed here: starting a child
   * needs the checkout, the cap, a port and a home directory, all of which
   * are async and belong outside a synchronous transition. `ensure` reads
   * the effect and does the work; see `startChild`.
   */
  const applySync = (id: string, event: ProcessEvent): { result: TransitionResult; killing: ChildProcess | null } => {
    const entry = entryFor(id)
    const before = exposedStatus(entry.record)
    const result = transition(entry.record, event, tick(), limits)
    entry.record = result.record
    // An admission lasts exactly as long as the `starting` state it was
    // granted for. Cleared here, in the one place every transition passes
    // through, rather than at each of the half dozen sites a start can end
    // at — a stale `admitted` would count a record against the cap that is
    // no longer coming up, or (worse) count the NEXT start before it has
    // passed `makeRoom`.
    if (entry.record.state.kind !== "starting") entry.admitted = false
    let killing: ChildProcess | null = null
    for (const effect of result.effects) {
      switch (effect.kind) {
        case "kill":
          killing = entry.child
          entry.child = null
          break
        case "drop":
          entries.delete(id)
          break
        case "spawn":
          break
      }
    }
    const after = statusOf(id)
    if (!sameStatus(before, after)) notify(id, after)
    return { result, killing }
  }

  /**
   * Stops a child: SIGTERM to the whole group, SIGKILL five seconds later if
   * it is still there — and SIGKILL to the group as soon as the leader is
   * gone, whether it went on its own or on the SIGTERM.
   *
   * That last kill is the point (codex round 14, Fix 1). What this manager
   * spawns is a process GROUP, not a process: the child is `detached`, so it
   * is the group leader, and anything it spawns for itself — a Next server
   * with `experimental.cpus`, a Nitro worker, a sidecar the app starts —
   * joins that group. A worker that ignores SIGTERM used to survive its own
   * leader: the SIGKILL timer was cleared the moment the LEADER exited, so
   * nothing ever reached the rest of the group, and that worker went on
   * holding its port past retire, past project delete, past viewer shutdown.
   *
   * `killTree` swallows ESRCH, so a group that is already empty costs
   * nothing. The already-exited case at the top gets the same kill for the
   * same reason: the leader being gone says nothing about what it left
   * behind.
   */
  const killAndWait = async (child: ChildProcess): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      killTree(child, "SIGKILL")
      return
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        killTree(child, "SIGKILL")
      }, 5000)
      child.once("exit", () => {
        clearTimeout(timer)
        killTree(child, "SIGKILL")
        resolve()
      })
      killTree(child, "SIGTERM")
    })
  }

  /**
   * One entry per child that has left its record but not yet the machine: the
   * `kill` effect has run, so nothing points at the process any more, and it
   * is still alive until its `killAndWait` resolves.
   *
   * Counted against the cap, and waited on by the room-making loop (codex
   * round 20, item 5). Eviction marks the victim idle in the same synchronous
   * step the kill starts in, so before this set existed a cold start racing
   * that window saw a free slot and spawned while the victim was still
   * listening on its own port — `maxRunning + 1` servers at once, for the
   * whole SIGTERM grace.
   *
   * A set of promises rather than a plain number because the loop needs
   * something to WAIT on: a dying child occupies a slot that nothing else can
   * free and that `chooseVictim` will never name, so counting it without
   * being able to wait for it would turn an ordinary eviction into a busy
   * refusal. Every entry settles (`killAndWait` SIGKILLs after five seconds
   * and resolves on the child's exit), so a waiter always makes progress.
   */
  const dying = new Set<Promise<void>>()

  /**
   * `killAndWait`, holding a slot against the cap until the child is gone.
   *
   * The entry is added in the same synchronous step the kill starts in — this
   * function is called with no await between it and `applySync`'s `kill`
   * effect — and removed before the promise waiters see settles.
   */
  const killAndWaitTracked = async (child: ChildProcess): Promise<void> => {
    let release: () => void = () => {}
    const slot = new Promise<void>((resolve) => {
      release = resolve
    })
    dying.add(slot)
    try {
      await killAndWait(child)
    } finally {
      dying.delete(slot)
      release()
    }
  }

  /**
   * `applySync`, plus the kill effect's wait and the refusal.
   *
   * MUST be called inside `lock.run(id, …)` — the two lease events are the
   * only exception, and `withLease` says why. A refusal becomes the existing
   * `PrototypeProcessError` carrying the machine's own sentence, so the
   * runtime never writes a second copy of one.
   */
  const apply = async (id: string, event: ProcessEvent): Promise<TransitionResult> => {
    const { result, killing } = applySync(id, event)
    if (killing) await killAndWaitTracked(killing)
    if (result.refused) throw new PrototypeProcessError(statusOf(id), result.refused)
    return result
  }

  /**
   * `apply`, for the events whose refusal IS the answer: a `reap` or an
   * `evict` the machine turned down (the record is leased, or it moved on)
   * means there was nothing to do, not that something failed.
   */
  const applyAllowingRefusal = async (id: string, event: ProcessEvent): Promise<void> => {
    try {
      await apply(id, event)
    } catch (error) {
      if (!(error instanceof PrototypeProcessError)) throw error
    }
  }

  /**
   * Every cold start that has been ADMITTED and is still coming up: it holds
   * a slot against `maxRunning`, and it is going somewhere (it will end as
   * `running` or as a crash), so it is safe to wait on.
   *
   * `opening !== null` is part of the predicate rather than an assumption
   * about it, so the count and the wait target below are decided by exactly
   * the same test. That is what makes "not admittable ⇒ there is something to
   * wait on" true by construction rather than by a second argument.
   */
  const admittedStarts = (): [string, Entry][] =>
    [...entries].filter(([, e]) => e.record.state.kind === "starting" && e.admitted && e.opening !== null)
  const runningCount = (): number => [...entries.values()].filter((e) => e.record.state.kind === "running").length
  const recordsById = (): Map<string, ProcessRecord> =>
    new Map([...entries].map(([id, e]) => [id, e.record] as const))

  /** The refusal `ensure` gives once `shutdown()` has run. */
  const closedError = (): PrototypeProcessError =>
    new PrototypeProcessError({ state: "stopped" }, "The viewer is shutting down.")

  /**
   * A cold start whose record was dropped under it: `forget` ran while the
   * child was coming up, so there is nothing left that owns this child.
   *
   * Kills it and hands back the refusal to reject `ensure` with. Deliberately
   * does NOT apply an event: every event goes through `entryFor`, which would
   * CREATE a record for a deployment the manager has just been told to forget
   * — a record nothing would ever drop. The sentence is the retired one,
   * which is what a reader in this position needs: this deployment is gone,
   * rebuild it.
   */
  const abandonedStart = (child: ChildProcess): PrototypeProcessError => {
    killTree(child, "SIGKILL")
    child.kill("SIGKILL")
    return new PrototypeProcessError({ state: "stopped" }, RETIRED_REFUSAL)
  }

  /**
   * Ready means LISTENING: a TCP connection to the port is accepted. The
   * probe used to be an HTTP GET of `/` with one second to answer, and a
   * healthy app whose root page took longer than that to render (a slow
   * loader, a cold data fetch) had every probe destroyed before it could
   * reply, until the outer deadline killed it (codex round 22). Whether the
   * app then answers requests is the proxy's business: a child that accepts
   * connections but never answers gets the proxy's timeout and 502, not a
   * spurious "did not start".
   */
  async function answers(port: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const socket = netConnect({ host: "127.0.0.1", port })
      const done = (ok: boolean): void => {
        socket.destroy()
        resolve(ok)
      }
      socket.setTimeout(1000, () => done(false))
      socket.once("connect", () => done(true))
      socket.once("error", () => done(false))
    })
  }

  /**
   * Reserves a slot for a record that has already transitioned to `starting`,
   * and marks it ADMITTED once it has one.
   *
   * The rule is `running + admittedStarting + dying < maxRunning`. This
   * record is not in any of the three counts — it is `starting` and not yet
   * admitted — so the strict `<` is what leaves the last slot for it.
   *
   * Admission is the whole of codex round 14, Fix 2. The count used to be
   * every `starting` record, admitted or not: fire more concurrent cold
   * starts than the cap and every one of them saw the cap exceeded, one
   * leader went through, and the rest found nothing evictable and gave the
   * reader the busy refusal with most of the slots still free.
   *
   * When there is no room, in order: evict the least recently used `running`
   * record with no open lease (`chooseVictim`, which never returns a leased
   * or a `starting` one) and re-check; else wait for an admitted start to
   * finish and re-check; else wait for a child that is already being killed
   * to actually go and re-check; else refuse as busy, releasing the slot this
   * attempt reserved.
   *
   * **Why this cannot deadlock.** A waiter only ever waits on something that
   * is making progress on its own. An admitted start never waits: it has
   * already left this loop, and every path out of `starting` is one it
   * reaches by itself (it becomes `running`, it crashes, it times out,
   * something stops it). A dying child never waits either: its
   * `killAndWait` SIGKILLs after five seconds and resolves on the exit. So
   * the wait graph has no cycles, and no waiter can be pointing at another
   * waiter. The "nothing to wait on" case is not a special case either: if
   * `running + admittedStarting + dying >= maxRunning` while
   * `running < maxRunning`, then one of the other two counts is above zero
   * and there IS something to wait on; and if `running >= maxRunning` with
   * nothing evictable, every slot is held by a record answering a request,
   * which is the busy refusal.
   *
   * A `running` record with an open lease (a response still being streamed)
   * is never a victim (codex round 8, Fix 2) — that rule is `chooseVictim`'s,
   * which skips any record with `leases > 0`.
   */
  /**
   * `stillOurs` says whether the record this start was granted on is still
   * the one in the map. The waits below can outlive a `forget`, and the busy
   * refusal must not then apply by id: `entryFor` would recreate a record
   * for a forgotten deployment, or stop a fresh start that already took
   * the id (codex round 19).
   */
  async function makeRoom(id: string, stillOurs: () => boolean): Promise<void> {
    while (runningCount() + admittedStarts().length + dying.size >= maxRunning) {
      const victimId = chooseVictim(recordsById())
      if (victimId !== null) {
        await lock.run(victimId, () => applyAllowingRefusal(victimId, { type: "evict" }))
        continue
      }
      // `id` is excluded defensively only: a record cannot be admitted while
      // it is inside its own `makeRoom` — `admitted` is cleared whenever the
      // record leaves `starting`, and `start-requested` is what put it there.
      const waitFor = admittedStarts().find(([otherId]) => otherId !== id)?.[1].opening
      if (waitFor) {
        await waitFor.catch(() => {})
        continue
      }
      // A slot held by a child that is on its way out: nothing else will
      // free it, and `chooseVictim` cannot name it (its record is already
      // idle), so this waits for the process itself rather than refusing a
      // reader over a server that is seconds from gone.
      if (dying.size > 0) {
        await Promise.race([...dying])
        continue
      }
      // Every slot is held by a running record that is actively answering a
      // request, and nothing here will free one on its own. Waiting would
      // block indefinitely on a response that may not end soon, so this
      // attempt fails fast instead, releasing the slot it reserved.
      await lock.run(id, () => {
        if (!stillOurs()) throw new PrototypeProcessError({ state: "stopped" }, RETIRED_REFUSAL)
        return apply(id, { type: "stop-requested" })
      })
      throw new PrototypeProcessError(statusOf(id), BUSY_MESSAGE, 5)
    }
    // In the same synchronous step as the check above, so two waiters cannot
    // both read "there is room" and both take the last slot.
    const entry = entries.get(id)
    if (entry && entry.record.state.kind === "starting") entry.admitted = true
  }

  /**
   * The whole cold start for a record the machine has already moved to
   * `starting` at `generation`.
   *
   * Runs OUTSIDE this id's lock, and takes it for each transition. That is
   * deliberate: a cold start can take a minute, and `stop`, `retire` and
   * `forget` must land promptly rather than queue behind it. What keeps the
   * start honest across those gaps is the generation the machine stamped on
   * `starting`: `spawned` and `ready` carry it, and either is refused once
   * something else has moved the record on.
   */
  async function startChild(id: string, serverStart: string[], generation: number): Promise<{ port: number }> {
    // The record this start was granted on. `forget` (a prune, a project
    // delete) can drop it while the awaits below are pending, and every
    // apply after an await goes through `entryFor`, which would CREATE a
    // fresh record for a deployment the manager was just told to forget:
    // a phantom nothing ever drops (codex round 17). So each post-await
    // apply first checks the record is still this one.
    const startEntry = entries.get(id)
    const stillOurs = (): boolean => startEntry !== undefined && entries.get(id) === startEntry
    const abandonedBeforeSpawn = (): PrototypeProcessError =>
      new PrototypeProcessError({ state: "stopped" }, RETIRED_REFUSAL)
    let cwd: string
    try {
      // Inside the try: a malformed id makes `checkoutDirFor` throw
      // synchronously, and that must land here too, not escape as an
      // uncaught rejection.
      cwd = checkoutDirFor(deps.checkoutsRoot, id)
      if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory")
    } catch {
      // Permanent: no number of restarts puts the files back, and no amount
      // of waiting does. Only a rebuild does, which is what the review page
      // then offers.
      await lock.run(id, () => {
        if (!stillOurs()) throw abandonedBeforeSpawn()
        return apply(id, { type: "start-failed", reason: MISSING_CHECKOUT_REASON, permanent: true })
      })
      throw new PrototypeProcessError(statusOf(id), MISSING_CHECKOUT_REASON)
    }

    await makeRoom(id, stillOurs)

    // Setup between the room-making above and the actual `spawn` below,
    // wrapped so a throw here cannot leave the record stuck `starting`
    // forever: `pickPort` can reject (ports exhausted), `substitutePort`
    // throws synchronously on an empty `serverStart`, and `mkdir` can reject
    // (permissions, disk full). Before this wrap, any of those rejected
    // `ensure` while leaving the record `starting`, permanently occupying a
    // slot against `maxRunning` — enough of them and the room-making loop
    // waits forever on records that will never resolve (codex round 3,
    // item 3).
    let port: number
    let file: string
    let args: string[]
    let home: string
    try {
      port = await pickPort()
      ;({ file, args } = substitutePort(serverStart, port))
      // Inside the checkout, not beside it: `pruneSupersededCheckouts`
      // deletes `checkoutDirFor(...)` wholesale, so a home dir living inside
      // it is pruned along with the checkout instead of leaking forever.
      home = join(cwd, ".desde-home")
      await mkdir(home, { recursive: true })
    } catch (error) {
      // Retryable: nothing here says the NEXT attempt would fail the same
      // way (a port that is free a moment later, a transient mkdir error).
      // The raw error goes to the manager's own log ONLY — never into
      // `reason`, which a reader (including a public-link one) can see
      // through the crashed panel and the 503 body. See `SETUP_FAILED_REASON`.
      // Charged to the restart budget like any other failed attempt (codex
      // round 9): uncharged, a failure that repeats on every attempt stayed
      // retryable for ever, and the review page remounted the frame every
      // five seconds without end. The machine charges it, because the
      // `permanent` flag below is false.
      console.error("[viewer] prototype process setup failed:", error)
      await lock.run(id, () => {
        if (!stillOurs()) throw abandonedBeforeSpawn()
        return apply(id, { type: "start-failed", reason: SETUP_FAILED_REASON, permanent: false })
      })
      throw new PrototypeProcessError(statusOf(id), SETUP_FAILED_REASON)
    }

    // The spawn itself, under the lock, with the `spawned` acknowledgement
    // applied first. Everything above has awaited at least once, so a stop, a
    // retire or a shutdown can have landed in between — and a spawn after any
    // of those is a child nobody will ever stop, because the manager has
    // already forgotten it is coming. The machine refuses `spawned` at a
    // stale generation, so that refusal IS the check, and it happens before
    // the child exists rather than after: there is nothing to kill, and the
    // log stays empty, which is how a test can tell "never spawned" from
    // "spawned and cleaned up". Nothing between that refusal point and the
    // handlers being wired is async, so no stop can land inside this block.
    const { entry, child } = await lock.run(id, async () => {
      if (!stillOurs()) throw abandonedBeforeSpawn()
      await apply(id, { type: "spawned", generation })
      if (closed) throw closedError()
      const entry = entryFor(id)
      entry.log = ""
      const spawned = spawn(file, args, {
        cwd,
        env: buildEnv(home, {
          // `spawnEnv` first, so it can never shadow the four below — see its
          // doc comment on `PrototypeProcessesDeps`.
          ...deps.spawnEnv,
          NODE_ENV: "production",
          PORT: String(port),
          HOSTNAME: "127.0.0.1",
          // Nitro/Nuxt and react-router-serve read HOST where Next reads the
          // `-H` flag; setting both is a hint, not enforcement — a server that
          // ignores its env and binds elsewhere is a substrate bug, not one
          // this manager can fix.
          HOST: "127.0.0.1",
        }) as NodeJS.ProcessEnv,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
      entry.child = spawned
      spawned.stdout?.on("data", (b: Buffer) => append(entry, b.toString("utf8")))
      spawned.stderr?.on("data", (b: Buffer) => append(entry, b.toString("utf8")))
      return { entry, child: spawned }
    })

    let exited = false
    // The identity guard runs INSIDE the lock, not at handler time: `child`
    // is only ever assigned or cleared under this id's lock, so a handler
    // that read it before queueing could act on a record a newer start had
    // already taken over.
    //
    // Codex round 15, Fix 1. This is the NATURAL-exit path: the leader
    // crashed, or just stopped, on its own — nobody here sent it a signal.
    // Round 14 (see `killAndWait`'s doc comment) only closed this gap for
    // the path where OUR OWN kill sends SIGTERM/SIGKILL to the whole group.
    // A leader that exits by itself was only ever recorded as crashed, with
    // the handle dropped and nothing sent to the group it leads — so a
    // worker that leader forked for itself (a Next server with
    // `experimental.cpus`, a Nitro worker, anything the app spawns) lived on
    // in the detached group, holding its port past the restart budget, past
    // a later `ensure`, and past shutdown. `killTree` swallows ESRCH, so a
    // group that already has nothing left in it costs nothing.
    child.once("exit", (code) => {
      exited = true
      killTree(child, "SIGKILL")
      void lock.run(id, async () => {
        if (entries.get(id) !== entry || entry.child !== child) return
        entry.child = null
        await applyAllowingRefusal(id, { type: "exited", code })
      })
    })
    child.once("error", (error) => {
      // Node emits `error` (never `exit`) for a spawn-time failure like
      // ENOENT — without setting `exited` here the poll loop would run all
      // the way to `readyTimeoutMs` reporting a misleading "did not answer".
      exited = true
      // The child's own ring buffer (`serverLog`) keeps the raw message —
      // that route is already reader-visible by design ("See the server
      // log" is what several other crash reasons point readers to) and
      // carries no MORE than a spawn failure's own text. `reason` is the
      // separate, narrower surface this fix closes: see `SETUP_FAILED_REASON`.
      append(entry, `\n${error.message}\n`)
      console.error("[viewer] prototype process setup failed:", error)
      void lock.run(id, async () => {
        if (entries.get(id) !== entry || entry.child !== child) return
        // Node emits `error` on a ChildProcess for more than a failed spawn:
        // a `kill()` that fails (an EPERM, say) raises one on a child that is
        // up and answering. `start-failed` is a no-op once the record is
        // `running`, so clearing the handle there dropped the manager's only
        // way to stop that child while leaving the record claiming it was
        // running. The ring buffer above has the message either way; only a
        // start that has not finished acts on it.
        if (entry.record.state.kind !== "starting") return
        entry.child = null
        await applyAllowingRefusal(id, { type: "start-failed", reason: SETUP_FAILED_REASON, permanent: false })
      })
    })

    const deadline = now() + readyTimeoutMs
    // `entry.child === child` is re-checked every iteration so a stop (or an
    // eviction) landing mid-poll ends this loop promptly instead of running
    // to the timeout against a child that is already gone.
    while (!exited && entry.child === child && now() < deadline) {
      if (await answers(port)) {
        const ready = await lock.run(id, async () => {
          // The record this start belongs to is gone (a `forget` while the
          // child was coming up). Applying anything here would CREATE a
          // record for a deployment the manager has deliberately forgotten,
          // so the child is killed and the start rejected without one.
          if (entries.get(id) !== entry) throw abandonedStart(child)
          try {
            await apply(id, { type: "ready", port, generation })
            return true
          } catch (error) {
            // Refused: a stop, a retire or a newer start landed while the
            // request above was in flight, so this child belongs to nobody.
            // Kill it rather than leave it holding a port, then let the
            // refusal reject this `ensure`.
            killTree(child, "SIGKILL")
            child.kill("SIGKILL")
            throw error
          }
        })
        if (ready) return { port }
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    // One more lock hold, for two reasons. It decides the timeout case, and
    // it is where an `exited`/`error` handler's own queued transition has
    // certainly landed: those queue on this lock before `exited` is read
    // here, and the lock is FIFO, so the status this reports is the settled
    // one rather than a race with it.
    return await lock.run(id, async () => {
      // Same rule as the ready branch above: no record, no event, no
      // phantom. The kill covers the case this loop left a child behind.
      if (entries.get(id) !== entry) throw abandonedStart(child)
      if (!exited && entry.child === child) {
        // Timed out on our own clock, not stopped or exited elsewhere.
        await applyAllowingRefusal(id, { type: "timed-out" })
      }
      const status = statusOf(id)
      throw new PrototypeProcessError(
        status,
        status.state === "crashed" ? status.reason : DID_NOT_START_REASON,
      )
    })
  }

  return {
    async ensure(deployment) {
      // Before anything else, including the record lookup: after `shutdown()`
      // there is nothing this manager can honestly promise, and a spawn here
      // outlives the process (children are detached).
      if (closed) throw closedError()
      const serverStart = deployment.serverStart
      if (!serverStart) {
        throw new PrototypeProcessError({ state: "stopped" }, "This deployment is served as files, not as a server.")
      }
      const id = deployment.id
      // Under the lock: reuse, join, or start. Only the DECISION is taken
      // here; the cold start itself runs outside (see `startChild`). The
      // decision is returned as a promise WRAPPED IN AN OBJECT rather than
      // returned directly, because an async function awaits a promise it
      // returns — which would hold this id's lock for the whole cold start
      // and leave `stop`, `retire` and `forget` queued behind it.
      const decision = await lock.run(
        id,
        async (): Promise<{ port: number } | { opening: Promise<{ port: number }> }> => {
          const entry = entryFor(id)
          const state = entry.record.state
          if (state.kind === "running") {
            // A touch, not an event: the machine has no transition for "still
            // in use", and this is the same bump `touch()` makes.
            entry.record = { ...entry.record, lastUsedAt: tick() }
            return { port: state.port }
          }
          if (entry.opening) return { opening: entry.opening }
          // Refused when the record is retired, permanently failed, or over
          // the restart budget. The sentence is the machine's.
          await apply(id, { type: "start-requested" })
          const generation = entry.record.generation
          // Assigned in this same lock hold, so a record that is `starting` is
          // never seen without its `opening` — the room-making loop's leader
          // wait depends on that.
          const started = startChild(id, serverStart, generation).finally(() => {
            entry.opening = null
          })
          entry.opening = started
          return { opening: started }
        },
      )
      return "port" in decision ? { port: decision.port } : await decision.opening
    },
    touch(id) {
      // A field, not an event: "still in use" is not a state change, and the
      // status a subscriber sees does not move.
      const e = entries.get(id)
      if (e) e.record = { ...e.record, lastUsedAt: tick() }
    },
    withLease(id, fn) {
      // Applied HERE, synchronously, before this function's first await, and
      // released in the `finally` below. Both are the only transitions taken
      // OUTSIDE the lock, on purpose: a request must not wait on a five
      // second SIGTERM to record that it is in flight, and the lease it takes
      // would be pointless if it landed after the eviction it exists to
      // prevent. They are safe there because they touch nothing but the
      // counter and `lastUsedAt`, and the machine refuses `reap` and `evict`
      // on a positive counter whatever the interleaving.
      //
      // The acquire CREATES the record when there is none, which is the
      // point: the cold start `fn` is about to ask for must find the lease
      // already on the record it creates, or the round 11 window is still
      // open.
      //
      // The release applies to THAT record and no other. Checking only that
      // some record exists under this id was not enough: a `forget` during
      // the lease drops the record, the next request creates a fresh one and
      // starts a new child under its own lease, and this release would then
      // decrement that stranger's counter to zero while its request was
      // still being answered — leaving it evictable mid-response, which is
      // the exact thing a lease exists to prevent.
      applySync(id, { type: "lease-acquired" })
      const leased = entries.get(id) ?? null
      return (async () => {
        try {
          return await fn()
        } finally {
          if (leased !== null && entries.get(id) === leased) applySync(id, { type: "lease-released" })
        }
      })()
    },
    async stop(id) {
      // The guard is INSIDE the lock, unlike `markUnreachable`'s and
      // `forget`'s. A `stop` racing a cold start must still land: `ensure`
      // creates the record in its own lock hold, so an id with a start
      // already queued has no entry yet at this line, and checking out here
      // would turn that stop into a no-op and leave the child running. Under
      // the lock the only ids with no record are the ones nothing has ever
      // asked for — and applying an event to those would CREATE an idle
      // record that nothing ever drops.
      await lock.run(id, async () => {
        if (!entries.has(id)) return
        await applyAllowingRefusal(id, { type: "stop-requested" })
      })
    },
    async markUnreachable(id) {
      // Inside the lock, like `stop`'s guard: a `forget` already queued
      // ahead of this call drops the record, and an apply after it would
      // recreate one through `entryFor` that nothing ever drops again
      // (codex round 21).
      await lock.run(id, () => {
        if (!entries.has(id)) return Promise.resolve()
        return applyAllowingRefusal(id, { type: "unreachable" })
      })
    },
    async forget(id) {
      if (!entries.has(id)) return
      // The machine orders the effects `kill` then `drop`, so the child is
      // down before the record goes: dropping first would let a concurrent
      // `ensure` create a fresh record and spawn into a checkout that is
      // about to be deleted.
      await lock.run(id, () => applyAllowingRefusal(id, { type: "forget" }))
    },
    async retire(id) {
      // The refusal is recorded even for a deployment that was never
      // `ensure`d: a later `ensure` for this same id must never fall through
      // to a start and find an inviting empty slot.
      //
      // It lands promptly, too. `lock.run` queues this transition
      // SYNCHRONOUSLY, before any caller can queue one of its own, so a
      // request landing on a still-open pinned listener in the seconds this
      // takes to stop a SIGTERM-ignoring child is refused rather than raced
      // (codex round 3, item 1).
      await lock.run(id, () => applyAllowingRefusal(id, { type: "retire" }))
    },
    status(id) {
      return statusOf(id)
    },
    serverLog(id) {
      return entries.get(id)?.log ?? ""
    },
    subscribe(id, listener) {
      let set = listeners.get(id)
      if (!set) {
        set = new Set()
        listeners.set(id, set)
      }
      set.add(listener)
      return () => {
        const current = listeners.get(id)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) listeners.delete(id)
      }
    },
    recordCount() {
      return entries.size
    },
    startReaper() {
      const timer = setInterval(() => {
        // The machine decides: a record that is not running, not idle long
        // enough, or holding a lease is refused or left alone. A request that
        // began before the idle bound passed and is still being answered (an
        // SSE stream, a large download) must not be cut out from under the
        // client — see `withLease`. `stop`/`retire`/`forget`/`shutdown` are
        // unaffected: they kill regardless, because they are explicit "this
        // deployment is going away" actions, not the passive idle sweep.
        for (const id of [...entries.keys()]) {
          // Same guard as `markUnreachable`: a `forget` queued ahead of this
          // sweep drops the record, and a reap applied after it would
          // recreate one (codex round 21).
          void lock.run(id, () => {
            if (!entries.has(id)) return Promise.resolve()
            return applyAllowingRefusal(id, { type: "reap", now: now(), idleMs })
          })
        }
      }, reapIntervalMs)
      timer.unref()
      return () => clearInterval(timer)
    },
    async shutdown() {
      // First thing, before any await: from here on `ensure` refuses, so a
      // request that lands while the children are being killed cannot start
      // a new one behind us.
      closed = true
      await Promise.all(
        [...entries.keys()].map((id) => lock.run(id, () => applyAllowingRefusal(id, { type: "stop-requested" }))),
      )
    },
  }
}
