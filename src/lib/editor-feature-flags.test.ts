/**
 * Phase 5 of tasks/editor-detached-sessions.md — feature-flag
 * resolution tests. The flag is read at module load from
 * `window.__DESDE_CLI__.detachedSessions` (CLI bootstrap), so
 * each test isolates module state with `vi.resetModules()` and
 * stubs `globalThis.window` before re-importing.
 */

import { afterEach, describe, expect, it, vi } from "vitest"

// The CLI bootstrap shape is wider than what the feature-flag module
// actually reads. Use a permissive shim type to silence noisy excess-
// property complaints when planting the global.
type StubBootstrap = {
  detachedSessions?: boolean
  [key: string]: unknown
}
type StubWindow = { __DESDE_CLI__?: StubBootstrap }

describe("EDITOR_DETACHED_SESSIONS", () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  afterEach(() => {
    // Restore in case a test failed mid-stub.
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window
    } else {
      ;(globalThis as { window?: unknown }).window = originalWindow
    }
    vi.resetModules()
  })

  function setBootstrap(detachedSessions: boolean | undefined): void {
    const stub: StubWindow = {
      __DESDE_CLI__: {
        ...(detachedSessions !== undefined ? { detachedSessions } : {}),
      },
    }
    ;(globalThis as { window?: StubWindow }).window = stub
  }

  it("defaults to true when the CLI bootstrap omits the field", async () => {
    setBootstrap(undefined)
    vi.resetModules()
    const mod = await import("./editor-feature-flags")
    expect(mod.EDITOR_DETACHED_SESSIONS).toBe(true)
  })

  it("is true when the CLI bootstrap sets detachedSessions: true", async () => {
    setBootstrap(true)
    vi.resetModules()
    const mod = await import("./editor-feature-flags")
    expect(mod.EDITOR_DETACHED_SESSIONS).toBe(true)
  })

  it("is false ONLY when the CLI bootstrap explicitly sets detachedSessions: false", async () => {
    setBootstrap(false)
    vi.resetModules()
    const mod = await import("./editor-feature-flags")
    expect(mod.EDITOR_DETACHED_SESSIONS).toBe(false)
  })

  it("defaults to true when there is no CLI bootstrap (web shell case)", async () => {
    ;(globalThis as { window?: StubWindow }).window = {}
    vi.resetModules()
    const mod = await import("./editor-feature-flags")
    expect(mod.EDITOR_DETACHED_SESSIONS).toBe(true)
  })
})

describe("EDITOR_FRAMEWORK", () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window
    } else {
      ;(globalThis as { window?: unknown }).window = originalWindow
    }
    vi.resetModules()
  })

  it("reports 'react' when the CLI bootstrap detected React", async () => {
    ;(globalThis as { window?: StubWindow }).window = {
      __DESDE_CLI__: { framework: "react" },
    }
    vi.resetModules()
    const mod = await import("./editor-feature-flags")
    expect(mod.EDITOR_FRAMEWORK).toBe("react")
  })

  it("defaults to 'vue3' when the bootstrap omits framework", async () => {
    ;(globalThis as { window?: StubWindow }).window = {
      __DESDE_CLI__: {},
    }
    vi.resetModules()
    const mod = await import("./editor-feature-flags")
    expect(mod.EDITOR_FRAMEWORK).toBe("vue3")
  })

  it("defaults to 'vue3' on the web shell (no CLI bootstrap)", async () => {
    ;(globalThis as { window?: StubWindow }).window = {}
    vi.resetModules()
    const mod = await import("./editor-feature-flags")
    expect(mod.EDITOR_FRAMEWORK).toBe("vue3")
  })
})

describe("EDITOR_IMPORTANT_UTILITIES / EDITOR_ELEMENT_SCOPE_OUTRANKED", () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window
    } else {
      ;(globalThis as { window?: unknown }).window = originalWindow
    }
    vi.resetModules()
  })

  async function load(bootstrap: StubBootstrap | undefined) {
    ;(globalThis as { window?: StubWindow }).window =
      bootstrap === undefined ? {} : { __DESDE_CLI__: bootstrap }
    vi.resetModules()
    return import("./editor-feature-flags")
  }

  it("both false when the bootstrap omits styleCapabilities (today's behavior)", async () => {
    const mod = await load({})
    expect(mod.EDITOR_IMPORTANT_UTILITIES).toBe(false)
    expect(mod.EDITOR_ELEMENT_SCOPE_OUTRANKED).toBe(false)
  })

  it("both false on the web shell (no CLI bootstrap)", async () => {
    const mod = await load(undefined)
    expect(mod.EDITOR_IMPORTANT_UTILITIES).toBe(false)
    expect(mod.EDITOR_ELEMENT_SCOPE_OUTRANKED).toBe(false)
  })

  it("both false when detection reported importantUtilities: false", async () => {
    const mod = await load({ styleCapabilities: { importantUtilities: false } })
    expect(mod.EDITOR_IMPORTANT_UTILITIES).toBe(false)
    expect(mod.EDITOR_ELEMENT_SCOPE_OUTRANKED).toBe(false)
  })

  it("outranks the element scope on Vue with important utilities", async () => {
    const mod = await load({
      framework: "vue3",
      styleCapabilities: { importantUtilities: true },
    })
    expect(mod.EDITOR_IMPORTANT_UTILITIES).toBe(true)
    // Vue's element scope is an UNLAYERED `!important` [data-desde-src] rule — the
    // weakest important tier.
    expect(mod.EDITOR_ELEMENT_SCOPE_OUTRANKED).toBe(true)
  })

  it("outranks the element scope on React with a non-Tailwind styling system", async () => {
    const mod = await load({
      framework: "react",
      stylingSystem: "inline",
      styleCapabilities: { importantUtilities: true },
    })
    // A plain inline `style={{}}` declaration loses to any `!important` rule.
    expect(mod.EDITOR_ELEMENT_SCOPE_OUTRANKED).toBe(true)
  })

  it("does NOT outrank on React + Tailwind — that lane replaces the utility itself", async () => {
    const mod = await load({
      framework: "react",
      stylingSystem: "tailwind",
      styleCapabilities: { importantUtilities: true },
    })
    expect(mod.EDITOR_IMPORTANT_UTILITIES).toBe(true)
    expect(mod.EDITOR_ELEMENT_SCOPE_OUTRANKED).toBe(false)
  })
})

/**
 * Dormant edit lanes (product decision 2026-08-11 — `tasks/dev-server-hosts.md`
 * § 9e). Both default OFF, and both must default OFF for the same reason
 * `EDITOR_CANVAS` does: an opt-IN flag whose absent state reads as enabled is
 * not a gate. The `=== true` comparison rather than `!== false` is the whole
 * mechanism, so it gets a case per falsy shape.
 */
describe("EDITOR_LANE_DETACH / EDITOR_LANE_SWAP", () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window
    } else {
      ;(globalThis as { window?: unknown }).window = originalWindow
    }
    vi.resetModules()
  })

  async function load(bootstrap: StubBootstrap | undefined) {
    ;(globalThis as { window?: StubWindow }).window =
      bootstrap === undefined ? {} : { __DESDE_CLI__: bootstrap }
    vi.resetModules()
    return import("./editor-feature-flags")
  }

  it("both dormant when the bootstrap omits the lanes block", async () => {
    const mod = await load({})
    expect(mod.EDITOR_LANE_DETACH).toBe(false)
    expect(mod.EDITOR_LANE_SWAP).toBe(false)
  })

  it("both dormant on the web shell (no CLI bootstrap at all)", async () => {
    const mod = await load(undefined)
    expect(mod.EDITOR_LANE_DETACH).toBe(false)
    expect(mod.EDITOR_LANE_SWAP).toBe(false)
  })

  it("both dormant when the block is present but the keys are absent", async () => {
    const mod = await load({ lanes: {} })
    expect(mod.EDITOR_LANE_DETACH).toBe(false)
    expect(mod.EDITOR_LANE_SWAP).toBe(false)
  })

  it("enables ONLY the lane set to true", async () => {
    const mod = await load({ lanes: { detach: true } })
    expect(mod.EDITOR_LANE_DETACH).toBe(true)
    expect(mod.EDITOR_LANE_SWAP).toBe(false)
  })

  it("enables both when both are true", async () => {
    const mod = await load({ lanes: { detach: true, swap: true } })
    expect(mod.EDITOR_LANE_DETACH).toBe(true)
    expect(mod.EDITOR_LANE_SWAP).toBe(true)
  })

  it("stays dormant on an explicit false", async () => {
    const mod = await load({ lanes: { detach: false, swap: false } })
    expect(mod.EDITOR_LANE_DETACH).toBe(false)
    expect(mod.EDITOR_LANE_SWAP).toBe(false)
  })
})

/**
 * In-app code view (product decision 2026-08-14 — it needs visual work and
 * should not ship half finished). Default OFF, for the same reason
 * `EDITOR_CANVAS` and the dormant lanes are: an opt-IN flag whose absent
 * state reads as enabled is not a gate. The `=== true` comparison rather
 * than `!== false` is the whole mechanism, so it gets a case per falsy shape.
 */
describe("EDITOR_CODE_VIEW", () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window
    } else {
      ;(globalThis as { window?: unknown }).window = originalWindow
    }
    vi.resetModules()
  })

  async function load(bootstrap: StubBootstrap | undefined) {
    ;(globalThis as { window?: StubWindow }).window =
      bootstrap === undefined ? {} : { __DESDE_CLI__: bootstrap }
    vi.resetModules()
    return import("./editor-feature-flags")
  }

  it("is dormant when the bootstrap omits the key", async () => {
    expect((await load({})).EDITOR_CODE_VIEW).toBe(false)
  })

  it("is dormant on the web shell (no CLI bootstrap at all)", async () => {
    expect((await load(undefined)).EDITOR_CODE_VIEW).toBe(false)
  })

  it("stays dormant on an explicit false", async () => {
    expect((await load({ codeView: false })).EDITOR_CODE_VIEW).toBe(false)
  })

  it("stays dormant on a truthy-but-not-true value", async () => {
    // `=== true`, not `!== false`: a config typo must not open the gate.
    expect((await load({ codeView: 1 })).EDITOR_CODE_VIEW).toBe(false)
    expect((await load({ codeView: "true" })).EDITOR_CODE_VIEW).toBe(false)
  })

  it("enables on an explicit true", async () => {
    expect((await load({ codeView: true })).EDITOR_CODE_VIEW).toBe(true)
  })

  it("does not disturb the other dormant gates", async () => {
    const mod = await load({ codeView: true })
    expect(mod.EDITOR_CANVAS).toBe(false)
    expect(mod.EDITOR_NOTES).toBe(false)
    expect(mod.EDITOR_LANE_DETACH).toBe(false)
    expect(mod.EDITOR_LANE_SWAP).toBe(false)
  })
})

/**
 * Notes (product decision 2026-08-14). Default OFF, same `=== true` gate as
 * every other dormant surface, so a config typo cannot open it.
 */
describe("EDITOR_NOTES", () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window
    } else {
      ;(globalThis as { window?: unknown }).window = originalWindow
    }
    vi.resetModules()
  })

  async function load(bootstrap: StubBootstrap | undefined) {
    ;(globalThis as { window?: StubWindow }).window =
      bootstrap === undefined ? {} : { __DESDE_CLI__: bootstrap }
    vi.resetModules()
    return import("./editor-feature-flags")
  }

  it("is dormant when the bootstrap omits the key", async () => {
    expect((await load({})).EDITOR_NOTES).toBe(false)
  })

  it("is dormant on the web shell (no CLI bootstrap at all)", async () => {
    expect((await load(undefined)).EDITOR_NOTES).toBe(false)
  })

  it("stays dormant on an explicit false", async () => {
    expect((await load({ notes: false })).EDITOR_NOTES).toBe(false)
  })

  it("stays dormant on a truthy-but-not-true value", async () => {
    expect((await load({ notes: 1 })).EDITOR_NOTES).toBe(false)
    expect((await load({ notes: "true" })).EDITOR_NOTES).toBe(false)
  })

  it("enables on an explicit true", async () => {
    expect((await load({ notes: true })).EDITOR_NOTES).toBe(true)
  })

  it("is independent of the code view gate", async () => {
    const mod = await load({ notes: true })
    expect(mod.EDITOR_NOTES).toBe(true)
    expect(mod.EDITOR_CODE_VIEW).toBe(false)
  })
})

/**
 * The REPORTING half of the secret-read policy's both-ends gate. The
 * capabilities panel renders a "Secret files / Blocked" row off this flag,
 * and it must render only for a project that actually turned blocking on.
 *
 * FX18 (2026-09-05) inverted the underlying key. Before it, the flag meant
 * "this project ALLOWS credential reads"; now it means "this project BLOCKS
 * them", and the default is not blocked. The bootstrap field was renamed with
 * it, so a stale `secretReads` is asserted here to decide nothing.
 */
describe("EDITOR_BLOCK_SECRET_READS", () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window
    } else {
      ;(globalThis as { window?: unknown }).window = originalWindow
    }
    vi.resetModules()
  })

  async function load(bootstrap: StubBootstrap | undefined) {
    if (bootstrap === undefined) {
      delete (globalThis as { window?: unknown }).window
    } else {
      ;(globalThis as { window?: StubWindow }).window = {
        __DESDE_CLI__: bootstrap,
      }
    }
    vi.resetModules()
    return import("./editor-feature-flags")
  }

  it("does not block when the bootstrap omits the key", async () => {
    expect((await load({})).EDITOR_BLOCK_SECRET_READS).toBe(false)
  })

  it("does not block on the web shell (no CLI bootstrap at all)", async () => {
    expect((await load(undefined)).EDITOR_BLOCK_SECRET_READS).toBe(false)
  })

  it("does not block on an explicit false", async () => {
    expect((await load({ blockSecretReads: false })).EDITOR_BLOCK_SECRET_READS).toBe(false)
  })

  it("does not block on a truthy-but-not-true value", async () => {
    expect((await load({ blockSecretReads: 1 })).EDITOR_BLOCK_SECRET_READS).toBe(false)
    expect((await load({ blockSecretReads: "true" })).EDITOR_BLOCK_SECRET_READS).toBe(false)
  })

  it("blocks on an explicit true", async () => {
    expect((await load({ blockSecretReads: true })).EDITOR_BLOCK_SECRET_READS).toBe(true)
  })

  it("ignores the pre-FX18 spelling of the key", async () => {
    expect((await load({ secretReads: true })).EDITOR_BLOCK_SECRET_READS).toBe(false)
  })
})
