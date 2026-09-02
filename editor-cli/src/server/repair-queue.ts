/**
 * Single-flight queue for Phase 5 Task 4's granular auto-repair (final
 * review fix wave — see
 * `.superpowers/sdd/2026-07-29-grounding-phase5-drift/final-fix-report.md`).
 *
 * `repairComponent` (`src/editor/drift/repair-component.ts`) runs
 * `ts.createProgram` synchronously per component. Before this module,
 * `maybeTriggerRepair` in `drift-handler.ts` fired every repairable signal's
 * repair as an independent fire-and-forget promise with no concurrency
 * bound — a single POST batch carrying signals for 50 distinct components
 * (the route's own per-request cap) could queue 50 synchronous TS program
 * builds at once, stalling the whole CLI event loop (other edit POSTs, chat
 * SSE) for as long as that takes.
 *
 * This queue serializes execution: at most ONE `repairComponent` call runs
 * at a time. Callers past that get FIFO-queued, bounded by `cap` — a
 * submission that arrives when the pending queue is already at capacity is
 * rejected immediately (the job function is never invoked, so it can never
 * itself start a TS program) with a `'failed'` outcome carrying a clear
 * reason, so the drift entry still gets a `repair` field rather than being
 * silently dropped. `enqueue` never rejects its returned promise — every
 * path (ordinary settle, internal job throw, queue-full) resolves to a
 * `RepairOutcome`, matching `repairComponent`'s own "never throws" contract
 * so `drift-handler.ts`'s `.then` write-back doesn't need its own `.catch`
 * guard for this layer.
 *
 * One instance is constructed per process (alongside `RepairDeps` in
 * `http-server.ts`) and threaded through `DriftHandlerCtx.repair.queue` —
 * NOT per-request, or every POST would get its own single-item "queue" and
 * this module would serialize nothing.
 */

import type { RepairOutcome } from "../../../src/editor/drift/repair-component.js"

/** Max PENDING jobs (not counting the one currently running) before a new submission is rejected outright. */
export const REPAIR_QUEUE_CAP = 10

export interface RepairQueue {
  /**
   * Run `job` once every job ahead of it (the current in-flight one, plus
   * anything already queued) has settled. Resolves to `job`'s own result,
   * or — if the pending queue is already at `cap` when this is called — a
   * synchronous `{ outcome: 'failed', reason: 'repair queue full…' }`
   * without ever invoking `job`.
   */
  enqueue(job: () => Promise<RepairOutcome>): Promise<RepairOutcome>
}

/** Production + test factory. `cap` defaults to {@link REPAIR_QUEUE_CAP}; tests may pass a small cap to exercise overflow without needing a dozen fake signals. */
export function createRepairQueue(cap: number = REPAIR_QUEUE_CAP): RepairQueue {
  // 0 or 1 — this queue enforces "at most one running", not a counting
  // semaphore, so a boolean would do; kept numeric only because it reads
  // naturally alongside `pending.length`.
  let runningCount = 0
  const pending: Array<() => void> = []

  function drainNext(): void {
    if (runningCount > 0) return
    const next = pending.shift()
    if (!next) return
    runningCount = 1
    next()
  }

  return {
    enqueue(job) {
      return new Promise<RepairOutcome>((resolve) => {
        const runNow = () => {
          job()
            .then((result) => {
              runningCount = 0
              resolve(result)
              drainNext()
            })
            .catch((err: unknown) => {
              // `repairComponent` itself never throws (it catches
              // internally), but a fake/test job or a future caller might —
              // guard here too so a bug in the job can never wedge the
              // queue (leaving `runningCount` stuck at 1 forever).
              runningCount = 0
              resolve({
                outcome: "failed",
                reason: err instanceof Error ? err.message : String(err),
              })
              drainNext()
            })
        }

        if (runningCount === 0) {
          runningCount = 1
          runNow()
          return
        }

        if (pending.length >= cap) {
          resolve({
            outcome: "failed",
            reason: `repair queue full (cap ${cap}); this component's auto-repair was skipped`,
          })
          return
        }

        pending.push(runNow)
      })
    },
  }
}
