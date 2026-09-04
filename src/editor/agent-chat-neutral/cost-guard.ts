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
 * A third thing is lost and CANNOT be replaced here: an ABORTED step costs
 * nothing against the ceiling. Usage only arrives on the vendor's `finish`
 * message, and an abort closes the stream before one is sent, so the tokens
 * the vendor has already billed for the partial generation are never
 * recorded. Repeatedly starting and stopping long steps therefore accrues
 * real spend and no ceiling pressure. This is inherent to the wire format —
 * the vendor has not reported the usage yet, so there is nothing to record —
 * and it is written down here rather than fixed, next to the step-boundary
 * overshoot above.
 */

import { estimateUsageCost } from '../llm-providers/rate-cards'

export interface CostGuardInput {
  model: string
  /** What this session had already spent before this turn. */
  priorCostUsd: number
  /** Session-cumulative ceiling. Undefined means no ceiling. */
  ceilingUsd?: number
}

export interface CostGuard {
  record(usage: { inputTokens: number; outputTokens: number }): void
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
