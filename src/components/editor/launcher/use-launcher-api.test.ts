/**
 * Tests for `useLauncherApi`'s New Project design-system-step additions
 * (Phase 3 attach/refresh, task 4): the two-phase `pickForNewProject` /
 * `cloneForNewProject` (resolve a path WITHOUT opening it) and
 * `suggestDesignSystems` / `declareDesignSystems` (the pre-open scan +
 * declare routes). Mocks global `fetch`; the initial `/projects` load fires
 * on mount for every test so each route stub accounts for it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useLauncherApi, type DesignSystemSuggestion } from "./use-launcher-api"
import type { DesignSystemDeclaration } from "@/editor/core/design-system-declarations"
import type { LauncherOpenBlock } from "@/types/launcher"
import type { InspectPathResult } from "./use-launcher-api"

type FetchSig = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
let fetchMock: ReturnType<typeof vi.fn<FetchSig>>
let realFetch: typeof fetch

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

beforeEach(() => {
  realFetch = globalThis.fetch
  fetchMock = vi.fn<FetchSig>()
  globalThis.fetch = fetchMock as unknown as typeof fetch
  fetchMock.mockImplementation((input) => {
    const url = String(input)
    if (url.endsWith("/api/launcher/projects")) {
      return Promise.resolve(json(200, { ok: true, projects: [] }))
    }
    return Promise.resolve(json(404, { ok: false, reason: "unhandled in test" }))
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

/**
 * The body of the last request that HAD one, i.e. the POST the test just made.
 *
 * Selected by "has a body" rather than by excluding known mount-time URLs. The
 * previous version excluded `/projects` by name and broke the moment the hook
 * gained a second mount-time load (`/demo`), because that GET became the first
 * non-projects call and carries no body. Every mount-time load is a GET, and
 * every call a test cares about is a POST, so this distinction cannot rot the
 * same way.
 */
function lastPostBody(): unknown {
  const withBody = fetchMock.mock.calls.filter(([, init]) => init?.body !== undefined)
  const call = withBody[withBody.length - 1]
  if (!call) throw new Error("no fetch call with a body recorded")
  return JSON.parse(String(call[1]?.body ?? "{}"))
}

async function ready() {
  const { result } = renderHook(() => useLauncherApi())
  await waitFor(() => expect(result.current.projects).not.toBeNull())
  return result
}

describe("useLauncherApi — pickForNewProject", () => {
  it("resolves the picked path without hitting /open", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith("/projects")) return Promise.resolve(json(200, { ok: true, projects: [] }))
      if (url.endsWith("/pick-folder")) {
        return Promise.resolve(json(200, { ok: true, supported: true, path: "/picked/repo" }))
      }
      return Promise.resolve(json(404, { ok: false }))
    })
    const result = await ready()

    let outcome: { supported: boolean; path?: string } | undefined
    await act(async () => {
      outcome = await result.current.pickForNewProject()
    })
    expect(outcome).toEqual({ supported: true, path: "/picked/repo" })
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/open"))).toBe(false)
  })

  it("reports supported:false with no path when the platform has no native picker", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith("/projects")) return Promise.resolve(json(200, { ok: true, projects: [] }))
      if (url.endsWith("/pick-folder")) return Promise.resolve(json(200, { ok: true, supported: false }))
      return Promise.resolve(json(404, { ok: false }))
    })
    const result = await ready()

    let outcome: { supported: boolean; path?: string } | undefined
    await act(async () => {
      outcome = await result.current.pickForNewProject()
    })
    expect(outcome).toEqual({ supported: false })
  })

  it("reports supported:true with no path on cancel", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith("/projects")) return Promise.resolve(json(200, { ok: true, projects: [] }))
      if (url.endsWith("/pick-folder")) {
        return Promise.resolve(json(200, { ok: true, supported: true, canceled: true }))
      }
      return Promise.resolve(json(404, { ok: false }))
    })
    const result = await ready()

    let outcome: { supported: boolean; path?: string } | undefined
    await act(async () => {
      outcome = await result.current.pickForNewProject()
    })
    expect(outcome).toEqual({ supported: true })
  })
})

/**
 * Inside the desktop shell, `window.desdeDesktop` is present
 * (`desktop/preload.ts`'s `contextBridge.exposeInMainWorld`) and
 * `pickForNewProject` must prefer its native `pickFolder()` over the HTTP
 * round-trip entirely — no `/api/launcher/pick-folder` request at all. See
 * `tasks/electron-app.md` §3 and `desktop/preload.ts`.
 */
describe("useLauncherApi — pickForNewProject prefers window.desdeDesktop", () => {
  afterEach(() => {
    delete (window as { desdeDesktop?: unknown }).desdeDesktop
  })

  function installDesktopBridge(pickFolder: () => Promise<string | null>) {
    ;(window as unknown as { desdeDesktop: unknown }).desdeDesktop = {
      appVersion: "0.1.0",
      updates: {
        getState: vi.fn(),
        onState: vi.fn(),
        download: vi.fn(),
        restartAndInstall: vi.fn(),
        getAutoDownload: vi.fn(),
        setAutoDownload: vi.fn(),
      },
      pickFolder,
    }
  }

  it("resolves the picked path via the bridge, never hitting /pick-folder", async () => {
    installDesktopBridge(async () => "/native/picked/repo")
    const result = await ready()

    let outcome: { supported: boolean; path?: string } | undefined
    await act(async () => {
      outcome = await result.current.pickForNewProject()
    })
    expect(outcome).toEqual({ supported: true, path: "/native/picked/repo" })
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/pick-folder"))).toBe(false)
  })

  it("reports supported:true with no path when the bridge resolves null (cancel)", async () => {
    installDesktopBridge(async () => null)
    const result = await ready()

    let outcome: { supported: boolean; path?: string } | undefined
    await act(async () => {
      outcome = await result.current.pickForNewProject()
    })
    expect(outcome).toEqual({ supported: true })
  })

  it("surfaces a bridge rejection as an error, without crashing", async () => {
    installDesktopBridge(async () => {
      throw new Error("IPC channel closed")
    })
    const result = await ready()

    let outcome: { supported: boolean; path?: string } | undefined
    await act(async () => {
      outcome = await result.current.pickForNewProject()
    })
    expect(outcome).toEqual({ supported: true })
    expect(result.current.error).toBe("IPC channel closed")
  })
})

/**
 * `openPath` vouches for a newly-opened project's origin via
 * `window.desdeDesktop.__trustOrigin` BEFORE navigating there — the
 * desktop shell's `will-navigate` guard otherwise has no way to learn a
 * per-project editor's origin (a free port the launcher itself picks). See
 * `desktop/navigation-guard.ts` and `src/types/desktop-bridge.ts`.
 */
describe("useLauncherApi — openPath vouches for the desktop shell's navigation guard", () => {
  afterEach(() => {
    delete (window as { desdeDesktop?: unknown }).desdeDesktop
  })

  it("awaits __trustOrigin with the opened url BEFORE navigating, when the bridge is present", async () => {
    let trustOriginResolved = false
    const trustOrigin = vi.fn(async () => {
      // A real microtask delay — proves the caller genuinely awaits this
      // promise rather than merely calling it fire-and-forget. If openPath
      // navigated before this resolved, that would reproduce exactly the
      // race the awaited invoke was built to close.
      await Promise.resolve()
      trustOriginResolved = true
    })
    ;(window as unknown as { desdeDesktop: unknown }).desdeDesktop = { __trustOrigin: trustOrigin }
    fetchMock.mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith("/projects")) return Promise.resolve(json(200, { ok: true, projects: [] }))
      if (url.endsWith("/open")) return Promise.resolve(json(200, { ok: true, url: "http://127.0.0.1:63461" }))
      return Promise.resolve(json(404, { ok: false }))
    })
    const result = await ready()

    await act(async () => {
      await result.current.openPath("/repo/a")
    })
    expect(trustOrigin).toHaveBeenCalledWith("http://127.0.0.1:63461")
    expect(trustOriginResolved).toBe(true)
  })

  it("swallows a __trustOrigin rejection rather than throwing (navigation may still be blocked, but openPath doesn't crash)", async () => {
    const trustOrigin = vi.fn().mockRejectedValue(new Error("IPC channel closed"))
    ;(window as unknown as { desdeDesktop: unknown }).desdeDesktop = { __trustOrigin: trustOrigin }
    fetchMock.mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith("/projects")) return Promise.resolve(json(200, { ok: true, projects: [] }))
      if (url.endsWith("/open")) return Promise.resolve(json(200, { ok: true, url: "http://127.0.0.1:63461" }))
      return Promise.resolve(json(404, { ok: false }))
    })
    const result = await ready()

    await expect(
      act(async () => {
        await result.current.openPath("/repo/a")
      }),
    ).resolves.toBeUndefined()
  })

  it("does not throw when the bridge is absent (plain browser tab)", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith("/projects")) return Promise.resolve(json(200, { ok: true, projects: [] }))
      if (url.endsWith("/open")) return Promise.resolve(json(200, { ok: true, url: "http://127.0.0.1:63461" }))
      return Promise.resolve(json(404, { ok: false }))
    })
    const result = await ready()

    await expect(
      act(async () => {
        await result.current.openPath("/repo/a")
      }),
    ).resolves.toBeUndefined()
  })
})

/**
 * The launcher's answer when a repo cannot be opened.
 *
 * What this pins is that the STRUCTURE survives the fetch boundary. Before
 * this, `/open` failed with whatever the spawned child's exit produced and the
 * hook kept `res.reason` — so the UI's only possible rendering was one line
 * reading `editor exited before it was ready (code 4)`.
 */
describe("useLauncherApi — a repo that cannot be opened", () => {
  const block: LauncherOpenBlock = {
    code: "framework-unsupported",
    summary: "Astro isn't supported.",
    remediation: [],
    attachCovers: false,
    supported: [
      { id: "vite", label: "Vite" },
      { id: "next", label: "Next.js" },
    ],
  }

  function stubOpen(status: number, body: unknown) {
    fetchMock.mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith("/projects")) return Promise.resolve(json(200, { ok: true, projects: [] }))
      if (url.endsWith("/open")) return Promise.resolve(json(status, body))
      if (url.endsWith("/inspect")) return Promise.resolve(json(status, body))
      return Promise.resolve(json(404, { ok: false }))
    })
  }

  it("keeps every field of the refusal instead of flattening it to a sentence", async () => {
    stubOpen(400, { ok: false, reason: block.summary, blocked: block })
    const result = await ready()

    await act(async () => {
      await result.current.openPath("/repo/astro")
    })
    expect(result.current.openBlock).toEqual(block)
    // The point of this test is that the SHAPE survives the fetch boundary,
    // not that any particular field is populated. `remediation` is legally
    // empty since 2026-08-17, so assert on a field this block actually has.
    expect(result.current.openBlock?.supported).toHaveLength(2)
    // One surface, not two: a structured refusal must not ALSO raise the
    // plain-string banner, or the page shows the summary twice.
    expect(result.current.error).toBeNull()
    expect(result.current.busy).toBeNull()
  })

  it("still reports an unstructured failure as a plain error", async () => {
    stubOpen(500, { ok: false, reason: "editor exited before it was ready (code 1)" })
    const result = await ready()

    await act(async () => {
      await result.current.openPath("/repo/mystery")
    })
    expect(result.current.openBlock).toBeNull()
    expect(result.current.error).toBe("editor exited before it was ready (code 1)")
  })

  it("clears a previous refusal when the next action starts", async () => {
    stubOpen(400, { ok: false, reason: block.summary, blocked: block })
    const result = await ready()
    await act(async () => {
      await result.current.openPath("/repo/astro")
    })
    expect(result.current.openBlock).not.toBeNull()

    stubOpen(200, { ok: true, blocked: null })
    await act(async () => {
      await result.current.inspectPath("/repo/fine")
    })
    expect(result.current.openBlock).toBeNull()
  })

  it("inspectPath surfaces the refusal without opening anything", async () => {
    stubOpen(200, { ok: true, blocked: block })
    const result = await ready()

    let out: InspectPathResult | null = null
    await act(async () => {
      out = await result.current.inspectPath("/repo/astro")
    })
    expect(out).toEqual({ block, error: null })
    expect(result.current.openBlock).toEqual(block)
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/open"))).toBe(false)
  })

  /**
   * A check that did not COMPLETE is not the same as a check that found
   * nothing wrong, and collapsing the two is what let a bad path advance the
   * wizard: this returned a bare `null` until 2026-08-17, the caller read it
   * as "nothing blocking", and "Not a directory: …" surfaced on the name step.
   */
  it("reports a failed check as an error, not as an absent block", async () => {
    stubOpen(400, { ok: false, reason: "Not a directory: /repo/nope" })
    const result = await ready()

    let out: InspectPathResult | null = null
    await act(async () => {
      out = await result.current.inspectPath("/repo/nope")
    })
    expect(out).toEqual({ block: null, error: "Not a directory: /repo/nope" })
    // And nothing was opened on the way.
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/open"))).toBe(false)
  })
})

describe("useLauncherApi — cloneForNewProject", () => {
  it("posts open:false and resolves dest without a url", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith("/projects")) return Promise.resolve(json(200, { ok: true, projects: [] }))
      if (url.endsWith("/clone")) return Promise.resolve(json(200, { ok: true, dest: "/cloned/repo" }))
      return Promise.resolve(json(404, { ok: false }))
    })
    const result = await ready()

    let outcome: { path?: string } | undefined
    await act(async () => {
      outcome = await result.current.cloneForNewProject("https://github.com/acme/repo.git")
    })
    expect(outcome).toEqual({ path: "/cloned/repo" })
    expect(lastPostBody()).toEqual({ repoUrl: "https://github.com/acme/repo.git", open: false })
  })

  it("surfaces a clone failure via error and resolves no path", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith("/projects")) return Promise.resolve(json(200, { ok: true, projects: [] }))
      if (url.endsWith("/clone")) return Promise.resolve(json(400, { ok: false, reason: "git clone failed" }))
      return Promise.resolve(json(404, { ok: false }))
    })
    const result = await ready()

    let outcome: { path?: string } | undefined
    await act(async () => {
      outcome = await result.current.cloneForNewProject("bad-url")
    })
    expect(outcome).toEqual({})
    expect(result.current.error).toBe("git clone failed")
  })
})

describe("useLauncherApi — suggestDesignSystems / declareDesignSystems", () => {
  it("posts the path and returns suggestions", async () => {
    const suggestions: DesignSystemSuggestion[] = [
      { package: "@acme/ui", componentCount: 3, framework: "vue3" },
    ]
    fetchMock.mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith("/projects")) return Promise.resolve(json(200, { ok: true, projects: [] }))
      if (url.endsWith("/design-systems/suggest")) return Promise.resolve(json(200, { ok: true, suggestions }))
      return Promise.resolve(json(404, { ok: false }))
    })
    const result = await ready()

    let outcome: DesignSystemSuggestion[] | undefined
    await act(async () => {
      outcome = await result.current.suggestDesignSystems("/picked/repo")
    })
    expect(outcome).toEqual(suggestions)
    expect(lastPostBody()).toEqual({ path: "/picked/repo" })
  })

  it("posts path + declarations and resolves ok:true on success", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith("/projects")) return Promise.resolve(json(200, { ok: true, projects: [] }))
      if (url.endsWith("/design-systems/declare")) {
        return Promise.resolve(json(200, { ok: true, appended: [], skipped: [] }))
      }
      return Promise.resolve(json(404, { ok: false }))
    })
    const result = await ready()

    const declarations: DesignSystemDeclaration[] = [
      { source: { kind: "installed", package: "@acme/ui" } },
    ]
    let outcome: { ok: true } | { ok: false; reason: string } | undefined
    await act(async () => {
      outcome = await result.current.declareDesignSystems("/picked/repo", declarations)
    })
    expect(outcome).toEqual({ ok: true })
    expect(lastPostBody()).toEqual({ path: "/picked/repo", declarations })
  })

  it("surfaces a declare failure via error and resolves ok:false", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith("/projects")) return Promise.resolve(json(200, { ok: true, projects: [] }))
      if (url.endsWith("/design-systems/declare")) {
        return Promise.resolve(json(400, { ok: false, reason: "bad declaration" }))
      }
      return Promise.resolve(json(404, { ok: false }))
    })
    const result = await ready()

    let outcome: { ok: true } | { ok: false; reason: string } | undefined
    await act(async () => {
      outcome = await result.current.declareDesignSystems("/picked/repo", [])
    })
    expect(outcome).toEqual({ ok: false, reason: "bad declaration" })
    expect(result.current.error).toBe("bad declaration")
  })
})
