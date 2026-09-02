import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  LAYERS_DENSITY_STORAGE_KEY,
  readStoredLayersDensity,
  writeStoredLayersDensity,
} from "./layers-density-storage"
import { DEFAULT_LAYERS_DENSITY } from "./layers-density-filter"

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe("readStoredLayersDensity", () => {
  it("returns the default when nothing is stored", () => {
    expect(readStoredLayersDensity()).toBe(DEFAULT_LAYERS_DENSITY)
  })

  it("round-trips every valid density", () => {
    for (const density of ["essentials", "detailed", "everything"] as const) {
      writeStoredLayersDensity(density)
      expect(readStoredLayersDensity()).toBe(density)
    }
  })

  it("falls back to the default for a stored value that is no longer valid", () => {
    // A key left behind by an older build, or a hand-edited one. Trusting it
    // would switch the filter on a level it cannot honour.
    for (const bad of ["compact", "ESSENTIALS", "", "null", "{}"]) {
      window.localStorage.setItem(LAYERS_DENSITY_STORAGE_KEY, bad)
      expect(readStoredLayersDensity()).toBe(DEFAULT_LAYERS_DENSITY)
    }
  })

  it("falls back to the default when localStorage throws", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage blocked")
    })
    expect(readStoredLayersDensity()).toBe(DEFAULT_LAYERS_DENSITY)
  })
})

describe("writeStoredLayersDensity", () => {
  it("writes under the desde.editor.* key the other preferences use", () => {
    writeStoredLayersDensity("detailed")
    expect(window.localStorage.getItem(LAYERS_DENSITY_STORAGE_KEY)).toBe(
      "detailed",
    )
    expect(LAYERS_DENSITY_STORAGE_KEY).toMatch(/^desde\.editor\./)
  })

  it("does not throw when storage is unavailable", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded")
    })
    expect(() => writeStoredLayersDensity("everything")).not.toThrow()
  })
})
