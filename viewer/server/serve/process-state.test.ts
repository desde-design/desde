import { describe, expect, it } from "vitest"
import {
  transition,
  newRecord,
  retryable,
  chooseVictim,
  isReapable,
  type ProcessRecord,
  type ProcessEvent,
  type Limits,
} from "./process-state"

const limits: Limits = { restartBudget: 3, restartWindowMs: 5 * 60_000 }
const t0 = 1_000_000

function after(record: ProcessRecord, events: ProcessEvent[], now = t0): ProcessRecord {
  return events.reduce((r, e) => transition(r, e, now, limits).record, record)
}

describe("transition", () => {
  it("idle → starting → running on start-requested, spawned, ready, with a spawn effect once", () => {
    const r0 = newRecord(t0)
    const s1 = transition(r0, { type: "start-requested" }, t0, limits)
    expect(s1.record.state.kind).toBe("starting")
    expect(s1.effects).toEqual([{ kind: "spawn" }])
    const s2 = transition(s1.record, { type: "spawned", generation: s1.record.generation }, t0, limits)
    const s3 = transition(s2.record, { type: "ready", port: 4321, generation: s1.record.generation }, t0, limits)
    expect(s3.record.state).toEqual({ kind: "running", generation: s1.record.generation, port: 4321, since: t0 })
  })

  it("retired absorbs everything except forget", () => {
    const r = after(newRecord(t0), [{ type: "retire" }])
    for (const e of [
      { type: "start-requested" },
      { type: "ready", port: 1, generation: 1 },
      { type: "unreachable" },
      { type: "reap", now: t0 + 1e9, idleMs: 1 },
    ] as ProcessEvent[]) {
      const out = transition(r, e, t0, limits)
      expect(out.record.state.kind).toBe("retired")
      expect(out.effects).toEqual([])
    }
    expect(transition(r, { type: "forget" }, t0, limits).effects).toEqual([{ kind: "drop" }])
  })

  it("a record with leases is never reaped or evicted", () => {
    const running = after(newRecord(t0), [
      { type: "start-requested" },
      { type: "spawned", generation: 1 },
      { type: "ready", port: 1, generation: 1 },
      { type: "lease-acquired" },
    ])
    expect(transition(running, { type: "reap", now: t0 + 1e9, idleMs: 1 }, t0, limits).refused).toBeDefined()
    expect(transition(running, { type: "evict" }, t0, limits).refused).toBeDefined()
    expect(isReapable(running, t0 + 1e9, 1)).toBe(false)
  })

  it("exited, unreachable, timed-out and a non-permanent start-failed each charge one attempt", () => {
    const running = after(newRecord(t0), [
      { type: "start-requested" },
      { type: "spawned", generation: 1 },
      { type: "ready", port: 1, generation: 1 },
    ])
    expect(transition(running, { type: "exited", code: 1 }, t0, limits).record.attempts).toHaveLength(1)
    expect(transition(running, { type: "unreachable" }, t0, limits).record.attempts).toHaveLength(1)
    const starting = after(newRecord(t0), [{ type: "start-requested" }])
    expect(transition(starting, { type: "timed-out" }, t0, limits).record.attempts).toHaveLength(1)
    expect(
      transition(starting, { type: "start-failed", reason: "x", permanent: false }, t0, limits).record.attempts,
    ).toHaveLength(1)
    expect(
      transition(starting, { type: "start-failed", reason: "x", permanent: true }, t0, limits).record.attempts,
    ).toHaveLength(0)
  })

  it("unreachable on a crashed record changes nothing", () => {
    const crashed = after(newRecord(t0), [
      { type: "start-requested" },
      { type: "start-failed", reason: "why", permanent: false },
    ])
    const out = transition(crashed, { type: "unreachable" }, t0, limits)
    expect(out.record).toEqual(crashed)
  })

  it("a stale generation's spawned and ready are refused", () => {
    const starting = after(newRecord(t0), [{ type: "start-requested" }])
    const stopped = transition(starting, { type: "stop-requested" }, t0, limits).record
    expect(
      transition(stopped, { type: "ready", port: 1, generation: starting.generation }, t0, limits).refused,
    ).toBeDefined()
  })

  it("retryable follows the budget window and the permanent flag", () => {
    let r = newRecord(t0)
    for (let i = 0; i < 3; i++) {
      r = after(r, [{ type: "start-requested" }, { type: "start-failed", reason: "x", permanent: false }])
    }
    expect(retryable(r, t0, limits)).toBe(false)
    expect(retryable(r, t0 + 6 * 60_000, limits)).toBe(true)
    const permanent = after(newRecord(t0), [
      { type: "start-requested" },
      { type: "start-failed", reason: "x", permanent: true },
    ])
    expect(retryable(permanent, t0 + 1e9, limits)).toBe(false)
  })

  it("chooseVictim picks the least recently used running record without leases", () => {
    const busyOld: ProcessRecord = {
      state: { kind: "running", generation: 1, port: 1, since: t0 },
      leases: 1,
      attempts: [],
      lastUsedAt: t0,
      generation: 1,
    }
    const idleMid: ProcessRecord = {
      state: { kind: "running", generation: 1, port: 2, since: t0 },
      leases: 0,
      attempts: [],
      lastUsedAt: t0 + 1000,
      generation: 1,
    }
    const idleNew: ProcessRecord = {
      state: { kind: "running", generation: 1, port: 3, since: t0 },
      leases: 0,
      attempts: [],
      lastUsedAt: t0 + 2000,
      generation: 1,
    }
    const records = new Map<string, ProcessRecord>([
      ["busy-old", busyOld],
      ["idle-mid", idleMid],
      ["idle-new", idleNew],
    ])
    expect(chooseVictim(records)).toBe("idle-mid")
  })

  it("chooseVictim returns null when nothing is eligible", () => {
    expect(chooseVictim(new Map())).toBeNull()
    const onlyBusy = new Map<string, ProcessRecord>([
      [
        "busy",
        {
          state: { kind: "running", generation: 1, port: 1, since: t0 },
          leases: 2,
          attempts: [],
          lastUsedAt: t0,
          generation: 1,
        },
      ],
    ])
    expect(chooseVictim(onlyBusy)).toBeNull()
  })
})

describe("invariants over random sequences", () => {
  // A tiny deterministic generator: 200 sequences of 30 events drawn from a
  // fixed list with a seeded LCG (no library).
  function makeLcg(seed: number): () => number {
    let state = seed >>> 0
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state
    }
  }

  const eventFactories: Array<(record: ProcessRecord) => ProcessEvent> = [
    () => ({ type: "start-requested" }),
    (r) => ({ type: "spawned", generation: r.generation }),
    (r) => ({ type: "ready", port: 4000, generation: r.generation }),
    () => ({ type: "exited", code: 1 }),
    () => ({ type: "unreachable" }),
    () => ({ type: "start-failed", reason: "boom", permanent: false }),
    () => ({ type: "start-failed", reason: "gone forever", permanent: true }),
    () => ({ type: "timed-out" }),
    () => ({ type: "stop-requested" }),
    () => ({ type: "retire" }),
    () => ({ type: "forget" }),
    () => ({ type: "lease-acquired" }),
    () => ({ type: "lease-released" }),
    () => ({ type: "reap", now: t0 + 1e9, idleMs: 500 }),
    () => ({ type: "evict" }),
  ]

  it("holds leases >= 0, generation monotonic, retired stays retired without forget, and crashed charges one attempt", () => {
    for (let seq = 0; seq < 200; seq++) {
      const rng = makeLcg(seq + 1)
      let record = newRecord(t0)
      let now = t0
      for (let step = 0; step < 30; step++) {
        now += 1 + (rng() % 10_000)
        const factory = eventFactories[rng() % eventFactories.length]!
        const event = factory(record)
        const before = record
        const result = transition(before, event, now, limits)

        // Invariant 1: no sequence reaches starting or running from retired
        // without a forget in between.
        if (before.state.kind === "retired" && event.type !== "forget") {
          expect(result.record.state.kind).toBe("retired")
        }

        // Invariant 2: leases never goes negative, and a record with
        // leases > 0 is never the subject of a kill effect from reap or evict.
        expect(result.record.leases).toBeGreaterThanOrEqual(0)
        if ((event.type === "reap" || event.type === "evict") && before.leases > 0) {
          expect(result.effects.some((eff) => eff.kind === "kill")).toBe(false)
        }

        // Invariant 3: every transition into crashed from running or starting
        // appends exactly one attempt, unless the cause was a permanent
        // start-failed (which appends zero — see the named test above).
        if (
          (before.state.kind === "running" || before.state.kind === "starting") &&
          result.record.state.kind === "crashed" &&
          !result.refused
        ) {
          const permanentStartFailed = event.type === "start-failed" && event.permanent
          const expectedDelta = permanentStartFailed ? 0 : 1
          expect(result.record.attempts.length).toBe(before.attempts.length + expectedDelta)
        }

        // Invariant 4: generation is monotonic.
        expect(result.record.generation).toBeGreaterThanOrEqual(before.generation)

        record = result.record
      }
    }
  })
})
