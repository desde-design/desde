import { describe, expect, it } from "vitest"
import { InMemoryStorage } from "./storage/in-memory-storage"
import {
  ALLOW_PUBLIC_LINKS_KEY,
  getAllowPublicLinks,
  invalidateInstanceSettingsCache,
} from "./instance-settings"

/**
 * The public-link kill switch is a SECURITY setting: it decides whether an
 * anonymous holder of a URL can read a `public-link` project at all. So its
 * reader gets its own tests rather than being covered only through
 * `canReadProject`, and the interesting cases are the ones the happy path
 * never produces.
 */
describe("getAllowPublicLinks", () => {
  it("defaults to ON when the setting was never written", async () => {
    expect(await getAllowPublicLinks(new InMemoryStorage())).toBe(true)
  })

  it("round-trips the exact representation the admin Settings route stores", async () => {
    const storage = new InMemoryStorage()
    // `String(boolean)` is literally what `PATCH /instance/settings` writes.
    await storage.setInstanceSetting(ALLOW_PUBLIC_LINKS_KEY, String(false))
    invalidateInstanceSettingsCache(storage)
    expect(await getAllowPublicLinks(storage)).toBe(false)
    await storage.setInstanceSetting(ALLOW_PUBLIC_LINKS_KEY, String(true))
    // The read above cached `false`. A test that pokes storage directly is a
    // writer that is not the settings route, so it carries the route's
    // obligation to invalidate — see this module's header.
    invalidateInstanceSettingsCache(storage)
    expect(await getAllowPublicLinks(storage)).toBe(true)
  })

  /**
   * A value that is present but is neither `"true"` nor `"false"` can only
   * come from a hand-edited database — the route is the only writer and it
   * stores `String(boolean)`. It must read as OFF.
   *
   * `raw !== "false"` was the first implementation and read every one of
   * these as ON, which is a corrupted kill switch failing OPEN. Absent is
   * different and stays ON: "never configured" has a documented default,
   * whereas an unrecognized value means the row was written by something
   * other than this product and there is nothing to infer from it.
   */
  it.each(["", "TRUE", "True", "1", "yes", "on", "null", " true", "true ", "0", "nonsense"])(
    "reads the unrecognized stored value %j as OFF, not ON",
    async (raw) => {
      const storage = new InMemoryStorage()
      await storage.setInstanceSetting(ALLOW_PUBLIC_LINKS_KEY, raw)
      expect(await getAllowPublicLinks(storage)).toBe(false)
    },
  )

  it("reads only its own key — an unrelated setting does not flip it", async () => {
    const storage = new InMemoryStorage()
    await storage.setInstanceSetting("something-else", "false")
    expect(await getAllowPublicLinks(storage)).toBe(true)
  })
})

/**
 * The cache (M2 review fix). It exists because `loadProjectReadPolicy` runs on
 * the prototype-serving path — once per ASSET, not once per API call — so the
 * uncached reader put a database round-trip in front of every image, font and
 * chunk a running prototype loads.
 *
 * Three properties are what make it safe, and each gets a test: it actually
 * caches, an explicit invalidation actually drops it, and two storages never
 * see each other's value.
 */
describe("getAllowPublicLinks — caching", () => {
  /** Counts reads so a cache HIT is observable, not merely inferred from the value. */
  function countingStorage(initial: string | null) {
    let value = initial
    let reads = 0
    return {
      get reads() {
        return reads
      },
      set(next: string | null) {
        value = next
      },
      storage: {
        async getInstanceSetting(key: string): Promise<string | null> {
          if (key !== ALLOW_PUBLIC_LINKS_KEY) return null
          reads += 1
          return value
        },
      },
    }
  }

  it("serves a second read from cache within the TTL — the storage is hit once", async () => {
    const s = countingStorage("false")
    expect(await getAllowPublicLinks(s.storage)).toBe(false)
    expect(await getAllowPublicLinks(s.storage)).toBe(false)
    expect(await getAllowPublicLinks(s.storage)).toBe(false)
    expect(s.reads).toBe(1)
  })

  it("a write that is NOT invalidated is invisible until the cache is dropped — which is why the PATCH route invalidates", async () => {
    const s = countingStorage("true")
    expect(await getAllowPublicLinks(s.storage)).toBe(true)

    s.set("false")
    // Still the cached answer: the whole point of the route's explicit
    // invalidation call is that this state never survives a real admin toggle.
    expect(await getAllowPublicLinks(s.storage)).toBe(true)
    expect(s.reads).toBe(1)

    invalidateInstanceSettingsCache(s.storage)
    expect(await getAllowPublicLinks(s.storage)).toBe(false)
    expect(s.reads).toBe(2)
  })

  it("keys by storage instance — one storage's cached value never answers another's read", async () => {
    const a = countingStorage("false")
    const b = countingStorage("true")

    expect(await getAllowPublicLinks(a.storage)).toBe(false)
    expect(await getAllowPublicLinks(b.storage)).toBe(true)
    // And again, from cache — still each with its own value.
    expect(await getAllowPublicLinks(a.storage)).toBe(false)
    expect(await getAllowPublicLinks(b.storage)).toBe(true)
    expect(a.reads).toBe(1)
    expect(b.reads).toBe(1)
  })

  it("invalidating one storage leaves another storage's cache intact", async () => {
    const a = countingStorage("false")
    const b = countingStorage("false")
    expect(await getAllowPublicLinks(a.storage)).toBe(false)
    expect(await getAllowPublicLinks(b.storage)).toBe(false)

    invalidateInstanceSettingsCache(a.storage)
    a.set("true")
    b.set("true")

    expect(await getAllowPublicLinks(a.storage)).toBe(true)
    // `b` was never invalidated, so it still answers from ITS own cache.
    expect(await getAllowPublicLinks(b.storage)).toBe(false)
    expect(a.reads).toBe(2)
    expect(b.reads).toBe(1)
  })

  it("invalidating a storage that was never read is a harmless no-op", () => {
    const s = countingStorage("true")
    expect(() => invalidateInstanceSettingsCache(s.storage)).not.toThrow()
  })
})
