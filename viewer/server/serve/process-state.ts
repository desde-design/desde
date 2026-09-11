/**
 * The pure process state machine for a server prototype's child process.
 *
 * No I/O, no timers, no child processes, no imports besides types. Every
 * rule about when a start, stop, reap or eviction is allowed lives here as
 * one row of the `transition` switch, instead of being re-checked at each
 * call site in the runtime that drives this (`prototype-processes.ts`).
 *
 * See the design spec, "The process manager becomes an explicit state
 * machine" (`docs/superpowers/specs/2026-09-11-server-prototypes-rework-design.md`,
 * section 1).
 */

export type ProcessState =
  | { kind: "idle" }
  | { kind: "starting"; generation: number }
  | { kind: "running"; generation: number; port: number; since: number }
  | { kind: "crashed"; exitCode: number | null; reason: string; permanent: boolean }
  | { kind: "retired" }

export interface ProcessRecord {
  state: ProcessState
  /** Open request leases. Never reaped or evicted while > 0. */
  leases: number
  /** Timestamps of every failed or exited attempt, for the restart budget. */
  attempts: number[]
  lastUsedAt: number
  /** Increments on every spawn; the review page keys the iframe on it. */
  generation: number
}

export type ProcessEvent =
  | { type: "start-requested" }
  | { type: "spawned"; generation: number }
  | { type: "ready"; port: number; generation: number }
  | { type: "exited"; code: number | null }
  | { type: "unreachable" }
  | { type: "start-failed"; reason: string; permanent: boolean }
  | { type: "timed-out" }
  | { type: "stop-requested" }
  | { type: "retire" }
  | { type: "forget" }
  | { type: "lease-acquired" }
  | { type: "lease-released" }
  | { type: "reap"; now: number; idleMs: number }
  | { type: "evict" }

export type Effect = { kind: "spawn" } | { kind: "kill" } | { kind: "drop" }

export interface Limits {
  restartBudget: number
  restartWindowMs: number
}

export interface TransitionResult {
  record: ProcessRecord
  effects: Effect[]
  refused?: string
}

/**
 * Sentences reused verbatim from the runtime this pure machine replaces
 * (`prototype-processes.ts`, grepped for `PrototypeProcessError(` at the
 * time of writing). The runtime imports these rather than re-typing them,
 * so the two never drift apart.
 */
export const RETIRED_REFUSAL = "The checkout for this deployment was removed. Rebuild it."
export const BUDGET_REFUSAL = "The server kept exiting. See the server log."
export const STALE_GENERATION_REFUSAL = "The server was stopped before it finished starting."

/** Only tested indirectly (a caller must never see this in practice; the runtime serialises). */
export const ALREADY_STARTING_REFUSAL = "The server is already starting."
export const LEASE_HELD_REAP_REFUSAL = "This deployment has an open request and cannot be reaped."
export const LEASE_HELD_EVICT_REFUSAL = "This deployment has an open request and cannot be evicted."

const EXITED_REASON = "The server exited."
const UNREACHABLE_REASON = "The server stopped answering."
const TIMED_OUT_REASON = "The server did not answer in time."

function ok(record: ProcessRecord, effects: Effect[] = []): TransitionResult {
  return { record, effects }
}

function refuse(record: ProcessRecord, sentence: string): TransitionResult {
  return { record, effects: [], refused: sentence }
}

/**
 * `forget` is "stop, and then forget", from EVERY state — never `drop`
 * alone.
 *
 * A record that is `starting` (and a `retired` one that a cold start
 * overtook) can still own a live child, so dropping the record without
 * killing first left that child running with nothing left in the map to stop
 * it: not `stop`, not the reaper, not `shutdown`. `kill` on a record whose
 * child is already gone costs the runtime nothing — `applySync` reads a null
 * handle and there is nothing to wait for — so one row for all five states is
 * both the correct one and the one that cannot drift.
 *
 * The order matters and is the effect list's own: the child is down before
 * the record disappears.
 */
const FORGET_EFFECTS: Effect[] = [{ kind: "kill" }, { kind: "drop" }]

/**
 * Records one failed attempt at `now`, and drops attempts older than the
 * budget window while doing so: only the window is ever read, and a
 * prototype that keeps crashing for days would otherwise grow this list
 * without bound.
 */
function withAttempt(record: ProcessRecord, now: number, limits: Limits): ProcessRecord {
  const recent = record.attempts.filter((t) => now - t < limits.restartWindowMs)
  return { ...record, attempts: [...recent, now] }
}

function releaseLease(record: ProcessRecord, now: number): ProcessRecord {
  return { ...record, leases: Math.max(0, record.leases - 1), lastUsedAt: now }
}

function acquireLease(record: ProcessRecord, now: number): ProcessRecord {
  return { ...record, leases: record.leases + 1, lastUsedAt: now }
}

/**
 * Whether the NEXT `start-requested` on a crashed record would be allowed:
 * not a permanent failure, and fewer than `limits.restartBudget` attempts
 * within `limits.restartWindowMs` of `now`. The same question the review
 * page asks to know whether to offer a retry.
 */
export function retryable(record: ProcessRecord, now: number, limits: Limits): boolean {
  if (record.state.kind !== "crashed") return true
  if (record.state.permanent) return false
  const within = record.attempts.filter((t) => now - t < limits.restartWindowMs).length
  return within < limits.restartBudget
}

/** The least recently used `running` record with no open leases, or `null`. */
export function chooseVictim(records: Map<string, ProcessRecord>): string | null {
  let victimId: string | null = null
  let victim: ProcessRecord | null = null
  for (const [id, record] of records) {
    if (record.state.kind !== "running" || record.leases > 0) continue
    if (victim === null || record.lastUsedAt < victim.lastUsedAt) {
      victimId = id
      victim = record
    }
  }
  return victimId
}

/** Whether a record is an idle-timeout reap target: running, unleased, idle for `idleMs`. */
export function isReapable(record: ProcessRecord, now: number, idleMs: number): boolean {
  return record.state.kind === "running" && record.leases === 0 && now - record.lastUsedAt >= idleMs
}

export function newRecord(now: number): ProcessRecord {
  return { state: { kind: "idle" }, leases: 0, attempts: [], lastUsedAt: now, generation: 0 }
}

export function transition(
  record: ProcessRecord,
  event: ProcessEvent,
  now: number,
  limits: Limits,
): TransitionResult {
  switch (record.state.kind) {
    case "idle": {
      switch (event.type) {
        case "start-requested": {
          const generation = record.generation + 1
          return ok({ ...record, generation, state: { kind: "starting", generation } }, [{ kind: "spawn" }])
        }
        case "spawned":
        case "ready":
          return refuse(record, STALE_GENERATION_REFUSAL)
        case "exited":
        case "unreachable":
        case "start-failed":
        case "timed-out":
        case "stop-requested":
          return ok(record)
        case "retire":
          return ok({ ...record, state: { kind: "retired" } })
        case "forget":
          return ok(record, FORGET_EFFECTS)
        case "lease-acquired":
          return ok(acquireLease(record, now))
        case "lease-released":
          return ok(releaseLease(record, now))
        case "reap":
        case "evict":
          return ok(record)
        default: {
          const _exhaustive: never = event
          throw new Error(`unreachable event: ${JSON.stringify(_exhaustive)}`)
        }
      }
    }

    case "starting": {
      const state = record.state
      switch (event.type) {
        case "start-requested":
          return refuse(record, ALREADY_STARTING_REFUSAL)
        case "spawned":
          if (event.generation !== state.generation) return refuse(record, STALE_GENERATION_REFUSAL)
          return ok(record)
        case "ready":
          if (event.generation !== state.generation) return refuse(record, STALE_GENERATION_REFUSAL)
          return ok({
            ...record,
            lastUsedAt: now,
            state: { kind: "running", generation: state.generation, port: event.port, since: now },
          })
        case "exited":
          return ok(withAttempt({ ...record, state: { kind: "crashed", exitCode: event.code, reason: EXITED_REASON, permanent: false } }, now, limits))
        case "unreachable":
          return ok(record)
        case "start-failed": {
          const crashed: ProcessRecord = {
            ...record,
            state: { kind: "crashed", exitCode: null, reason: event.reason, permanent: event.permanent },
          }
          return ok(event.permanent ? crashed : withAttempt(crashed, now, limits), [])
        }
        case "timed-out":
          return ok(
            withAttempt(
              { ...record, state: { kind: "crashed", exitCode: null, reason: TIMED_OUT_REASON, permanent: false } },
              now,
              limits,
            ),
            [{ kind: "kill" }],
          )
        case "stop-requested":
          return ok({ ...record, state: { kind: "idle" } }, [{ kind: "kill" }])
        case "retire":
          return ok({ ...record, state: { kind: "retired" } }, [{ kind: "kill" }])
        case "forget":
          return ok(record, FORGET_EFFECTS)
        case "lease-acquired":
          return ok(acquireLease(record, now))
        case "lease-released":
          return ok(releaseLease(record, now))
        case "reap":
        case "evict":
          return ok(record)
        default: {
          const _exhaustive: never = event
          throw new Error(`unreachable event: ${JSON.stringify(_exhaustive)}`)
        }
      }
    }

    case "running": {
      switch (event.type) {
        case "start-requested":
          return refuse(record, ALREADY_STARTING_REFUSAL)
        case "spawned":
        case "ready":
          return refuse(record, STALE_GENERATION_REFUSAL)
        case "exited":
          return ok(
            withAttempt(
              { ...record, state: { kind: "crashed", exitCode: event.code, reason: EXITED_REASON, permanent: false } },
              now,
              limits,
            ),
          )
        case "unreachable":
          return ok(
            withAttempt(
              { ...record, state: { kind: "crashed", exitCode: null, reason: UNREACHABLE_REASON, permanent: false } },
              now,
              limits,
            ),
            [{ kind: "kill" }],
          )
        case "start-failed":
        case "timed-out":
          return ok(record)
        case "stop-requested":
          return ok({ ...record, state: { kind: "idle" } }, [{ kind: "kill" }])
        case "retire":
          return ok({ ...record, state: { kind: "retired" } }, [{ kind: "kill" }])
        case "forget":
          return ok(record, FORGET_EFFECTS)
        case "lease-acquired":
          return ok(acquireLease(record, now))
        case "lease-released":
          return ok(releaseLease(record, now))
        case "reap": {
          if (record.leases > 0) return refuse(record, LEASE_HELD_REAP_REFUSAL)
          if (!isReapable(record, event.now, event.idleMs)) return ok(record)
          return ok({ ...record, state: { kind: "idle" } }, [{ kind: "kill" }])
        }
        case "evict": {
          if (record.leases > 0) return refuse(record, LEASE_HELD_EVICT_REFUSAL)
          return ok({ ...record, state: { kind: "idle" } }, [{ kind: "kill" }])
        }
        default: {
          const _exhaustive: never = event
          throw new Error(`unreachable event: ${JSON.stringify(_exhaustive)}`)
        }
      }
    }

    case "crashed": {
      switch (event.type) {
        case "start-requested": {
          // A permanent failure (a missing checkout, say) refuses with its
          // own reason, which names the way out; only a spent budget says
          // the server kept exiting.
          if (record.state.permanent) return refuse(record, record.state.reason)
          if (!retryable(record, now, limits)) return refuse(record, BUDGET_REFUSAL)
          const generation = record.generation + 1
          return ok({ ...record, generation, state: { kind: "starting", generation } }, [{ kind: "spawn" }])
        }
        case "spawned":
        case "ready":
          return refuse(record, STALE_GENERATION_REFUSAL)
        case "exited":
        case "start-failed":
        case "timed-out":
          return ok(record)
        case "unreachable":
          // A stop must not write over a crash: `unreachable` reaching a
          // record that is already `crashed` is a stale signal and changes
          // nothing (matches `markUnreachable`'s own early return today).
          return ok(record)
        case "stop-requested":
          return ok(record)
        case "retire":
          return ok({ ...record, state: { kind: "retired" } })
        case "forget":
          return ok(record, FORGET_EFFECTS)
        case "lease-acquired":
          return ok(acquireLease(record, now))
        case "lease-released":
          return ok(releaseLease(record, now))
        case "reap":
        case "evict":
          return ok(record)
        default: {
          const _exhaustive: never = event
          throw new Error(`unreachable event: ${JSON.stringify(_exhaustive)}`)
        }
      }
    }

    case "retired": {
      switch (event.type) {
        case "start-requested":
          return refuse(record, RETIRED_REFUSAL)
        case "forget":
          return ok(record, FORGET_EFFECTS)
        // A cold start this record was retired out from under still carries
        // its own `spawned` and `ready`. Absorbing them let the runtime go on
        // to spawn a child into a checkout that is being deleted, and then
        // hand a reader its port. Refusing is what makes `startChild` throw
        // before the spawn, and kill the child when a `ready` is already in
        // flight.
        case "spawned":
        case "ready":
          return refuse(record, RETIRED_REFUSAL)
        case "exited":
        case "unreachable":
        case "start-failed":
        case "timed-out":
        case "stop-requested":
        case "retire":
        case "lease-acquired":
        case "lease-released":
        case "reap":
        case "evict":
          return ok(record)
        default: {
          const _exhaustive: never = event
          throw new Error(`unreachable event: ${JSON.stringify(_exhaustive)}`)
        }
      }
    }

    default: {
      const _exhaustive: never = record.state
      throw new Error(`unreachable state: ${JSON.stringify(_exhaustive)}`)
    }
  }
}
