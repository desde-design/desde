/**
 * Tests for `StorybookUrlManifestSource`. Uses a stubbed fetch so the
 * tests are deterministic and offline.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  StorybookUrlManifestSource,
  _resetStorybookUrlCacheForTests,
} from './index'

beforeEach(() => {
  _resetStorybookUrlCacheForTests()
})

function makeFetchStub(
  responses: Record<string, { status?: number; body?: unknown }>,
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    const entry = responses[url]
    if (!entry) {
      // Default: 404 so the adapter falls through to the next probe.
      return new Response('not found', { status: 404 }) as Response
    }
    const status = entry.status ?? 200
    const body = entry.body ?? null
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }) as Response
  }) as unknown as typeof fetch
}

const V7_INDEX = {
  v: 5,
  entries: {
    'components-button--primary': {
      id: 'components-button--primary',
      title: 'Components/Button',
      name: 'Primary',
      type: 'story' as const,
      importPath: './src/components/Button.stories.ts',
    },
    'components-button--secondary': {
      id: 'components-button--secondary',
      title: 'Components/Button',
      name: 'Secondary',
      type: 'story' as const,
      importPath: './src/components/Button.stories.ts',
    },
    'forms-input--default': {
      id: 'forms-input--default',
      title: 'Forms/Input',
      name: 'Default',
      type: 'story' as const,
      importPath: './src/components/Input.stories.ts',
    },
    'docs-only': {
      id: 'docs-only',
      title: 'Docs/Welcome',
      name: 'Welcome',
      type: 'docs' as const,
    },
  },
}

const V6_INDEX = {
  v: 3,
  stories: {
    'components-button--primary': {
      id: 'components-button--primary',
      title: 'Components/Button',
      name: 'Primary',
      importPath: './src/components/Button.stories.ts',
    },
  },
}

describe('StorybookUrlManifestSource', () => {
  it('groups Storybook v7 entries by component name and emits stub manifests', async () => {
    const fetchStub = makeFetchStub({
      'https://example.com/index.json': { body: V7_INDEX },
    })
    const source = new StorybookUrlManifestSource({
      baseUrl: 'https://example.com',
      designSystem: 'example-ds',
      fetch: fetchStub,
    })
    const list = await source.listComponents()
    const names = list.map((m) => m.name).sort()
    expect(names).toEqual(['Button', 'Input'])
  })

  it('emits empty props/slots/events (discovery only)', async () => {
    const fetchStub = makeFetchStub({
      'https://example.com/index.json': { body: V7_INDEX },
    })
    const source = new StorybookUrlManifestSource({
      baseUrl: 'https://example.com',
      designSystem: 'example-ds',
      fetch: fetchStub,
    })
    const button = await source.getComponent('Button')
    expect(button).not.toBeNull()
    if (!button) return
    expect(button.props).toEqual([])
    expect(button.slots).toEqual([])
    expect(button.events).toEqual([])
  })

  it('stamps the source extractor as storybook-url', async () => {
    const fetchStub = makeFetchStub({
      'https://example.com/index.json': { body: V7_INDEX },
    })
    const source = new StorybookUrlManifestSource({
      baseUrl: 'https://example.com',
      designSystem: 'example-ds',
      fetch: fetchStub,
    })
    const button = await source.getComponent('Button')
    expect(button?.source?.extractor).toBe('storybook-url')
  })

  it('records the Storybook URL as docsUrl in extensions', async () => {
    const fetchStub = makeFetchStub({
      'https://example.com/index.json': { body: V7_INDEX },
    })
    const source = new StorybookUrlManifestSource({
      baseUrl: 'https://example.com',
      designSystem: 'example-ds',
      fetch: fetchStub,
    })
    const button = await source.getComponent('Button')
    expect(button?.extensions?.docsUrl).toBe(
      'https://example.com/?path=/story/components-button--primary',
    )
    expect(button?.extensions?.storybookId).toBe('components-button--primary')
  })

  it('skips MDX docs entries', async () => {
    const fetchStub = makeFetchStub({
      'https://example.com/index.json': { body: V7_INDEX },
    })
    const source = new StorybookUrlManifestSource({
      baseUrl: 'https://example.com',
      designSystem: 'example-ds',
      fetch: fetchStub,
    })
    expect(await source.getComponent('Welcome')).toBeNull()
  })

  it('falls back to stories.json for v6 deployments', async () => {
    const fetchStub = makeFetchStub({
      // index.json missing → 404 → fall back
      'https://example.com/index.json': { status: 404 },
      'https://example.com/stories.json': { body: V6_INDEX },
    })
    const source = new StorybookUrlManifestSource({
      baseUrl: 'https://example.com',
      designSystem: 'example-ds',
      fetch: fetchStub,
    })
    const button = await source.getComponent('Button')
    expect(button?.name).toBe('Button')
  })

  it('returns an empty list when both index and stories endpoints fail', async () => {
    const fetchStub = makeFetchStub({})
    const source = new StorybookUrlManifestSource({
      baseUrl: 'https://example.com',
      designSystem: 'example-ds',
      fetch: fetchStub,
    })
    expect(await source.listComponents()).toEqual([])
    expect(await source.getComponent('Button')).toBeNull()
  })

  it('survives a network error on the first probe and tries the next', async () => {
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/index.json')) {
        throw new Error('ECONNRESET')
      }
      return new Response(JSON.stringify(V6_INDEX), { status: 200 }) as Response
    }) as unknown as typeof fetch
    const source = new StorybookUrlManifestSource({
      baseUrl: 'https://example.com',
      designSystem: 'example-ds',
      fetch: fetchStub,
    })
    const button = await source.getComponent('Button')
    expect(button?.name).toBe('Button')
  })

  it('uses the last segment of the title as the component name', async () => {
    const fetchStub = makeFetchStub({
      'https://example.com/index.json': {
        body: {
          v: 5,
          entries: {
            'a-b-c-deeply-nested--default': {
              id: 'a-b-c-deeply-nested--default',
              title: 'A/B/C/DeeplyNested',
              name: 'Default',
              type: 'story' as const,
            },
          },
        },
      },
    })
    const source = new StorybookUrlManifestSource({
      baseUrl: 'https://example.com',
      designSystem: 'example-ds',
      fetch: fetchStub,
    })
    expect(await source.getComponent('DeeplyNested')).not.toBeNull()
  })

  it('caches results within the TTL window', async () => {
    const calls: string[] = []
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      return new Response(JSON.stringify(V7_INDEX), { status: 200 }) as Response
    }) as unknown as typeof fetch
    const source = new StorybookUrlManifestSource({
      baseUrl: 'https://example.com',
      designSystem: 'example-ds',
      fetch: fetchStub,
      // Very long TTL so the second call is guaranteed to hit cache.
      ttlMs: 60_000,
    })
    await source.listComponents()
    await source.listComponents()
    // Each populate makes at most one successful fetch (index.json).
    expect(calls.filter((u) => u.endsWith('/index.json')).length).toBe(1)
  })

  it('refetches when ttlMs is 0', async () => {
    const calls: string[] = []
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      return new Response(JSON.stringify(V7_INDEX), { status: 200 }) as Response
    }) as unknown as typeof fetch
    const source = new StorybookUrlManifestSource({
      baseUrl: 'https://example.com',
      designSystem: 'example-ds',
      fetch: fetchStub,
      ttlMs: 0,
    })
    await source.listComponents()
    await source.listComponents()
    expect(calls.filter((u) => u.endsWith('/index.json')).length).toBe(2)
  })

  it('coalesces concurrent fetches on cache miss', async () => {
    // Two concurrent populate calls that both miss the cache should
    // share one outbound fetch. Regression for codex re-review's P3:
    // bursty inspector usage shouldn't multiply outbound traffic.
    const pendingResolves: Array<(v: Response) => void> = []
    const calls: string[] = []
    const fetchStub = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      // Return a never-settling promise we control by hand.
      return new Promise<Response>((resolve) => {
        pendingResolves.push(resolve)
      })
    }) as unknown as typeof fetch
    const a = new StorybookUrlManifestSource({
      baseUrl: 'https://example.com',
      designSystem: 'example-ds',
      fetch: fetchStub,
      ttlMs: 60_000,
    })
    const b = new StorybookUrlManifestSource({
      baseUrl: 'https://example.com',
      designSystem: 'example-ds',
      fetch: fetchStub,
      ttlMs: 60_000,
    })
    const pA = a.listComponents()
    const pB = b.listComponents()
    // Settle the in-flight fetch.
    expect(pendingResolves.length).toBe(1)
    pendingResolves[0](
      new Response(JSON.stringify(V7_INDEX), { status: 200 }) as Response,
    )
    await Promise.all([pA, pB])
    // Only one /index.json fetch should have occurred despite two
    // concurrent populate calls.
    expect(calls.filter((u) => u.endsWith('/index.json')).length).toBe(1)
  })

  it('shares the cache across instances pointed at the same URL', async () => {
    // Two distinct source instances with the same baseUrl + TTL should
    // dedupe their fetches. This is the regression guard for the
    // codex review's P2: the route rebuilds adapters per request, so
    // without module-level caching every inspector click would
    // trigger a fresh outbound fetch.
    const calls: string[] = []
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      return new Response(JSON.stringify(V7_INDEX), { status: 200 }) as Response
    }) as unknown as typeof fetch
    const a = new StorybookUrlManifestSource({
      baseUrl: 'https://example.com',
      designSystem: 'example-ds',
      fetch: fetchStub,
      ttlMs: 60_000,
    })
    const b = new StorybookUrlManifestSource({
      baseUrl: 'https://example.com',
      designSystem: 'example-ds',
      fetch: fetchStub,
      ttlMs: 60_000,
    })
    await a.listComponents()
    await b.listComponents()
    expect(calls.filter((u) => u.endsWith('/index.json')).length).toBe(1)
  })

  it('strips trailing slash from baseUrl when probing endpoints', async () => {
    const fetchStub = makeFetchStub({
      'https://example.com/index.json': { body: V7_INDEX },
    })
    const source = new StorybookUrlManifestSource({
      baseUrl: 'https://example.com/',
      designSystem: 'example-ds',
      fetch: fetchStub,
    })
    const list = await source.listComponents()
    expect(list.length).toBeGreaterThan(0)
  })
})
