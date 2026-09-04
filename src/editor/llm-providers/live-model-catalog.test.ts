import { describe, expect, it } from 'vitest'
import type { ProviderModelCatalog } from '../core/model-catalog'
import { mergeLiveModels } from './live-model-catalog'
import { OPENAI_MODEL_CATALOG } from './openai-model-catalog'

const STATIC: ProviderModelCatalog = {
  providerId: 'anthropic',
  models: [
    { id: 'claude-opus-5', label: 'Opus 5', description: 'Most capable', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-opus-4-8', label: 'Opus 4.8', description: 'Default', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], isDefault: true },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', effortLevels: ['low', 'medium', 'high', 'max'] },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5', effortLevels: null },
  ],
}

describe('mergeLiveModels', () => {
  const fallback = (id: string) => (id.startsWith('claude-opus-') ? (['low', 'medium', 'high', 'xhigh', 'max'] as const).slice() : null)

  it('returns null for an empty live list so the caller falls back to static', () => {
    expect(mergeLiveModels(STATIC, [], { effortFallback: fallback })).toBeNull()
  })

  it('takes membership and order from the live list, detail from the static one', () => {
    const merged = mergeLiveModels(
      STATIC,
      [
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
        { id: 'claude-opus-5', label: 'Claude Opus 5' },
      ],
      { effortFallback: fallback },
    )!
    expect(merged.models.map((m) => m.id)).toEqual(['claude-sonnet-4-6', 'claude-opus-5'])
    // Static ladder wins over "no information".
    expect(merged.models[0]!.effortLevels).toEqual(['low', 'medium', 'high', 'max'])
    // Static label + description win over the live label.
    expect(merged.models[1]).toMatchObject({ label: 'Opus 5', description: 'Most capable' })
    // The static default is not live, so the first live entry is the default.
    expect(merged.models.filter((m) => m.isDefault).map((m) => m.id)).toEqual(['claude-sonnet-4-6'])
  })

  it('keeps the static default when the live list has it', () => {
    const merged = mergeLiveModels(
      STATIC,
      [{ id: 'claude-opus-5' }, { id: 'claude-opus-4-8' }],
      { effortFallback: fallback },
    )!
    expect(merged.models.filter((m) => m.isDefault).map((m) => m.id)).toEqual(['claude-opus-4-8'])
  })

  it('prefers an explicit live ladder, then the flag, then the fallback', () => {
    const merged = mergeLiveModels(
      STATIC,
      [
        { id: 'claude-sonnet-4-6', effortLevels: ['low', 'high'] },
        { id: 'claude-sonnet-6', supportsEffort: true },
        { id: 'claude-haiku-6', supportsEffort: false, effortLevels: null },
        { id: 'claude-opus-6' },
        { id: 'claude-mystery-1' },
      ],
      { effortFallback: fallback },
    )!
    const by = (id: string) => merged.models.find((m) => m.id === id)!.effortLevels
    expect(by('claude-sonnet-4-6')).toEqual(['low', 'high'])
    expect(by('claude-sonnet-6')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(by('claude-haiku-6')).toBeNull()
    expect(by('claude-opus-6')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(by('claude-mystery-1')).toBeNull()
  })

  it('carries the adaptive flag through, live first, then static', () => {
    const withStatic: ProviderModelCatalog = {
      ...STATIC,
      models: [...STATIC.models, { id: 'claude-known-1', label: 'Known', effortLevels: null, adaptiveThinking: true }],
    }
    const merged = mergeLiveModels(
      withStatic,
      [{ id: 'default', adaptiveThinking: true }, { id: 'claude-known-1' }, { id: 'claude-opus-5' }],
      { effortFallback: fallback },
    )!
    expect(merged.models.map((m) => [m.id, m.adaptiveThinking])).toEqual([
      ['default', true],
      ['claude-known-1', true],
      ['claude-opus-5', undefined],
    ])
  })

  it('drops duplicate ids and falls back to the id as a label', () => {
    const merged = mergeLiveModels(STATIC, [{ id: 'x-1' }, { id: 'x-1' }], { effortFallback: fallback })!
    expect(merged.models).toEqual([{ id: 'x-1', label: 'x-1', effortLevels: null, isDefault: true }])
  })

  it('keeps the flagship as the default when the live list carries only its dated or suffixed forms', () => {
    const merged = mergeLiveModels(
      STATIC,
      [
        // A dated snapshot of the static default, not itself a static entry.
        { id: 'claude-opus-4-8-20260315' },
        { id: 'claude-sonnet-4-6' },
      ],
      { effortFallback: fallback },
    )!
    expect(merged.models.filter((m) => m.isDefault).map((m) => m.id)).toEqual(['claude-opus-4-8-20260315'])
  })

  it('picks the flagship alias, not a cheaper tier that shares its stem, when the live list has no bare gpt-5.6', () => {
    // Regression for the real 2026-09-04 shell: the live list carried
    // gpt-5.6-sol, gpt-5.6-terra and gpt-5.6-luna but no bare gpt-5.6, and
    // the served default fell to Luna (the cheapest tier) because it was
    // simply first in the (newest-first) live order. Terra and Luna are
    // already their own static entries, so only Sol (live-only) qualifies
    // as an alias of the default.
    const merged = mergeLiveModels(
      OPENAI_MODEL_CATALOG,
      [
        { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      ],
      { effortFallback: () => null },
    )
    expect(merged?.models.find((m) => m.isDefault)?.id).toBe('gpt-5.6-sol')
  })
})
