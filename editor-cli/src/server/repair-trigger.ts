/**
 * Shared repair-triggering logic for drift signals (extracted 2026-07-30,
 * codex P2 follow-up to Phase 5 carry-forward (g)).
 *
 * Originally lived only as `maybeTriggerRepair` inside `drift-handler.ts`,
 * reachable exclusively from `POST /api/editor/drift`. When the
 * server-side `manifest-value-mismatch` producer
 * (`manifest-value-mismatch-drift.ts`) started recording signals directly
 * onto the `DriftLog` — bypassing the POST route entirely — its entries
 * never ran through this logic, so `manifest-value-mismatch` being added to
 * `REPAIRABLE_DRIFT_KINDS` had no effect for the only producer that emits
 * it (no auto re-extract, no invalidation enqueue) unless a client happened
 * to independently POST the same signal. Extracting this into its own
 * module lets BOTH producers — the client-facing POST handler and the
 * server-side producer — call the exact same function, so the repairable-
 * kinds rule, the once-per-entry guard, the single-flight queue, and the
 * invalidation enqueue behave identically no matter which one recorded the
 * entry.
 */

import { REPAIRABLE_DRIFT_KINDS, type DriftEntry, type DriftSignal } from "../../../src/editor/core"
import { repairComponent, type RepairDeps } from "../../../src/editor/drift/repair-component.js"
import type { RepairQueue } from "./repair-queue.js"
import type { PendingInvalidationQueue } from "./pending-invalidation-queue.js"

/**
 * Everything `triggerRepairForEntry` needs from a caller. Both
 * `DriftHandlerCtx` (drift-handler.ts) and
 * `RecordManifestValueMismatchDriftCtx` (manifest-value-mismatch-drift.ts)
 * carry these two fields with this exact shape — either extend this
 * interface directly or structurally satisfy it.
 */
export interface RepairTriggerCtx {
  /**
   * Phase 5 Task 4 (granular repair) wiring. When present, a signal whose
   * `kind` is in `REPAIRABLE_DRIFT_KINDS` on an entry that hasn't been
   * attempted yet THIS PROCESS kicks off `repairComponent` —
   * fire-and-forget (`void … .then(...)`), never awaited by
   * `triggerRepairForEntry`, so a slow/hung re-extract can never delay the
   * caller. Guarded via `entry.repair`: set synchronously to
   * `{ outcome: 'pending' }` the instant a repair is claimed (closes the
   * race where a second signal for the same entry arrives before the first
   * repair settles), then overwritten with the real outcome once
   * `repairComponent`'s promise resolves.
   *
   * Omitted when the caller hasn't wired a `prototypeRoot` (repair is a
   * pure enhancement; its absence never affects signal recording).
   *
   * `queue` serializes every repair through ONE `RepairQueue` — see that
   * module's doc comment for why an unbounded fire-and-forget fan-out of
   * `repairComponent` calls (each running a synchronous TS program) could
   * stall the CLI event loop. MUST be the SAME instance across calls
   * (constructed once per process in `http-server.ts`) — a fresh queue per
   * call would serialize nothing.
   *
   * `onRegistryChange` invalidates the memoized server `GroundingService`
   * (`resetGroundingCache`, wired in `http-server.ts`) so a repair that
   * writes a fresh on-disk manifest is actually visible to the NEXT
   * manifest/catalog request this same process serves — without it, the
   * repair's effect is invisible until a full grounding reset or CLI
   * restart. Optional only so callers that don't care about server-cache
   * invalidation don't need to wire it.
   */
  repair?: { prototypeRoot: string; deps: RepairDeps; queue: RepairQueue; onRegistryChange?: () => void }
  /**
   * Durable, `DriftLog`-independent delivery for manifest invalidations
   * (see `pending-invalidation-queue.ts`'s doc comment for the full "why").
   * A repair triggered here settles asynchronously, possibly after its
   * triggering `DriftEntry` has been dismissed/cleared, so deriving
   * `invalidate` from the (ephemeral) log itself can silently lose a
   * settled repair forever — every drift response drains this queue
   * wholesale instead. Omitted only by callers that don't care about
   * invalidation delivery at all.
   */
  pendingInvalidations?: PendingInvalidationQueue
}

/**
 * Kick off `repairComponent` for `entry` when `kind` (the signal that was
 * JUST recorded) is repairable and no repair has been claimed for this
 * entry yet this process. Fire-and-forget: the returned promise is never
 * awaited or returned to the caller, so this function itself completes
 * synchronously and can never delay whatever recorded the signal — the
 * client-facing `POST /api/editor/drift` response, or (for the
 * server-side producer) the edit response that already went out before
 * this runs.
 *
 * On settle, a `'repaired'`/`'seeded'` outcome (i.e. a fresh manifest was
 * actually WRITTEN to disk for this `(component, importPath)`) enqueues its
 * own invalidation onto `ctx.pendingInvalidations`, independent of whatever
 * has happened to `entry`/the drift log in the meantime (dismissed,
 * cleared, still present). `'unchanged'` (no write), `'failed'`, and
 * `'unsupported'` correctly enqueue nothing — there's nothing new for a
 * client to re-fetch. The same write also resets the caller's memoized
 * grounding service via `ctx.repair.onRegistryChange`, when provided.
 */
export function triggerRepairForEntry(
  kind: DriftSignal["kind"],
  entry: DriftEntry,
  ctx: RepairTriggerCtx,
): void {
  if (!ctx.repair) return
  if (!(REPAIRABLE_DRIFT_KINDS as readonly string[]).includes(kind)) return
  if (entry.repair !== undefined) return // already attempted (or in flight/queued) this process

  const attemptedAt = new Date().toISOString()
  entry.repair = { attemptedAt, outcome: "pending" }
  const { prototypeRoot, deps, queue, onRegistryChange } = ctx.repair
  const component = entry.component
  const importPath = entry.importPath

  void queue
    .enqueue(() =>
      repairComponent({
        entryKey: entry.key,
        component: entry.component,
        importPath: entry.importPath,
        designSystem: entry.designSystem,
        prototypeRoot,
        deps,
      }),
    )
    .then((result) => {
      entry.repair = { attemptedAt, outcome: result.outcome, reason: result.reason }
      if (result.outcome === "repaired" || result.outcome === "seeded") {
        ctx.pendingInvalidations?.enqueue({
          name: component,
          ...(importPath !== undefined ? { importPath } : {}),
          attemptedAt,
        })
        onRegistryChange?.()
      }
    })
}
