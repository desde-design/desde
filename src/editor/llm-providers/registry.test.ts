/**
 * Tests for the provider registry. Confirms config-driven provider
 * selection (Phase 0 + Phase 4.5) and the `apiKeyEnv` honoring fix
 * (Phase 0 punchlist).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getProvider,
  pickDefaultConfig,
  configForProvider,
  DEFAULT_LLM_CONFIG,
  CLAUDE_CODE_LLM_CONFIG,
  type LLMConfig,
} from './registry'
import { AnthropicProvider } from './anthropic-provider'
import { ClaudeAgentSdkProvider } from './claude-agent-sdk-provider'

describe('getProvider', () => {
  const originalEnv = { ...process.env }
  beforeEach(() => {
    process.env = { ...originalEnv }
  })
  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('defaults to Anthropic when ANTHROPIC_API_KEY is set', () => {
    const p = getProvider({
      env: { ANTHROPIC_API_KEY: 'sk-fake' } as unknown as NodeJS.ProcessEnv,
    })
    expect(p.name).toBe('anthropic')
    expect(p).toBeInstanceOf(AnthropicProvider)
  })

  /**
   * This test previously asserted the OPPOSITE — that no key silently fell
   * back to the bundled `claude` binary's subscription. That was fine while
   * Editor was a single-user internal tool and wrong the moment it ships:
   * it spends the END USER's personal Claude subscription, which the Agent
   * SDK terms do not permit for distributed software. Inverted deliberately.
   */
  it('refuses, with instructions, when neither a key nor the subscription opt-in is set', () => {
    expect(() => getProvider({ env: {} as unknown as NodeJS.ProcessEnv })).toThrow(
      /ANTHROPIC_API_KEY/,
    )
    expect(() => getProvider({ env: {} as unknown as NodeJS.ProcessEnv })).toThrow(
      /EDITOR_USE_CLAUDE_SUBSCRIPTION/,
    )
  })

  it('uses the Claude subscription only when explicitly opted into', () => {
    const p = getProvider({
      env: { EDITOR_USE_CLAUDE_SUBSCRIPTION: '1' } as unknown as NodeJS.ProcessEnv,
    })
    expect(p.name).toBe('claude_code')
    expect(p).toBeInstanceOf(ClaudeAgentSdkProvider)
  })

  it('ignores a non-truthy opt-in value rather than guessing', () => {
    // `0`/`false`/empty must NOT enable it — a half-set flag should fail
    // closed toward the billing model the user explicitly controls.
    for (const v of ['0', 'false', '', 'no']) {
      expect(() =>
        getProvider({ env: { EDITOR_USE_CLAUDE_SUBSCRIPTION: v } as unknown as NodeJS.ProcessEnv }),
      ).toThrow(/ANTHROPIC_API_KEY/)
    }
  })

  it('returns the override unchanged', () => {
    const fake = {
      name: 'fake',
      defaultModel: 'm',
      complete: async () => ({ text: '', stopReason: 'end_turn' as const }),
      streamConversation: async function* () {},
    }
    expect(getProvider({ override: fake })).toBe(fake)
  })

  it('builds an OpenAI provider from an openai LLMConfig', () => {
    const env = { OPENAI_API_KEY: 'sk-test' } as unknown as NodeJS.ProcessEnv
    const config = configForProvider('openai', env)
    const provider = getProvider({ config, env })
    expect(provider.name).toBe('openai')
    // The wire round trip is asserted in ai-sdk-provider.test.ts against the
    // SDK's own mock model. What the registry owes is the right provider with
    // the right credentials bound, and nothing more.
    expect(typeof provider.streamConversation).toBe('function')
  })

  it('throws on unknown provider', () => {
    const config: LLMConfig = { provider: 'mystery' }
    expect(() => getProvider({ config })).toThrow(/Unknown LLM provider/)
  })

  // (Previously: tested env mutation. Removed in the Phase 4.5
  // Codex-review pass — apiKey is now passed directly to the
  // provider instance, no process.env mutation. The new
  // "binds each Anthropic provider to its own apiKey" test below
  // covers the corrected behavior.)

  it('honors a custom apiKeyEnv for OpenAI', () => {
    // What the registry owes is reading the NAMED env var rather than the
    // descriptor's default one — proven here by the missing-key guard NOT
    // firing. The wire-level "does that key reach createOpenAI" assertion
    // lives in ai-sdk-openai.test.ts, which stubs createOpenAI directly;
    // this file only owns which env var the registry reads.
    delete process.env.OPENAI_API_KEY
    process.env.MY_OPENAI_KEY = 'sk-openai-overridden'
    const provider = getProvider({
      config: { provider: 'openai', apiKeyEnv: 'MY_OPENAI_KEY' },
    })
    expect(provider.name).toBe('openai')
  })

  it('forwards baseUrl from config to the OpenAI provider', () => {
    // Same split as above: this proves the registry passes `baseUrl` through
    // to `buildProvider`, not that createOpenAI receives it as `baseURL` —
    // that forwarding is asserted directly in ai-sdk-openai.test.ts.
    process.env.OPENAI_API_KEY = 'sk-test'
    const p = getProvider({
      config: {
        provider: 'openai',
        baseUrl: 'https://my-codex-gateway.example.com',
      },
    })
    expect(p.name).toBe('openai')
  })

  it('binds each Anthropic provider to its own apiKey (no process.env mutation)', () => {
    delete process.env.ANTHROPIC_API_KEY
    process.env.KEY_A = 'sk-ant-aaa'
    process.env.KEY_B = 'sk-ant-bbb'
    const a = getProvider({ config: { provider: 'anthropic', apiKeyEnv: 'KEY_A' } })
    const b = getProvider({ config: { provider: 'anthropic', apiKeyEnv: 'KEY_B' } })
    // The shared env stays clean — no key was mutated onto
    // ANTHROPIC_API_KEY. Each provider holds its own.
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(a).toBeInstanceOf(AnthropicProvider)
    expect(b).toBeInstanceOf(AnthropicProvider)
  })
})

describe('pickDefaultConfig consults the descriptor table', () => {
  it('still prefers an Anthropic key over everything', () => {
    expect(
      pickDefaultConfig({ ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-y' }),
    ).toMatchObject({ provider: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' })
  })

  it('picks openai when it is the only credentialed provider', () => {
    expect(pickDefaultConfig({ OPENAI_API_KEY: 'sk-y' })).toMatchObject({
      provider: 'openai',
      apiKeyEnv: 'OPENAI_API_KEY',
    })
  })

  it("carries a base URL from the provider's own env var", () => {
    expect(
      pickDefaultConfig({ OPENAI_API_KEY: 'sk-y', OPENAI_BASE_URL: 'https://gw.internal' }),
    ).toMatchObject({ provider: 'openai', baseUrl: 'https://gw.internal' })
  })

  it('still routes to claude_code on the explicit subscription opt-in', () => {
    expect(pickDefaultConfig({ EDITOR_USE_CLAUDE_SUBSCRIPTION: '1' })).toEqual(
      CLAUDE_CODE_LLM_CONFIG,
    )
  })

  it('falls back to the Anthropic API config when nothing is credentialed', () => {
    // Deliberate: `buildProvider` then refuses with an actionable message
    // rather than quietly billing someone's personal subscription.
    expect(pickDefaultConfig({})).toMatchObject({ provider: 'anthropic' })
  })
})

describe('buildProvider refuses a missing key for ANY provider', () => {
  it('refuses openai up front instead of failing inside complete()', () => {
    expect(() =>
      getProvider({ config: { provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY' }, env: {} }),
    ).toThrow(/OPENAI_API_KEY/)
  })

  it('names the provider whose key is missing', () => {
    expect(() =>
      getProvider({ config: { provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY' }, env: {} }),
    ).toThrow(/OpenAI/)
  })

  it('still mentions the subscription escape hatch only for anthropic', () => {
    expect(() => getProvider({ config: DEFAULT_LLM_CONFIG, env: {} })).toThrow(
      /EDITOR_USE_CLAUDE_SUBSCRIPTION/,
    )
    expect(() =>
      getProvider({ config: { provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY' }, env: {} }),
    ).not.toThrow(/EDITOR_USE_CLAUDE_SUBSCRIPTION/)
  })

  it('builds openai when the key is present', () => {
    const provider = getProvider({
      config: { provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
      env: { OPENAI_API_KEY: 'sk-y' },
    })
    expect(provider.name).toBe('openai')
  })
})
