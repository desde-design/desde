/**
 * The dollar ceiling, enforced by the loop.
 *
 * Two things are lost relative to the SDK lane and replaced here. The vendor's
 * own `total_cost_usd`, which this lane never receives, becomes a rate-card
 * estimate from the `usage` events. And the vendor's in-flight
 * `maxBudgetUsd` stop becomes a STEP-BOUNDARY stop: the loop checks after each
 * step, so it can overshoot by at most one step's output.
 *
 * The consequence is worth stating because it changes what a stale rate card
 * costs. On the SDK lane a wrong card only mis-renders a number. Here it
 * mis-enforces a spending limit. That is why every descriptor's static catalog
 * is covered by a rate-card assertion, and why an id with no card prices at
 * the conservative fallback rather than at zero.
 *
 * A third thing is only approximated: the cost of a step cut off by a steer
 * or Stop. On the AI SDK transport usage arrives only on the vendor's
 * `finish` part, and an abort closes the stream before one is sent, so the
 * transport reports zero for a request the vendor billed. The loop records
 * an ESTIMATE for such a step instead (`estimate-cut-off-usage.ts`), flagged
 * `estimated: true`, and this guard counts it like any other usage. The
 * estimate errs high, which is the safe direction for a ceiling.
 */

import { estimateUsageCost } from '../llm-providers/rate-cards'
import type { Usage } from '../llm-providers/types'

export interface CostGuardInput {
  model: string
  /** What this session had already spent before this turn. */
  priorCostUsd: number
  /** Session-cumulative ceiling. Undefined means no ceiling. */
  ceilingUsd?: number
}

export interface CostGuard {
  record(usage: Usage): void
  /** True once prior spend plus this turn's estimate crosses the ceiling. */
  readonly exceeded: boolean
  /** This turn's estimated cost so far. */
  readonly turnCostUsd: number
  /** The sentence the user sees when the loop stops for the ceiling. */
  refusalMessage(): string
}

export function createCostGuard(input: CostGuardInput): CostGuard {
  let turnCostUsd = 0
  return {
    record(usage) {
      turnCostUsd += estimateUsageCost(input.model, usage)
    },
    get exceeded() {
      if (typeof input.ceilingUsd !== 'number') return false
      return input.priorCostUsd + turnCostUsd >= input.ceilingUsd
    },
    get turnCostUsd() {
      return turnCostUsd
    },
    refusalMessage() {
      const spent = (input.priorCostUsd + turnCostUsd).toFixed(2)
      return (
        `This session has reached its cost ceiling ($${spent} of $${input.ceilingUsd}). ` +
        'Start a new session, or raise the ceiling, to keep going.'
      )
    },
  }
}
