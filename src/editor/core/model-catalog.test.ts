import { describe, expect, it } from 'vitest'
import {
  defaultModelConfig,
  reconcileSessionModelConfig,
  validateSessionModelConfig,
  type ProviderModelCatalog,
} from './model-catalog'

const CATALOGS: ProviderModelCatalog[] = [
  {
    providerId: 'anthropic',
    models: [
      { id: 'claude-opus-4-8', label: 'Opus 4.8', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], isDefault: true },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', effortLevels: null },
    ],
  },
]

describe('validateSessionModelConfig', () => {
  it('accepts a known model with a supported effort', () => {
    const r = validateSessionModelConfig(
      { provider: 'anthropic', model: 'claude-opus-4-8', effort: 'low' },
      CATALOGS,
    )
    expect(r).toEqual({
      ok: true,
      config: { provider: 'anthropic', model: 'claude-opus-4-8', effort: 'low' },
      warnings: [],
    })
  })

  it('accepts a known model with no effort', () => {
    const r = validateSessionModelConfig(
      { provider: 'anthropic', model: 'claude-opus-4-8' },
      CATALOGS,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.effort).toBeUndefined()
  })

  it('strips effort on a model without effort support, with a warning', () => {
    const r = validateSessionModelConfig(
      { provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'high' },
      CATALOGS,
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.config.effort).toBeUndefined()
      expect(r.warnings).toHaveLength(1)
      expect(r.warnings[0]).toMatch(/does not support effort/i)
    }
  })

  it('rejects an unknown provider', () => {
    const r = validateSessionModelConfig(
      { provider: 'openai', model: 'gpt-5.2' },
      CATALOGS,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/unknown provider/i)
  })

  it('rejects an unknown model', () => {
    const r = validateSessionModelConfig(
      { provider: 'anthropic', model: 'claude-nonexistent' },
      CATALOGS,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/unknown model/i)
  })

  it('rejects an invalid effort value', () => {
    const r = validateSessionModelConfig(
      { provider: 'anthropic', model: 'claude-opus-4-8', effort: 'turbo' },
      CATALOGS,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/effort/i)
  })

  it('rejects non-object input', () => {
    expect(validateSessionModelConfig('opus', CATALOGS).ok).toBe(false)
    expect(validateSessionModelConfig(null, CATALOGS).ok).toBe(false)
  })

  it('rejects an effort level outside the model allowlist', () => {
    const catalogs: ProviderModelCatalog[] = [
      {
        providerId: 'anthropic',
        models: [{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', effortLevels: ['low', 'medium', 'high', 'max'] }],
      },
    ]
    const r = validateSessionModelConfig(
      { provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'xhigh' },
      catalogs,
    )
    expect(r.ok).toBe(false)
  })
})

describe('defaultModelConfig', () => {
  it('prefers the isDefault entry', () => {
    expect(defaultModelConfig(CATALOGS[0])).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
    })
  })

  it('falls back to the first model when nothing is flagged default', () => {
    const catalog: ProviderModelCatalog = {
      providerId: 'anthropic',
      models: [
        { id: 'a', label: 'A', effortLevels: null },
        { id: 'b', label: 'B', effortLevels: null },
      ],
    }
    expect(defaultModelConfig(catalog).model).toBe('a')
  })

  // M4 — an empty catalog used to dereference `undefined.id` and throw an
  // opaque TypeError from inside the model-catalog GET handler.
  it('throws a named error instead of a TypeError on an empty catalog', () => {
    const empty: ProviderModelCatalog = { providerId: 'anthropic', models: [] }
    expect(() => defaultModelConfig(empty)).toThrowError(
      /catalog for provider 'anthropic' has no models/i,
    )
    expect(() => defaultModelConfig(empty)).not.toThrowError(TypeError)
  })
})

describe('reconcileSessionModelConfig', () => {
  it('returns null for absent input', () => {
    expect(reconcileSessionModelConfig(null, CATALOGS)).toBeNull()
    expect(reconcileSessionModelConfig(undefined, CATALOGS)).toBeNull()
  })

  it('passes through a still-valid config', () => {
    expect(
      reconcileSessionModelConfig(
        { provider: 'anthropic', model: 'claude-opus-4-8', effort: 'high' },
        CATALOGS,
      ),
    ).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8', effort: 'high' })
  })

  it('drops a model that has left the catalog', () => {
    expect(
      reconcileSessionModelConfig(
        { provider: 'anthropic', model: 'claude-retired-1' },
        CATALOGS,
      ),
    ).toBeNull()
  })

  it('drops an unknown provider', () => {
    expect(
      reconcileSessionModelConfig(
        { provider: 'openai', model: 'claude-opus-4-8' },
        CATALOGS,
      ),
    ).toBeNull()
  })

  it('drops an effort the model no longer accepts', () => {
    const catalogs: ProviderModelCatalog[] = [
      {
        providerId: 'anthropic',
        models: [
          {
            id: 'claude-sonnet-4-6',
            label: 'Sonnet 4.6',
            effortLevels: ['low', 'medium', 'high', 'max'],
          },
        ],
      },
    ]
    expect(
      reconcileSessionModelConfig(
        { provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'xhigh' },
        catalogs,
      ),
    ).toBeNull()
  })

  // M1 — returns the validator's SANITIZED config, not the raw input: a
  // hand-edited session carrying effort on a no-effort model must not
  // forward that effort.
  it('strips effort from a model that has no effort parameter', () => {
    expect(
      reconcileSessionModelConfig(
        { provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' },
        CATALOGS,
      ),
    ).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' })
  })
})
