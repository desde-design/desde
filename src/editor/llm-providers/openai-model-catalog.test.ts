import { describe, expect, it } from 'vitest'
import { OPENAI_MODEL_CATALOG } from './openai-model-catalog'

describe('OPENAI_MODEL_CATALOG', () => {
  it('names the openai provider', () => {
    expect(OPENAI_MODEL_CATALOG.providerId).toBe('openai')
  })

  it('has exactly one default', () => {
    const defaults = OPENAI_MODEL_CATALOG.models.filter((m) => m.isDefault)
    expect(defaults.map((m) => m.id)).toEqual(['gpt-5.6'])
  })

  it('gives every model the five-level ladder Desde and OpenAI share', () => {
    for (const model of OPENAI_MODEL_CATALOG.models) {
      expect(model.effortLevels, model.id).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    }
  })

  it('has no duplicate ids and a label on every entry', () => {
    const ids = OPENAI_MODEL_CATALOG.models.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const model of OPENAI_MODEL_CATALOG.models) {
      expect(model.label.length, model.id).toBeGreaterThan(0)
    }
  })
})
