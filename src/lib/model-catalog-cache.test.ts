/**
 * `setCatalogCacheIfVersion` is the fix for FX5 item 2: an in-flight catalog
 * fetch settling AFTER `invalidateModelCatalogCache()` ran must not
 * repopulate the cache with the pre-invalidation catalog. See
 * `model-picker-chip.test.tsx`'s "an in-flight fetch cannot defeat an
 * invalidation racing it" for the end-to-end version of this; these tests
 * pin the primitive itself, directly and deterministically.
 *
 * The gate itself moved from `version` to the narrower `epoch` counter for
 * FX6 item 7: `version` bumps on every successful write too, which used to
 * make a second, equally fresh, concurrent write look stale just because a
 * sibling's write landed first. `epoch` only moves on an actual
 * invalidation, so these tests capture `getCatalogEpoch()` — the same
 * primitive `model-picker-chip.tsx`'s fetch effect captures at its own
 * start — rather than `getCatalogVersion()`.
 *
 * Each test re-imports the module after `vi.resetModules()`, matching
 * `model-picker-chip.test.tsx`'s convention, because the cache and its
 * counters are module-level state.
 */
import { describe, expect, it, vi } from 'vitest'

describe('setCatalogCacheIfVersion', () => {
  it('applies the write when the epoch still matches', async () => {
    vi.resetModules()
    const { getCatalogCache, getCatalogEpoch, getCatalogVersion, setCatalogCacheIfVersion } =
      await import('./model-catalog-cache')
    const before = getCatalogEpoch()
    const versionBefore = getCatalogVersion()
    const value = { catalogs: [], default: { provider: 'anthropic', model: 'x' } } as never
    setCatalogCacheIfVersion(before, value)
    expect(getCatalogCache()).toBe(value)
    // A successful write still bumps the version, same as `setCatalogCache`,
    // even though it leaves the epoch alone.
    expect(getCatalogVersion()).toBe(versionBefore + 1)
    expect(getCatalogEpoch()).toBe(before)
  })

  it('discards the write when the epoch has already moved on', async () => {
    vi.resetModules()
    const {
      getCatalogCache,
      getCatalogEpoch,
      invalidateModelCatalogCache,
      setCatalogCacheIfVersion,
    } = await import('./model-catalog-cache')
    const staleEpoch = getCatalogEpoch()
    // Something else invalidated the cache after `staleEpoch` was
    // captured — the exact shape of the race: a fetch that started before
    // the invalidation resolves after it.
    invalidateModelCatalogCache()
    const epochAfterInvalidate = getCatalogEpoch()
    const staleValue = { catalogs: [], default: { provider: 'anthropic', model: 'stale' } } as never
    setCatalogCacheIfVersion(staleEpoch, staleValue)
    expect(getCatalogCache()).toBeNull()
    // Discarding is silent: it does not itself bump the epoch again.
    expect(getCatalogEpoch()).toBe(epochAfterInvalidate)
  })

  it('applies a second concurrent write at the same starting epoch, since no invalidation happened between them', async () => {
    // FX6 item 7: two mounted chips fetching at once both capture the same
    // starting epoch. The first one's successful write must not make the
    // second look stale — nothing about the catalog changed between them,
    // only `version`, which also serves `useSyncExternalStore`'s change
    // signal but is not what this gate reads. Before the fix (when this
    // gate read `version`) the second write was discarded outright: it
    // self-healed, because the cache already held an equally fresh
    // catalog, but a response that was never actually stale should not be
    // thrown away.
    vi.resetModules()
    const { getCatalogCache, getCatalogEpoch, setCatalogCacheIfVersion } = await import(
      './model-catalog-cache'
    )
    const startingEpoch = getCatalogEpoch()
    const first = { catalogs: [], default: { provider: 'anthropic', model: 'first' } } as never
    const second = { catalogs: [], default: { provider: 'anthropic', model: 'second' } } as never
    setCatalogCacheIfVersion(startingEpoch, first)
    // The second chip's fetch started before the first one's write landed,
    // so it captured the SAME starting epoch, not a later one.
    setCatalogCacheIfVersion(startingEpoch, second)
    expect(getCatalogCache()).toBe(second)
  })

  it('does not resurrect a value once a later invalidation clears it, even for a stale write that lands second', async () => {
    vi.resetModules()
    const {
      getCatalogCache,
      getCatalogEpoch,
      invalidateModelCatalogCache,
      setCatalogCache,
      setCatalogCacheIfVersion,
    } = await import('./model-catalog-cache')
    const fresh = { catalogs: [], default: { provider: 'anthropic', model: 'fresh' } } as never
    setCatalogCache(fresh)
    const epochAtFreshWrite = getCatalogEpoch()
    invalidateModelCatalogCache()
    const stale = { catalogs: [], default: { provider: 'anthropic', model: 'stale' } } as never
    // A write carrying the OLD (pre-invalidation) epoch, arriving after
    // the invalidation, must not land — even though a plain write of the
    // same value would have succeeded before the invalidation.
    setCatalogCacheIfVersion(epochAtFreshWrite, stale)
    expect(getCatalogCache()).toBeNull()
  })
})
