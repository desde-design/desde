/**
 * Tests for `CachedManifestLookup`. Pin the cache semantics that
 * `attribute()` depends on: synchronous get returns null on cache
 * miss (rather than throwing), prefetch is idempotent, failures
 * leave entries unset, invalidate works.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ComponentManifest, ComponentManifestSource } from '../core'
import { CachedManifestLookup } from './manifest-lookup'
import { NON_IDENTIFYING_COMPONENT_NAME } from './types'

function makeManifest(name: string, importPath = '@acme/design-system'): ComponentManifest {
  return {
    id: `${importPath}.${name}`,
    name,
    framework: 'vue3',
    designSystem: 'acme-ds',
    importPath,
    props: [],
  }
}

function makeSource(manifests: ComponentManifest[]): ComponentManifestSource {
  const byName = new Map(manifests.map((m) => [m.name, m]))
  return {
    id: 'test',
    framework: 'vue3',
    designSystem: 'acme-ds',
    listComponents: async () => Array.from(byName.values()),
    getComponent: async (name: string) => byName.get(name) ?? null,
  }
}

describe('CachedManifestLookup', () => {
  it('returns null on cache miss (does not throw)', () => {
    const lookup = new CachedManifestLookup(makeSource([]))
    expect(lookup.getByName('UiLabel')).toBeNull()
  })

  it('returns the cached manifest after prefetch', async () => {
    const klabel = makeManifest('UiLabel')
    const lookup = new CachedManifestLookup(makeSource([klabel]))
    await lookup.prefetch([{ name: 'UiLabel' }])
    expect(lookup.getByName('UiLabel')).toBe(klabel)
  })

  it('caches null for components the source returns null for (no refetch on next lookup)', async () => {
    const source = makeSource([])
    const getSpy = vi.spyOn(source, 'getComponent')
    const lookup = new CachedManifestLookup(source)
    await lookup.prefetch([{ name: 'NonExistent' }])
    expect(getSpy).toHaveBeenCalledTimes(1)
    // Second prefetch should NOT re-fetch (cache entry is null, not missing).
    await lookup.prefetch([{ name: 'NonExistent' }])
    expect(getSpy).toHaveBeenCalledTimes(1)
    expect(lookup.getByName('NonExistent')).toBeNull()
  })

  it('prefetch is idempotent for already-cached entries', async () => {
    const klabel = makeManifest('UiLabel')
    const source = makeSource([klabel])
    const getSpy = vi.spyOn(source, 'getComponent')
    const lookup = new CachedManifestLookup(source)
    await lookup.prefetch([{ name: 'UiLabel' }])
    await lookup.prefetch([{ name: 'UiLabel' }, { name: 'UiLabel' }])
    expect(getSpy).toHaveBeenCalledTimes(1)
  })

  it('source failures leave entry unset (subsequent prefetch retries)', async () => {
    const source = makeSource([makeManifest('UiLabel')])
    let calls = 0
    vi.spyOn(source, 'getComponent').mockImplementation(async (name: string) => {
      calls++
      if (calls === 1) throw new Error('network')
      return makeManifest(name)
    })
    const lookup = new CachedManifestLookup(source)
    await lookup.prefetch([{ name: 'UiLabel' }])
    expect(lookup.getByName('UiLabel')).toBeNull() // unset means null
    expect(calls).toBe(1)
    await lookup.prefetch([{ name: 'UiLabel' }]) // retries because not in cache
    expect(calls).toBe(2)
    expect(lookup.getByName('UiLabel')?.name).toBe('UiLabel')
  })

  it('invalidate(undefined) clears the entire cache', async () => {
    const lookup = new CachedManifestLookup(makeSource([makeManifest('UiLabel')]))
    await lookup.prefetch([{ name: 'UiLabel' }])
    expect(lookup.getByName('UiLabel')).not.toBeNull()
    lookup.invalidate()
    expect(lookup.getByName('UiLabel')).toBeNull()
  })

  it('invalidate(entries) clears only those keys', async () => {
    const source = makeSource([makeManifest('UiLabel'), makeManifest('UiInput')])
    const lookup = new CachedManifestLookup(source)
    await lookup.prefetch([{ name: 'UiLabel' }, { name: 'UiInput' }])
    lookup.invalidate([{ name: 'UiLabel' }])
    expect(lookup.getByName('UiLabel')).toBeNull()
    expect(lookup.getByName('UiInput')?.name).toBe('UiInput')
  })

  it('deduplicates in-flight fetches across concurrent prefetch calls', async () => {
    // Regression for codex P2: previously prefetch only checked
    // cache.has(), so two concurrent calls for the same key would
    // both invoke source.getComponent. The fix tracks in-flight
    // promises per key and reuses them.
    const klabel = makeManifest('UiLabel')
    const source = makeSource([klabel])
    let calls = 0
    let resolveGate: () => void = () => {}
    const gate = new Promise<void>((r) => { resolveGate = r })
    vi.spyOn(source, 'getComponent').mockImplementation(async (name: string) => {
      calls++
      await gate
      return name === 'UiLabel' ? klabel : null
    })
    const lookup = new CachedManifestLookup(source)
    // Three concurrent prefetches for the same key; should result
    // in exactly ONE source.getComponent call.
    const p1 = lookup.prefetch([{ name: 'UiLabel' }])
    const p2 = lookup.prefetch([{ name: 'UiLabel' }])
    const p3 = lookup.prefetch([{ name: 'UiLabel' }])
    resolveGate()
    await Promise.all([p1, p2, p3])
    expect(calls).toBe(1)
    expect(lookup.getByName('UiLabel')).toBe(klabel)
  })

  it('recovers from synchronously-throwing source.getComponent (regression: stale in-flight)', async () => {
    // Codex round-2 P1: previous fetchOne registered inFlight AFTER
    // running the async IIFE body. When source.getComponent throws
    // synchronously, the IIFE's try/catch/finally would walk through
    // and delete inFlight[key] BEFORE the set ever fired, then the
    // set installed an already-settled promise that future prefetch
    // calls reused forever — never retrying. The deferred-promise
    // pattern (set before starting work) closes that race.
    let throwSync = true
    const klabel = makeManifest('UiLabel')
    const source = makeSource([klabel])
    const getSpy = vi.spyOn(source, 'getComponent').mockImplementation(((name: string) => {
      if (throwSync) {
        // Synchronous throw — happens BEFORE returning a promise.
        // This is the exact shape the regression targets.
        throw new Error('sync boom')
      }
      return Promise.resolve(name === 'UiLabel' ? klabel : null)
    }) as ComponentManifestSource['getComponent'])
    const lookup = new CachedManifestLookup(source)
    // First prefetch: source throws sync. Entry stays un-cached;
    // inFlight is correctly cleared via the deferred pattern.
    await lookup.prefetch([{ name: 'UiLabel' }])
    expect(getSpy).toHaveBeenCalledTimes(1)
    expect(lookup.getByName('UiLabel')).toBeNull()
    // Second prefetch must RETRY because the in-flight entry was
    // correctly removed. With the buggy implementation, the stale
    // settled promise would be returned and this call would not
    // re-invoke source.getComponent.
    throwSync = false
    await lookup.prefetch([{ name: 'UiLabel' }])
    expect(getSpy).toHaveBeenCalledTimes(2)
    expect(lookup.getByName('UiLabel')).toBe(klabel)
  })

  it('deduplicates duplicate entries within a single prefetch call', async () => {
    // Same fix: a single prefetch call with duplicate entries
    // should issue only one fetch per unique key.
    const source = makeSource([makeManifest('UiLabel')])
    const getSpy = vi.spyOn(source, 'getComponent')
    const lookup = new CachedManifestLookup(source)
    await lookup.prefetch([
      { name: 'UiLabel' },
      { name: 'UiLabel' },
      { name: 'UiLabel' },
    ])
    expect(getSpy).toHaveBeenCalledTimes(1)
  })

  it('falls back to name-only resolution when prefetched WITH an importPath but looked up WITHOUT one', async () => {
    // This is the load-bearing real-world case: the shell prefetches
    // library manifests with a known importPath (`@acme/design-system`),
    // but the bridge can't determine importPath at runtime for
    // pre-compiled library bundles that strip `__file`, so the chain
    // entry's importPath is undefined. The lookup must still resolve.
    const klabel = makeManifest('UiLabel', '@acme/design-system')
    const lookup = new CachedManifestLookup(makeSource([klabel]))
    await lookup.prefetch([{ name: 'UiLabel', importPath: '@acme/design-system' }])
    expect(lookup.getByName('UiLabel')).toBe(klabel)
    expect(lookup.getByName('UiLabel', undefined)).toBe(klabel)
  })

  it('honors an exact cached not-found for a specific importPath instead of falling back', async () => {
    // When the caller asks for a SPECIFIC importPath and we have a
    // definitive cached answer for that exact key, don't silently
    // return a different library's manifest via name fallback.
    const labelAcme = makeManifest('UiLabel', '@acme/design-system')
    const source: ComponentManifestSource = {
      id: 'test',
      framework: 'vue3',
      designSystem: 'acme-ds',
      listComponents: async () => [labelAcme],
      // Returns the package's manifest only for the name; null otherwise.
      getComponent: async (name: string) => (name === 'UiLabel' ? labelAcme : null),
    }
    const lookup = new CachedManifestLookup(source)
    await lookup.prefetch([
      { name: 'UiLabel', importPath: '@acme/design-system' },
      { name: 'KMissing', importPath: 'other/library' },
    ])
    // Exact key cached as not-found → returns null, does NOT fall back
    // to UiLabel via name index (different name anyway, but the point is
    // the exact-key short-circuit fires).
    expect(lookup.getByName('KMissing', 'other/library')).toBeNull()
    // Name-only still resolves the one we have.
    expect(lookup.getByName('UiLabel')).toBe(labelAcme)
  })

  it('does NOT name-fall-back when an explicit, uncached importPath is requested', async () => {
    // Codex P1: prefetching the package's UiLabel must not satisfy a lookup for
    // a DIFFERENT library's UiLabel. An explicit importPath is a request
    // for that specific contract; an uncached exact key must miss
    // (return null) rather than return the package's manifest via the name
    // index, which would misattribute the edit to the wrong component.
    const labelAcme = makeManifest('UiLabel', '@acme/design-system')
    const lookup = new CachedManifestLookup(makeSource([labelAcme]))
    await lookup.prefetch([{ name: 'UiLabel', importPath: '@acme/design-system' }])
    expect(lookup.getByName('UiLabel', 'other/library')).toBeNull()
    // Sanity: the key and the name-only lookup still resolve.
    expect(lookup.getByName('UiLabel', '@acme/design-system')).toBe(labelAcme)
    expect(lookup.getByName('UiLabel')).toBe(labelAcme)
  })

  it('name-only fallback is cleared by invalidate', async () => {
    const klabel = makeManifest('UiLabel', '@acme/design-system')
    const lookup = new CachedManifestLookup(makeSource([klabel]))
    await lookup.prefetch([{ name: 'UiLabel', importPath: '@acme/design-system' }])
    expect(lookup.getByName('UiLabel')).toBe(klabel)
    lookup.invalidate([{ name: 'UiLabel', importPath: '@acme/design-system' }])
    expect(lookup.getByName('UiLabel')).toBeNull()
  })

  describe('hasFailedFetch', () => {
    it('is false for a key that was never requested', () => {
      const lookup = new CachedManifestLookup(makeSource([]))
      expect(lookup.hasFailedFetch('UiLabel')).toBe(false)
    })

    it('is false after a successful fetch, even one that resolved a confirmed miss', async () => {
      const lookup = new CachedManifestLookup(makeSource([]))
      await lookup.prefetch([{ name: 'NonExistent' }])
      // getByName correctly reports "no manifest" — and hasFailedFetch
      // confirms that's a REAL answer, not a fetch failure standing in
      // for one.
      expect(lookup.getByName('NonExistent')).toBeNull()
      expect(lookup.hasFailedFetch('NonExistent')).toBe(false)
    })

    it('is true after a fetch throws — the load-bearing distinction from a confirmed miss', async () => {
      const source = makeSource([])
      vi.spyOn(source, 'getComponent').mockRejectedValue(new Error('network'))
      const lookup = new CachedManifestLookup(source)
      await lookup.prefetch([{ name: 'UiLabel', importPath: '@acme/design-system' }])
      expect(lookup.getByName('UiLabel', '@acme/design-system')).toBeNull()
      expect(lookup.hasFailedFetch('UiLabel', '@acme/design-system')).toBe(true)
    })

    it('clears once a later prefetch for the same key actually resolves', async () => {
      const klabel = makeManifest('UiLabel')
      const source = makeSource([klabel])
      let calls = 0
      vi.spyOn(source, 'getComponent').mockImplementation(async (name: string) => {
        calls++
        if (calls === 1) throw new Error('network')
        return klabel.name === name ? klabel : null
      })
      const lookup = new CachedManifestLookup(source)
      await lookup.prefetch([{ name: 'UiLabel' }])
      expect(lookup.hasFailedFetch('UiLabel')).toBe(true)
      await lookup.prefetch([{ name: 'UiLabel' }]) // retries because not in cache
      expect(lookup.hasFailedFetch('UiLabel')).toBe(false)
      expect(lookup.getByName('UiLabel')).toBe(klabel)
    })

    it('is cleared by invalidate (specific key and full clear)', async () => {
      const source = makeSource([])
      vi.spyOn(source, 'getComponent').mockRejectedValue(new Error('network'))
      const lookup = new CachedManifestLookup(source)
      await lookup.prefetch([{ name: 'UiLabel', importPath: '@acme/design-system' }])
      expect(lookup.hasFailedFetch('UiLabel', '@acme/design-system')).toBe(true)
      lookup.invalidate([{ name: 'UiLabel', importPath: '@acme/design-system' }])
      expect(lookup.hasFailedFetch('UiLabel', '@acme/design-system')).toBe(false)

      await lookup.prefetch([{ name: 'UiLabel', importPath: '@acme/design-system' }])
      expect(lookup.hasFailedFetch('UiLabel', '@acme/design-system')).toBe(true)
      lookup.invalidate()
      expect(lookup.hasFailedFetch('UiLabel', '@acme/design-system')).toBe(false)
    })
  })

  it('importPath disambiguates name collisions in the cache key', async () => {
    const labelAcme = makeManifest('UiLabel', '@acme/design-system')
    const klabelOther = makeManifest('UiLabel', 'other/library')
    const source: ComponentManifestSource = {
      id: 'test',
      framework: 'vue3',
      designSystem: 'acme-ds',
      listComponents: async () => [labelAcme, klabelOther],
      // Simulate a source that disambiguates internally; here we
      // just return the package's UiLabel for any getByName call but the
      // cache keys both entries separately.
      getComponent: async () => labelAcme,
    }
    const lookup = new CachedManifestLookup(source)
    await lookup.prefetch([
      { name: 'UiLabel', importPath: '@acme/design-system' },
      { name: 'UiLabel', importPath: 'other/library' },
    ])
    expect(lookup.getByName('UiLabel', '@acme/design-system')).toBe(labelAcme)
    expect(lookup.getByName('UiLabel', 'other/library')).toBe(labelAcme)
  })

  describe('non-identifying component names (F9)', () => {
    it('never reaches the source for the anonymous placeholder', async () => {
      const getComponent = vi.fn(async () => null)
      const source: ComponentManifestSource = {
        id: 'test',
        framework: 'vue3',
        designSystem: 'acme-ds',
        listComponents: async () => [],
        getComponent,
      }
      const lookup = new CachedManifestLookup(source)
      await lookup.prefetch([
        { name: NON_IDENTIFYING_COMPONENT_NAME },
        { name: NON_IDENTIFYING_COMPONENT_NAME, importPath: '@acme/design-system' },
        { name: '   ' },
      ])
      // The whole point: an anonymous component can never have a manifest, so
      // the request was pure waste and a guaranteed 404 in the console.
      expect(getComponent).not.toHaveBeenCalled()
      expect(lookup.getByName(NON_IDENTIFYING_COMPONENT_NAME)).toBeNull()
    })

    it('records the skip as a CONFIRMED miss, not a failed fetch', async () => {
      // Load-bearing for drift: `hasFailedFetch` suppresses the
      // `unknown-component` signal because it means "we never found out". A
      // guarded skip DID find out — there is nothing to find — so conflating
      // the two would silence a real signal class on an unrelated component.
      const lookup = new CachedManifestLookup(makeSource([]))
      await lookup.prefetch([{ name: NON_IDENTIFYING_COMPONENT_NAME }])
      expect(lookup.hasFailedFetch(NON_IDENTIFYING_COMPONENT_NAME)).toBe(false)
    })

    it('still resolves real names in the same batch', async () => {
      const klabel = makeManifest('UiLabel')
      const lookup = new CachedManifestLookup(makeSource([klabel]))
      await lookup.prefetch([
        { name: NON_IDENTIFYING_COMPONENT_NAME },
        { name: 'UiLabel' },
      ])
      expect(lookup.getByName('UiLabel')).toBe(klabel)
    })
  })

})
