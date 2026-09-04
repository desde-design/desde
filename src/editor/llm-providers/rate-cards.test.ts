/**
 * Rate-card resolution for every model any provider's picker can offer.
 *
 * This used to iterate ANTHROPIC_MODEL_CATALOG by name, which made it blind to
 * a second provider by construction. It now iterates the descriptor table, so a
 * vendor added in phase 6 is covered the moment its descriptor is registered
 * and cannot quietly price at UNKNOWN_MODEL_RATE.
 *
 * Why that matters more than it used to: on the Claude Agent SDK lane the
 * vendor reports a dollar figure and the rate card is decoration. On the
 * neutral lane there is no such figure, so the card IS the cost ceiling. A
 * missing entry prices a cheap model at the Opus-tier fallback and refuses
 * turns the user has the budget for.
 */
import { describe, expect, it } from 'vitest'
import { getRateCard, UNKNOWN_MODEL_RATE } from './rate-cards'
import { PROVIDER_DESCRIPTORS } from './provider-registry'

describe('getRateCard — descriptor-table coverage', () => {
  for (const descriptor of PROVIDER_DESCRIPTORS) {
    for (const model of descriptor.staticCatalog.models) {
      it(`resolves a non-fallback rate card for ${descriptor.id}/${model.id}`, () => {
        const card = getRateCard(model.id)
        // Reference identity, not value equality: an Opus-tier model
        // legitimately shares UNKNOWN_MODEL_RATE's numbers, so only identity
        // can tell "found its own entry" from "fell through".
        expect(
          card,
          `'${model.id}' resolved to UNKNOWN_MODEL_RATE — add a RATE_CARDS entry`,
        ).not.toBe(UNKNOWN_MODEL_RATE)
      })
    }
  }

  it('falls back to the conservative default for a genuinely unknown id', () => {
    expect(getRateCard('some-model-nobody-published-pricing-for')).toBe(UNKNOWN_MODEL_RATE)
  })

  it('prices gpt-5.2 at the published rate, not the old guess', () => {
    // The row that sat here said $5 / $15. Measured: $1.75 / $14. Output was
    // wrong by a factor of three in the cheap direction, which is the direction
    // that lets a session overrun its ceiling.
    expect(getRateCard('gpt-5.2')).toEqual({ inputPerM: 1.75, outputPerM: 14 })
  })
})
