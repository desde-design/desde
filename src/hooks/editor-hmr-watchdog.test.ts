/**
 * Tests for the prototype-reload + HMR-miss-telemetry watchdog extracted
 * from `useEditorEditing` (share-readiness Phase 3 Batch B).
 *
 * Exercises the `window.__EDITOR_HMR_STATS__` seam directly (same seam
 * dogfooders inspect live) with fake timers, since the arm/record/timeout
 * dance is time-dependent.
 *
 * See tasks/share-readiness-plan.md.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  armHmrTimeoutCheck,
  ensureHmrStats,
  recordHmrTreeUpdate,
  requestPrototypeReload,
  reloadBackstopEnabled,
  type EditorHmrStats,
} from "./editor-hmr-watchdog"

function getStats(): EditorHmrStats {
  return (window as unknown as { __EDITOR_HMR_STATS__: EditorHmrStats })
    .__EDITOR_HMR_STATS__
}

beforeEach(() => {
  vi.useFakeTimers()
  delete (window as unknown as { __EDITOR_HMR_STATS__?: unknown })
    .__EDITOR_HMR_STATS__
  window.localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("ensureHmrStats", () => {
  it("initializes a zeroed stats object on first call", () => {
    const stats = ensureHmrStats()
    expect(stats).toEqual({
      dispatches: 0,
      hits: 0,
      misses: 0,
      sentReloads: 0,
      skippedReloads: 0,
      lastDispatch: null,
      pending: new Map(),
    })
  })

  it("memoizes the SAME object on window across calls", () => {
    const first = ensureHmrStats()
    first.hits = 3
    const second = ensureHmrStats()
    expect(second).toBe(first)
    expect(second.hits).toBe(3)
  })
})

describe("armHmrTimeoutCheck", () => {
  it("increments dispatches and records a pending entry", () => {
    armHmrTimeoutCheck("test-reason")
    const stats = getStats()
    expect(stats.dispatches).toBe(1)
    expect(stats.pending.size).toBe(1)
    expect(stats.misses).toBe(0)
  })

  it("counts a MISS when no DOM_MUTATED arrives within the timeout", () => {
    armHmrTimeoutCheck("test-reason")
    vi.advanceTimersByTime(3000)
    const stats = getStats()
    expect(stats.misses).toBe(1)
    expect(stats.pending.size).toBe(0)
  })

  it("does not double-count a miss if the timer already fired once", () => {
    armHmrTimeoutCheck("test-reason")
    vi.advanceTimersByTime(3000)
    vi.advanceTimersByTime(3000)
    expect(getStats().misses).toBe(1)
  })
})

describe("recordHmrTreeUpdate", () => {
  it("resolves the oldest pending dispatch as a HIT and clears its timeout", () => {
    armHmrTimeoutCheck("first")
    recordHmrTreeUpdate()
    const stats = getStats()
    expect(stats.hits).toBe(1)
    expect(stats.pending.size).toBe(0)
    // The cleared timer must not later fire a miss.
    vi.advanceTimersByTime(3000)
    expect(getStats().misses).toBe(0)
  })

  it("is a no-op when nothing is pending", () => {
    ensureHmrStats()
    recordHmrTreeUpdate()
    expect(getStats().hits).toBe(0)
  })

  it("resolves the OLDEST of multiple pending dispatches first", () => {
    armHmrTimeoutCheck("older")
    armHmrTimeoutCheck("newer")
    expect(getStats().pending.size).toBe(2)
    recordHmrTreeUpdate()
    const stats = getStats()
    expect(stats.hits).toBe(1)
    expect(stats.pending.size).toBe(1)
    // Whichever key remains belongs to "newer" (dispatch #2).
    const remainingKey = [...stats.pending.keys()][0]
    expect(remainingKey).toContain("newer")
  })
})

describe("reloadBackstopEnabled", () => {
  it("defaults to true (backstop on) with no localStorage override", () => {
    expect(reloadBackstopEnabled()).toBe(true)
  })

  it("returns false when localStorage disables it for the session", () => {
    window.localStorage.setItem("editor:disable-reload-backstop", "1")
    expect(reloadBackstopEnabled()).toBe(false)
  })

  it("stays enabled for any other localStorage value", () => {
    window.localStorage.setItem("editor:disable-reload-backstop", "0")
    expect(reloadBackstopEnabled()).toBe(true)
  })
})

describe("requestPrototypeReload", () => {
  let iframe: HTMLIFrameElement

  beforeEach(() => {
    // A real jsdom iframe carries a real (about:blank) `contentWindow` with
    // a real `postMessage` — spy on that instead of replacing the object,
    // so jsdom's own environment teardown still finds a genuine Window to
    // tear down (faking `contentWindow` with a plain object confuses it).
    iframe = document.createElement("iframe")
    document.body.appendChild(iframe)
  })

  afterEach(() => {
    iframe.remove()
  })

  it("posts RELOAD_PROTOTYPE and bumps sentReloads when the backstop is enabled", () => {
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage")
    requestPrototypeReload(iframe, "save-success")
    expect(postMessage).toHaveBeenCalledWith(
      { type: "RELOAD_PROTOTYPE", payload: { reason: "save-success" } },
      "*",
    )
    expect(getStats().sentReloads).toBe(1)
    expect(getStats().skippedReloads).toBe(0)
    expect(getStats().lastDispatch).toEqual({ reason: "save-success", at: expect.any(Number) })
  })

  it("skips the postMessage and arms the timeout check when the backstop is disabled", () => {
    window.localStorage.setItem("editor:disable-reload-backstop", "1")
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage")
    requestPrototypeReload(iframe, "chat-turn-complete")
    expect(postMessage).not.toHaveBeenCalled()
    const stats = getStats()
    expect(stats.skippedReloads).toBe(1)
    expect(stats.sentReloads).toBe(0)
    expect(stats.dispatches).toBe(1)
    expect(stats.pending.size).toBe(1)
  })

  it("force mode always posts, even with the backstop disabled", () => {
    window.localStorage.setItem("editor:disable-reload-backstop", "1")
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage")
    requestPrototypeReload(iframe, "conflict-reload", "force")
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(getStats().sentReloads).toBe(1)
  })

  it("no-ops when the iframe has no contentWindow", () => {
    expect(() => requestPrototypeReload(null, "save-success")).not.toThrow()
    expect(getStats().sentReloads).toBe(1)
    expect(getStats().skippedReloads).toBe(0)
  })
})
