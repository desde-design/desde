// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import { shouldRefreshAfterPoll, shouldRefreshWhileEmbedded, useProcessRecovery } from "../review/use-process-recovery"
import type { ProcessStatus } from "../../server/serve/prototype-processes"
import { ok, routeTable, useFetchOverride } from "@/components/gallery/fetch-override"

/**
 * Codex round 2, item 2: a crash panel resolved server-side never noticed
 * the manager's restart budget aging out. This table is the decision
 * `useProcessRecovery` (same file) drives `router.refresh()` from — every
 * row is a shape the polled `prototype-origin` route can actually answer
 * with.
 */
describe("shouldRefreshAfterPoll", () => {
  it("refreshes when the poll reports no process at all (a static deployment, or an unparsed body)", () => {
    expect(shouldRefreshAfterPoll(undefined)).toBe(true)
  })

  it("refreshes when the process is no longer crashed", () => {
    const rows: ProcessStatus[] = [
      { state: "stopped" },
      { state: "starting" },
      { state: "running", port: 4321, since: "2026-09-10T00:00:00.000Z" },
    ]
    for (const status of rows) {
      expect(shouldRefreshAfterPoll(status)).toBe(true)
    }
  })

  it("refreshes when still crashed but the manager would retry it now", () => {
    const status: ProcessStatus = {
      state: "crashed",
      exitCode: 1,
      restarts: 1,
      reason: "The server exited.",
      retryable: true,
    }
    expect(shouldRefreshAfterPoll(status)).toBe(true)
  })

  it("does NOT refresh while still crashed and still not retryable — the one state the page already shows correctly", () => {
    const status: ProcessStatus = {
      state: "crashed",
      exitCode: 1,
      restarts: 4,
      reason: "The server kept exiting.",
      retryable: false,
    }
    expect(shouldRefreshAfterPoll(status)).toBe(false)
  })
})

/**
 * Codex round 4, Fix 2. The crashed-panel table above (`shouldRefreshAfterPoll`)
 * treats an unrecognised body (`undefined`) as "refresh" — reasonable for a
 * panel that is already showing failure, since a bad read can only replace
 * one failure state with another. An EMBEDDED frame is the opposite case: the
 * iframe is presumed fine unless the poll says otherwise, so an unrecognised
 * body must be a no-op, or a server that started sending a shape this poll
 * cannot parse would refresh the page in a loop forever. Refresh happens ONLY
 * on an explicit `crashed` — retryable or not, since either way the
 * server-side render decides the right panel (or a fresh frame) once it
 * re-resolves.
 */
describe("shouldRefreshWhileEmbedded", () => {
  it("does not refresh when there is no process to read (a static deployment, or an unparsed body)", () => {
    expect(shouldRefreshWhileEmbedded(undefined)).toBe(false)
  })

  it("does not refresh for any non-crashed state", () => {
    const rows: ProcessStatus[] = [
      { state: "stopped" },
      { state: "starting" },
      { state: "running", port: 4321, since: "2026-09-10T00:00:00.000Z" },
    ]
    for (const status of rows) {
      expect(shouldRefreshWhileEmbedded(status)).toBe(false)
    }
  })

  it("refreshes on crashed, retryable or not", () => {
    const retryable: ProcessStatus = { state: "crashed", exitCode: 1, restarts: 1, reason: "The server exited.", retryable: true }
    const notRetryable: ProcessStatus = { state: "crashed", exitCode: 1, restarts: 4, reason: "The server kept exiting.", retryable: false }
    expect(shouldRefreshWhileEmbedded(retryable)).toBe(true)
    expect(shouldRefreshWhileEmbedded(notRetryable)).toBe(true)
  })
})

/**
 * Codex round 4, Fix 2. The hook itself, in `mode: "embedded"` — a SERVER
 * deployment embedded as a live frame, where nothing else was watching for a
 * start failure or a later crash happening INSIDE the iframe (see the long
 * doc comment on `useProcessRecovery` for the full defect).
 *
 * Drives the poll loop with fake timers rather than real waits: real 5s/30s
 * polling would make this suite slow for no added confidence, and fake timers
 * let the test assert the exact cadence instead of merely "eventually".
 */
describe("useProcessRecovery — embedded mode", () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function loopbackBody(process: ProcessStatus): unknown {
    return { mode: "loopback", origin: "http://127.0.0.1:4321", serve: "server", process, range: null }
  }

  it("polls every 5s until running is observed: stopped, starting, then crashed triggers exactly one refresh", async () => {
    vi.useFakeTimers()
    const responses: ProcessStatus[] = [
      { state: "stopped" },
      { state: "starting" },
      { state: "crashed", exitCode: 1, restarts: 1, reason: "The server exited.", retryable: true },
    ]
    let call = 0
    const onShouldRefresh = vi.fn()

    function useHarness() {
      useFetchOverride(
        routeTable({
          "GET /api/v1/projects/p1/prototype-origin": () => {
            const status = responses[Math.min(call, responses.length - 1)]!
            call++
            return ok(loopbackBody(status))
          },
        }),
      )
      useProcessRecovery({ active: true, projectId: "p1", onShouldRefresh, mode: "embedded" })
    }

    renderHook(() => useHarness())

    // First poll at +5s: "stopped" — no refresh, still fast cadence.
    // `advanceTimersByTimeAsync`, not the sync form: the poll is an async
    // function (it awaits the mocked `fetch`), and only the async advance
    // flushes the microtasks in between the timer firing and the NEXT
    // `setTimeout` it schedules — the sync form fires the callback but
    // leaves that follow-up promise chain unresolved, and the next assertion
    // would see the call count from before this tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(call).toBe(1)
    expect(onShouldRefresh).not.toHaveBeenCalled()

    // Second poll at +10s: "starting" — no refresh, still fast cadence.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(call).toBe(2)
    expect(onShouldRefresh).not.toHaveBeenCalled()

    // Third poll at +15s: "crashed" — exactly one refresh.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(call).toBe(3)
    expect(onShouldRefresh).toHaveBeenCalledTimes(1)
  })

  it("keeps its timer across re-renders that hand it a new callback identity", async () => {
    // The review shell re-renders on bridge messages and comment updates,
    // and `useRouterRefresh` returns a fresh function each render. If the
    // effect restarted on every callback identity, a shell re-rendering
    // more often than every 5s would never let the first poll fire.
    vi.useFakeTimers()
    let call = 0
    const seen: (() => void)[] = []

    function useHarness() {
      useFetchOverride(
        routeTable({
          "GET /api/v1/projects/p1/prototype-origin": () => {
            call++
            return ok(loopbackBody({ state: "crashed", exitCode: 1, restarts: 1, reason: "x", retryable: true }))
          },
        }),
      )
      const onShouldRefresh = () => {
        seen.push(onShouldRefresh)
      }
      useProcessRecovery({ active: true, projectId: "p1", onShouldRefresh, mode: "embedded" })
    }

    const { rerender } = renderHook(() => useHarness())

    // Re-render at +4s, +8s: each render passes a new callback.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000)
    })
    rerender()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000)
    })
    rerender()
    // The first poll was due at +5s and must have fired despite the re-renders.
    expect(call).toBe(1)
    // And it called the LATEST callback, not the one from the first render.
    expect(seen).toHaveLength(1)
  })

  it("switches to the 30s cadence once running has been observed", async () => {
    vi.useFakeTimers()
    const responses: ProcessStatus[] = [
      { state: "starting" },
      { state: "running", port: 4321, since: "2026-09-10T00:00:00.000Z" },
    ]
    let call = 0
    const onShouldRefresh = vi.fn()

    function useHarness() {
      useFetchOverride(
        routeTable({
          "GET /api/v1/projects/p1/prototype-origin": () => {
            const status = responses[Math.min(call, responses.length - 1)]!
            call++
            return ok(loopbackBody(status))
          },
        }),
      )
      useProcessRecovery({ active: true, projectId: "p1", onShouldRefresh, mode: "embedded" })
    }

    renderHook(() => useHarness())

    // +5s: "starting" — fast cadence still in effect.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(call).toBe(1)

    // +10s: "running" observed — the NEXT poll should wait 30s, not 5s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(call).toBe(2)

    // Only 5s more (+15s total since running) — the 30s cadence means no
    // third poll yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(call).toBe(2)

    // The remaining 25s to reach the 30s mark since "running" was observed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000)
    })
    expect(call).toBe(3)
  })
})
