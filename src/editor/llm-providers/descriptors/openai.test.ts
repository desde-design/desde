import { describe, expect, it, vi } from 'vitest'
import { OPENAI_DESCRIPTOR } from './openai'

describe('OPENAI_DESCRIPTOR', () => {
  it('declares the neutral chat runtime and no subscription runtime', () => {
    expect(OPENAI_DESCRIPTOR.id).toBe('openai')
    expect(OPENAI_DESCRIPTOR.label).toBe('OpenAI')
    expect(OPENAI_DESCRIPTOR.chatRuntime).toBe('neutral')
    expect(OPENAI_DESCRIPTOR.credentials.hasSubscriptionRuntime).toBeUndefined()
  })

  it('names both env vars and the mask prefix an OpenAI key really has', () => {
    expect(OPENAI_DESCRIPTOR.credentials.apiKeyEnvVar).toBe('OPENAI_API_KEY')
    expect(OPENAI_DESCRIPTOR.credentials.baseUrlEnvVar).toBe('OPENAI_BASE_URL')
    expect(OPENAI_DESCRIPTOR.credentials.maskPrefix).toBe('sk-')
  })

  it('reports the asymmetries the neutral lane will have', () => {
    expect(OPENAI_DESCRIPTOR.capabilities.midTurnSteering).toBe(false)
    expect(OPENAI_DESCRIPTOR.capabilities.vendorRateLimitEvents).toBe(false)
    expect(OPENAI_DESCRIPTOR.capabilities.inTurnBudgetStop).toBe('step-boundary')
    expect(OPENAI_DESCRIPTOR.capabilities.webTools).toBe(false)
  })

  it('serves a placeholder static catalog with exactly one default', () => {
    const defaults = OPENAI_DESCRIPTOR.staticCatalog.models.filter((m) => m.isDefault)
    expect(OPENAI_DESCRIPTOR.staticCatalog.providerId).toBe('openai')
    expect(defaults).toHaveLength(1)
  })

  it('has no live model list until phase 4 adds one', () => {
    expect(OPENAI_DESCRIPTOR.listLiveModels).toBeUndefined()
  })

  it('builds an OpenAIProvider bound to the key and base URL it is given', () => {
    const provider = OPENAI_DESCRIPTOR.buildProvider({
      apiKey: 'sk-explicit',
      baseUrl: 'https://gateway.internal',
      model: 'gpt-5.2',
    })
    expect(provider.name).toBe('openai')
    expect(provider.defaultModel).toBe('gpt-5.2')
  })
})

describe('OPENAI_DESCRIPTOR.validateKey', () => {
  it('calls the models endpoint with a bearer token', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    expect(
      await OPENAI_DESCRIPTOR.validateKey({
        apiKey: 'sk-good',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toEqual({ ok: true })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/models')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-good')
  })

  it('validates against a custom base URL when one is given', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    await OPENAI_DESCRIPTOR.validateKey({
      apiKey: 'sk-good',
      baseUrl: 'https://gateway.internal/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://gateway.internal/v1/models')
  })

  it('rejects a key the endpoint answers 403 for', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 403 }))
    expect(
      await OPENAI_DESCRIPTOR.validateKey({
        apiKey: 'sk-bad',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toEqual({ ok: false, message: 'OpenAI rejected that key.' })
  })

  it('fails closed when the network throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ENOTFOUND')
    })
    const result = await OPENAI_DESCRIPTOR.validateKey({
      apiKey: 'sk-any',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Could not reach OpenAI')
  })
})
