import { describe, expect, it, vi } from 'vitest'
import { fromOpenAiModelsApi, labelFromOpenAiId, listOpenAiLiveModels } from './openai-live-models'
import { mergeLiveModels } from './live-model-catalog'
import { OPENAI_DESCRIPTOR } from './descriptors/openai'

describe('labelFromOpenAiId', () => {
  it('labels a live-only OpenAI id the way the static catalog would', () => {
    expect(labelFromOpenAiId('gpt-5.4-nano')).toBe('GPT-5.4 Nano')
    expect(labelFromOpenAiId('gpt-5.6-sol')).toBe('GPT-5.6 Sol')
    expect(labelFromOpenAiId('gpt-5')).toBe('GPT-5')
    expect(labelFromOpenAiId('gpt-5-mini')).toBe('GPT-5 Mini')
  })
})

describe('fromOpenAiModelsApi', () => {
  it('keeps gpt-5 chat models, newest first', () => {
    const live = fromOpenAiModelsApi([
      { id: 'gpt-5.4', object: 'model', created: 100, owned_by: 'openai' },
      { id: 'gpt-5.6', object: 'model', created: 300, owned_by: 'openai' },
      { id: 'gpt-5.5', object: 'model', created: 200, owned_by: 'openai' },
    ])
    expect(live.map((m) => m.id)).toEqual(['gpt-5.6', 'gpt-5.5', 'gpt-5.4'])
  })

  it('drops everything that is not a chat model', () => {
    const live = fromOpenAiModelsApi([
      { id: 'gpt-5.6', object: 'model', created: 1, owned_by: 'openai' },
      { id: 'gpt-5.5-pro', object: 'model', created: 1, owned_by: 'openai' },
      { id: 'gpt-5-audio-preview', object: 'model', created: 1, owned_by: 'openai' },
      { id: 'gpt-5-realtime', object: 'model', created: 1, owned_by: 'openai' },
      { id: 'gpt-5-mini-transcribe', object: 'model', created: 1, owned_by: 'openai' },
      { id: 'gpt-5-tts', object: 'model', created: 1, owned_by: 'openai' },
      { id: 'gpt-5-search-preview', object: 'model', created: 1, owned_by: 'openai' },
      { id: 'gpt-5-image', object: 'model', created: 1, owned_by: 'openai' },
      { id: 'gpt-4o', object: 'model', created: 1, owned_by: 'openai' },
      { id: 'text-embedding-3-large', object: 'model', created: 1, owned_by: 'openai' },
      { id: 'omni-moderation-latest', object: 'model', created: 1, owned_by: 'openai' },
      { id: 'gpt-5.2-chat-latest', object: 'model', created: 1, owned_by: 'openai' },
    ])
    expect(live.map((m) => m.id)).toEqual(['gpt-5.6'])
  })

  it('drops a model whose retirement has been announced', () => {
    const live = fromOpenAiModelsApi([
      { id: 'gpt-5.6', object: 'model', created: 2, owned_by: 'openai' },
      { id: 'gpt-5.1', object: 'model', created: 1, owned_by: 'openai', shutdown_date: '2026-12-01' },
    ])
    expect(live.map((m) => m.id)).toEqual(['gpt-5.6'])
  })

  it('says nothing about effort, so the merge keeps the static ladder', () => {
    const [live] = fromOpenAiModelsApi([{ id: 'gpt-5.6', object: 'model', created: 1, owned_by: 'openai' }])
    // `/v1/models` carries no capability metadata, so claiming a ladder here
    // would be an invention. `undefined` is what mergeLiveModels reads as
    // "ask the static catalog".
    expect(live!.effortLevels).toBeUndefined()
    expect(live!.supportsEffort).toBeUndefined()
  })

  it('labels every entry so a live-only id never shows its raw id in the picker', () => {
    const live = fromOpenAiModelsApi([
      { id: 'gpt-5.6-sol', object: 'model', created: 2, owned_by: 'openai' },
      { id: 'gpt-5.4-nano', object: 'model', created: 1, owned_by: 'openai' },
    ])
    expect(live.map((m) => m.label)).toEqual(['GPT-5.6 Sol', 'GPT-5.4 Nano'])
  })
})

describe('fromOpenAiModelsApi + mergeLiveModels, through the real OPENAI_DESCRIPTOR', () => {
  it('serves gpt-5.6-sol as the default, not the newer and pricier gpt-5.6-cyber, when the bare id is retired', () => {
    // End-to-end regression for the real 2026-09-04 shell defect: cyber
    // passes the live-model allowlist (CHAT_MODEL_ID names it explicitly)
    // and, being newer, sorts ahead of sol. The descriptor's explicit
    // `defaultAlias` map is what keeps the served default on sol.
    const live = fromOpenAiModelsApi([
      { id: 'gpt-5.6-cyber', object: 'model', created: 2000, owned_by: 'openai' },
      { id: 'gpt-5.6-sol', object: 'model', created: 1000, owned_by: 'openai' },
      { id: 'gpt-5.4', object: 'model', created: 500, owned_by: 'openai' },
    ])
    expect(live.map((m) => m.id)).toEqual(['gpt-5.6-cyber', 'gpt-5.6-sol', 'gpt-5.4'])
    const merged = mergeLiveModels(OPENAI_DESCRIPTOR.staticCatalog, live, {
      effortFallback: () => null,
      defaultAlias: OPENAI_DESCRIPTOR.defaultAlias,
    })!
    expect(merged.models.find((m) => m.isDefault)?.id).toBe('gpt-5.6-sol')
  })
})

describe('listOpenAiLiveModels', () => {
  it('calls /v1/models with a bearer token and shapes the result', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'gpt-5.6', object: 'model', created: 5, owned_by: 'openai' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const models = await listOpenAiLiveModels({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/models')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    expect(models.map((m) => m.id)).toEqual(['gpt-5.6'])
  })

  it('honours a base URL override without doubling the /v1 segment', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 }),
    )
    await listOpenAiLiveModels({
      apiKey: 'sk-test',
      baseUrl: 'https://gateway.example/v1/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://gateway.example/v1/models')
  })

  it('returns an empty list rather than throwing when the call fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }))
    // The catalog resolver treats an empty live list as "use the static one".
    // A picker with a stale entry beats a picker with none, so this fails soft.
    await expect(
      listOpenAiLiveModels({ apiKey: 'sk-test', fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual([])
  })
})
