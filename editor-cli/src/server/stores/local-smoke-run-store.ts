/**
 * Persistence for smoke-run history under `.desde/smoke-runs/`.
 *
 * Layout:
 *   <root>/.desde/smoke-runs/index.json  — array of run summaries,
 *                                               newest-first, capped at 20.
 *   <root>/.desde/smoke-runs/<runId>/     — per-run dir holding
 *                                               `report.json` + screenshots
 *                                               (written by runSmoke itself
 *                                               when `artifactsDir` is passed).
 *
 * Persists under `canonicalRoot` (the user's stable repo root) so history
 * survives session churn — the per-session worktree path can change across
 * CLI restarts, but the canonical root is stable.
 */

import { rm } from "node:fs/promises"
import { resolve as resolvePath, dirname } from "node:path"
import {
  resolveStorePath,
  readJsonFile,
  writeJsonFile,
  mutate,
} from "./local-store-base.js"
import type { SmokeReport } from "../../smoke/types.js"

/** Canonical path to the smoke-runs index under a given repo root. */
function indexPath(root: string): string {
  return resolveStorePath(root, "smoke-runs", "index.json")
}

/** Maximum number of run summaries + their artifact dirs to retain. */
const MAX_RUNS = 20

export interface SmokeRunSummary {
  id: string
  startedAt: string
  ok: boolean
  totalRoutes: number
  failedRoutes: number
  durationMs: number
  artifactsDir: string
  routes: { route: string; ok: boolean }[]
}

/**
 * Build a `SmokeRunSummary` from a completed `SmokeReport` and a
 * caller-supplied `runId`. The `artifactsDir` is the dir the caller
 * passed to `runSmoke` — it is owned by the caller (already exists +
 * populated by the time we're called), so we just record its path.
 */
function summaryFromReport(
  runId: string,
  artifactsDir: string,
  report: SmokeReport,
): SmokeRunSummary {
  return {
    id: runId,
    startedAt: report.startedAt,
    ok: report.ok,
    totalRoutes: report.routes.length,
    failedRoutes: report.routes.filter((r) => !r.ok).length,
    durationMs: report.durationMs,
    artifactsDir,
    routes: report.routes.map((r) => ({ route: r.route, ok: r.ok })),
  }
}

/**
 * Prepend a new run summary to the index, pruning entries beyond the
 * cap (and their on-disk artifact dirs, best-effort). Returns the
 * newly created summary.
 *
 * Serialized via the `mutate()` mutex on the index file so concurrent
 * smoke-test requests don't corrupt the list.
 */
export async function addSmokeRun(
  root: string,
  runId: string,
  report: SmokeReport,
): Promise<SmokeRunSummary> {
  const artifactsDir = resolveStorePath(root, "smoke-runs", runId)
  const summary = summaryFromReport(runId, artifactsDir, report)
  const path = indexPath(root)

  await mutate(path, async () => {
    const current = await readJsonFile<SmokeRunSummary[]>(path, [])
    const updated = [summary, ...current]
    const keep = updated.slice(0, MAX_RUNS)
    const prune = updated.slice(MAX_RUNS)

    await writeJsonFile(path, keep)

    // Best-effort removal of pruned run artifact directories. NEVER trust
    // the persisted `artifactsDir` for deletion — a tampered/corrupted
    // index.json could point `rm -rf` at any path the process can reach
    // (arbitrary-delete primitive). Reconstruct the dir from the run id
    // under smoke-runs/ and require strict containment before deleting.
    const smokeRunsDir = resolveStorePath(root, "smoke-runs")
    for (const old of prune) {
      const dir = resolvePath(smokeRunsDir, old.id)
      // Require a DIRECT child of smoke-runs/: rejects "" (the dir itself),
      // "../escape", and nested "a/b" ids alike.
      if (dirname(dir) !== smokeRunsDir) continue
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  return summary
}

/**
 * Return the most recent smoke run summaries, newest first.
 * Defaults to all retained (up to `MAX_RUNS`).
 */
export async function listSmokeRuns(
  root: string,
  limit?: number,
): Promise<SmokeRunSummary[]> {
  const runs = await readJsonFile<SmokeRunSummary[]>(indexPath(root), [])
  return limit !== undefined ? runs.slice(0, limit) : runs
}

