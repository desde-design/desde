/**
 * Thinking-mode resolution for every model the picker can offer.
 *
 * This suite is the guard rail described in run-chat-turn-sdk.ts: the
 * expectation table below must cover `ANTHROPIC_MODEL_CATALOG` exactly,
 * so adding a model to the catalog without teaching the resolver fails
 * here rather than silently shipping the wrong thinking config.
 *
 * Why it matters: adaptive-thinking models don't merely ignore a fixed
 * `budgetTokens` — on the current generation the Anthropic API rejects
 * it outright, and `effort` is defined to modulate adaptive thinking.
 * Sending the legacy fixed-budget branch to e.g. Opus 5 is a wrong
 * request, not just a wasted knob.
 */
import { describe, expect, it } from 'vitest'
import {
  resolveThinkingConfig,
  supportsAdaptiveThinking,
} from './run-chat-turn-sdk'
import { ANTHROPIC_MODEL_CATALOG } from '../llm-providers/anthropic-model-catalog'

/**
 * Ground truth from the Anthropic API docs: Opus 4.6/4.7/4.8, Opus 5,
 * Sonnet 4.6, Sonnet 5 and Fable 5 support adaptive thinking (and it is
 * the recommended setting). Haiku 4.5 is an older-generation model that
 * still takes a fixed thinking budget.
 */
const EXPECTED_ADAPTIVE: Record<string, boolean> = {
  'claude-opus-5': true,
  'claude-opus-4-8': true,
  'claude-sonnet-5': true,
  'claude-sonnet-4-6': true,
  'claude-haiku-4-5': false,
}

const ADAPTIVE_CONFIG = { type: 'adaptive', display: 'summarized' } as const
const FIXED_BUDGET_CONFIG = {
  type: 'enabled',
  budgetTokens: 4000,
  display: 'summarized',
} as const

describe('resolveThinkingConfig — catalog coverage', () => {
  it('covers every catalog model (add new models to EXPECTED_ADAPTIVE)', () => {
    const catalogIds = ANTHROPIC_MODEL_CATALOG.models.map((m) => m.id).sort()
    expect(catalogIds).toEqual(Object.keys(EXPECTED_ADAPTIVE).sort())
  })

  for (const model of ANTHROPIC_MODEL_CATALOG.models) {
    it(`resolves the right thinking config for ${model.id}`, () => {
      const adaptive = EXPECTED_ADAPTIVE[model.id]
      expect(
        adaptive,
        `no EXPECTED_ADAPTIVE entry for catalog model '${model.id}'`,
      ).toBeTypeOf('boolean')
      expect(resolveThinkingConfig(model.id)).toEqual(
        adaptive ? ADAPTIVE_CONFIG : FIXED_BUDGET_CONFIG,
      )
    })
  }

  it('never pairs a fixed thinking budget with a model that offers effort', () => {
    // Effort modulates adaptive thinking. A catalog model that exposes
    // effort levels but resolves to the legacy fixed-budget branch would
    // silently cap the reasoning the user asked for.
    for (const model of ANTHROPIC_MODEL_CATALOG.models) {
      if (model.effortLevels === null) continue
      expect(
        resolveThinkingConfig(model.id).type,
        `${model.id} offers effort but resolves to a fixed thinking budget`,
      ).toBe('adaptive')
    }
  })
})

describe('supportsAdaptiveThinking', () => {
  it('accepts every adaptive-thinking family, including ones not in the catalog', () => {
    for (const id of [
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-sonnet-4-6',
      'claude-sonnet-5',
      'claude-fable-5',
    ]) {
      expect(supportsAdaptiveThinking(id), id).toBe(true)
    }
  })

  it('rejects older-generation models', () => {
    for (const id of [
      'claude-haiku-4-5',
      'claude-opus-4-5',
      'claude-opus-4-1',
      'claude-sonnet-4-5',
      'claude-3-7-sonnet-20250219',
    ]) {
      expect(supportsAdaptiveThinking(id), id).toBe(false)
    }
  })

  it('tolerates a dated-snapshot suffix', () => {
    expect(supportsAdaptiveThinking('claude-opus-5-20260401')).toBe(true)
    expect(supportsAdaptiveThinking('claude-sonnet-4-6-20251114')).toBe(true)
  })

  it('does not match a different family by bare prefix', () => {
    // The separator is required, so a hypothetical future id that merely
    // starts with an adaptive family's characters is not swept in.
    expect(supportsAdaptiveThinking('claude-opus-50')).toBe(false)
    expect(supportsAdaptiveThinking('claude-opus-4-80')).toBe(false)
  })
})
