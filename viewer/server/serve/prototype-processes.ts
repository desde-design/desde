import { spawn, type ChildProcess } from "node:child_process"
import { request as httpRequest } from "node:http"
import { createServer } from "node:net"
import { mkdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { buildEnv } from "../build/exec"
import { checkoutDirFor } from "../build/checkouts"
import type { Deployment } from "../storage/types"

/**
 * Runs a server prototype's own server as a child process, on demand.
 *
 * One process per deployment, started by the first request that needs it
 * and stopped when idle, at the cap, on prune, or at shutdown. The spawn
 * discipline is `build/exec.ts`'s: an env ALLOWLIST (the Viewer's secrets
 * never reach the child), `detached` so the whole tree dies together, and
 * a loopback bind only. See the server-prototypes spec, "Process manager".
 */
export type ProcessStatus =
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "running"; port: number; since: string }
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
    }

export class PrototypeProcessError extends Error {
  readonly name = "PrototypeProcessError"
  constructor(
    public readonly status: ProcessStatus,
    message: string,
  ) {
    super(message)
  }
}

export interface PrototypeProcesses {
  ensure(deployment: Pick<Deployment, "id" | "serverStart">): Promise<{ port: number }>
  touch(deploymentId: string): void
  /**
   * Marks a request as in-flight against this deployment's process, so the
   * idle reaper leaves it alone for as long as the request is open.
   *
   * Call it right before proxying to the process and call the returned
   * function when the response ends — `res.once("close", release)` in
   * `serve-router.ts`. Without this, `touch()` at request-start alone was not
   * enough: a long SSE stream or a large streamed download can outlive the
   * idle bound while it is still actively being answered, and the reaper
   * would cut it out from under the client (codex round 2, item 3).
   *
   * Safe to call for an entry that does not exist yet, or one that is not
   * currently running — it only affects whether a FUTURE reap tick skips
   * this id, so there is nothing to guard against calling it early or for an
   * id the manager has never seen.
   */
  beginRequest(deploymentId: string): () => void
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
   * crash (an ordinary entry in `restartsAt`, the same as an exit or a
   * timeout), so the next `ensure` restarts it under the normal budget.
   *
   * `stop()` was the wrong call for this (codex round 5, Fix 2): it leaves
   * the entry `stopped`, and the review page's embedded poll
   * (`shouldRefreshWhileEmbedded`) only reacts to `crashed` — a `stopped`
   * entry never told the reader anything was wrong, and the 502 page in the
   * frame makes no further request on its own, so the process was never
   * restarted without a manual reload. Recording `crashed` instead is what
   * gets the reader an iframe remount (`review-shell.tsx`'s `frameEpoch`).
   *
   * If the entry is already `crashed` (the exit handler beat the proxy to
   * it, or a previous `markUnreachable` already ran), this leaves the status
   * and its reason exactly as they are — the proxy's failure is not new
   * information once the manager already knows the child is down, and
   * overwriting a more specific reason with this generic one would be a
   * regression. If the entry is `starting` or `stopped`, this does nothing:
   * neither state claims the child is up, so there is nothing to correct.
   */
  markUnreachable(deploymentId: string): Promise<void>
  status(deploymentId: string): ProcessStatus
  serverLog(deploymentId: string): string
  startReaper(): () => void
  shutdown(): Promise<void>
}

export const MAX_RUNNING_SERVER_PROTOTYPES = 4
/** The log ring buffer is measured in characters (`string.slice`), not bytes. */
const LOG_CHARS = 64 * 1024
/** At most this many restarts (crashes followed by another attempt) inside `RESTART_WINDOW_MS`. */
const RESTART_BUDGET = 3
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
 * What an entry RECORDS: `ProcessStatus` with the crashed variant's
 * `retryable` left out, because that field is computed when the status is
 * read (see `exposedStatus`). Storing it was the defect: the budget is a
 * moving five-minute window, so a value written at crash time is stale from
 * the next tick onward.
 */
type StoredStatus =
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "running"; port: number; since: string }
  | { state: "crashed"; exitCode: number | null; restarts: number; reason: string }

/**
 * A `crashed` status's own reason, or `fallback` otherwise.
 *
 * Pulled out as a function (rather than an inline `status.state === "crashed"
 * ? status.reason : fallback` at the call site) because TypeScript narrows
 * `entry.status` to whatever literal it was last assigned along the
 * SYNCHRONOUS path it can see — it does not know an `async` callback (the
 * child's `exit`/`error` handlers) can reassign it during an `await`. Taking
 * `status: ProcessStatus` as a plain parameter resets that narrowing to the
 * full declared union on every call, which is what makes the check safe to
 * write at all right after an `await`.
 */
function reasonOrFallback(status: StoredStatus, fallback: string): string {
  return status.state === "crashed" ? status.reason : fallback
}

/**
 * A `crashed` status's own `exitCode`, or `null` otherwise.
 *
 * Same reason as `reasonOrFallback` above, and now needed for the same
 * cause: `start()` assigns `e.status = { state: "starting" }` synchronously
 * near its top (to reserve the entry's slot against the concurrency cap),
 * so by the time the restart-budget check reads `e.status.state ===
 * "crashed"` further down, TypeScript narrows the FIELD to the literal
 * `{ state: "starting" }` it last saw assigned along this function's own
 * synchronous path — it has no way to know the intervening `await` let a
 * concurrent `stop()`/`retire()` on this same entry reassign it. Taking
 * `status: StoredStatus` as a plain parameter resets that narrowing to the
 * full declared union, which is what makes the check safe to write at all.
 */
function crashedExitCodeOrNull(status: StoredStatus): number | null {
  return status.state === "crashed" ? status.exitCode : null
}

/**
 * Whether a status is `"stopped"`.
 *
 * Same reason as `reasonOrFallback`/`crashedExitCodeOrNull` above, and needed
 * by `markUnreachable`: it narrows `e.status.state` to `"running"` at an
 * early-return guard, then awaits `stopEntry(e)` — which reassigns
 * `e.status` during that await, something TypeScript cannot see happening
 * inside an opaque async call. Without this, the later `e.status.state !==
 * "stopped"` check is flagged as comparing two literals TypeScript still
 * believes can never overlap. Taking `status: StoredStatus` as a plain
 * parameter resets that narrowing to the full declared union.
 */
function isStopped(status: StoredStatus): boolean {
  return status.state === "stopped"
}

interface Entry {
  status: StoredStatus
  child: ChildProcess | null
  port: number | null
  lastUsedAt: number
  /**
   * A monotonic counter, bumped alongside `lastUsedAt` on every touch.
   *
   * `lastUsedAt` alone is `now()`, which under the real clock has 1ms
   * resolution: two entries touched within the same millisecond tie, and
   * `Array.prototype.sort`'s stability then falls back to Map insertion
   * order, evicting whichever entry was CREATED first rather than used
   * least recently. `recency` can never tie, so LRU eviction stays correct
   * even when `touch()` and a sibling's start race inside one millisecond
   * (MEASURED: this happened in the LRU test on this machine).
   */
  recency: number
  log: string
  restartsAt: number[]
  opening: Promise<{ port: number }> | null
  /**
   * Bumped by every `stopEntry`. A `start()` reads it before and after
   * `spawn` to notice a stop it could not otherwise see.
   *
   * `e.child` is the flag for a stop that lands while a child exists, but
   * between `pickPort()` and `spawn()` there IS no child: `stopEntry` finds
   * `e.child === null`, no-ops, and the spawn then proceeds into a process
   * nobody is holding a handle to. A counter records that a stop happened at
   * all, which is the part `e.child` cannot.
   */
  generation: number
  /**
   * The last crash was one no restart can clear: the checkout is missing, or
   * the deployment id is malformed.
   *
   * Kept on the ENTRY rather than in the status because `retryable` is
   * computed from the restart window at read time, and this is the one input
   * to that answer which the passing of time must not change. Cleared at the
   * top of every `start()`, so a later attempt decides afresh whatever its
   * outcome.
   */
  permanentFailure: boolean
  /**
   * Set by `retire()` and never cleared by `start()` (unlike
   * `permanentFailure`, which every fresh attempt resets). `ensure` checks
   * this BEFORE calling `start()` at all, so a retired entry stays refused
   * regardless of how many restart-budget windows pass. Only `forget`
   * (deleting the entry outright) or a brand new deployment id clears it.
   */
  retired: boolean
  /**
   * How many requests `beginRequest` has opened against this entry that have
   * not yet called their release function. The reaper skips any entry with
   * `inFlight > 0`, whatever `lastUsedAt` says — see `beginRequest` on
   * `PrototypeProcesses`.
   *
   * A counter, not a flag, because two requests can be in flight against the
   * same process at once (two reviewers, or a page issuing several fetches);
   * the entry stays protected until the LAST one releases.
   */
  inFlight: number
}

export function createPrototypeProcesses(deps: PrototypeProcessesDeps): PrototypeProcesses {
  const now = deps.now ?? (() => Date.now())
  const readyTimeoutMs = deps.readyTimeoutMs ?? 60_000
  const idleMs = deps.idleMs ?? 30 * 60_000
  const reapIntervalMs = deps.reapIntervalMs ?? 5 * 60_000
  const maxRunning = deps.maxRunning ?? MAX_RUNNING_SERVER_PROTOTYPES
  const pickPort = deps.pickPort ?? pickLoopbackPort
  const entries = new Map<string, Entry>()
  let recencyCounter = 0
  /**
   * Set by `shutdown()` before it kills anything, and never cleared.
   *
   * `index.ts` awaits `shutdown()` BEFORE the listeners and the main server
   * close, so a request can still land in that window. Without this it would
   * call `ensure`, spawn a DETACHED child, and the process would then exit
   * leaving that child holding a port with nobody to stop it.
   */
  let closed = false
  /** Bumps both the human-readable `lastUsedAt` and the tie-proof `recency`. */
  const touchEntry = (e: Entry): void => {
    e.lastUsedAt = now()
    e.recency = recencyCounter++
  }

  const entryFor = (id: string): Entry => {
    let e = entries.get(id)
    if (!e) {
      e = { status: { state: "stopped" }, child: null, port: null, lastUsedAt: now(), recency: recencyCounter++, log: "", restartsAt: [], opening: null, generation: 0, permanentFailure: false, retired: false, inFlight: 0 }
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
  const running = (): [string, Entry][] => [...entries].filter(([, e]) => e.status.state === "running")
  /**
   * `running` PLUS `starting` — every entry that currently occupies a slot
   * against `maxRunning`. `start()` reserves its own slot by setting its
   * status to `starting` synchronously before its first `await` (see
   * there), so by the time any concurrent `start()` reaches the room-making
   * loop below, every entry racing it is already counted here — that is
   * what closes the concurrent-cold-start cap bypass.
   */
  const occupied = (): [string, Entry][] =>
    [...entries].filter(([, e]) => e.status.state === "running" || e.status.state === "starting")

  /**
   * Would the next `ensure` start this entry again?
   *
   * The same question `start()` asks of its own budget below, asked from the
   * crash sites so the status can STATE the answer. Written once here rather
   * than at each site, because a second copy of the budget rule is how the
   * status and the behaviour would come to disagree.
   */
  const withinRestartBudget = (e: Entry): boolean =>
    e.restartsAt.filter((t) => now() - t < RESTART_WINDOW_MS).length <= RESTART_BUDGET

  /**
   * The entry's status as callers see it: the stored one, plus the computed
   * `retryable` on a crash.
   *
   * The single place `retryable` is decided, and it is decided at READ time
   * on purpose — see `ProcessStatus`. `permanentFailure` is the only thing
   * that can veto the budget's own answer.
   */
  const exposedStatus = (e: Entry): ProcessStatus =>
    e.status.state === "crashed"
      ? { ...e.status, retryable: !e.permanentFailure && withinRestartBudget(e) }
      : e.status

  /** The refusal `ensure` gives once `shutdown()` has run. */
  const closedError = (): PrototypeProcessError =>
    new PrototypeProcessError({ state: "stopped" }, "The viewer is shutting down.")

  /**
   * Stops an entry's child, if it has one, and marks it `stopped`.
   *
   * `e.child` is nulled and `e.status` becomes `stopped` SYNCHRONOUSLY,
   * before anything is awaited. A concurrent `start()` for the same entry
   * reads `e.child` every poll iteration precisely so it notices a stop
   * landing mid-start without any separate flag: `e.child` IS that flag,
   * and this is the moment it flips. See `start()`'s poll loop.
   */
  async function stopEntry(e: Entry): Promise<void> {
    const child = e.child
    // Bumped for every stop, child or not — see `Entry.generation` for the
    // window `e.child` cannot cover.
    e.generation++
    e.child = null
    e.port = null
    e.status = { state: "stopped" }
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        killTree(child, "SIGKILL")
      }, 5000)
      child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
      killTree(child, "SIGTERM")
    })
  }

  async function answers(port: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/", method: "GET", timeout: 1000 }, (res) => {
        res.resume()
        resolve(true)
      })
      req.on("error", () => resolve(false))
      req.on("timeout", () => {
        req.destroy()
        resolve(false)
      })
      req.end()
    })
  }

  async function start(id: string, serverStart: string[], e: Entry): Promise<{ port: number }> {
    // Read once, at the top: every check below asks whether a stop has landed
    // SINCE this attempt began, and a value re-read later would answer a
    // different question.
    const generation = e.generation
    // This attempt decides the verdict afresh: a previous "no restart can fix
    // this" must not outlive the attempt that recorded it.
    e.permanentFailure = false
    // Reserves this entry's slot for the cap check below, SYNCHRONOUSLY,
    // before the first `await` in this function. Without this, several
    // concurrent `ensure()`s for different stopped deployments could each
    // read the cap as "not yet full" before any of them had a chance to
    // record that it was starting — spawning more children than
    // `maxRunning` allows. See the "make room" loop, which now counts this
    // status too.
    e.status = { state: "starting" }
    let cwd: string
    try {
      // Inside the try: a malformed id makes `checkoutDirFor` throw
      // synchronously, and that must land here too, not escape as an
      // uncaught rejection. The reason string below is fixed and generic on
      // purpose — `checkoutDirFor`'s own message echoes the id, which is not
      // safe to hand back as a crash reason.
      cwd = checkoutDirFor(deps.checkoutsRoot, id)
      if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory")
    } catch {
      // Not retryable, and not by the budget's reckoning either: no number of
      // restarts puts the files back, and no amount of waiting does. Only a
      // rebuild does, which is what the review page then offers.
      e.permanentFailure = true
      e.status = { state: "crashed", exitCode: null, restarts: e.restartsAt.length, reason: "The checkout for this deployment is missing. Rebuild it." }
      throw new PrototypeProcessError(exposedStatus(e), e.status.reason)
    }
    const recent = e.restartsAt.filter((t) => now() - t < RESTART_WINDOW_MS)
    e.restartsAt = recent
    // "At most 3 restarts in 5 minutes": the very first attempt is not a
    // restart, so this refuses once a 4th crash (the would-be 4th restart)
    // is already on record, not on the 3rd.
    if (recent.length > RESTART_BUDGET) {
      // No `retryable` written here either: `exposedStatus` asks
      // `withinRestartBudget` the same question this branch just asked, so
      // the status says `false` now and says `true` again once these crashes
      // age out of the window — which is exactly when the next `ensure`
      // would start trying again.
      e.status = { state: "crashed", exitCode: crashedExitCodeOrNull(e.status), restarts: recent.length, reason: "The server kept exiting. See the server log." }
      throw new PrototypeProcessError(exposedStatus(e), e.status.reason)
    }
    // Make room. `occupied()` counts this entry too (it just reserved its
    // own `starting` slot above), so the condition is `> maxRunning`, not
    // `>=`: this entry alone is allowed to fill the last slot.
    //
    // Never evict a `starting` entry — it may have no child yet, or one
    // mid-spawn. When every occupied slot is `starting` (nothing `running`
    // to evict), the entry that reserved its slot FIRST — stable Map
    // insertion order — is always let through, and every other `starting`
    // entry waits on THAT ONE specifically. That fixed, single leader is
    // what keeps this from deadlocking: two `starting` entries can never end
    // up waiting on each other, because only the earliest one is ever a
    // wait target, and the earliest one never waits (it always sees itself
    // as the leader and proceeds). Once the leader settles (running or
    // crashed) the waiters re-check from scratch.
    //
    // A `running` entry with `inFlight > 0` (an open response — an SSE
    // stream, a large download — held by `beginRequest`) is never a victim
    // either (codex round 8, Fix 2). Eviction used to sort every `running`
    // entry by recency and stop the oldest one regardless of `inFlight`, so
    // a fifth prototype opening while the least-recently-used one was
    // mid-response would kill it out from under its reader — exactly what
    // `beginRequest`/`inFlight` exist to protect against for the idle
    // reaper, but eviction never consulted them.
    while (occupied().length > maxRunning) {
      const evictable = running().filter(([, oe]) => oe.inFlight === 0)
      if (evictable.length > 0) {
        const [victimId] = evictable.sort((a, b) => a[1].recency - b[1].recency)[0]!
        await stopEntry(entryFor(victimId))
        continue
      }
      const leaderId = [...entries].find(([, oe]) => oe.status.state === "starting")?.[0]
      if (leaderId && leaderId !== id) {
        const leaderOpening = entries.get(leaderId)?.opening
        if (leaderOpening) {
          await leaderOpening.catch(() => {})
        } else {
          // Should be unreachable — a `starting` entry's `opening` is set in
          // the same synchronous turn as its status (see above), so this is
          // only a defensive yield against ever spinning the event loop if
          // that invariant is somehow violated.
          await Promise.resolve()
        }
        continue
      }
      // No running entry can be evicted, and there is no OTHER starting
      // entry to wait on either. Two cases reach here, and they must be told
      // apart:
      //
      // - `running().length === 0`: every occupied slot is a fresh cold
      //   start, including possibly this one. This is the deadlock-freedom
      //   case above — `leaderId` is either absent or this entry itself, so
      //   there is nothing productive left to wait for, and breaking out
      //   (proceeding to spawn over the cap, transiently) is what lets the
      //   single leader through instead of every `starting` entry waiting on
      //   every other.
      // - `running().length > 0`: every slot is held by a RUNNING entry that
      //   is actively answering a request, and nothing here will free one on
      //   its own. Waiting would either spin or block indefinitely on a
      //   response that may not end soon — so this attempt fails fast
      //   instead, releasing the slot it reserved.
      if (running().length > 0) {
        e.status = { state: "stopped" }
        throw new PrototypeProcessError(exposedStatus(e), BUSY_MESSAGE)
      }
      break
    }

    // Setup between reserving the slot above and the actual `spawn` below,
    // wrapped so a throw here cannot leave the entry stuck "starting"
    // forever: `pickPort` can reject (ports exhausted), `substitutePort`
    // throws synchronously on an empty `serverStart`, and `mkdir` can reject
    // (permissions, disk full). Before this wrap, any of those rejected
    // `ensure` while leaving `e.status` at "starting", permanently occupying
    // a slot against `maxRunning` — enough of them and the room-making loop
    // above waits forever on entries that will never resolve (codex round 3,
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
      console.error("[viewer] prototype process setup failed:", error)
      e.status = {
        state: "crashed",
        exitCode: null,
        restarts: e.restartsAt.length,
        reason: SETUP_FAILED_REASON,
      }
      throw new PrototypeProcessError(exposedStatus(e), e.status.reason)
    }
    // Immediately before the spawn. Everything above this line has awaited at
    // least once, so a `stop()` or a `shutdown()` can have landed in between —
    // and a spawn after either of those is a child nobody will ever stop,
    // because the manager has already forgotten it is coming.
    if (closed) throw closedError()
    if (e.generation !== generation) {
      throw new PrototypeProcessError(exposedStatus(e), "The server was stopped before it finished starting.")
    }
    e.status = { state: "starting" }
    e.log = ""
    const child = spawn(file, args, {
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
    // And immediately after it. DEFENCE, not a window: every line between the
    // check above and `spawn` is synchronous, so no stop can land in between
    // and this branch is unreachable as the code stands. It is kept because
    // one `await` added above `spawn` would open that window silently, and
    // this is what would already be here to close it. A child spawned across
    // a stop is killed rather than left running.
    if (closed || e.generation !== generation) {
      killTree(child, "SIGKILL")
      // The group kill can lose a race with the child's own `setsid` (spawn
      // has returned, the child may not have run yet), so the pid is killed
      // directly as well. Either call is a no-op once the other has landed.
      child.kill("SIGKILL")
      if (closed) throw closedError()
      throw new PrototypeProcessError(exposedStatus(e), "The server was stopped before it finished starting.")
    }
    e.child = child
    child.stdout?.on("data", (b: Buffer) => append(e, b.toString("utf8")))
    child.stderr?.on("data", (b: Buffer) => append(e, b.toString("utf8")))
    let exited = false
    child.once("exit", (code) => {
      exited = true
      if (e.child !== child) return
      e.child = null
      e.port = null
      e.restartsAt.push(now())
      e.status = { state: "crashed", exitCode: code, restarts: e.restartsAt.length, reason: "The server exited." }
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
      append(e, `\n${error.message}\n`)
      console.error("[viewer] prototype process setup failed:", error)
      if (e.child !== child) return
      e.child = null
      e.port = null
      e.restartsAt.push(now())
      e.status = { state: "crashed", exitCode: null, restarts: e.restartsAt.length, reason: SETUP_FAILED_REASON }
    })

    const deadline = now() + readyTimeoutMs
    // `e.child === child` is re-checked every iteration so a `stop()` (or an
    // eviction) landing mid-poll ends this loop promptly instead of running
    // to the timeout against a child that is already gone.
    while (!exited && e.child === child && now() < deadline) {
      if (await answers(port)) {
        // The request above can outlive a `stop()` that lands while it is in
        // flight. Bail rather than declare a dead child "running" — this is
        // the same identity guard the exit handler uses.
        if (e.child !== child) {
          throw new PrototypeProcessError(exposedStatus(e), reasonOrFallback(e.status, "The server was stopped before it finished starting."))
        }
        e.port = port
        e.status = { state: "running", port, since: new Date(now()).toISOString() }
        touchEntry(e)
        return { port }
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    if (!exited && e.child === child) {
      // Timed out on our own clock, not stopped or exited elsewhere.
      await stopEntry(e)
      e.restartsAt.push(now())
      e.status = { state: "crashed", exitCode: null, restarts: e.restartsAt.length, reason: "The server did not answer in time." }
    }
    throw new PrototypeProcessError(exposedStatus(e), reasonOrFallback(e.status, "The server did not start."))
  }

  return {
    async ensure(deployment) {
      // Before anything else, including the entry lookup: after `shutdown()`
      // there is nothing this manager can honestly promise, and a spawn here
      // outlives the process (children are detached).
      if (closed) throw closedError()
      if (!deployment.serverStart) {
        throw new PrototypeProcessError({ state: "stopped" }, "This deployment is served as files, not as a server.")
      }
      const e = entryFor(deployment.id)
      // Checked before the running/opening fast paths: a retired entry is
      // never running and never mid-open (`retire` stops it first), but
      // this order also makes the refusal explicit rather than incidental.
      if (e.retired) {
        throw new PrototypeProcessError(exposedStatus(e), reasonOrFallback(e.status, "The checkout for this deployment was removed. Rebuild it."))
      }
      if (e.status.state === "running" && e.port !== null) {
        touchEntry(e)
        return { port: e.port }
      }
      if (e.opening) return await e.opening
      e.opening = start(deployment.id, deployment.serverStart, e).finally(() => {
        e.opening = null
      })
      return await e.opening
    },
    touch(id) {
      const e = entries.get(id)
      if (e) touchEntry(e)
    },
    beginRequest(id) {
      const e = entryFor(id)
      e.inFlight++
      let released = false
      return () => {
        // Idempotent: `res.once("close", release)` fires at most once, but a
        // caller that ALSO invokes the returned function directly (belt and
        // braces around an error path, say) must not double-decrement and
        // let the count drift below the number of requests actually open.
        if (released) return
        released = true
        e.inFlight--
        touchEntry(e)
      }
    },
    async stop(id) {
      const e = entries.get(id)
      if (e) await stopEntry(e)
    },
    async markUnreachable(id) {
      const e = entries.get(id)
      if (!e) return
      // Only a `running` entry is this call's business — see the interface
      // doc comment for why `crashed`/`starting`/`stopped` are each a no-op.
      if (e.status.state !== "running") return
      await stopEntry(e)
      // `stopEntry` awaits the old child's exit (up to 5s on a SIGTERM it
      // ignores), during which a concurrent `ensure()` can have raced in and
      // started a fresh attempt of its own — `stopEntry` reset the status to
      // `stopped` synchronously at its own top, which is exactly the moment
      // a racing `start()` reads as "safe to restart". Only record THIS call's
      // crash if nothing else has touched the entry since: a status that is
      // still `stopped` is this stop's own doing, and anything else (a fresh
      // `starting`/`running`, or another crash) is a newer answer than this
      // one and must not be clobbered.
      if (!isStopped(e.status)) return
      e.restartsAt.push(now())
      e.status = {
        state: "crashed",
        exitCode: null,
        restarts: e.restartsAt.length,
        reason: "The server stopped answering.",
      }
    },
    async forget(id) {
      const e = entries.get(id)
      if (!e) return
      // Stopped first, dropped second. Dropping first would let a concurrent
      // `ensure` create a fresh entry and spawn into a checkout that is about
      // to be deleted; this way the child is down before the record goes.
      await stopEntry(e)
      entries.delete(id)
    },
    async retire(id) {
      // `entryFor`, not `entries.get`: a deployment can be pruned before it
      // was ever `ensure`d, and the refusal must still be recorded — a later
      // `ensure` for this same id must never fall through to `start()` and
      // find an inviting empty slot.
      const e = entryFor(id)
      // `e.retired` — the flag `ensure` checks FIRST, before anything else —
      // is set SYNCHRONOUSLY, before `stopEntry`'s own first `await` (its
      // wait for the old child to exit, which a SIGTERM-ignoring child can
      // stretch out for up to 5s). Without this, a request on the still-open
      // pinned listener could call `ensure` in that window: `stopEntry`
      // already reset `e.status` to "stopped" synchronously at ITS top, so
      // `ensure` would see an entry that looks safe to restart and spawn a
      // replacement — one that `pruneSupersededCheckouts` then deletes the
      // checkout out from under, once this `retire` finishes and the
      // directory removal proceeds (codex round 3, item 1).
      e.retired = true
      e.permanentFailure = true
      await stopEntry(e)
      // `stopEntry` just reset `e.status` to "stopped" as part of stopping the
      // child; restore the permanent refusal now that the stop is done. The
      // `retired` flag above is what actually closed the race — this is the
      // status a caller reading `status()` afterward should see.
      e.status = {
        state: "crashed",
        exitCode: null,
        restarts: e.restartsAt.length,
        reason: "The checkout for this deployment was removed. Rebuild it.",
      }
    },
    status(id) {
      const e = entries.get(id)
      return e ? exposedStatus(e) : { state: "stopped" }
    },
    serverLog(id) {
      return entries.get(id)?.log ?? ""
    },
    startReaper() {
      const timer = setInterval(() => {
        for (const [, e] of running()) {
          // A request that began before the idle bound passed and is still
          // being answered (an SSE stream, a large download) must not be cut
          // out from under the client — see `beginRequest`. `stop`/`retire`/
          // `forget`/`shutdown` are unaffected: they kill regardless, because
          // they are explicit "this deployment is going away" actions, not
          // the passive idle sweep.
          if (e.inFlight > 0) continue
          if (now() - e.lastUsedAt >= idleMs) void stopEntry(e)
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
      await Promise.all([...entries.values()].map((e) => stopEntry(e)))
    },
  }
}
