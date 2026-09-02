/**
 * Rate-card resolution for every model the picker can offer.
 *
 * Mirrors the coverage pattern in
 * agent-chat-sdk/resolve-thinking-config.test.ts: the cost ceiling
 * math in run-chat-turn-sdk.ts's computeSessionCost calls
 * estimateUsageCost(turn.model, ...), which silently falls back to
 * UNKNOWN_MODEL_RATE for any id missing from RATE_CARDS. A catalog
 * model with no rate-card entry doesn't error — it just gets priced
 * at the conservative Opus-tier fallback, which is wrong (and
 * expensive-looking) for e.g. Haiku. This suite asserts every
 * catalog id resolves to its own entry, not the fallback.
 */
import { describe, expect, it } from 'vitest'
import { getRateCard, UNKNOWN_MODEL_RATE } from './rate-cards'
import { ANTHROPIC_MODEL_CATALOG } from './anthropic-model-catalog'

describe('getRateCard — catalog coverage', () => {
  for (const model of ANTHROPIC_MODEL_CATALOG.models) {
    it(`resolves a non-fallback rate card for ${model.id}`, () => {
      const card = getRateCard(model.id)
      // Reference identity, not value equality: some catalog models
      // (Opus-tier) legitimately share UNKNOWN_MODEL_RATE's numbers,
      // so a value comparison can't distinguish "found its own entry"
      // from "fell through to the fallback". Object identity can.
      expect(
        card,
        `'${model.id}' resolved to UNKNOWN_MODEL_RATE — add a RATE_CARDS entry`,
      ).not.toBe(UNKNOWN_MODEL_RATE)
    })
  }

  it('falls back to the conservative default for a genuinely unknown id', () => {
    expect(getRateCard('some-model-nobody-published-pricing-for')).toBe(
      UNKNOWN_MODEL_RATE,
    )
  })
})
