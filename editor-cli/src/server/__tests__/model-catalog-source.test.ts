import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANTHROPIC_MODEL_CATALOG } from '../../../../src/editor/llm-providers/anthropic-model-catalog.js'
import type { LiveModel } from '../../../../src/editor/llm-providers/live-model-catalog.js'
import { getDescriptor } from '../../../../src/editor/llm-providers/provider-registry.js'
import { createModelCatalogResolver, chatRuntimeServable } from '../model-catalog-source.js'

const OPENAI_DESCRIPTOR = getDescriptor('openai')!

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

  it('serves only the precedence default, static, when there are no credentials at all', async () => {
    // An uncredentialed provider is not served (codex fix): the picker must
    // never offer a provider the chat gate then refuses every turn. With
    // NOTHING credentialed the picker still needs a default to show on
    // first run, so the precedence default (Anthropic) is served alone.
    const { resolver, listViaApi, listViaCli } = makeResolver({})
    const result = await resolver.get()
    expect(result.source).toBe('static')
    expect(result.catalogs[0]).toEqual(ANTHROPIC_MODEL_CATALOG)
    expect(result.catalogs.map((c) => c.providerId)).toEqual(['anthropic'])
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
  afterEach(() => {
    delete process.env.EDITOR_NEUTRAL_CHAT
  })

  it("serves every provider whose chat runtime can dispatch, by default", async () => {
    // The neutral gate is opt-OUT now (Task 40), so with no configuration at
    // all the OpenAI group is servable and appears alongside Anthropic's —
    // both are credentialed here. Keyed per provider so neither call ever
    // reaches a real vendor.
    const resolver = createModelCatalogResolver({
      env: () => ({ ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-y' }),
      listViaApi: { anthropic: async () => [], openai: async () => [] },
      listViaCli: async () => [],
    })
    const resolved = await resolver.get()
    expect(resolved.catalogs.map((c) => c.providerId)).toEqual(['anthropic', 'openai'])
  })

  it("stops serving a provider whose chat runtime cannot dispatch, once the gate is off", async () => {
    // OpenAI's descriptor declares `chatRuntime: 'neutral'`. Serving its
    // catalog while the neutral runtime is off would let the picker offer a
    // model the chat handler refuses one second later.
    process.env.EDITOR_NEUTRAL_CHAT = '0'
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
      listViaApi: { anthropic: async () => [], openai: async () => [] },
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
      listViaApi: {
        anthropic: async () => {
          calls += 1
          return [{ id: 'claude-opus-9', label: 'Opus 9' }]
        },
        // Only servable once the second get() adds an OpenAI key; keyed so
        // that call never reaches the real vendor.
        openai: async () => [],
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
      listViaApi: { anthropic: async () => [], openai: async () => [] },
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

  it("falls back to the credentialed provider's static catalog when its live source throws", async () => {
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
    // OpenAI has no key here, so it is not served at all (credentialed-only,
    // codex fix) — only Anthropic's static fallback appears.
    expect(resolved.catalogs.map((c) => c.providerId)).toEqual(['anthropic'])
  })

  it("caches a partial fallback for the failure TTL, and reports the weakest source", async () => {
    // Anthropic's live source answers; OpenAI's throws. The aggregate
    // `source` has to read as the WEAKEST one served, not the strongest —
    // otherwise a struggling OpenAI would silently buy the whole response
    // the long success TTL instead of the short failure one.
    let t = 1_000_000
    let openaiCalls = 0
    const resolver = createModelCatalogResolver({
      env: () => ({ ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-y' }),
      listViaApi: {
        anthropic: async () => [{ id: 'claude-opus-9', label: 'Opus 9' }],
        openai: async () => {
          openaiCalls += 1
          throw new Error('openai down')
        },
      },
      listViaCli: async () => [],
      includeDescriptor: () => true,
      now: () => t,
      failureTtlMs: 1_000,
      ttlMs: 10 * 60_000,
      log: () => {},
    })
    const resolved = await resolver.get()
    expect(resolved.source).toBe('static')
    expect(resolved.catalogs.map((c) => c.providerId)).toEqual(['anthropic', 'openai'])
    // Held for the failure TTL, not the (much longer) success one.
    t += 500
    await resolver.get()
    expect(openaiCalls).toBe(1)
    t += 600
    await resolver.get()
    expect(openaiCalls).toBe(2)
  })
})

describe('chatRuntimeServable', () => {
  afterEach(() => {
    delete process.env.EDITOR_NEUTRAL_CHAT
  })

  it('serves the OpenAI catalog once the neutral gate is on', async () => {
    // `chatRuntimeServable` is the `includeDescriptor` default, and
    // production passes nothing, so the gate flipping to opt-OUT (Task 40)
    // is the whole mechanism by which an OpenAI group appears in the
    // picker. No handler edit, and no second switch to keep in step with
    // this one. No ANTHROPIC_API_KEY here, so Anthropic is uncredentialed
    // and does not appear — only OpenAI, which does.
    expect(chatRuntimeServable(OPENAI_DESCRIPTOR)).toBe(true)
    const resolver = createModelCatalogResolver({
      env: () => ({ OPENAI_API_KEY: 'sk-test' }),
      listViaApi: { openai: async () => [] },
      listViaCli: async () => [],
    })
    const resolved = await resolver.get()
    expect(resolved.catalogs.map((c) => c.providerId)).toEqual(['openai'])
  })

  it('does not serve it while the gate is explicitly off', async () => {
    process.env.EDITOR_NEUTRAL_CHAT = '0'
    expect(chatRuntimeServable(OPENAI_DESCRIPTOR)).toBe(false)
    // OpenAI is excluded before credentials are even considered (the gate),
    // and Anthropic has no key here either, so nothing is credentialed and
    // the precedence default's static catalog is served alone.
    const resolver = createModelCatalogResolver({
      env: () => ({ OPENAI_API_KEY: 'sk-test' }),
      listViaApi: async () => [],
      listViaCli: async () => [],
    })
    const resolved = await resolver.get()
    expect(resolved.catalogs.map((c) => c.providerId)).toEqual(['anthropic'])
  })

  it('CX7 item 4: the nothing-credentialed fallback picks a SERVABLE precedence id, not DEFAULT_PROVIDER_PRECEDENCE[0] unconditionally', async () => {
    // Anthropic is excluded from THIS resolution's servable set (via
    // `includeDescriptor`, the same seam the two tests above use), and
    // nobody is credentialed. `DEFAULT_PROVIDER_PRECEDENCE[0]` is
    // 'anthropic' — unconditionally trusting it would serve a provider this
    // resolution was never allowed to serve at all. The fallback must walk
    // the precedence list for the first id that IS in the servable set
    // (openai here).
    const resolver = createModelCatalogResolver({
      env: () => ({}),
      listViaApi: async () => [],
      listViaCli: async () => [],
      includeDescriptor: (d) => d.id !== 'anthropic',
    })
    const resolved = await resolver.get()
    expect(resolved.catalogs.map((c) => c.providerId)).toEqual(['openai'])
  })
})

describe('every provider is injectable, so no unit test reaches a real vendor', () => {
  afterEach(() => {
    delete process.env.EDITOR_NEUTRAL_CHAT
  })

  it('never reaches the network from a unit test, for any provider', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      throw new Error('network reached: ' + String(input))
    }) as typeof fetch
    try {
      const resolver = createModelCatalogResolver({
        env: () => ({ ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-y' }),
        listViaApi: { anthropic: async () => [], openai: async () => [] },
        listViaCli: async () => [],
        log: () => {},
      })
      const r = await resolver.get()
      expect(r.catalogs).toHaveLength(2)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('keys the cache on the base URL and passes it to the live lookup', async () => {
    const seen: Array<{ baseUrl?: string }> = []
    const env: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: 'sk-y',
      OPENAI_BASE_URL: 'https://gateway.internal/v1',
    }
    const resolver = createModelCatalogResolver({
      env: () => env,
      listViaApi: {
        openai: async (input) => {
          seen.push({ baseUrl: input.baseUrl })
          return []
        },
      },
      listViaCli: async () => [],
      log: () => {},
    })
    await resolver.get()
    expect(seen[0]?.baseUrl).toBe('https://gateway.internal/v1')
    // A changed base URL is a different provider identity — a cache miss,
    // not a stale hit.
    env.OPENAI_BASE_URL = 'https://other.internal/v1'
    await resolver.get()
    expect(seen).toHaveLength(2)
    expect(seen[1]?.baseUrl).toBe('https://other.internal/v1')
  })

  it('logs once per (provider, model) when a served model has no rate card', async () => {
    const logged: string[] = []
    const resolver = createModelCatalogResolver({
      env: () => ({ ANTHROPIC_API_KEY: 'sk-ant-x' }),
      listViaApi: {
        anthropic: async () => [{ id: 'claude-mystery-9', label: 'Mystery 9' }],
      },
      listViaCli: async () => [],
      log: (message) => logged.push(message),
    })
    await resolver.get()
    // Force a second real resolution (not a cache hit) so the dedup is
    // proven by the log-once guard, not by the cache alone.
    resolver.invalidate()
    await resolver.get()
    const rateCardLines = logged.filter((m) => m.includes('no rate card for anthropic/claude-mystery-9'))
    expect(rateCardLines).toHaveLength(1)
  })
})
