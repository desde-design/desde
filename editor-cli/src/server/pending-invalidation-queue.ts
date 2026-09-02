/**
 * Durable, `DriftLog`-independent queue for manifest-invalidation delivery
 * (Phase 5 Task 2 root-cause fix — see
 * `.superpowers/sdd/2026-07-29-grounding-phase5-drift/final-fix-report.md`).
 *
 * Background: before this module, `drift-handler.ts` DERIVED the
 * `invalidate` field every response carries from the drift LOG itself — a
 * response scanned `driftLog.list()` for entries whose `repair.outcome` was
 * `'repaired'`/`'seeded'`. That derivation is fundamentally unsound because
 * a `DriftEntry` is EPHEMERAL: `POST …/:key/…` dismiss and the base-route
 * `DELETE` (clear-all) both delete entries outright. A repair triggered by
 * `maybeTriggerRepair` runs fire-and-forget — it can settle at ANY time
 * after the triggering POST's response has already gone out — so if the
 * user dismisses (or clears) the entry before its repair settles, the
 * settle's `.then` callback in `drift-handler.ts` mutates a `DriftEntry`
 * object that is no longer reachable from `driftLog.list()`. The write
 * still happens on disk (a fresh manifest IS cached), but nothing ever
 * reports it to the shell again — `CachedManifestLookup` stays stale for
 * the rest of the process. This was patched twice before as narrow special
 * cases (capture-before-clear on the two DELETE routes) and each patch
 * missed this exact "dismissed while still pending" gap, because the
 * capture only sees whatever `entry.repair` already IS at dismiss time —
 * `pending` has no outcome yet to capture.
 *
 * The fix: stop deriving invalidation from the log at all. When a repair
 * SETTLES with an outcome that wrote a manifest (`'repaired'`/`'seeded'`),
 * it enqueues its own delivery record here — independent of whether the
 * triggering `DriftEntry` still exists. Every drift response (`GET`, `POST`,
 * both `DELETE` routes) drains this queue wholesale into its `invalidate`
 * field, so:
 *
 *   - A repair that settles after its entry was dismissed still gets
 *     delivered on the NEXT response of any kind (nothing to derive from
 *     the log, so dismissal can't erase it).
 *   - A settled repair is delivered EXACTLY ONCE — `drain()` empties the
 *     queue, unlike the old log-scan (which re-reported a `repaired`/
 *     `seeded` entry on every subsequent GET for as long as it stayed in
 *     the log).
 *   - Clear-all can never lose a pending repair's eventual invalidation —
 *     the repair's settle-time enqueue doesn't touch the log at all.
 *
 * One instance is constructed per process (alongside `DriftLog` and
 * `RepairQueue` in `http-server.ts`) and threaded through
 * `DriftHandlerCtx.pendingInvalidations` — NOT per-request, or every
 * response would drain (and lose) whatever a concurrent settle just
 * enqueued a moment earlier.
 */

/** One `(component, importPath)` pair whose on-disk manifest just changed, with the repair attempt's own identity for client-side dedupe. Same shape the `invalidate` field has always carried — this module only changes HOW it's assembled, not its wire contract. */
export interface PendingInvalidation {
  name: string
  importPath?: string
  attemptedAt: string
}

/** Max entries held before a settle is delivered — bounded so an unbounded string of settled repairs with no client ever polling can't grow this without limit. Generous relative to `MAX_SIGNALS_PER_REQUEST` (50): several full batches' worth of repairs could settle before any response drains them. */
export const PENDING_INVALIDATION_QUEUE_CAP = 100

export interface PendingInvalidationQueue {
  /** Record a settled repair's invalidation. Never throws, never blocks. */
  enqueue(invalidation: PendingInvalidation): void
  /** Return every invalidation recorded since the last `drain()`, and empty the queue — a settled repair is reported exactly once. */
  drain(): PendingInvalidation[]
}

/** Production + test factory. `cap` defaults to {@link PENDING_INVALIDATION_QUEUE_CAP}; tests may pass a small cap to exercise the drop-oldest path without needing a hundred fake settles. */
export function createPendingInvalidationQueue(
  cap: number = PENDING_INVALIDATION_QUEUE_CAP,
): PendingInvalidationQueue {
  let items: PendingInvalidation[] = []

  return {
    enqueue(invalidation) {
      items.push(invalidation)
      if (items.length > cap) {
        const dropped = items.shift()
         
        // signal: a dropped invalidation means some component's manifest
        // cache can go stale until the NEXT drift/repair for it, which is
        // worth a server log line even though it's not fatal to anything.
        console.warn(
          `[editor-cli] pending-invalidation queue exceeded cap (${cap}); dropped oldest entry for '${dropped?.name}'.`,
        )
      }
    },
    drain() {
      const drained = items
      items = []
      return drained
    },
  }
}
