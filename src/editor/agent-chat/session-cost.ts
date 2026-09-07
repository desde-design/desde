/**
 * What a chat session has cost so far.
 *
 * Lives here rather than inside either runtime because BOTH check it, and a
 * second copy would be a second answer. `archivedCostUsd` is what keeps a long
 * session honest: `saveSession` rolls the oldest turns into a sidecar once the
 * retention cap is passed, and without folding their summed cost back in, a
 * session's ceiling check would silently reset as it aged.
 *
 * Every per-turn figure goes through the shared `costOfTurn`, the same formula
 * `sumTurnCostUsd` uses when it archives a turn, so a usage-only turn prices
 * identically whether it is still in `turns` or already in `archivedCostUsd`.
 */

import { costOfTurn } from '../llm-providers/rate-cards'
import type { ChatSession } from './types'

export function computeSessionCost(session: ChatSession): number {
  let total = session.archivedCostUsd ?? 0
  for (const turn of session.turns) total += costOfTurn(turn)
  return total
}
