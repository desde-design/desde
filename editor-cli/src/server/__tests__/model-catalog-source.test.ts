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
