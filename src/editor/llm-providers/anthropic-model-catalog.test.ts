import { describe, expect, it } from 'vitest'
import { ANTHROPIC_MODEL_CATALOG } from './anthropic-model-catalog'
import { defaultModelConfig } from '../core/model-catalog'
import { DEFAULT_SDK_MODEL } from '../agent-chat-sdk/run-chat-turn-sdk'

describe('ANTHROPIC_MODEL_CATALOG', () => {
  it('has providerId anthropic and a non-empty model list', () => {
    expect(ANTHROPIC_MODEL_CATALOG.providerId).toBe('anthropic')
    expect(ANTHROPIC_MODEL_CATALOG.models.length).toBeGreaterThan(0)
  })

  it('marks exactly one default, matching the SDK runtime default', () => {
    const defaults = ANTHROPIC_MODEL_CATALOG.models.filter((m) => m.isDefault)
    expect(defaults).toHaveLength(1)
    expect(defaults[0].id).toBe(DEFAULT_SDK_MODEL)
    expect(defaultModelConfig(ANTHROPIC_MODEL_CATALOG)).toEqual({
      provider: 'anthropic',
      model: DEFAULT_SDK_MODEL,
    })
  })

  it('gives Haiku no effort levels and Opus 4.8 the full ladder', () => {
    const haiku = ANTHROPIC_MODEL_CATALOG.models.find((m) => m.id === 'claude-haiku-4-5')
    expect(haiku?.effortLevels).toBeNull()
    const opus48 = ANTHROPIC_MODEL_CATALOG.models.find((m) => m.id === 'claude-opus-4-8')
    expect(opus48?.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('has unique model ids', () => {
    const ids = ANTHROPIC_MODEL_CATALOG.models.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
