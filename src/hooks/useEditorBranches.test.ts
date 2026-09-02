/**
 * Tests for useEditorBranches — audit-fixes wave item 7(a): the
 * background poll (POLL_INTERVAL_MS) was calling `setChanges` with a
 * freshly-parsed array every tick even when the working tree was
 * unchanged, so anything downstream keyed on `changes` (the Activity
 * panel) re-rendered every 2.5s for no reason. `sameChanges` closes that
 * by keeping the array referentially stable when its contents match.
 */

import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/editor-fetch", () => ({
  editorFetch: vi.fn(),
}))

import { editorFetch } from "@/lib/editor-fetch"
import { sameChanges, useEditorBranches, type WorkingTreeChange } from "./useEditorBranches"

const editorFetchMock = editorFetch as ReturnType<typeof vi.fn>

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response
}

function branchesBody(changes: WorkingTreeChange[]) {
  return {
    ok: true,
    branches: [{ name: "main", current: true, isDefault: true }],
    current: "main",
    defaultBranch: "main",
    dirty: changes.length > 0,
    changes,
    ahead: 0,
    behind: 0,
    hasRemote: false,
    unpushed: false,
  }
}

function failureResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => body,
  } as Response
}

beforeEach(() => {
  editorFetchMock.mockReset()
})

afterEach(() => {
  editorFetchMock.mockReset()
  vi.useRealTimers()
})

describe("sameChanges", () => {
  it("is true for two empty arrays", () => {
    expect(sameChanges([], [])).toBe(true)
  })

  it("is true for structurally identical arrays (different array identity)", () => {
    const a: WorkingTreeChange[] = [{ path: "src/App.vue", status: "modified" }]
    const b: WorkingTreeChange[] = [{ path: "src/App.vue", status: "modified" }]
    expect(sameChanges(a, b)).toBe(true)
  })

  it("is false when lengths differ", () => {
    const a: WorkingTreeChange[] = [{ path: "src/App.vue", status: "modified" }]
    expect(sameChanges(a, [])).toBe(false)
  })

  it("is false when a field differs", () => {
    const a: WorkingTreeChange[] = [{ path: "src/App.vue", status: "modified" }]
    const b: WorkingTreeChange[] = [{ path: "src/App.vue", status: "deleted" }]
    expect(sameChanges(a, b)).toBe(false)
  })

  it("is false when 'from' (rename source) differs", () => {
    const a: WorkingTreeChange[] = [{ path: "src/New.vue", status: "renamed", from: "src/Old.vue" }]
    const b: WorkingTreeChange[] = [{ path: "src/New.vue", status: "renamed", from: "src/Older.vue" }]
    expect(sameChanges(a, b)).toBe(false)
  })
})

describe("useEditorBranches — poll stability", () => {
  it("keeps the same `changes` array reference across polls when nothing changed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const changes: WorkingTreeChange[] = [{ path: "src/App.vue", status: "modified" }]
    editorFetchMock.mockResolvedValue(jsonResponse(branchesBody(changes)))

    const { result } = renderHook(() => useEditorBranches())

    await waitFor(() => expect(result.current.changes).toHaveLength(1))
    const firstRef = result.current.changes

    // Advance past one poll tick — same server payload (new array each
    // response, matching real fetch/JSON.parse behavior).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500)
    })
    await waitFor(() => expect(editorFetchMock.mock.calls.length).toBeGreaterThan(1))

    expect(result.current.changes).toBe(firstRef)
  })

  it("produces a new `changes` array reference when the working tree actually changed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    editorFetchMock.mockResolvedValueOnce(
      jsonResponse(branchesBody([{ path: "src/App.vue", status: "modified" }])),
    )

    const { result } = renderHook(() => useEditorBranches())
    await waitFor(() => expect(result.current.changes).toHaveLength(1))
    const firstRef = result.current.changes

    editorFetchMock.mockResolvedValueOnce(
      jsonResponse(
        branchesBody([
          { path: "src/App.vue", status: "modified" },
          { path: "src/Other.vue", status: "added" },
        ]),
      ),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500)
    })
    await waitFor(() => expect(result.current.changes).toHaveLength(2))

    expect(result.current.changes).not.toBe(firstRef)
  })
})

describe("useEditorBranches — remote sync", () => {
  it("surfaces `behind` from the server and fetches origin once a remote exists", async () => {
    editorFetchMock.mockImplementation(async (path: string) =>
      path === "/api/editor/branches/fetch"
        ? jsonResponse({ ok: true, behind: 3 })
        : jsonResponse({ ...branchesBody([]), hasRemote: true, behind: 3 }),
    )
    const { result } = renderHook(() => useEditorBranches())
    await waitFor(() => expect(result.current.behind).toBe(3))
    // The long-interval effect fires once when the remote is first seen —
    // an explicit fetch endpoint call, distinct from the 2.5s GET poll.
    await waitFor(() =>
      expect(
        editorFetchMock.mock.calls.some(
          (c) => c[0] === "/api/editor/branches/fetch",
        ),
      ).toBe(true),
    )
  })

  it("never fetches origin when the repo has no remote", async () => {
    editorFetchMock.mockResolvedValue(jsonResponse(branchesBody([])))
    const { result } = renderHook(() => useEditorBranches())
    await waitFor(() => expect(result.current.current).toBe("main"))
    expect(
      editorFetchMock.mock.calls.some((c) => c[0] === "/api/editor/branches/fetch"),
    ).toBe(false)
  })

  it("passes conflictFiles through on a conflicting update", async () => {
    editorFetchMock.mockImplementation(async (path: string) =>
      path === "/api/editor/branches/update-from-default"
        ? failureResponse(409, {
            ok: false,
            reason: "Merging 'main' into 'feat/x' hit conflicts.",
            conflict: true,
            conflictFiles: ["src/App.vue"],
          })
        : jsonResponse(branchesBody([])),
    )
    const { result } = renderHook(() => useEditorBranches())
    await waitFor(() => expect(result.current.current).toBe("main"))
    let res: Awaited<ReturnType<typeof result.current.updateFromDefault>> | null = null
    await act(async () => {
      res = await result.current.updateFromDefault()
    })
    expect(res!.ok).toBe(false)
    expect(res!.conflictFiles).toEqual(["src/App.vue"])
  })

  it("parses hasUpstream so the UI can disable Pull for a branch with none", async () => {
    editorFetchMock.mockResolvedValue(
      jsonResponse({ ...branchesBody([]), hasRemote: true, hasUpstream: true }),
    )
    const { result } = renderHook(() => useEditorBranches())
    await waitFor(() => expect(result.current.hasUpstream).toBe(true))
  })

  it("passes committedBranch through on an up-to-date result (the silent-commit case)", async () => {
    editorFetchMock.mockImplementation(async (path: string) =>
      path === "/api/editor/branches/update-from-default"
        ? jsonResponse({ ok: true, upToDate: true, committedBranch: true })
        : jsonResponse(branchesBody([])),
    )
    const { result } = renderHook(() => useEditorBranches())
    await waitFor(() => expect(result.current.current).toBe("main"))
    let res: Awaited<ReturnType<typeof result.current.updateFromDefault>> | null = null
    await act(async () => {
      res = await result.current.updateFromDefault()
    })
    expect(res!.ok).toBe(true)
    expect(res!.upToDate).toBe(true)
    // Before this field existed, `mutate` dropped it on the floor and the
    // UI could not say the action had committed the working tree.
    expect(res!.committedBranch).toBe(true)
  })

  it("passes committedBranch through on a conflicting update too", async () => {
    editorFetchMock.mockImplementation(async (path: string) =>
      path === "/api/editor/branches/pull-remote"
        ? failureResponse(409, {
            ok: false,
            reason: "Merging 'origin/main' into 'main' hit conflicts.",
            conflict: true,
            conflictFiles: ["a.txt"],
            committedBranch: true,
          })
        : jsonResponse(branchesBody([])),
    )
    const { result } = renderHook(() => useEditorBranches())
    await waitFor(() => expect(result.current.current).toBe("main"))
    let res: Awaited<ReturnType<typeof result.current.pullRemote>> | null = null
    await act(async () => {
      res = await result.current.pullRemote()
    })
    expect(res!.ok).toBe(false)
    expect(res!.conflictFiles).toEqual(["a.txt"])
    expect(res!.committedBranch).toBe(true)
  })

  it("reports upToDate on a no-op pull", async () => {
    editorFetchMock.mockImplementation(async (path: string) =>
      path === "/api/editor/branches/pull-remote"
        ? jsonResponse({ ok: true, upToDate: true })
        : jsonResponse(branchesBody([])),
    )
    const { result } = renderHook(() => useEditorBranches())
    await waitFor(() => expect(result.current.current).toBe("main"))
    let res: Awaited<ReturnType<typeof result.current.pullRemote>> | null = null
    await act(async () => {
      res = await result.current.pullRemote()
    })
    expect(res!.ok).toBe(true)
    expect(res!.upToDate).toBe(true)
  })
})
