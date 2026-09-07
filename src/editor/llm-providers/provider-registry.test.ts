// @vitest-environment node
//
// Filesystem test below: the default jsdom environment rewrites
// `import.meta.url` to a non-file scheme, so path resolution from it throws
// at collection time (see design-system-neutrality.test.ts for the same note).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROVIDER_PRECEDENCE,
  PROVIDER_DESCRIPTORS,
  credentialsFromEnv,
  getDescriptor,
  isCredentialedFromEnv,
  listDescriptors,
  resolveDefaultProviderId,
} from './provider-registry'
import { ANTHROPIC_DESCRIPTOR } from './descriptors/anthropic'
import { OPENAI_DESCRIPTOR } from './descriptors/openai'
import type { ProviderDescriptor } from './provider-descriptor'

const none = () => false
const all = () => true

describe('the descriptor table', () => {
  it('registers anthropic first and openai second', () => {
    expect(PROVIDER_DESCRIPTORS.map((d) => d.id)).toEqual(['anthropic', 'openai'])
    expect(listDescriptors()).toBe(PROVIDER_DESCRIPTORS)
  })

  it('looks a descriptor up by id and answers undefined for a stranger', () => {
    expect(getDescriptor('openai')?.label).toBe('OpenAI')
    expect(getDescriptor('moonshot')).toBeUndefined()
  })

  /** Coverage assertions: decisions turned into invariants. */
  it('gives every descriptor a unique id, a key env var and a capability record', () => {
    const ids = PROVIDER_DESCRIPTORS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const d of PROVIDER_DESCRIPTORS) {
      expect(d.credentials.apiKeyEnvVar.length, d.id).toBeGreaterThan(0)
      expect(d.credentials.maskPrefix.length, d.id).toBeGreaterThan(0)
      expect(d.credentials.consoleUrl.startsWith('https://'), d.id).toBe(true)
      expect(typeof d.capabilities.midTurnSteering, d.id).toBe('boolean')
      expect(typeof d.capabilities.vendorRateLimitEvents, d.id).toBe('boolean')
    }
  })

  it('gives every static catalog exactly one default model', () => {
    for (const d of PROVIDER_DESCRIPTORS) {
      const defaults = d.staticCatalog.models.filter((m) => m.isDefault)
      expect(defaults.length, `${d.id} static catalog defaults`).toBe(1)
      expect(d.staticCatalog.providerId, d.id).toBe(d.id)
    }
  })

  it('gives only anthropic a subscription runtime', () => {
    const withRuntime = PROVIDER_DESCRIPTORS.filter(
      (d) => d.credentials.hasSubscriptionRuntime === true,
    ).map((d) => d.id)
    expect(withRuntime).toEqual(['anthropic'])
  })
})

describe('resolveDefaultProviderId', () => {
  it('honours a configured default when that provider is credentialed', () => {
    expect(
      resolveDefaultProviderId({
        env: {},
        configuredDefault: 'openai',
        isCredentialed: all,
      }),
    ).toBe('openai')
  })

  it('ignores a configured default that is not credentialed', () => {
    expect(
      resolveDefaultProviderId({
        env: {},
        configuredDefault: 'openai',
        isCredentialed: (d: ProviderDescriptor) => d.id === 'anthropic',
      }),
    ).toBe('anthropic')
  })

  it('ignores a configured default nobody registered', () => {
    expect(
      resolveDefaultProviderId({
        env: {},
        configuredDefault: 'moonshot',
        isCredentialed: all,
      }),
    ).toBe('anthropic')
  })

  it('walks the precedence order when several are credentialed', () => {
    expect(DEFAULT_PROVIDER_PRECEDENCE).toEqual(['anthropic', 'openai'])
    expect(resolveDefaultProviderId({ env: {}, isCredentialed: all })).toBe('anthropic')
  })

  it('picks the only credentialed provider even when it is later in precedence', () => {
    expect(
      resolveDefaultProviderId({
        env: {},
        isCredentialed: (d: ProviderDescriptor) => d.id === 'openai',
      }),
    ).toBe('openai')
  })

  it('falls back to the first descriptor when nothing is credentialed', () => {
    expect(resolveDefaultProviderId({ env: {}, isCredentialed: none })).toBe('anthropic')
  })
})

/**
 * A source-level guard, not a runtime one. A cycle here would very likely
 * still WORK today (every cross-reference sits inside a function body, so
 * Node's live bindings resolve once both modules finish loading) and would
 * break silently and repo-wide the moment someone hoisted one of those
 * references to module scope. The point is to keep the dependency arrow
 * pointing one way while it is still cheap.
 */
describe('the descriptor table does not depend on the registry it feeds', () => {
  it('never imports from ./registry', () => {
    const source = readFileSync(
      new URL('./provider-registry.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toMatch(/from '\.\/registry'/)
  })

  it('imports the subscription opt-in from the leaf module instead', () => {
    const source = readFileSync(
      new URL('./provider-registry.ts', import.meta.url),
      'utf8',
    )
    expect(source).toContain("from './claude-subscription'")
  })
})

describe('isCredentialedFromEnv', () => {
  it('reads each descriptor\'s own key variable', () => {
    const env = { OPENAI_API_KEY: 'sk-live' }
    expect(isCredentialedFromEnv(getDescriptor('openai')!, env)).toBe(true)
    expect(isCredentialedFromEnv(getDescriptor('anthropic')!, env)).toBe(false)
  })

  it('treats a whitespace-only value as absent', () => {
    expect(isCredentialedFromEnv(getDescriptor('openai')!, { OPENAI_API_KEY: '  ' })).toBe(
      false,
    )
  })

  it('counts the subscription opt-in only for a provider that has one', () => {
    const env = { EDITOR_USE_CLAUDE_SUBSCRIPTION: '1' }
    expect(isCredentialedFromEnv(getDescriptor('anthropic')!, env)).toBe(true)
    expect(isCredentialedFromEnv(getDescriptor('openai')!, env)).toBe(false)
  })
})

describe('credentialsFromEnv', () => {
  it("reads the descriptor's own variables and trims them", () => {
    const env = { OPENAI_API_KEY: '  sk-test-123  ', OPENAI_BASE_URL: 'https://gateway.internal/v1 ' }
    expect(credentialsFromEnv(OPENAI_DESCRIPTOR, env)).toEqual({
      apiKey: 'sk-test-123',
      baseUrl: 'https://gateway.internal/v1',
    })
  })

  it('reports nothing for an empty or absent value', () => {
    expect(credentialsFromEnv(OPENAI_DESCRIPTOR, { OPENAI_API_KEY: '   ' })).toEqual({})
    expect(credentialsFromEnv(ANTHROPIC_DESCRIPTOR, {})).toEqual({})
  })

  it('agrees with isCredentialedFromEnv on the key half', () => {
    for (const env of [{}, { OPENAI_API_KEY: 'sk-x' }, { ANTHROPIC_API_KEY: 'sk-ant-x' }]) {
      for (const d of listDescriptors()) {
        const hasKey = credentialsFromEnv(d, env).apiKey !== undefined
        if (hasKey) expect(isCredentialedFromEnv(d, env)).toBe(true)
      }
    }
  })
})
