/**
 * Tests for `useDriftEntries` — the Drift panel section's data hook. Mocks
 * global `fetch` (which `editorFetch` wraps) and drives the SSE
 * regenerate-hints stream from a real `Response` body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useDriftEntries } from "./useDriftEntries"

type FetchSig = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
let fetchMock: ReturnType<typeof vi.fn<FetchSig>>
let realFetch: typeof fetch

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function sse(...events: unknown[]): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
  return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

const entry = (over: Record<string, unknown> = {}) => ({
  key: "KButton::@acme/ui",
  component: "KButton",
  importPath: "@acme/ui",
  designSystem: "@acme/ui",
  kinds: ["hint-miss"],
  count: 1,
  firstSeen: "2026-07-29T00:00:00.000Z",
  lastSeen: "2026-07-29T00:00:00.000Z",
  ...over,
})

beforeEach(() => {
  fetchMock = vi.fn<FetchSig>()
  realFetch = globalThis.fetch
  globalThis.fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe("useDriftEntries", () => {
  it("loads drift entries on mount", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(json(200, { ok: true, entries: [entry()], invalidate: [] })),
    )
    const { result } = renderHook(() => useDriftEntries())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.entries).toHaveLength(1)
    expect(result.current.entries[0].component).toBe("KButton")
  })

  it("surfaces a load failure", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(json(500, { ok: false, reason: "boom" })),
    )
    const { result } = renderHook(() => useDriftEntries())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toMatch(/boom/)
    expect(result.current.entries).toEqual([])
  })

  it("dismisses one entry and reloads", async () => {
    let dismissed = false
    fetchMock.mockImplementation((input, init) => {
      const method = (init?.method ?? "GET").toUpperCase()
      if (method === "DELETE") {
        dismissed = true
        return Promise.resolve(json(200, { ok: true, entries: [], invalidate: [] }))
      }
      return Promise.resolve(
        json(200, { ok: true, entries: dismissed ? [] : [entry()], invalidate: [] }),
      )
    })
    const { result } = renderHook(() => useDriftEntries())
    await waitFor(() => expect(result.current.entries).toHaveLength(1))

    await act(async () => {
      await result.current.dismiss("KButton::@acme/ui")
    })
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/drift/KButton%3A%3A%40acme%2Fui",
      expect.objectContaining({ method: "DELETE" }),
    )
    await waitFor(() => expect(result.current.entries).toHaveLength(0))
    expect(result.current.busy).toBe(false)
  })

  it("clears all entries", async () => {
    let cleared = false
    fetchMock.mockImplementation((input, init) => {
      const url = String(input)
      const method = (init?.method ?? "GET").toUpperCase()
      if (method === "DELETE" && url.endsWith("/drift")) {
        cleared = true
        return Promise.resolve(json(200, { ok: true, entries: [], invalidate: [] }))
      }
      return Promise.resolve(
        json(200, { ok: true, entries: cleared ? [] : [entry(), entry({ key: "KInput::@acme/ui", component: "KInput" })], invalidate: [] }),
      )
    })
    const { result } = renderHook(() => useDriftEntries())
    await waitFor(() => expect(result.current.entries).toHaveLength(2))

    await act(async () => {
      await result.current.clearAll()
    })
    await waitFor(() => expect(result.current.entries).toHaveLength(0))
  })

  it("surfaces a dismiss failure reason", async () => {
    fetchMock.mockImplementation((input, init) => {
      const method = (init?.method ?? "GET").toUpperCase()
      if (method === "DELETE") return Promise.resolve(json(500, { ok: false, reason: "lock held" }))
      return Promise.resolve(json(200, { ok: true, entries: [entry()], invalidate: [] }))
    })
    const { result } = renderHook(() => useDriftEntries())
    await waitFor(() => expect(result.current.entries).toHaveLength(1))

    await act(async () => {
      await result.current.dismiss("KButton::@acme/ui")
    })
    await waitFor(() => expect(result.current.error).toMatch(/lock held/))
  })

  describe("regenerateHints(key)", () => {
    it("streams progress, reloads the list, and returns the run summary", async () => {
      let regenerated = false
      fetchMock.mockImplementation((input, init) => {
        const url = String(input)
        const method = (init?.method ?? "GET").toUpperCase()
        if (method === "POST" && url.endsWith("/regenerate-hints")) {
          regenerated = true
          return Promise.resolve(
            sse(
              { type: "progress", progress: { component: "KButton", index: 0, total: 1 } },
              { type: "result", result: { probed: 1, hinted: 1, verified: 1, skipped: [] } },
            ),
          )
        }
        return Promise.resolve(
          json(200, {
            ok: true,
            entries: regenerated ? [] : [entry()],
            invalidate: [],
          }),
        )
      })
      const { result } = renderHook(() => useDriftEntries())
      await waitFor(() => expect(result.current.entries).toHaveLength(1))

      let summary: unknown
      await act(async () => {
        summary = await result.current.regenerateHints("KButton::@acme/ui")
      })
      expect(summary).toEqual({ probed: 1, hinted: 1, verified: 1, skipped: [] })
      expect(result.current.busy).toBe(false)
      expect(result.current.regeneratingKey).toBeNull()
      expect(result.current.regenerateProgress).toBeNull()
      expect(result.current.error).toBeNull()
    })

    it("surfaces an SSE error frame and returns null", async () => {
      fetchMock.mockImplementation((input, init) => {
        const url = String(input)
        const method = (init?.method ?? "GET").toUpperCase()
        if (method === "POST" && url.endsWith("/regenerate-hints")) {
          return Promise.resolve(sse({ type: "error", message: "component not found" }))
        }
        return Promise.resolve(json(200, { ok: true, entries: [entry()], invalidate: [] }))
      })
      const { result } = renderHook(() => useDriftEntries())
      await waitFor(() => expect(result.current.entries).toHaveLength(1))

      let summary: unknown = "unset"
      await act(async () => {
        summary = await result.current.regenerateHints("KButton::@acme/ui")
      })
      expect(summary).toBeNull()
      expect(result.current.error).toMatch(/component not found/)
    })

    it("surfaces a non-stream JSON error (e.g. 422)", async () => {
      fetchMock.mockImplementation((input, init) => {
        const url = String(input)
        const method = (init?.method ?? "GET").toUpperCase()
        if (method === "POST" && url.endsWith("/regenerate-hints")) {
          return Promise.resolve(json(422, { ok: false, reason: "no resolved design system" }))
        }
        return Promise.resolve(json(200, { ok: true, entries: [entry()], invalidate: [] }))
      })
      const { result } = renderHook(() => useDriftEntries())
      await waitFor(() => expect(result.current.entries).toHaveLength(1))

      let summary: unknown = "unset"
      await act(async () => {
        summary = await result.current.regenerateHints("KButton::@acme/ui")
      })
      expect(summary).toBeNull()
      expect(result.current.error).toMatch(/no resolved design system/)
    })
  })

  describe("manifest invalidation (final review fix wave)", () => {
    it("calls invalidateManifest with the GET response's invalidate list", async () => {
      const invalidateManifest = vi.fn()
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          json(200, {
            ok: true,
            entries: [entry()],
            invalidate: [
              { name: "KButton", importPath: "@acme/ui", attemptedAt: "2026-07-29T00:00:00.000Z" },
            ],
          }),
        ),
      )
      renderHook(() => useDriftEntries({ invalidateManifest }))

      await waitFor(() =>
        expect(invalidateManifest).toHaveBeenCalledWith([{ name: "KButton", importPath: "@acme/ui" }]),
      )
    })

    it("never invalidates the same (name, importPath, attemptedAt) twice across reloads", async () => {
      const invalidateManifest = vi.fn()
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          json(200, {
            ok: true,
            entries: [entry()],
            invalidate: [{ name: "KButton", attemptedAt: "2026-07-29T00:00:00.000Z" }],
          }),
        ),
      )
      const { result } = renderHook(() => useDriftEntries({ invalidateManifest }))
      await waitFor(() => expect(invalidateManifest).toHaveBeenCalledTimes(1))

      await act(async () => {
        await result.current.reload()
      })
      // Same settled repair (same `attemptedAt`) reported again — the
      // documented "recomputed fresh every response" contract — must not
      // re-invalidate.
      expect(invalidateManifest).toHaveBeenCalledTimes(1)
    })

    it("invalidates through dismiss()'s trailing reload, without needing a separate drift-reporting edit", async () => {
      const invalidateManifest = vi.fn()
      let dismissed = false
      fetchMock.mockImplementation((input, init) => {
        const method = (init?.method ?? "GET").toUpperCase()
        if (method === "DELETE") {
          dismissed = true
          return Promise.resolve(json(200, { ok: true, entries: [], invalidate: [] }))
        }
        return Promise.resolve(
          json(200, {
            ok: true,
            entries: dismissed ? [] : [entry()],
            invalidate: dismissed
              ? [{ name: "KButton", importPath: "@acme/ui", attemptedAt: "2026-07-29T00:00:00.000Z" }]
              : [],
          }),
        )
      })
      const { result } = renderHook(() => useDriftEntries({ invalidateManifest }))
      await waitFor(() => expect(result.current.entries).toHaveLength(1))
      expect(invalidateManifest).not.toHaveBeenCalled()

      await act(async () => {
        await result.current.dismiss("KButton::@acme/ui")
      })

      expect(invalidateManifest).toHaveBeenCalledWith([{ name: "KButton", importPath: "@acme/ui" }])
    })

    it("dismiss applies the DELETE response's OWN invalidate list — the entry is already gone by the trailing GET, so a reload-only hook could never see it (codex P2, 2026-07-30)", async () => {
      const invalidateManifest = vi.fn()
      const calls: string[] = []
      let dismissed = false
      fetchMock.mockImplementation((input, init) => {
        const method = (init?.method ?? "GET").toUpperCase()
        if (method === "DELETE") {
          dismissed = true
          calls.push("delete")
          return Promise.resolve(
            json(200, {
              ok: true,
              entries: [],
              // A repair settled AFTER this hook's last load but BEFORE the
              // dismiss — the server captured it before removing the entry.
              invalidate: [
                { name: "KButton", importPath: "@acme/ui", attemptedAt: "2026-07-30T00:00:00.000Z" },
              ],
            }),
          )
        }
        calls.push("get")
        // The trailing reload's GET carries NO invalidation — the entry
        // (and its `repair`) is already deleted from the server-side log by
        // the time this fires, so `invalidateList` there has nothing left
        // to report for it. This is exactly why relying on `reload()` alone
        // reproduces the bug.
        return Promise.resolve(json(200, { ok: true, entries: dismissed ? [] : [entry()], invalidate: [] }))
      })
      const { result } = renderHook(() => useDriftEntries({ invalidateManifest }))
      await waitFor(() => expect(result.current.entries).toHaveLength(1))
      calls.length = 0 // drop the mount-time GET; only the dismiss flow matters below

      await act(async () => {
        await result.current.dismiss("KButton::@acme/ui")
      })

      expect(invalidateManifest).toHaveBeenCalledWith([{ name: "KButton", importPath: "@acme/ui" }])
      // Ordering: the DELETE response is applied before the trailing reload
      // fires its own GET.
      expect(calls[0]).toBe("delete")
      expect(calls).toContain("get")
    })

    it("clearAll applies the DELETE (base route) response's OWN invalidate list across every cleared entry, same as dismiss (codex P2, 2026-07-30)", async () => {
      const invalidateManifest = vi.fn()
      let cleared = false
      fetchMock.mockImplementation((input, init) => {
        const url = String(input)
        const method = (init?.method ?? "GET").toUpperCase()
        if (method === "DELETE" && url.endsWith("/drift")) {
          cleared = true
          return Promise.resolve(
            json(200, {
              ok: true,
              entries: [],
              invalidate: [
                { name: "KButton", importPath: "@acme/ui", attemptedAt: "2026-07-30T00:00:00.000Z" },
                { name: "KInput", attemptedAt: "2026-07-30T00:01:00.000Z" },
              ],
            }),
          )
        }
        // Trailing GET after clear-all: log is empty, nothing to report.
        return Promise.resolve(
          json(200, {
            ok: true,
            entries: cleared ? [] : [entry(), entry({ key: "KInput::", component: "KInput", importPath: undefined })],
            invalidate: [],
          }),
        )
      })
      const { result } = renderHook(() => useDriftEntries({ invalidateManifest }))
      await waitFor(() => expect(result.current.entries).toHaveLength(2))

      await act(async () => {
        await result.current.clearAll()
      })

      expect(invalidateManifest).toHaveBeenCalledWith([
        { name: "KButton", importPath: "@acme/ui" },
        { name: "KInput" },
      ])
    })

    it("does not throw when invalidateManifest is omitted", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(json(200, { ok: true, entries: [], invalidate: [{ name: "KButton" }] })),
      )
      const { result } = renderHook(() => useDriftEntries())
      await waitFor(() => expect(result.current.loading).toBe(false))
    })

    it("regenerateHints applies the SSE result frame's OWN invalidate entry — a regenerate never sets entry.repair, so the trailing reload's GET invalidate list never carries it (codex P2, 2026-07-30)", async () => {
      const invalidateManifest = vi.fn()
      let regenerated = false
      fetchMock.mockImplementation((input, init) => {
        const url = String(input)
        const method = (init?.method ?? "GET").toUpperCase()
        if (method === "POST" && url.endsWith("/regenerate-hints")) {
          regenerated = true
          return Promise.resolve(
            sse(
              { type: "progress", progress: { component: "KButton", index: 0, total: 1 } },
              {
                type: "result",
                result: { probed: 1, hinted: 1, verified: 1, skipped: [] },
                invalidate: [
                  { name: "KButton", importPath: "@acme/ui", attemptedAt: "2026-07-30T00:00:00.000Z" },
                ],
              },
            ),
          )
        }
        // The trailing reload's GET response deliberately carries an EMPTY
        // invalidate list — a regenerate never touches `entry.repair`, so
        // `invalidateList` (auto-repair-only) has nothing to report for it.
        // If the hook only reacted to this reload, it would never invalidate.
        return Promise.resolve(json(200, { ok: true, entries: regenerated ? [] : [entry()], invalidate: [] }))
      })
      const { result } = renderHook(() => useDriftEntries({ invalidateManifest }))
      await waitFor(() => expect(result.current.entries).toHaveLength(1))

      await act(async () => {
        await result.current.regenerateHints("KButton::@acme/ui")
      })

      expect(invalidateManifest).toHaveBeenCalledWith([{ name: "KButton", importPath: "@acme/ui" }])
    })

    it("a second regenerate-hints run for the same component invalidates again (distinct attemptedAt, not swallowed by the shared dedupe)", async () => {
      const invalidateManifest = vi.fn()
      let call = 0
      fetchMock.mockImplementation((input, init) => {
        const url = String(input)
        const method = (init?.method ?? "GET").toUpperCase()
        if (method === "POST" && url.endsWith("/regenerate-hints")) {
          call += 1
          return Promise.resolve(
            sse({
              type: "result",
              result: { probed: 1, hinted: 1, verified: 1, skipped: [] },
              invalidate: [
                {
                  name: "KButton",
                  importPath: "@acme/ui",
                  // Distinct completion timestamp per run — the fix's whole
                  // point is that a regenerate stamps its OWN identity
                  // rather than reusing a shared/prior one, so this must
                  // NOT be deduped away.
                  attemptedAt: `2026-07-30T00:0${call}:00.000Z`,
                },
              ],
            }),
          )
        }
        return Promise.resolve(json(200, { ok: true, entries: [entry()], invalidate: [] }))
      })
      const { result } = renderHook(() => useDriftEntries({ invalidateManifest }))
      await waitFor(() => expect(result.current.entries).toHaveLength(1))

      await act(async () => {
        await result.current.regenerateHints("KButton::@acme/ui")
      })
      await act(async () => {
        await result.current.regenerateHints("KButton::@acme/ui")
      })

      expect(invalidateManifest).toHaveBeenCalledTimes(2)
      expect(invalidateManifest).toHaveBeenNthCalledWith(1, [{ name: "KButton", importPath: "@acme/ui" }])
      expect(invalidateManifest).toHaveBeenNthCalledWith(2, [{ name: "KButton", importPath: "@acme/ui" }])
    })
  })
})
