/**
 * `setCatalogCacheIfVersion` is the fix for FX5 item 2: an in-flight catalog
 * fetch settling AFTER `invalidateModelCatalogCache()` ran must not
 * repopulate the cache with the pre-invalidation catalog. See
 * `model-picker-chip.test.tsx`'s "an in-flight fetch cannot defeat an
 * invalidation racing it" for the end-to-end version of this; these tests
 * pin the primitive itself, directly and deterministically.
 *
 * Each test re-imports the module after `vi.resetModules()`, matching
 * `model-picker-chip.test.tsx`'s convention, because the cache and its
 * version counter are module-level state.
 */
import { describe, expect, it, vi } from 'vitest'

describe('setCatalogCacheIfVersion', () => {
  it('applies the write when the version still matches', async () => {
    vi.resetModules()
    const { getCatalogCache, getCatalogVersion, setCatalogCacheIfVersion } = await import(
      './model-catalog-cache'
    )
    const before = getCatalogVersion()
    const value = { catalogs: [], default: { provider: 'anthropic', model: 'x' } } as never
    setCatalogCacheIfVersion(before, value)
    expect(getCatalogCache()).toBe(value)
    // A successful write still bumps the version, same as `setCatalogCache`.
    expect(getCatalogVersion()).toBe(before + 1)
  })

  it('discards the write when the version has already moved on', async () => {
    vi.resetModules()
    const {
      getCatalogCache,
      getCatalogVersion,
      invalidateModelCatalogCache,
      setCatalogCacheIfVersion,
    } = await import('./model-catalog-cache')
    const staleVersion = getCatalogVersion()
    // Something else invalidated the cache after `staleVersion` was
    // captured — the exact shape of the race: a fetch that started before
    // the invalidation resolves after it.
    invalidateModelCatalogCache()
    const versionAfterInvalidate = getCatalogVersion()
    const staleValue = { catalogs: [], default: { provider: 'anthropic', model: 'stale' } } as never
    setCatalogCacheIfVersion(staleVersion, staleValue)
    expect(getCatalogCache()).toBeNull()
    // Discarding is silent: it does not itself bump the version again.
    expect(getCatalogVersion()).toBe(versionAfterInvalidate)
  })

  it('does not resurrect a value once a later invalidation clears it, even for a stale write that lands second', async () => {
    vi.resetModules()
    const {
      getCatalogCache,
      getCatalogVersion,
      invalidateModelCatalogCache,
      setCatalogCache,
      setCatalogCacheIfVersion,
    } = await import('./model-catalog-cache')
    const fresh = { catalogs: [], default: { provider: 'anthropic', model: 'fresh' } } as never
    setCatalogCache(fresh)
    const versionAtFreshWrite = getCatalogVersion()
    invalidateModelCatalogCache()
    const stale = { catalogs: [], default: { provider: 'anthropic', model: 'stale' } } as never
    // A write carrying the OLD (pre-invalidation) version, arriving after
    // the invalidation, must not land — even though a plain write of the
    // same value would have succeeded before the invalidation.
    setCatalogCacheIfVersion(versionAtFreshWrite, stale)
    expect(getCatalogCache()).toBeNull()
  })
})
