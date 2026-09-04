import { describe, expect, it, vi } from 'vitest'
import { ANTHROPIC_DESCRIPTOR } from './anthropic'
import { ANTHROPIC_MODEL_CATALOG } from '../anthropic-model-catalog'

describe('ANTHROPIC_DESCRIPTOR', () => {
  it('keeps today\'s identity, runtime and credential facts', () => {
    expect(ANTHROPIC_DESCRIPTOR.id).toBe('anthropic')
    expect(ANTHROPIC_DESCRIPTOR.label).toBe('Anthropic')
    expect(ANTHROPIC_DESCRIPTOR.chatRuntime).toBe('claude-agent-sdk')
    expect(ANTHROPIC_DESCRIPTOR.credentials.apiKeyEnvVar).toBe('ANTHROPIC_API_KEY')
    expect(ANTHROPIC_DESCRIPTOR.credentials.maskPrefix).toBe('sk-ant-')
    expect(ANTHROPIC_DESCRIPTOR.credentials.hasSubscriptionRuntime).toBe(true)
    expect(ANTHROPIC_DESCRIPTOR.credentials.baseUrlEnvVar).toBeUndefined()
  })

  it('serves the existing static catalog unchanged', () => {
    expect(ANTHROPIC_DESCRIPTOR.staticCatalog).toBe(ANTHROPIC_MODEL_CATALOG)
  })

  it('reports the capability asymmetries the SDK lane actually has', () => {
    expect(ANTHROPIC_DESCRIPTOR.capabilities).toEqual({
      midTurnSteering: true,
      vendorReportedCostUsd: true,
      inTurnBudgetStop: 'vendor',
      reasoningVisibility: true,
      vendorRateLimitEvents: true,
      imagesInPrompt: true,
      webTools: true,
    })
  })

  it('builds a provider bound to the key it is given, reading no process.env', () => {
    const before = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-the-process'
    try {
      const provider = ANTHROPIC_DESCRIPTOR.buildProvider({
        apiKey: 'sk-ant-explicit',
        model: 'claude-opus-5',
      })
      expect(provider.name).toBe('anthropic')
      expect(provider.defaultModel).toBe('claude-opus-5')
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = before
    }
  })

  it('offers the five-level effort ladder and puts nothing on the wire', () => {
    expect(ANTHROPIC_DESCRIPTOR.effort.levels).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    // The SDK runtime resolves thinking itself; `toRequest` is the neutral
    // lane's channel and Anthropic never travels it.
    expect(ANTHROPIC_DESCRIPTOR.effort.toRequest('high')).toEqual({})
  })
})

describe('ANTHROPIC_DESCRIPTOR.validateKey', () => {
  it('accepts a key the models endpoint answers 200 for', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const result = await ANTHROPIC_DESCRIPTOR.validateKey({
      apiKey: 'sk-ant-good',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toEqual({ ok: true })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1')
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-good')
    expect((init.headers as Record<string, string>)['anthropic-version']).toBe(
      '2023-06-01',
    )
  })

  it('rejects a key the endpoint answers 401 for', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }))
    expect(
      await ANTHROPIC_DESCRIPTOR.validateKey({
        apiKey: 'sk-ant-bad',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toEqual({ ok: false, message: 'Anthropic rejected that key.' })
  })

  it('fails closed when the network throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ENOTFOUND')
    })
    const result = await ANTHROPIC_DESCRIPTOR.validateKey({
      apiKey: 'sk-ant-any',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Could not reach Anthropic')
  })
})
