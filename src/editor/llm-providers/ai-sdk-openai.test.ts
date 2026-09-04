/**
 * Confirms `buildOpenAiProvider` actually forwards its inputs to
 * `@ai-sdk/openai`'s `createOpenAI` and reaches the Responses API, not just
 * that it returns something named `openai`. Both `createOpenAI` and
 * `AiSdkProvider` are mocked so the assertions land on the options each
 * receives, without a live network call or depending on `AiSdkProvider`'s
 * own internals (those are covered separately in `ai-sdk-provider.test.ts`).
 */
import { describe, expect, it, vi } from 'vitest'

const createOpenAIMock = vi.fn()
const responsesMock = vi.fn()
const aiSdkProviderCtorMock = vi.fn()

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: (...args: unknown[]) => {
    createOpenAIMock(...args)
    return { responses: responsesMock }
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

import { buildOpenAiProvider, OPENAI_DEFAULT_MODEL, OPENAI_PROVIDER_OPTIONS_KEY } from './ai-sdk-openai'

describe('buildOpenAiProvider', () => {
  it('forwards apiKey to createOpenAI', () => {
    buildOpenAiProvider({ apiKey: 'sk-test' })
    expect(createOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-test' }),
    )
  })

  it('forwards baseUrl as baseURL only when set', () => {
    buildOpenAiProvider({ apiKey: 'sk-test', baseUrl: 'https://gw.internal' })
    expect(createOpenAIMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseURL: 'https://gw.internal' }),
    )

    createOpenAIMock.mockClear()
    buildOpenAiProvider({ apiKey: 'sk-test' })
    const lastCallOptions = createOpenAIMock.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(lastCallOptions).not.toHaveProperty('baseURL')
  })

  it('forwards fetchImpl only when set', () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    buildOpenAiProvider({ apiKey: 'sk-test', fetchImpl })
    expect(createOpenAIMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ fetch: fetchImpl }),
    )

    createOpenAIMock.mockClear()
    buildOpenAiProvider({ apiKey: 'sk-test' })
    const lastCallOptions = createOpenAIMock.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(lastCallOptions).not.toHaveProperty('fetch')
  })

  it('wires the AiSdkProvider to fetch the model from openai.responses, not chat completions', () => {
    aiSdkProviderCtorMock.mockClear()
    buildOpenAiProvider({ apiKey: 'sk-test', model: 'gpt-5.6-mini' })
    const opts = aiSdkProviderCtorMock.mock.calls.at(-1)?.[0] as {
      languageModel: (modelId: string) => unknown
      providerOptionsKey: string
    }
    responsesMock.mockClear()
    opts.languageModel('gpt-5.6-mini')
    expect(responsesMock).toHaveBeenCalledWith('gpt-5.6-mini')
    expect(opts.providerOptionsKey).toBe(OPENAI_PROVIDER_OPTIONS_KEY)
  })

  it('defaults the model to OPENAI_DEFAULT_MODEL when none is given', () => {
    aiSdkProviderCtorMock.mockClear()
    buildOpenAiProvider({ apiKey: 'sk-test' })
    const opts = aiSdkProviderCtorMock.mock.calls.at(-1)?.[0] as { defaultModel: string }
    expect(opts.defaultModel).toBe(OPENAI_DEFAULT_MODEL)
  })

  it('returns a provider named openai', () => {
    const provider = buildOpenAiProvider({ apiKey: 'sk-test' })
    expect(provider.name).toBe('openai')
  })
})
