/**
 * Tests for `useDesignSystems` — the Design Systems panel's data hook. Mocks
 * global `fetch` (which `editorFetch` wraps) and drives the SSE onboarding
 * stream from a real `Response` body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useDesignSystems } from "./useDesignSystems"

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

const entry = (over = {}) => ({
  id: "@acme/ui",
  source: { kind: "installed", package: "@acme/ui" },
  package: "@acme/ui",
  version: "1.0.0",
  framework: "vue3",
  designSystem: "@acme/ui",
  importPath: "@acme/ui",
  addedAt: "x",
  ...over,
})

const suggestion = (over = {}) => ({
  package: "@acme/design-system",
  version: "9.0.0",
  framework: "vue3",
  componentCount: 42,
  importFrequency: 7,
  ...over,
})

/** Route the mock by method + path. `list`/`suggestions`/`updates` re-read on each call. */
function route(handlers: {
  list?: () => unknown
  suggestions?: () => unknown
  health?: () => unknown
  updates?: () => unknown
  post?: () => Response
  del?: () => Response
}) {
  fetchMock.mockImplementation((input, init) => {
    const url = String(input)
    const method = (init?.method ?? "GET").toUpperCase()
    if (method === "GET" && url.endsWith("/suggestions")) {
      return Promise.resolve(json(200, { ok: true, suggestions: handlers.suggestions?.() ?? [] }))
    }
    if (method === "GET" && url.endsWith("/updates")) {
      return Promise.resolve(json(200, { ok: true, updates: handlers.updates?.() ?? {} }))
    }
    if (method === "GET" && url.endsWith("/design-systems")) {
      return Promise.resolve(
        json(200, {
          ok: true,
          designSystems: handlers.list?.() ?? [],
          health: handlers.health ? handlers.health() : null,
        }),
      )
    }
    if (method === "POST") return Promise.resolve(handlers.post?.() ?? json(500, {}))
    if (method === "DELETE") return Promise.resolve(handlers.del?.() ?? json(200, { ok: true }))
    return Promise.resolve(json(404, {}))
  })
}

beforeEach(() => {
  fetchMock = vi.fn<FetchSig>()
  realFetch = globalThis.fetch
  globalThis.fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe("useDesignSystems", () => {
  it("loads registered systems + suggestions on mount", async () => {
    route({ list: () => [entry()], suggestions: () => [suggestion()] })
    const { result } = renderHook(() => useDesignSystems())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.systems).toHaveLength(1)
    expect(result.current.suggestions).toHaveLength(1)
  })

  it("surfaces health from the list response, defaulting to null before a build", async () => {
    route({ list: () => [entry()], suggestions: () => [] })
    const { result } = renderHook(() => useDesignSystems())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.health).toBeNull()

    const health = {
      root: "/proto",
      builtAt: "2026-01-01T00:00:00.000Z",
      sources: [{ step: "a", sourceId: "a", discovered: 1, status: "ok" }],
      runtimeErrors: [],
    }
    route({ list: () => [entry()], suggestions: () => [], health: () => health })
    await act(async () => {
      await result.current.reload()
    })
    expect(result.current.health).toEqual(health)
  })

  it("onboards an npm spec via SSE, streams progress, then refreshes the list", async () => {
    let added = false
    route({
      list: () => (added ? [entry({ package: "@acme/widgets", id: "@acme/widgets" })] : []),
      suggestions: () => [],
      post: () => {
        added = true // the server registered it; the hook's refresh should see it
        return sse(
          { type: "progress", stage: "ingesting" },
          { type: "progress", stage: "extracting" },
          { type: "result", result: { package: "@acme/widgets", framework: "vue3" } },
        )
      },
    })
    const { result } = renderHook(() => useDesignSystems())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let res: unknown
    await waitFor(async () => {
      res = await result.current.addNpm("@acme/widgets@2.1.0")
    })
    expect(res).toMatchObject({ package: "@acme/widgets" })
    await waitFor(() => expect(result.current.systems).toHaveLength(1))
    expect(result.current.busy).toBe(false)
    expect(result.current.progress).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it("surfaces an SSE error frame and does not register", async () => {
    route({
      list: () => [],
      suggestions: () => [],
      post: () => sse({ type: "error", message: "npm spec 'nope' not found" }),
    })
    const { result } = renderHook(() => useDesignSystems())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let res: unknown = "unset"
    await waitFor(async () => {
      res = await result.current.addNpm("nope")
    })
    expect(res).toBeNull()
    await waitFor(() => expect(result.current.error).toMatch(/not found/))
    expect(result.current.busy).toBe(false)
  })

  it("onboards a git repo, threading url/ref/subdir + allowBuild into the POST body", async () => {
    let posted: Record<string, unknown> | null = null
    route({
      list: () => [],
      suggestions: () => [],
      post: () => sse({ type: "result", result: { package: "@acme/repo-ui" } }),
    })
    // Capture the POST body.
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input, init) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST") {
        posted = JSON.parse(String(init?.body))
      }
      return inner(input, init)
    })
    const { result } = renderHook(() => useDesignSystems())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(async () => {
      await result.current.addRepo({
        url: "https://github.com/acme/ui.git",
        ref: "v3",
        subdir: "packages/ui",
        allowBuild: false,
      })
    })
    expect(posted).toMatchObject({
      source: { kind: "repo", url: "https://github.com/acme/ui.git", ref: "v3", subdir: "packages/ui" },
      allowBuild: false,
    })
  })

  it("surfaces a non-stream JSON error (e.g. 422)", async () => {
    route({
      list: () => [],
      suggestions: () => [],
      post: () => json(422, { ok: false, reason: "@nope/x is not installed" }),
    })
    const { result } = renderHook(() => useDesignSystems())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(async () => {
      await result.current.addInstalled("@nope/x")
    })
    await waitFor(() => expect(result.current.error).toMatch(/not installed/))
  })

  it("surfaces a load failure and keeps previously-loaded data", async () => {
    // First load OK, then the list endpoint starts failing on a refresh.
    let failList = false
    fetchMock.mockImplementation((input, init) => {
      const url = String(input)
      const method = (init?.method ?? "GET").toUpperCase()
      if (method === "GET" && url.endsWith("/suggestions")) {
        return Promise.resolve(json(200, { ok: true, suggestions: [] }))
      }
      if (method === "GET" && url.endsWith("/design-systems")) {
        return failList
          ? Promise.resolve(json(500, { ok: false, reason: "malformed registry file" }))
          : Promise.resolve(json(200, { ok: true, designSystems: [entry()] }))
      }
      if (method === "DELETE") return Promise.resolve(json(500, { ok: false, reason: "boom" }))
      return Promise.resolve(json(404, {}))
    })
    const { result } = renderHook(() => useDesignSystems())
    await waitFor(() => expect(result.current.systems).toHaveLength(1))

    failList = true
    await waitFor(async () => {
      await result.current.reload()
    })
    await waitFor(() => expect(result.current.error).toMatch(/malformed registry/))
    // Data preserved, NOT cleared to an empty "all clear".
    expect(result.current.systems).toHaveLength(1)
  })

  it("ignores a stale in-flight refresh that resolves after an onboard", async () => {
    // The initial mount's suggestions scan hangs; an onboard's own refresh
    // lands the new system first; then the slow initial scan resolves with its
    // pre-add snapshot. The generation guard must drop that stale result.
    let resolveFirstSug: (r: Response) => void = () => {}
    const firstSug = new Promise<Response>((r) => {
      resolveFirstSug = r
    })
    let sugCalls = 0
    let added = false
    fetchMock.mockImplementation((input, init) => {
      const url = String(input)
      const method = (init?.method ?? "GET").toUpperCase()
      if (method === "GET" && url.endsWith("/suggestions")) {
        sugCalls += 1
        return sugCalls === 1 ? firstSug : Promise.resolve(json(200, { ok: true, suggestions: [] }))
      }
      if (method === "GET" && url.endsWith("/design-systems")) {
        return Promise.resolve(
          json(200, {
            ok: true,
            designSystems: added ? [entry({ package: "@acme/widgets", id: "@acme/widgets" })] : [],
          }),
        )
      }
      if (method === "POST") {
        added = true
        return Promise.resolve(sse({ type: "result", result: { package: "@acme/widgets" } }))
      }
      return Promise.resolve(json(404, {}))
    })

    const { result } = renderHook(() => useDesignSystems())
    await waitFor(() => expect(sugCalls).toBe(1)) // initial refresh stuck on suggestions

    await act(async () => {
      await result.current.addNpm("@acme/widgets@2.1.0")
    })
    await waitFor(() => expect(result.current.systems).toHaveLength(1)) // onboard refresh landed

    // Now release the stale initial suggestions scan (its list snapshot was []).
    await act(async () => {
      resolveFirstSug(json(200, { ok: true, suggestions: [] }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.systems).toHaveLength(1) // NOT clobbered to []
  })

  it("removes a system and refreshes", async () => {
    let removed = false
    const del = vi.fn(() => {
      removed = true
      return json(200, { ok: true, removed: "@acme/ui" })
    })
    route({ list: () => (removed ? [] : [entry()]), suggestions: () => [], del })
    const { result } = renderHook(() => useDesignSystems())
    await waitFor(() => expect(result.current.systems).toHaveLength(1))

    await waitFor(async () => {
      await result.current.remove("@acme/ui")
    })
    expect(del).toHaveBeenCalled()
    await waitFor(() => expect(result.current.systems).toHaveLength(0))
  })

  it("shares a registered system's declaration and refreshes its declared state", async () => {
    let shared = false
    fetchMock.mockImplementation((input, init) => {
      const url = String(input)
      const method = (init?.method ?? "GET").toUpperCase()
      if (method === "GET" && url.endsWith("/suggestions")) {
        return Promise.resolve(json(200, { ok: true, suggestions: [] }))
      }
      if (method === "GET" && url.endsWith("/design-systems")) {
        return Promise.resolve(
          json(200, { ok: true, designSystems: [entry({ declared: shared })] }),
        )
      }
      if (method === "POST" && url.endsWith("/share")) {
        shared = true
        return Promise.resolve(json(200, { ok: true, declared: true }))
      }
      return Promise.resolve(json(404, {}))
    })
    const { result } = renderHook(() => useDesignSystems())
    await waitFor(() => expect(result.current.systems).toHaveLength(1))
    expect(result.current.systems[0].declared).toBe(false)

    let ok: boolean | undefined
    await waitFor(async () => {
      ok = await result.current.share("@acme/ui")
    })
    expect(ok).toBe(true)
    await waitFor(() => expect(result.current.systems[0].declared).toBe(true))
  })

  it("surfaces a share failure reason and returns false", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input)
      const method = (init?.method ?? "GET").toUpperCase()
      if (method === "GET" && url.endsWith("/suggestions")) {
        return Promise.resolve(json(200, { ok: true, suggestions: [] }))
      }
      if (method === "GET" && url.endsWith("/design-systems")) {
        return Promise.resolve(json(200, { ok: true, designSystems: [entry({ declared: false })] }))
      }
      if (method === "POST" && url.endsWith("/share")) {
        return Promise.resolve(json(409, { ok: false, reason: "already declared" }))
      }
      return Promise.resolve(json(404, {}))
    })
    const { result } = renderHook(() => useDesignSystems())
    await waitFor(() => expect(result.current.systems).toHaveLength(1))

    let ok: boolean | undefined
    await waitFor(async () => {
      ok = await result.current.share("@acme/ui")
    })
    expect(ok).toBe(false)
    await waitFor(() => expect(result.current.error).toMatch(/already declared/))
  })

  it("loads staleness from …/updates alongside the list", async () => {
    route({
      list: () => [entry()],
      suggestions: () => [],
      updates: () => ({ "@acme/ui": { id: "@acme/ui", state: "update-available", latest: "2.0.0" } }),
    })
    const { result } = renderHook(() => useDesignSystems())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.updates["@acme/ui"]).toEqual({
      id: "@acme/ui",
      state: "update-available",
      latest: "2.0.0",
    })
  })

  it("does not block loading on a slow/hung …/updates fetch", async () => {
    // A cold-cache staleness check (npm view / git ls-remote per entry) can be
    // genuinely slow. It must never hold the panel in `loading` — list +
    // suggestions settling is what ends loading; updates land whenever they land.
    let resolveUpdates: (r: Response) => void = () => {}
    const updatesPromise = new Promise<Response>((resolve) => {
      resolveUpdates = resolve
    })
    fetchMock.mockImplementation((input, init) => {
      const url = String(input)
      const method = (init?.method ?? "GET").toUpperCase()
      if (method === "GET" && url.endsWith("/suggestions")) {
        return Promise.resolve(json(200, { ok: true, suggestions: [] }))
      }
      if (method === "GET" && url.endsWith("/updates")) {
        return updatesPromise // never resolves for the duration of this test
      }
      if (method === "GET" && url.endsWith("/design-systems")) {
        return Promise.resolve(json(200, { ok: true, designSystems: [entry()] }))
      }
      return Promise.resolve(json(404, {}))
    })
    const { result } = renderHook(() => useDesignSystems())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.systems).toHaveLength(1)
    expect(result.current.updates).toEqual({})

    // Release it so the pending promise doesn't leak past the test.
    await act(async () => {
      resolveUpdates(json(200, { ok: true, updates: {} }))
      await Promise.resolve()
    })
  })

  it("checkUpdates(force) requests ?force=1 and replaces the updates map", async () => {
    let forced = false
    fetchMock.mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith("/suggestions")) return Promise.resolve(json(200, { ok: true, suggestions: [] }))
      if (url.includes("/updates")) {
        forced = url.includes("force=1")
        return Promise.resolve(
          json(200, {
            ok: true,
            updates: forced
              ? { "@acme/ui": { id: "@acme/ui", state: "fresh" } }
              : { "@acme/ui": { id: "@acme/ui", state: "update-available" } },
          }),
        )
      }
      if (url.endsWith("/design-systems")) {
        return Promise.resolve(json(200, { ok: true, designSystems: [entry()] }))
      }
      return Promise.resolve(json(404, {}))
    })
    const { result } = renderHook(() => useDesignSystems())
    await waitFor(() => expect(result.current.updates["@acme/ui"]?.state).toBe("update-available"))

    await act(async () => {
      await result.current.checkUpdates(true)
    })
    expect(forced).toBe(true)
    expect(result.current.updates["@acme/ui"]).toEqual({ id: "@acme/ui", state: "fresh" })
  })

  it("refresh(id) streams progress, reloads the list, and returns true on success", async () => {
    let refreshed = false
    route({
      list: () => [entry({ version: refreshed ? "2.0.0" : "1.0.0" })],
      suggestions: () => [],
      post: () => {
        refreshed = true
        return sse(
          { type: "progress", stage: "ingesting" },
          { type: "result", result: { package: "@acme/ui", version: "2.0.0" } },
        )
      },
    })
    const { result } = renderHook(() => useDesignSystems())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let ok: boolean | undefined
    await waitFor(async () => {
      ok = await result.current.refresh("@acme/ui")
    })
    expect(ok).toBe(true)
    expect(result.current.busy).toBe(false)
    expect(result.current.progress).toBeNull()
    await waitFor(() => expect(result.current.systems[0]?.version).toBe("2.0.0"))
  })

  it("refresh(id) surfaces an SSE error frame and returns false", async () => {
    route({
      list: () => [entry()],
      suggestions: () => [],
      post: () => sse({ type: "error", message: "package no longer resolvable" }),
    })
    const { result } = renderHook(() => useDesignSystems())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let ok: boolean | undefined
    await waitFor(async () => {
      ok = await result.current.refresh("@acme/ui")
    })
    expect(ok).toBe(false)
    await waitFor(() => expect(result.current.error).toMatch(/no longer resolvable/))
  })

  describe("generateHints(id) — Phase 4 Task 3 probe-derived hints", () => {
    it("streams progress, reloads the list (picking up hintCoverage), and returns the run summary", async () => {
      let generated = false
      route({
        list: () => [
          entry({ hintCoverage: generated ? { hinted: 1, verified: 1, total: 1 } : null }),
        ],
        suggestions: () => [],
        post: () => {
          generated = true
          return sse(
            { type: "progress", progress: { component: "UiButton", index: 0, total: 1 } },
            { type: "result", result: { probed: 1, hinted: 1, verified: 1, skipped: [] } },
          )
        },
      })
      const { result } = renderHook(() => useDesignSystems())
      await waitFor(() => expect(result.current.loading).toBe(false))

      let summary: unknown
      await waitFor(async () => {
        summary = await result.current.generateHints("@acme/ui")
      })
      expect(summary).toEqual({ probed: 1, hinted: 1, verified: 1, skipped: [] })
      expect(result.current.busy).toBe(false)
      expect(result.current.hintProgress).toBeNull()
      expect(result.current.error).toBeNull()
      await waitFor(() =>
        expect(result.current.systems[0]?.hintCoverage).toEqual({
          hinted: 1,
          verified: 1,
          total: 1,
        }),
      )
    })

    it("sends useLlm:false by default and useLlm:true when the caller opts in (Phase 4 Task 5)", async () => {
      const bodies: unknown[] = []
      route({
        list: () => [entry()],
        suggestions: () => [],
        post: () => sse({ type: "result", result: { probed: 0, hinted: 0, verified: 0, skipped: [] } }),
      })
      fetchMock.mockImplementation((input, init) => {
        if ((init?.method ?? "GET").toUpperCase() === "POST" && String(input).endsWith("/generate-hints")) {
          bodies.push(init?.body ? JSON.parse(String(init.body)) : null)
          return Promise.resolve(
            sse({ type: "result", result: { probed: 0, hinted: 0, verified: 0, skipped: [] } }),
          )
        }
        if ((init?.method ?? "GET").toUpperCase() === "GET" && String(input).endsWith("/suggestions")) {
          return Promise.resolve(json(200, { ok: true, suggestions: [] }))
        }
        if ((init?.method ?? "GET").toUpperCase() === "GET" && String(input).endsWith("/updates")) {
          return Promise.resolve(json(200, { ok: true, updates: {} }))
        }
        if ((init?.method ?? "GET").toUpperCase() === "GET" && String(input).endsWith("/design-systems")) {
          return Promise.resolve(json(200, { ok: true, designSystems: [entry()], health: null }))
        }
        return Promise.resolve(json(404, {}))
      })
      const { result } = renderHook(() => useDesignSystems())
      await waitFor(() => expect(result.current.loading).toBe(false))

      await waitFor(async () => {
        await result.current.generateHints("@acme/ui")
      })
      await waitFor(async () => {
        await result.current.generateHints("@acme/ui", true)
      })
      expect(bodies).toEqual([{ useLlm: false }, { useLlm: true }])
    })

    it("surfaces an SSE error frame and returns null", async () => {
      route({
        list: () => [entry()],
        suggestions: () => [],
        post: () =>
          sse({
            type: "error",
            message: "package not installed in the prototype; probing supports installed packages only (V1)",
          }),
      })
      const { result } = renderHook(() => useDesignSystems())
      await waitFor(() => expect(result.current.loading).toBe(false))

      let summary: unknown = "unset"
      await waitFor(async () => {
        summary = await result.current.generateHints("@acme/ui")
      })
      expect(summary).toBeNull()
      await waitFor(() => expect(result.current.error).toMatch(/not installed/))
    })

    it("surfaces a non-stream JSON error (e.g. 404 unknown id)", async () => {
      route({
        list: () => [],
        suggestions: () => [],
        post: () => json(404, { ok: false, reason: "No design system registered with id '@nope/x'." }),
      })
      const { result } = renderHook(() => useDesignSystems())
      await waitFor(() => expect(result.current.loading).toBe(false))

      let summary: unknown = "unset"
      await waitFor(async () => {
        summary = await result.current.generateHints("@nope/x")
      })
      expect(summary).toBeNull()
      await waitFor(() => expect(result.current.error).toMatch(/No design system registered/))
    })
  })
})
