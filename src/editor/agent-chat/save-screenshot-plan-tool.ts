/**
 * `mcp__editor__save_screenshot_plan` handler (Phase 3 of
 * editor-screenshot-flows.md). The agent walks a flow live (navigate +
 * interact + capture_screenshot) and then EMITS a durable, semantic
 * `ScreenshotPlan` via this tool. The plan is validated and written to
 * `<worktree>/.desde/screenshot-plans/<id>.json` — the same on-disk format
 * the `ScreenshotPlanStore` reads, so the deterministic replay (and the shell's
 * replay-then-persist-to-Canvas flow) picks it up with no further work.
 *
 * Writes the JSON directly (no dependency on editor-cli's store impl — wrong
 * layering direction) but matches its format exactly: `{ id, name, baseUrl,
 * source, prompt?, steps, createdAt }`. Path resolution goes through the vetted
 * `resolveRepoPath` (realpath + traversal guard).
 */

import { randomUUID } from 'node:crypto'

import {
  validateScreenshotPlan,
  type ScreenshotPlan,
  type ScreenshotPlanStep,
} from '../core'
import type { FileWriteToolResult } from './editor-tools'
import { writePlanFile } from './screenshot-plan-io'

export interface SaveScreenshotPlanInput {
  name: string
  baseUrl: string
  prompt?: string
  steps: ScreenshotPlanStep[]
}

export interface SaveScreenshotPlanHandlerOpts {
  worktreeRoot: string | undefined
  input: SaveScreenshotPlanInput
}

function fwError(text: string): FileWriteToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

export async function saveScreenshotPlanHandler(
  opts: SaveScreenshotPlanHandlerOpts,
): Promise<FileWriteToolResult> {
  const { worktreeRoot, input } = opts
  if (!worktreeRoot) {
    return fwError(
      'save_screenshot_plan requires an active worktree session. Not in a worktree-session run.',
    )
  }

  const plan: ScreenshotPlan = {
    id: randomUUID(),
    name: input.name,
    baseUrl: input.baseUrl,
    source: 'prompt',
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    steps: input.steps ?? [],
    createdAt: new Date().toISOString(),
  }

  const validation = validateScreenshotPlan(plan)
  if (!validation.valid) {
    return fwError(
      `save_screenshot_plan: the plan is malformed and was not saved: ${validation.errors.join('; ')}`,
    )
  }

  const written = await writePlanFile(worktreeRoot, plan)
  if (!written.ok) {
    return fwError(`save_screenshot_plan: write failed: ${written.reason}`)
  }
  const rel = written.rel

  const navCount = plan.steps.filter((s) => s.kind === 'navigate').length
  const interactCount = plan.steps.filter((s) => s.kind === 'interact').length
  const captureCount = plan.steps.filter((s) => s.kind === 'capture').length
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          planId: plan.id,
          name: plan.name,
          steps: plan.steps.length,
          breakdown: { navigate: navCount, interact: interactCount, capture: captureCount },
          path: rel,
        }),
      },
    ],
  }
}
