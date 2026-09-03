import { describe, expect, it } from 'vitest'
import type { ProviderModelCatalog } from '../core/model-catalog'
import { fromAgentSdk, fromModelsApi, mergeLiveModels } from './live-model-catalog'

const STATIC: ProviderModelCatalog = {
  providerId: 'anthropic',
  models: [
    { id: 'claude-opus-5', label: 'Opus 5', description: 'Most capable', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-opus-4-8', label: 'Opus 4.8', description: 'Default', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], isDefault: true },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', effortLevels: ['low', 'medium', 'high', 'max'] },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5', effortLevels: null },
  ],
}

const yes = { supported: true }
const no = { supported: false }
const fullEffort = { supported: true, low: yes, medium: yes, high: yes, xhigh: yes, max: yes }

describe('fromModelsApi', () => {
  it('keeps Claude 4+ models, newest first, with the API effort ladder', () => {
    const live = fromModelsApi([
      { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created_at: '2026-02-01T00:00:00Z', capabilities: { effort: { ...fullEffort, xhigh: no } } },
      { id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-05-01T00:00:00Z', capabilities: { effort: fullEffort } },
      { id: 'claude-3-7-sonnet-20250219', display_name: 'Claude Sonnet 3.7', created_at: '2025-02-19T00:00:00Z', capabilities: { effort: { supported: false } } },
      { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z', capabilities: { effort: { supported: false } } },
    ])
    expect(live.map((m) => m.id)).toEqual(['claude-opus-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'])
    expect(live[0]).toEqual({ id: 'claude-opus-5', label: 'Opus 5', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] })
    expect(live[1]!.effortLevels).toEqual(['low', 'medium', 'high', 'max'])
    expect(live[2]!.effortLevels).toBeNull()
  })

  it('drops a dated snapshot when its bare alias is listed, keeps it otherwise', () => {
    const live = fromModelsApi([
      { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z' },
      { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z' },
      { id: 'claude-opus-4-1-20250805', display_name: 'Claude Opus 4.1', created_at: '2025-08-05T00:00:00Z' },
    ])
    expect(live.map((m) => m.id)).toEqual(['claude-haiku-4-5', 'claude-opus-4-1-20250805'])
  })

  it('leaves effort undefined when the API carries no capability tree', () => {
    const [m] = fromModelsApi([{ id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-05-01T00:00:00Z', capabilities: null }])
    expect(m!.effortLevels).toBeUndefined()
  })
})

describe('fromAgentSdk', () => {
  it('keeps every offered value, carrying the effort flag through', () => {
    const live = fromAgentSdk([
      { value: 'default', displayName: 'Default (recommended)', description: 'Opus 4.8', supportsEffort: true },
      { value: 'claude-haiku-4-5', displayName: 'Haiku 4.5', description: 'Fastest', supportsEffort: false },
      { value: 'claude-opus-5', displayName: 'Opus 5', description: '' },
      { value: '', displayName: 'broken' },
    ])
    expect(live).toEqual([
      { id: 'default', label: 'Default (recommended)', description: 'Opus 4.8', supportsEffort: true },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fastest', effortLevels: null, supportsEffort: false },
      { id: 'claude-opus-5', label: 'Opus 5' },
    ])
  })

  it('reads the per-level ladder and the adaptive flag the binary actually sends', () => {
    // The shape MEASURED from the real binary on 2026-09-02, with fields the
    // SDK's type declaration does not list.
    const live = fromAgentSdk([
      {
        value: 'sonnet',
        displayName: 'Sonnet',
        description: 'Sonnet 4.6 · Best for everyday tasks',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'max', 'bogus'],
        supportsAdaptiveThinking: true,
      },
      { value: 'haiku', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
    ])
    expect(live[0]).toEqual({
      id: 'sonnet',
      label: 'Sonnet',
      description: 'Sonnet 4.6 · Best for everyday tasks',
      effortLevels: ['low', 'medium', 'high', 'max'],
      supportsEffort: true,
      adaptiveThinking: true,
    })
    expect(live[1]).toEqual({ id: 'haiku', label: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' })
  })
})

describe('fromModelsApi adaptive thinking', () => {
  it('reads the adaptive capability leaf', () => {
    const live = fromModelsApi([
      { id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-05-01T00:00:00Z', capabilities: { thinking: { supported: true, types: { adaptive: yes } } } },
      { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z', capabilities: { thinking: { supported: true, types: { adaptive: no } } } },
      { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2026-03-01T00:00:00Z', capabilities: null },
    ])
    expect(live.map((m) => [m.id, m.adaptiveThinking])).toEqual([
      ['claude-opus-5', true],
      ['claude-opus-4-8', undefined],
      ['claude-haiku-4-5', false],
    ])
  })
})

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
})
