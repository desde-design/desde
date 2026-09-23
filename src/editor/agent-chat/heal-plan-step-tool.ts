/**
 * `mcp__editor__heal_plan_step` handler (Phase 4 of
 * editor-screenshot-flows.md) — the correctness-critical self-heal.
 *
 * After deterministic replay reports an interact step can't be resolved, the
 * agent re-finds the element by the step's NL intent and proposes a semantic
 * target. This tool **independently re-resolves that proposal against the live
 * page (via the bridge — not the agent's word) and validates it matches the
 * step's ORIGINAL intent BEFORE writing the new selector back into the plan**.
 * A rejected proposal is never written — the agent must pick the right element
 * or report it's gone. A validated heal rewrites `target.resolvedSelector`
 * (+ role/name) so the next replay is deterministic again.
 */

import type { BridgeClient } from '../agent-tools/types'
import {
  applyHealToStep,
  validateHealedTarget,
  type LiveResolution,
} from '../replay/heal-plan-step'
import type { FileWriteToolResult } from './editor-tools'
import { readPlanFile, writePlanFile } from './screenshot-plan-io'

export interface HealPlanStepInput {
  planId: string
  stepIndex: number
  /** The agent's re-identified semantic target for the broken step. */
  target: { role?: string; name?: string; text?: string }
}

export interface HealPlanStepHandlerOpts {
  worktreeRoot: string | undefined
  bridge: BridgeClient
  signal?: AbortSignal
  input: HealPlanStepInput
}

function fwError(text: string): FileWriteToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

export async function healPlanStepHandler(
  opts: HealPlanStepHandlerOpts,
): Promise<FileWriteToolResult> {
  const { worktreeRoot, bridge, signal, input } = opts
  if (!worktreeRoot) {
    return fwError('heal_plan_step requires an active worktree session.')
  }

  const plan = await readPlanFile(worktreeRoot, input.planId)
  if (!plan) {
    return fwError(`heal_plan_step: screenshot plan '${input.planId}' not found.`)
  }
  const idx = input.stepIndex
  if (!Number.isInteger(idx) || idx < 0 || idx >= plan.steps.length) {
    return fwError(
      `heal_plan_step: step index ${idx} is out of range (the plan has ${plan.steps.length} steps).`,
    )
  }
  const step = plan.steps[idx]
  if (step.kind !== 'interact') {
    return fwError(
      `heal_plan_step: step ${idx} is a '${step.kind}' step: only interact steps can be healed.`,
    )
  }

  // Independently re-resolve the agent's proposed target on the LIVE page.
  // We read role + name + selector from the page, NOT from the agent's claim —
  // this is the "never trust the first re-resolution" gate.
  let live: LiveResolution | null
  try {
    live = (await bridge.send(
      'chat:resolve_target',
      { target: { role: input.target.role, name: input.target.name, text: input.target.text } },
      { signal, timeoutMs: 15_000 },
    )) as LiveResolution | null
  } catch (err) {
    return fwError(`heal_plan_step: live re-resolution failed: ${(err as Error).message}`)
  }

  // Validate the live resolution against the step's ORIGINAL recorded intent.
  const validation = validateHealedTarget(step, live)
  if (!validation.valid) {
    return fwError(
      `heal_plan_step REJECTED (the plan was NOT changed): ${validation.reason}`,
    )
  }

  // Validated — write the new selector back and persist.
  const healedStep = applyHealToStep(step, live as LiveResolution)
  const nextPlan = {
    ...plan,
    steps: plan.steps.map((s, i) => (i === idx ? healedStep : s)),
  }
  const written = await writePlanFile(worktreeRoot, nextPlan)
  if (!written.ok) {
    return fwError(`heal_plan_step: write failed: ${written.reason}`)
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          planId: plan.id,
          stepIndex: idx,
          healed: {
            resolvedSelector: healedStep.target?.resolvedSelector,
            role: healedStep.target?.role,
            name: healedStep.target?.name,
          },
        }),
      },
    ],
  }
}
