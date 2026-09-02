/**
 * Tests for `useDriftReporter` — the debounced/coalescing client for
 * `POST /api/editor/drift`. Mocks global `fetch` (which `editorFetch`
 * wraps) and uses fake timers to drive the 3s flush window deterministically.
 */

import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useDriftReporter } from "./useDriftReporter"
import type { DriftSignal } from "@/editor/core"

type FetchSig = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
let fetchMock: ReturnType<typeof vi.fn<FetchSig>>
let realFetch: typeof fetch

function ok(): Response {
  return new Response(JSON.stringify({ ok: true, recorded: 1, skipped: 0, entries: [] }), {
    status: 200,
  })
}

function signal(overrides: Partial<DriftSignal> = {}): DriftSignal {
  return {
    kind: "hint-miss",
    component: "UiButton",
    at: "2026-07-29T00:00:00.000Z",
    ...overrides,
  }
}

function bodySignals(call: unknown[]): DriftSignal[] {
  const init = call[1] as RequestInit
  const parsed = JSON.parse(init.body as string) as { signals: DriftSignal[] }
  return parsed.signals
}

beforeEach(() => {
  realFetch = global.fetch
  fetchMock = vi.fn<FetchSig>()
  global.fetch = fetchMock as unknown as typeof fetch
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  global.fetch = realFetch
})

describe("useDriftReporter", () => {
  it("does not POST immediately — buffers until the 3s window elapses", async () => {
    fetchMock.mockResolvedValue(ok())
    const { result } = renderHook(() => useDriftReporter())

    act(() => {
      result.current.report([signal()])
    })
    expect(fetchMock).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe("/api/editor/drift")
    expect(bodySignals(fetchMock.mock.calls[0])).toEqual([signal()])
  })

  it("flushes at most once per 3s regardless of how many report() calls land in between", async () => {
    fetchMock.mockResolvedValue(ok())
    const { result } = renderHook(() => useDriftReporter())

    act(() => {
      result.current.report([signal({ component: "A" })])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    act(() => {
      result.current.report([signal({ component: "B" })])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000) // total 3000ms since the FIRST report
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const sent = bodySignals(fetchMock.mock.calls[0])
    expect(sent.map((s) => s.component).sort()).toEqual(["A", "B"])
  })

  it("coalesces repeat signals for the same (kind, component, importPath, detail) key", async () => {
    fetchMock.mockResolvedValue(ok())
    const { result } = renderHook(() => useDriftReporter())

    act(() => {
      result.current.report([signal({ at: "2026-07-29T00:00:00.000Z", detail: "first" })])
      result.current.report([signal({ at: "2026-07-29T00:01:00.000Z", detail: "first" })])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const sent = bodySignals(fetchMock.mock.calls[0])
    expect(sent).toHaveLength(1)
    // Coalescing keeps the latest sighting for the key.
    expect(sent[0].at).toBe("2026-07-29T00:01:00.000Z")
  })

  it("does not coalesce signals with different kind/component/importPath/detail", async () => {
    fetchMock.mockResolvedValue(ok())
    const { result } = renderHook(() => useDriftReporter())

    act(() => {
      result.current.report([
        signal({ detail: "a" }),
        signal({ detail: "b" }),
        signal({ kind: "unknown-props" }),
        signal({ importPath: "@acme/design-system" }),
      ])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(bodySignals(fetchMock.mock.calls[0])).toHaveLength(4)
  })

  it("flushes immediately when the buffer hits the cap, instead of dropping the oldest", async () => {
    // Baseline (pre-fix): this exact scenario — 55 distinct keys inside one
    // 3s window — used to silently evict C0-C4 to make room, per the old
    // "caps the buffer at 50 distinct keys, dropping the oldest" test this
    // one replaces. Detection now runs on every inspection/click (fa9f7ef0),
    // not just text-edit commits, so selection churn (rapid clicking,
    // Layers-panel navigation) can plausibly produce 50+ distinct keys in
    // one window — silent eviction meant real signals vanished with no
    // trace. The fix: a new key that brings the buffer to the cap triggers
    // an immediate flush of that full batch instead of evicting anything.
    fetchMock.mockResolvedValue(ok())
    const { result } = renderHook(() => useDriftReporter())

    act(() => {
      // 55 distinct keys in one burst, well within the 3s window.
      for (let i = 0; i < 55; i++) {
        result.current.report([signal({ component: `C${i}` })])
      }
    })

    // The 50th distinct key (C49) should have triggered an immediate flush
    // of the first 50 — synchronously, no need to advance timers.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const firstBatch = bodySignals(fetchMock.mock.calls[0])
    expect(firstBatch).toHaveLength(50)
    expect(firstBatch.map((s) => s.component)).toEqual(
      Array.from({ length: 50 }, (_, i) => `C${i}`),
    )

    // The remaining 5 (C50..C54) are still buffered, waiting on the
    // (freshly restarted) 3s timer — not dropped, not sent yet.
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondBatch = bodySignals(fetchMock.mock.calls[1])
    expect(secondBatch.map((s) => s.component)).toEqual(["C50", "C51", "C52", "C53", "C54"])

    // Nothing was ever dropped across the whole burst.
    const allSent = [...firstBatch, ...secondBatch]
    expect(allSent).toHaveLength(55)
  })

  it("cap-triggered flush sends exactly the server's per-request limit (50), never more", async () => {
    // The server (`editor-cli/src/server/drift-handler.ts`) 400s any
    // batch over `MAX_SIGNALS_PER_REQUEST` (50). The cap-triggered flush
    // must never exceed that, or every high-churn session would start
    // failing requests instead of just flushing more often.
    fetchMock.mockResolvedValue(ok())
    const { result } = renderHook(() => useDriftReporter())

    act(() => {
      for (let i = 0; i < 51; i++) {
        result.current.report([signal({ component: `C${i}` })])
      }
    })

    for (const call of fetchMock.mock.calls) {
      expect(bodySignals(call).length).toBeLessThanOrEqual(50)
    }
  })

  it("retries once on transport failure, then drops the batch silently", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"))
    fetchMock.mockRejectedValueOnce(new Error("network down again"))
    const { result } = renderHook(() => useDriftReporter())

    act(() => {
      result.current.report([signal()])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("does not retry when the POST succeeds", async () => {
    fetchMock.mockResolvedValueOnce(ok())
    const { result } = renderHook(() => useDriftReporter())

    act(() => {
      result.current.report([signal()])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("flushes whatever is buffered on unmount, without waiting for the 3s window", () => {
    fetchMock.mockResolvedValue(ok())
    const { result, unmount } = renderHook(() => useDriftReporter())

    act(() => {
      result.current.report([signal()])
    })
    expect(fetchMock).not.toHaveBeenCalled()

    unmount()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("report() with an empty array is a no-op", async () => {
    fetchMock.mockResolvedValue(ok())
    const { result } = renderHook(() => useDriftReporter())

    act(() => {
      result.current.report([])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(fetchMock).not.toHaveBeenCalled()
  })

  describe("manifest invalidation (Phase 5 Task 5)", () => {
    function okWithInvalidate(
      invalidate: Array<{ name: string; importPath?: string; attemptedAt?: string }>,
    ): Response {
      return new Response(
        JSON.stringify({ ok: true, recorded: 1, skipped: 0, entries: [], invalidate }),
        { status: 200 },
      )
    }

    it("calls invalidateManifest with the response's invalidate list after a successful flush", async () => {
      fetchMock.mockResolvedValue(
        okWithInvalidate([
          { name: "UiButton", importPath: "@acme/design-system", attemptedAt: "2026-07-29T00:00:00.000Z" },
        ]),
      )
      const invalidateManifest = vi.fn()
      const { result } = renderHook(() => useDriftReporter({ invalidateManifest }))

      act(() => {
        result.current.report([signal()])
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })

      // `attemptedAt` is dedupe-key-only — never forwarded to the caller,
      // which only needs `(name, importPath)` to invalidate a manifest.
      expect(invalidateManifest).toHaveBeenCalledWith([{ name: "UiButton", importPath: "@acme/design-system" }])
    })

    it("never invalidates the same key twice across separate flushes (same repair resent)", async () => {
      // Same `attemptedAt` on both flushes — the handler's documented
      // "recomputed fresh every response, not a delta" contract: the SAME
      // settled repair keeps appearing in `invalidate` for as long as the
      // entry stays in the log.
      fetchMock.mockResolvedValue(okWithInvalidate([{ name: "UiButton", attemptedAt: "2026-07-29T00:00:00.000Z" }]))
      const invalidateManifest = vi.fn()
      const { result } = renderHook(() => useDriftReporter({ invalidateManifest }))

      act(() => {
        result.current.report([signal({ component: "A" })])
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      expect(invalidateManifest).toHaveBeenCalledTimes(1)

      act(() => {
        result.current.report([signal({ component: "B" })])
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      expect(invalidateManifest).toHaveBeenCalledTimes(1)
    })

    it("invalidates AGAIN for the same component when a later flush reports a DIFFERENT attemptedAt (dismiss-then-redrift)", async () => {
      // Reproduces the review-flagged bug: Dismiss (DELETE /api/editor/drift/:key)
      // removes the DriftEntry entirely, including its settled `repair`. If
      // the SAME component drifts again afterward, the server runs a BRAND
      // NEW repair (a new `attemptedAt`) and legitimately re-lists it in
      // `invalidate`. Deduping on `(name, importPath)` alone would swallow
      // this second, genuinely distinct repair forever.
      const invalidateManifest = vi.fn()
      const { result } = renderHook(() => useDriftReporter({ invalidateManifest }))

      fetchMock.mockResolvedValueOnce(
        okWithInvalidate([{ name: "UiButton", importPath: "@acme/ui", attemptedAt: "2026-07-29T00:00:00.000Z" }]),
      )
      act(() => {
        result.current.report([signal({ component: "UiButton", importPath: "@acme/ui" })])
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      expect(invalidateManifest).toHaveBeenCalledTimes(1)

      // User dismissed the entry, the component drifted again, and the
      // server ran (and settled) a NEW repair — different `attemptedAt`.
      fetchMock.mockResolvedValueOnce(
        okWithInvalidate([{ name: "UiButton", importPath: "@acme/ui", attemptedAt: "2026-07-29T01:00:00.000Z" }]),
      )
      act(() => {
        result.current.report([signal({ component: "UiButton", importPath: "@acme/ui" })])
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })

      expect(invalidateManifest).toHaveBeenCalledTimes(2)
      expect(invalidateManifest).toHaveBeenNthCalledWith(2, [{ name: "UiButton", importPath: "@acme/ui" }])
    })

    it("does not throw when invalidateManifest is omitted", async () => {
      fetchMock.mockResolvedValue(okWithInvalidate([{ name: "UiButton" }]))
      const { result, unmount } = renderHook(() => useDriftReporter())

      act(() => {
        result.current.report([signal()])
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      unmount()
    })

    it("ignores a malformed invalidate list without throwing", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ ok: true, invalidate: "not-an-array" }), { status: 200 }),
      )
      const invalidateManifest = vi.fn()
      const { result } = renderHook(() => useDriftReporter({ invalidateManifest }))

      act(() => {
        result.current.report([signal()])
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })

      expect(invalidateManifest).not.toHaveBeenCalled()
    })
  })
})
