/**
 * Local-file ScreenshotPlanStore.
 *
 * Layout (one file per plan — the spec's "data plan" the replay engine
 * interprets):
 *   `<repoRoot>/.desde/screenshot-plans/<id>.json`                — plan metadata
 *   `<repoRoot>/.desde/screenshot-plans/<id>/screenshots.json`    — per-plan screenshots
 *
 * Screenshots are stored as data: URLs in JSON for v1 (matches the existing
 * FlowScreenshot shape, reused here). Mirrors `local-flow-store.ts`; the only
 * structural difference is per-plan files instead of one `flows.json` array,
 * because the spec persists each plan at its own `<id>.json` path.
 */

import { rm } from "node:fs/promises"
import type { FlowScreenshot } from "../../../../src/types/bridge"
import type {
  ScreenshotPlan,
  ScreenshotPlanCreateInput,
  ScreenshotPlanStore,
  ScreenshotPlanUpdatePatch,
} from "../../../../src/editor/core"
import {
  listDir,
  mutate,
  newId,
  nowIso,
  readJsonFile,
  resolveStorePath,
  resolveStoreRemovalPath,
  writeJsonFile,
} from "./local-store-base.js"

const PLANS_SUBDIR = "screenshot-plans"

function plansDir(repoRoot: string): string {
  return resolveStorePath(repoRoot, PLANS_SUBDIR)
}

function planPath(repoRoot: string, id: string): string {
  return resolveStorePath(repoRoot, PLANS_SUBDIR, `${id}.json`)
}

function planScreenshotsPath(repoRoot: string, id: string): string {
  return resolveStorePath(repoRoot, PLANS_SUBDIR, id, "screenshots.json")
}

// Only ever `rm(..., { recursive: true })`'d — resolved through the
// removal-time guard rather than `resolveStorePath`.
function planScreenshotsDir(repoRoot: string, id: string): string {
  return resolveStoreRemovalPath(repoRoot, PLANS_SUBDIR, id)
}

export function createLocalScreenshotPlanStore(
  repoRoot: string,
): ScreenshotPlanStore {
  return {
    async list() {
      const entries = await listDir(plansDir(repoRoot))
      const plans: ScreenshotPlan[] = []
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue
        const plan = await readJsonFile<ScreenshotPlan | null>(
          resolveStorePath(repoRoot, PLANS_SUBDIR, entry),
          null,
        )
        if (plan) plans.push(plan)
      }
      // Stable, newest-first ordering. createdAt is ISO-8601 so a string
      // compare sorts chronologically.
      plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return plans
    },

    async get(id) {
      return readJsonFile<ScreenshotPlan | null>(planPath(repoRoot, id), null)
    },

    async create(input: ScreenshotPlanCreateInput) {
      const id = newId()
      const path = planPath(repoRoot, id)
      return mutate(path, async () => {
        const plan: ScreenshotPlan = {
          id,
          name: input.name,
          baseUrl: input.baseUrl,
          source: input.source,
          ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
          steps: input.steps,
          createdAt: nowIso(),
        }
        await writeJsonFile(path, plan)
        return plan
      })
    },

    async update(id: string, patch: ScreenshotPlanUpdatePatch) {
      const path = planPath(repoRoot, id)
      return mutate(path, async () => {
        const existing = await readJsonFile<ScreenshotPlan | null>(path, null)
        if (!existing) throw new Error(`Screenshot plan ${id} not found`)
        const next: ScreenshotPlan = {
          ...existing,
          name: patch.name ?? existing.name,
          steps: patch.steps ?? existing.steps,
          // Only override prompt when the patch supplies one; otherwise keep
          // existing as-is (absent stays absent — no stray `prompt: undefined`).
          ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
        }
        await writeJsonFile(path, next)
        return next
      })
    },

    async delete(id: string) {
      const path = planPath(repoRoot, id)
      return mutate(path, async () => {
        const existing = await readJsonFile<ScreenshotPlan | null>(path, null)
        if (!existing) throw new Error(`Screenshot plan ${id} not found`)
        await rm(path, { force: true })
        // Best-effort cleanup of the per-plan screenshots directory.
        // Swallow errors — leaving an orphaned directory is preferable to
        // failing the delete if cleanup hits a permissions issue.
        await rm(planScreenshotsDir(repoRoot, id), {
          recursive: true,
          force: true,
        }).catch(() => {})
      })
    },

    async saveScreenshots(planId: string, screenshots: FlowScreenshot[]) {
      const path = planScreenshotsPath(repoRoot, planId)
      await mutate(path, async () => {
        await writeJsonFile(path, screenshots)
      })
    },

    async getScreenshots(planId: string) {
      return readJsonFile<FlowScreenshot[]>(
        planScreenshotsPath(repoRoot, planId),
        [],
      )
    },
  }
}
