/**
 * Read/write a persisted ScreenshotPlan JSON in the worktree, in the exact
 * on-disk format the `ScreenshotPlanStore` uses
 * (`.desde/screenshot-plans/<id>.json`). Shared by the `save_screenshot_plan`
 * and `heal_plan_step` tools. Path resolution goes through the vetted
 * `resolveRepoPath` (realpath + traversal guard).
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { resolveRepoPath } from '../agent-tools/read-tools'
import { resolveSafeCreatePath } from '../edit-service/safe-create-path'
import type { ScreenshotPlan } from '../core'

/** Plan ids are uuids; reject anything that could escape the plans dir. */
export function isSafePlanId(planId: string): boolean {
  return typeof planId === 'string' && /^[A-Za-z0-9._-]+$/.test(planId) && !planId.includes('..')
}

function planRel(planId: string): string {
  return `.desde/screenshot-plans/${planId}.json`
}

export async function readPlanFile(
  worktreeRoot: string,
  planId: string,
): Promise<ScreenshotPlan | null> {
  if (!isSafePlanId(planId)) return null
  const safe = await resolveRepoPath(worktreeRoot, planRel(planId))
  if (!safe.ok) return null
  try {
    return JSON.parse(await readFile(safe.absolute, 'utf8')) as ScreenshotPlan
  } catch {
    return null
  }
}

export async function writePlanFile(
  worktreeRoot: string,
  plan: ScreenshotPlan,
): Promise<{ ok: true; rel: string } | { ok: false; reason: string }> {
  if (!isSafePlanId(plan.id)) return { ok: false, reason: `invalid plan id '${plan.id}'` }
  const rel = planRel(plan.id)
  const safe = await resolveRepoPath(worktreeRoot, rel)
  if (!safe.ok) return { ok: false, reason: safe.reason }
  // Overwrite of an existing plan (heal re-saves by id): `resolveRepoPath`
  // realpath'd the leaf, so its containment check already covers a symlink
  // escape. NEW-file create (the common save_screenshot_plan case): the leaf
  // doesn't exist yet, so `resolveRepoPath` only did the LEXICAL check — a
  // symlinked ancestor (`.desde` or `.desde/screenshot-plans`
  // pointing outside the worktree) would let the subsequent mkdir/writeFile
  // escape. Validate the create path with the symlink-aware ancestor walk, the
  // same guard the new-SFC scaffold + Write lanes use.
  let absolute = safe.absolute
  if (!existsSync(safe.absolute)) {
    const create = await resolveSafeCreatePath(worktreeRoot, rel)
    if (!create.ok) return { ok: false, reason: create.reason }
    absolute = create.absolute
  }
  try {
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, JSON.stringify(plan, null, 2), 'utf8')
    return { ok: true, rel }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}
