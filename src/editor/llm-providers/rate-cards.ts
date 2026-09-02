/**
 * Per-model rate cards for cost estimation (Phase 5).
 *
 * Used by the chat orchestrator to compute a running per-session
 * dollar estimate and refuse new turns when the configured cost
 * ceiling is hit. Numbers are USD per 1M tokens, as of late 2025;
 * update when providers publish new pricing. Unknown models get a
 * conservative default so we never under-bill (and thus never let an
 * unknown model slip past the ceiling unnoticed).
 *
 * No live API call — these are static lookups. Bypassable by editing
 * this file, which is acceptable: the ceiling is a designer-facing
 * affordance to avoid runaway spend on a long session, not a billing
 * boundary. The provider's own usage-API is the source of truth.
 *
 * **This is the ONE place per-turn dollar cost is computed** (audit
 * Task 15, codex round 4 P2). Two independent call sites need the
 * exact same per-turn formula and previously didn't have it:
 * `computeSessionCost` (`run-chat-turn-sdk.ts`, the cost-ceiling
 * check) and the turns-archive sum (`session-turns-archive.ts`,
 * `sumTurnCostUsd` — what a trimmed turn's cost gets folded into
 * `archivedCostUsd` as). Before the fix, the archive sum only looked
 * at `turn.costUsd` and silently treated a usage-only turn (no
 * vendor-reported cost, common for turns captured before
 * `total_cost_usd` was wired up, or non-SDK legacy turns) as **zero**
 * — once that turn left the head file, its real (rate-card-estimated)
 * cost vanished from the running total, and a long session could blow
 * past a configured ceiling without ever tripping it. `costOfTurn`
 * below is the shared formula both call sites now use, so they can't
 * drift apart again.
 */

export interface ModelRateCard {
  /** USD per 1M input tokens. */
  inputPerM: number
  /** USD per 1M output tokens. */
  outputPerM: number
}

/**
 * Conservative fallback for unknown models. ~$15 in / $75 out
 * (roughly Anthropic Opus tier). Picked high enough that an unknown
 * model never under-bills against the ceiling — overestimate by
 * design so the ceiling triggers safely.
 */
export const UNKNOWN_MODEL_RATE: ModelRateCard = {
  inputPerM: 15,
  outputPerM: 75,
}

const RATE_CARDS: Record<string, ModelRateCard> = {
  // Anthropic — late-2025 published pricing tiers.
  'claude-haiku-4-5-20251001': { inputPerM: 1, outputPerM: 5 },
  'claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15 },
  'claude-opus-4-7': { inputPerM: 15, outputPerM: 75 },
  // Bare catalog ids used by ANTHROPIC_MODEL_CATALOG /
  // ChatSession.modelConfig.model — see anthropic-model-catalog.ts.
  // Not separately published by the repo; priced by family tier.
  // family-tier estimate, verify against published pricing
  'claude-haiku-4-5': { inputPerM: 1, outputPerM: 5 },
  // family-tier estimate, verify against published pricing
  'claude-sonnet-5': { inputPerM: 3, outputPerM: 15 },
  // family-tier estimate, verify against published pricing
  'claude-opus-4-8': { inputPerM: 15, outputPerM: 75 },
  // family-tier estimate, verify against published pricing
  'claude-opus-5': { inputPerM: 15, outputPerM: 75 },
  // OpenAI — guesses based on the gpt-5.x family. Update when pricing
  // is published. The "unknown model" fallback is intentionally
  // identical to Opus so cost estimates stay conservative.
  'gpt-5.2': { inputPerM: 5, outputPerM: 15 },
  'gpt-5.2-codex': { inputPerM: 5, outputPerM: 15 },
}

export function getRateCard(model: string): ModelRateCard {
  return RATE_CARDS[model] ?? UNKNOWN_MODEL_RATE
}

/**
 * Compute the dollar cost of a usage record at this model's rate.
 * Returns a fractional dollar value.
 */
export function estimateUsageCost(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): number {
  const card = getRateCard(model)
  return (
    (usage.inputTokens * card.inputPerM) / 1_000_000 +
    (usage.outputTokens * card.outputPerM) / 1_000_000
  )
}

/**
 * The minimal shape `costOfTurn` needs — deliberately structural
 * (not `import type { ChatTurn }`) so this leaf module doesn't take a
 * hard dependency on the chat-session schema; any caller with a
 * turn-shaped object can use it.
 */
export interface CostableTurn {
  costUsd?: number
  usage?: { inputTokens: number; outputTokens: number }
  model?: string
}

/**
 * Single per-turn dollar-cost formula, precedence order:
 *   1. `turn.costUsd` — vendor-reported (SDK `total_cost_usd`).
 *      Ground truth when present; never re-estimated even if `usage`
 *      is ALSO present (a stale/approximate usage record must not
 *      override a real reported cost).
 *   2. `turn.usage` — rate-card ESTIMATE via `estimateUsageCost`, for
 *      turns that never captured a vendor cost.
 *   3. Neither present → `0`. Not an estimate — there's nothing to
 *      estimate FROM, and inventing a number here would be worse than
 *      undercounting a turn we have zero information about.
 *
 * Every cost-ceiling / archival computation in this codebase MUST
 * route through this function (see the module doc comment above) —
 * `computeSessionCost` and `sumTurnCostUsd` both do.
 */
export function costOfTurn(turn: CostableTurn): number {
  if (typeof turn.costUsd === 'number') return turn.costUsd
  if (turn.usage) return estimateUsageCost(turn.model ?? 'unknown-model', turn.usage)
  return 0
}
