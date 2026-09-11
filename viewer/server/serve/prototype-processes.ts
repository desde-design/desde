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

/** Substitutes `$PORT` in each argv entry. The first entry is the executable. */
export function substitutePort(argv: string[], port: number): { file: string; args: string[] } {
  const substituted = argv.map((a) => a.replaceAll("$PORT", String(port)))
  const [file, ...args] = substituted
  if (!file) throw new Error("serverStart is empty")
  return { file, args }
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
      e = { status: { state: "stopped" }, child: null, port: null, lastUsedAt: now(), recency: recencyCounter++, log: "", restartsAt: [], opening: null, generation: 0, permanentFailure: false, retired: false }
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
    while (occupied().length > maxRunning) {
      const runningNow = running()
      if (runningNow.length > 0) {
        const [victimId] = runningNow.sort((a, b) => a[1].recency - b[1].recency)[0]!
        await stopEntry(entryFor(victimId))
        continue
      }
      const leaderId = [...entries].find(([, oe]) => oe.status.state === "starting")?.[0]
      if (!leaderId || leaderId === id) break
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
    }

    const port = await pickPort()
    const { file, args } = substitutePort(serverStart, port)
    // Inside the checkout, not beside it: `pruneSupersededCheckouts` deletes
    // `checkoutDirFor(...)` wholesale, so a home dir living inside it is
    // pruned along with the checkout instead of leaking forever.
    const home = join(cwd, ".desde-home")
    await mkdir(home, { recursive: true })
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
      append(e, `\n${error.message}\n`)
      if (e.child !== child) return
      e.child = null
      e.port = null
      e.restartsAt.push(now())
      e.status = { state: "crashed", exitCode: null, restarts: e.restartsAt.length, reason: `The server could not be started: ${error.message}` }
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
    async stop(id) {
      const e = entries.get(id)
      if (e) await stopEntry(e)
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
      await stopEntry(e)
      e.retired = true
      e.permanentFailure = true
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
