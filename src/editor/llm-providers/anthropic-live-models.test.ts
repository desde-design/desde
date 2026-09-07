import { describe, expect, it } from 'vitest'
import { fromAgentSdk, fromModelsApi, versionedNameFrom, versionedNameFromId } from './anthropic-live-models'
import { mergeLiveModels } from './live-model-catalog'
import { ANTHROPIC_DESCRIPTOR } from './descriptors/anthropic'

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
  it('keeps every versioned value, carrying the effort flag through', () => {
    const live = fromAgentSdk([
      { value: 'default', displayName: 'Default (recommended)', description: 'Opus 4.8', supportsEffort: true },
      { value: 'claude-haiku-4-5', displayName: 'Haiku 4.5', description: 'Fastest', supportsEffort: false },
      { value: 'claude-opus-5', displayName: 'Opus 5', description: '' },
      { value: '', displayName: 'broken' },
    ])
    expect(live).toEqual([
      { id: 'default', label: 'Opus 4.8', description: 'Opus 4.8', supportsEffort: true },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fastest', effortLevels: null, supportsEffort: false },
      { id: 'claude-opus-5', label: 'Opus 5' },
    ])
  })

  it('keeps one row per name and version, the first alias winning', () => {
    const live = fromAgentSdk([
      { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5 with 1M context · Most capable' },
      { value: 'opus[1m]', displayName: 'Opus', description: 'Opus 5 with 1M context' },
      { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5 · Best for everyday tasks' },
    ])
    expect(live.map((m) => [m.id, m.label])).toEqual([
      ['default', 'Opus 5'],
      ['sonnet', 'Sonnet 5'],
    ])
  })

  it('drops an entry whose version cannot be read from its description or id', () => {
    const live = fromAgentSdk([
      { value: 'fable[1m]', displayName: 'fable[1m]', description: 'Custom model' },
      { value: 'mystery', displayName: 'Mystery', description: 'Something' },
    ])
    expect(live).toEqual([])
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
      label: 'Sonnet 4.6',
      description: 'Sonnet 4.6 · Best for everyday tasks',
      effortLevels: ['low', 'medium', 'high', 'max'],
      supportsEffort: true,
      adaptiveThinking: true,
    })
    expect(live[1]).toEqual({ id: 'haiku', label: 'Haiku 4.5', description: 'Haiku 4.5 · Fastest for quick answers' })
  })
})

describe('versionedNameFrom', () => {
  it('reads the leading family and version, and nothing else', () => {
    expect(versionedNameFrom('Opus 4.7 with 1M context · Most capable for complex work')).toBe('Opus 4.7')
    expect(versionedNameFrom('Sonnet 4.6 · Best for everyday tasks')).toBe('Sonnet 4.6')
    expect(versionedNameFrom('Fable 5.1')).toBe('Fable 5.1')
    expect(versionedNameFrom('Custom model')).toBeUndefined()
    expect(versionedNameFrom('')).toBeUndefined()
    expect(versionedNameFrom(undefined)).toBeUndefined()
  })
})

describe('versionedNameFromId', () => {
  it('reads family and version out of an id, ignoring context and snapshot suffixes', () => {
    expect(versionedNameFromId('claude-fable-5-1[1m]')).toBe('Fable 5.1')
    expect(versionedNameFromId('claude-opus-5')).toBe('Opus 5')
    expect(versionedNameFromId('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(versionedNameFromId('fable[1m]')).toBeUndefined()
    expect(versionedNameFromId('default')).toBeUndefined()
  })

  it('is the fallback for a binary entry whose description says nothing', () => {
    const live = fromAgentSdk([
      { value: 'claude-fable-5-1[1m]', displayName: 'Fable', description: 'Custom model' },
      { value: 'fable[1m]', displayName: 'fable[1m]', description: 'Custom model' },
    ])
    expect(live.map((m) => m.label)).toEqual(['Fable 5.1'])
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

describe('fromModelsApi + mergeLiveModels, through the real ANTHROPIC_DESCRIPTOR', () => {
  it('serves the dated snapshot of claude-opus-4-8 as the default when the bare id is retired', () => {
    // FX6 item 1: the OpenAI half of this proof already existed
    // (`openai-live-models.test.ts`). This is the Anthropic half the FX5
    // brief asked for and the FX4/FX5 review found missing: delete
    // `defaultAlias: { kind: 'dated-snapshot' }` from `ANTHROPIC_DESCRIPTOR`
    // and every existing suite stays green, while a live list shaped like
    // Anthropic's own rollover (only the dated snapshot survives) would
    // hand the default to whichever live entry sorts first instead of the
    // flagship.
    const live = fromModelsApi([
      { id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-06-01T00:00:00Z' },
      {
        id: 'claude-opus-4-8-20260315',
        display_name: 'Claude Opus 4.8',
        created_at: '2026-03-15T00:00:00Z',
      },
      { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created_at: '2026-01-01T00:00:00Z' },
    ])
    expect(live.map((m) => m.id)).toEqual([
      'claude-opus-5',
      'claude-opus-4-8-20260315',
      'claude-sonnet-4-6',
    ])
    const merged = mergeLiveModels(ANTHROPIC_DESCRIPTOR.staticCatalog, live, {
      effortFallback: () => null,
      defaultAlias: ANTHROPIC_DESCRIPTOR.defaultAlias,
    })!
    expect(merged.models.find((m) => m.isDefault)?.id).toBe('claude-opus-4-8-20260315')
  })
})
