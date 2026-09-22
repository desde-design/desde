/**
 * Confirms `buildAnthropicProvider` actually forwards its inputs to
 * `@ai-sdk/anthropic`'s `createAnthropic` and calls the returned provider
 * directly (the Messages API model), not just that it returns something
 * named `anthropic`. Both `createAnthropic` and `AiSdkProvider` are mocked
 * so the assertions land on the options each receives, without a live
 * network call or depending on `AiSdkProvider`'s own internals (those are
 * covered separately in `ai-sdk-provider.test.ts`).
 */
import { describe, expect, it, vi } from 'vitest'

const createAnthropicMock = vi.fn()
const languageModelMock = vi.fn()
const aiSdkProviderCtorMock = vi.fn()

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: (...args: unknown[]) => {
    createAnthropicMock(...args)
    return languageModelMock
  },
}))

vi.mock('./ai-sdk-provider', () => ({
  AiSdkProvider: class {
    name: string
    constructor(opts: Record<string, unknown>) {
      aiSdkProviderCtorMock(opts)
      this.name = opts.name as string
    }
  },
}))

import {
  ANTHROPIC_AI_SDK_DEFAULT_MODEL,
  ANTHROPIC_PROVIDER_OPTIONS_KEY,
  buildAnthropicProvider,
} from './ai-sdk-anthropic'

describe('buildAnthropicProvider', () => {
  it('refuses to build without a key, naming the env var', () => {
    expect(() => buildAnthropicProvider({})).toThrow(/ANTHROPIC_API_KEY/)
  })

  it('forwards apiKey to createAnthropic', () => {
    buildAnthropicProvider({ apiKey: 'sk-ant-test' })
    expect(createAnthropicMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-ant-test' }),
    )
  })

  it('forwards baseUrl as baseURL only when set', () => {
    buildAnthropicProvider({ apiKey: 'sk-ant-test', baseUrl: 'https://gw.internal' })
    expect(createAnthropicMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseURL: 'https://gw.internal' }),
    )

    createAnthropicMock.mockClear()
    buildAnthropicProvider({ apiKey: 'sk-ant-test' })
    const lastCallOptions = createAnthropicMock.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(lastCallOptions).not.toHaveProperty('baseURL')
  })

  it('forwards fetchImpl only when set', () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    buildAnthropicProvider({ apiKey: 'sk-ant-test', fetchImpl })
    expect(createAnthropicMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ fetch: fetchImpl }),
    )

    createAnthropicMock.mockClear()
    buildAnthropicProvider({ apiKey: 'sk-ant-test' })
    const lastCallOptions = createAnthropicMock.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(lastCallOptions).not.toHaveProperty('fetch')
  })

  it('wires the AiSdkProvider to fetch the model by calling the provider directly', () => {
    aiSdkProviderCtorMock.mockClear()
    buildAnthropicProvider({ apiKey: 'sk-ant-test', model: 'claude-sonnet-5' })
    const opts = aiSdkProviderCtorMock.mock.calls.at(-1)?.[0] as {
      languageModel: (modelId: string) => unknown
      providerOptionsKey: string
    }
    languageModelMock.mockClear()
    opts.languageModel('claude-sonnet-5')
    expect(languageModelMock).toHaveBeenCalledWith('claude-sonnet-5')
    expect(opts.providerOptionsKey).toBe(ANTHROPIC_PROVIDER_OPTIONS_KEY)
  })

  it('builds the provider with cacheControl set, so a marked system block reaches the wire as breakpoint caching', () => {
    aiSdkProviderCtorMock.mockClear()
    buildAnthropicProvider({ apiKey: 'sk-ant-test' })
    const opts = aiSdkProviderCtorMock.mock.calls.at(-1)?.[0] as { cacheControl?: string }
    expect(opts.cacheControl).toBe('anthropic')
  })

  it('builds an LLMProvider named anthropic with the default model', () => {
    aiSdkProviderCtorMock.mockClear()
    const p = buildAnthropicProvider({ apiKey: 'sk-ant-test' })
    expect(p.name).toBe('anthropic')
    const opts = aiSdkProviderCtorMock.mock.calls.at(-1)?.[0] as { defaultModel: string }
    expect(opts.defaultModel).toBe(ANTHROPIC_AI_SDK_DEFAULT_MODEL)
    expect(ANTHROPIC_AI_SDK_DEFAULT_MODEL).toBe('claude-opus-4-8')
  })
})
