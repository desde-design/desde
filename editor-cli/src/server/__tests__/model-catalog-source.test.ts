import { describe, expect, it, vi } from 'vitest'
import { ANTHROPIC_MODEL_CATALOG } from '../../../../src/editor/llm-providers/anthropic-model-catalog.js'
import type { LiveModel } from '../../../../src/editor/llm-providers/live-model-catalog.js'
import { createModelCatalogResolver } from '../model-catalog-source.js'

const API_LIST: LiveModel[] = [
  { id: 'claude-opus-5', label: 'Opus 5', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-brand-new-7', label: 'Brand New 7', effortLevels: ['low', 'high'] },
]
const CLI_LIST: LiveModel[] = [
  { id: 'default', label: 'Default (recommended)', description: 'Opus 4.8', supportsEffort: true },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', supportsEffort: true },
]

function makeResolver(env: NodeJS.ProcessEnv, overrides: Parameters<typeof createModelCatalogResolver>[0] = {}) {
  let t = 1_000_000
  const clock = { advance: (ms: number) => (t += ms) }
  const listViaApi = vi.fn(async () => API_LIST)
  const listViaCli = vi.fn(async () => CLI_LIST)
  const resolver = createModelCatalogResolver({
    env: () => env,
    listViaApi,
    listViaCli,
    now: () => t,
    log: () => {},
    ...overrides,
  })
  return { resolver, listViaApi, listViaCli, clock }
}

describe('createModelCatalogResolver', () => {
  it('uses the Models API when a key is active, merged over the static catalog', async () => {
    const { resolver, listViaApi, listViaCli } = makeResolver({ ANTHROPIC_API_KEY: 'sk-ant-x' })
    const result = await resolver.get()
    expect(result.source).toBe('api')
    expect(listViaApi).toHaveBeenCalledWith('sk-ant-x', expect.any(AbortSignal))
    expect(listViaCli).not.toHaveBeenCalled()
    expect(result.catalogs[0]!.models.map((m) => m.id)).toEqual(['claude-opus-5', 'claude-brand-new-7'])
    // A model the static file never heard of is offered with the API's ladder.
    expect(result.catalogs[0]!.models[1]!.effortLevels).toEqual(['low', 'high'])
  })

  it('uses the claude binary in dev mode / subscription mode with no key', async () => {
    const { resolver, listViaApi, listViaCli } = makeResolver({ EDITOR_USE_CLAUDE_SUBSCRIPTION: '1' })
    const result = await resolver.get()
    expect(result.source).toBe('cli')
    expect(listViaCli).toHaveBeenCalledTimes(1)
    expect(listViaApi).not.toHaveBeenCalled()
    expect(result.catalogs[0]!.models.map((m) => m.id)).toEqual(['default', 'claude-opus-4-8'])
    // The static default is live, so it stays the default.
    expect(result.catalogs[0]!.models.find((m) => m.isDefault)?.id).toBe('claude-opus-4-8')
  })

  it('prefers the key over the subscription flag when both are set', async () => {
    const { resolver, listViaApi, listViaCli } = makeResolver({
      ANTHROPIC_API_KEY: 'sk-ant-x',
      EDITOR_USE_CLAUDE_SUBSCRIPTION: '1',
    })
    expect((await resolver.get()).source).toBe('api')
    expect(listViaApi).toHaveBeenCalledTimes(1)
    expect(listViaCli).not.toHaveBeenCalled()
  })

  it('answers static without calling anything when there are no credentials', async () => {
    const { resolver, listViaApi, listViaCli } = makeResolver({})
    const result = await resolver.get()
    expect(result.source).toBe('static')
    expect(result.catalogs).toEqual([ANTHROPIC_MODEL_CATALOG])
    expect(listViaApi).not.toHaveBeenCalled()
    expect(listViaCli).not.toHaveBeenCalled()
  })

  it('falls back to static on failure and retries after the failure TTL', async () => {
    const listViaApi = vi.fn<(k: string, s: AbortSignal) => Promise<LiveModel[]>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(API_LIST)
    const { resolver, clock } = makeResolver({ ANTHROPIC_API_KEY: 'k' }, { listViaApi, failureTtlMs: 1_000 })
    expect((await resolver.get()).source).toBe('static')
    // Within the failure TTL the static answer is held.
    clock.advance(500)
    expect((await resolver.get()).source).toBe('static')
    expect(listViaApi).toHaveBeenCalledTimes(1)
    clock.advance(600)
    expect((await resolver.get()).source).toBe('api')
    expect(listViaApi).toHaveBeenCalledTimes(2)
  })

  it('treats an empty live list as a failure', async () => {
    const { resolver } = makeResolver({ ANTHROPIC_API_KEY: 'k' }, { listViaApi: async () => [] })
    expect((await resolver.get()).source).toBe('static')
  })

  it('caches a live answer for the TTL and shares one fetch between concurrent callers', async () => {
    const { resolver, listViaApi, clock } = makeResolver({ ANTHROPIC_API_KEY: 'k' }, { ttlMs: 10_000 })
    const [a, b] = await Promise.all([resolver.get(), resolver.get()])
    expect(a).toBe(b)
    expect(listViaApi).toHaveBeenCalledTimes(1)
    clock.advance(9_000)
    await resolver.get()
    expect(listViaApi).toHaveBeenCalledTimes(1)
    clock.advance(2_000)
    await resolver.get()
    expect(listViaApi).toHaveBeenCalledTimes(2)
  })

  it('refetches when the key changes, even inside the TTL', async () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'first' }
    const { resolver, listViaApi } = makeResolver(env)
    await resolver.get()
    env.ANTHROPIC_API_KEY = 'second'
    await resolver.get()
    expect(listViaApi).toHaveBeenNthCalledWith(2, 'second', expect.any(AbortSignal))
  })

  it('aborts a live attempt that outlives the timeout and answers static', async () => {
    vi.useFakeTimers()
    try {
      const listViaApi = vi.fn(
        (_k: string, signal: AbortSignal) =>
          new Promise<LiveModel[]>((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      )
      const { resolver } = makeResolver({ ANTHROPIC_API_KEY: 'k' }, { listViaApi, timeoutMs: 50 })
      const pending = resolver.get()
      await vi.advanceTimersByTimeAsync(60)
      expect((await pending).source).toBe('static')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("the resolver loops the descriptor table", () => {
  it("serves only providers whose chat runtime can actually dispatch today", async () => {
    // OpenAI's descriptor declares `chatRuntime: 'neutral'`, and the neutral
    // runtime is off. Serving its catalog would let the picker offer a model
    // the chat handler refuses one second later.
    const resolver = createModelCatalogResolver({
      env: () => ({ ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-y' }),
      listViaApi: async () => [],
      listViaCli: async () => [],
    })
    const resolved = await resolver.get()
    expect(resolved.catalogs.map((c) => c.providerId)).toEqual(['anthropic'])
  })

  it("serves a second provider's static catalog once it is included", async () => {
    const resolver = createModelCatalogResolver({
      env: () => ({ ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-y' }),
      listViaApi: async () => [],
      listViaCli: async () => [],
      includeDescriptor: () => true,
    })
    const resolved = await resolver.get()
    expect(resolved.catalogs.map((c) => c.providerId)).toEqual(['anthropic', 'openai'])
    expect(resolved.catalogs[1]?.models.some((m) => m.isDefault)).toBe(true)
  })

  it("still merges a live Anthropic list over the static one", async () => {
    const resolver = createModelCatalogResolver({
      env: () => ({ ANTHROPIC_API_KEY: 'sk-ant-x' }),
      listViaApi: async () => [{ id: 'claude-opus-9', label: 'Opus 9' }],
      listViaCli: async () => [],
    })
    const resolved = await resolver.get()
    expect(resolved.source).toBe('api')
    expect(resolved.catalogs[0]?.models.map((m) => m.id)).toEqual(['claude-opus-9'])
  })

  it("re-resolves when ANOTHER provider's credential changes", async () => {
    // The cache key used to be Anthropic's key alone, so adding an OpenAI key
    // would have served a stale catalog for up to ten minutes.
    let env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'sk-ant-x' }
    let calls = 0
    const resolver = createModelCatalogResolver({
      env: () => env,
      listViaApi: async () => {
        calls += 1
        return [{ id: 'claude-opus-9', label: 'Opus 9' }]
      },
      listViaCli: async () => [],
      includeDescriptor: () => true,
    })
    await resolver.get()
    env = { ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-y' }
    await resolver.get()
    expect(calls).toBe(2)
  })

  it("serves both providers' real catalogs when both are credentialed", async () => {
    // Explicit, and independent of the neutral gate: this case is about the
    // CATALOG being right, not about when it is offered. `chatRuntimeServable`
    // itself is asserted directly, elsewhere.
    const resolver = createModelCatalogResolver({
      env: () => ({ ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' }),
      listViaApi: async () => [],
      listViaCli: async () => [],
      includeDescriptor: () => true,
    })
    const resolved = await resolver.get()
    expect(resolved.catalogs.map((c) => c.providerId).sort()).toEqual(['anthropic', 'openai'])
    const openai = resolved.catalogs.find((c) => c.providerId === 'openai')!
    // The placeholder had one entry. The real catalog has the seven the
    // picker offers, and exactly one of them opens.
    expect(openai.models.length).toBeGreaterThan(1)
    expect(openai.models.filter((m) => m.isDefault).map((m) => m.id)).toEqual(['gpt-5.6'])
  })

  it("falls back to every provider's static catalog when a live source throws", async () => {
    const resolver = createModelCatalogResolver({
      env: () => ({ ANTHROPIC_API_KEY: 'sk-ant-x' }),
      listViaApi: async () => {
        throw new Error('network down')
      },
      listViaCli: async () => [],
      log: () => {},
    })
    const resolved = await resolver.get()
    expect(resolved.source).toBe('static')
    expect(resolved.catalogs.map((c) => c.providerId)).toEqual(['anthropic'])
  })
})
