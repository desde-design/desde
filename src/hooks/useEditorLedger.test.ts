/**
 * Tests for useEditorLedger — Plan B, Task 2. The client hook that reads
 * the edit ledger (Plan A's `GET /api/editor/ledger`) and issues
 * per-entry undo (Plan B Task 1's `POST /api/editor/ledger/:id/undo`).
 *
 * Follows the fetch-mocking + poll-stability pattern established by
 * `useEditorBranches.test.ts` (`sameChanges` / "poll stability") rather
 * than inventing a second style — see `sameLedgerRows` below.
 */

import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/editor-fetch", () => ({
  editorFetch: vi.fn(),
}))

import { editorFetch } from "@/lib/editor-fetch"
import { sameLedgerRows, useEditorLedger, type LedgerRow } from "./useEditorLedger"
import { useEditorBranches } from "./useEditorBranches"

const editorFetchMock = editorFetch as ReturnType<typeof vi.fn>

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response
}

function failureResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => body,
  } as Response
}

const ROW_A: LedgerRow = {
  id: "entry-a",
  at: "2026-08-19T00:00:00.000Z",
  kind: "prop",
  lane: "direct",
  files: ["src/App.vue"],
  afterHashes: { "src/App.vue": "abc123" },
  description: "Changed a prop on App.vue",
  committed: false,
}

/**
 * A structural (not shallow) clone — a fresh top-level object AND fresh
 * `files`/`afterHashes` instances, matching what a real `fetch` response's
 * `.json()` (i.e. `JSON.parse`) produces: an entirely new object graph per
 * call, never a shared reference back to a previous response's data.
 *
 * Used instead of reusing a single row/array literal across mocked polls
 * so the referential-stability tests below actually exercise
 * `sameLedgerRows`. A `mockResolvedValue(...)` (not `Once`) reused across
 * polls would hand back the exact same array reference every time
 * regardless of whether `sameLedgerRows` ran at all — a mutation-tested
 * gap in the sibling `useEditorBranches.test.ts`'s "poll stability" test,
 * which this file deliberately does not copy.
 */
function cloneRow(row: LedgerRow): LedgerRow {
  return {
    ...row,
    files: [...row.files],
    afterHashes: { ...row.afterHashes },
  }
}

const ROW_B: LedgerRow = {
  id: "entry-b",
  at: "2026-08-19T00:01:00.000Z",
  kind: "swap",
  lane: "chat",
  files: ["src/Other.vue"],
  backupDir: ".desde/backups/2026-08-19T00:01:00-abc",
  afterHashes: { "src/Other.vue": "def456" },
  description: "Swapped a component in Other.vue",
  committed: true,
  sha: "deadbeef",
}

beforeEach(() => {
  editorFetchMock.mockReset()
})

afterEach(() => {
  editorFetchMock.mockReset()
  vi.useRealTimers()
})

describe("sameLedgerRows", () => {
  it("is true for two empty arrays", () => {
    expect(sameLedgerRows([], [])).toBe(true)
  })

  it("is true for structurally identical arrays (different array identity)", () => {
    expect(sameLedgerRows([{ ...ROW_A }], [{ ...ROW_A }])).toBe(true)
  })

  it("is false when lengths differ", () => {
    expect(sameLedgerRows([ROW_A], [])).toBe(false)
  })

  it("is false when a scalar field differs", () => {
    expect(sameLedgerRows([ROW_A], [{ ...ROW_A, committed: true }])).toBe(false)
  })

  it("is false when files differ", () => {
    expect(
      sameLedgerRows([ROW_A], [{ ...ROW_A, files: ["src/Different.vue"] }]),
    ).toBe(false)
  })

  it("is false when afterHashes differ", () => {
    expect(
      sameLedgerRows(
        [ROW_A],
        [{ ...ROW_A, afterHashes: { "src/App.vue": "different" } }],
      ),
    ).toBe(false)
  })
})

describe("useEditorLedger — fetch on mount", () => {
  it("fetches the ledger on mount and exposes the rows", async () => {
    editorFetchMock.mockResolvedValue(jsonResponse({ entries: [ROW_A, ROW_B] }))

    const { result } = renderHook(() => useEditorLedger())

    await waitFor(() => expect(result.current.rows).toHaveLength(2))
    expect(result.current.rows).toEqual([ROW_A, ROW_B])
    expect(result.current.error).toBeNull()
    expect(editorFetchMock).toHaveBeenCalledWith(
      "/api/editor/ledger",
      expect.objectContaining({ method: "GET" }),
    )
  })
})

describe("useEditorLedger — polling", () => {
  it("polls on the same 2500ms cadence as useEditorBranches", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    editorFetchMock.mockResolvedValue(jsonResponse({ entries: [ROW_A] }))

    const { result } = renderHook(() => useEditorLedger())
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    expect(editorFetchMock.mock.calls.length).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500)
    })
    await waitFor(() => expect(editorFetchMock.mock.calls.length).toBeGreaterThan(1))
  })

  it("keeps the same `rows` array reference across polls when nothing changed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    editorFetchMock.mockResolvedValueOnce(jsonResponse({ entries: [cloneRow(ROW_A)] }))

    const { result } = renderHook(() => useEditorLedger())
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    const firstRef = result.current.rows

    // A second, DISTINCT payload with the same content — see `cloneRow`'s
    // doc comment above for why this must not be a reused
    // `mockResolvedValue`.
    editorFetchMock.mockResolvedValueOnce(jsonResponse({ entries: [cloneRow(ROW_A)] }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500)
    })
    await waitFor(() => expect(editorFetchMock.mock.calls.length).toBeGreaterThan(1))

    expect(result.current.rows).toBe(firstRef)
  })

  it("produces a new `rows` array reference when the ledger actually changed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    editorFetchMock.mockResolvedValueOnce(jsonResponse({ entries: [ROW_A] }))

    const { result } = renderHook(() => useEditorLedger())
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    const firstRef = result.current.rows

    editorFetchMock.mockResolvedValueOnce(jsonResponse({ entries: [ROW_A, ROW_B] }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500)
    })
    await waitFor(() => expect(result.current.rows).toHaveLength(2))

    expect(result.current.rows).not.toBe(firstRef)
  })
})

describe("useEditorLedger — failed fetch does not blank the panel", () => {
  it("sets `error` and keeps existing rows on a failed poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    editorFetchMock.mockResolvedValueOnce(jsonResponse({ entries: [ROW_A] }))

    const { result } = renderHook(() => useEditorLedger())
    await waitFor(() => expect(result.current.rows).toHaveLength(1))

    editorFetchMock.mockResolvedValueOnce(
      failureResponse(500, { ok: false, reason: "boom" }),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500)
    })
    await waitFor(() => expect(result.current.error).not.toBeNull())

    // The transient failure must not blank the panel — the rows the user
    // already saw are still there.
    expect(result.current.rows).toEqual([ROW_A])
  })

  it("sets `error` from a thrown network failure without clearing rows", async () => {
    editorFetchMock.mockResolvedValueOnce(jsonResponse({ entries: [ROW_A] }))
    const { result } = renderHook(() => useEditorLedger())
    await waitFor(() => expect(result.current.rows).toHaveLength(1))

    editorFetchMock.mockRejectedValueOnce(new Error("network down"))
    await act(async () => {
      result.current.refresh()
    })
    await waitFor(() => expect(result.current.error).toBe("network down"))
    expect(result.current.rows).toEqual([ROW_A])
  })
})

describe("useEditorLedger — undo", () => {
  it("posts to the entry's undo URL and refreshes on success", async () => {
    editorFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/editor/ledger/entry-a/undo") {
        return jsonResponse({ ok: true })
      }
      return jsonResponse({ entries: [ROW_B] })
    })

    const { result } = renderHook(() => useEditorLedger())
    await waitFor(() => expect(result.current.rows).toHaveLength(1))

    let undoResult: Awaited<ReturnType<typeof result.current.undo>> | null = null
    await act(async () => {
      undoResult = await result.current.undo("entry-a")
    })

    expect(undoResult!.ok).toBe(true)
    const undoCall = editorFetchMock.mock.calls.find(
      (c) => c[0] === "/api/editor/ledger/entry-a/undo",
    )
    expect(undoCall).toBeDefined()
    // The route is a mutation (`POST /api/editor/ledger/:id/undo`) — a
    // regression sending the wrong verb would still hit the right URL and
    // pass the assertion above, so the method must be checked too.
    expect((undoCall?.[1] as RequestInit | undefined)?.method).toBe("POST")
    // Refreshed after success — the server's post-undo ledger (an
    // appended `undo` entry) is now what `rows` reflects.
    await waitFor(() => expect(result.current.rows).toEqual([ROW_B]))
  })

  it("surfaces a 409's reason verbatim and does not refresh away the error", async () => {
    let ledgerFetchCount = 0
    editorFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/editor/ledger/entry-a/undo") {
        return failureResponse(409, {
          ok: false,
          code: "drifted",
          reason: "The file changed since this edit — undo refused.",
        })
      }
      ledgerFetchCount += 1
      return jsonResponse({ entries: [ROW_A] })
    })

    const { result } = renderHook(() => useEditorLedger())
    await waitFor(() => expect(result.current.rows).toHaveLength(1))
    const countAfterMount = ledgerFetchCount

    let undoResult: Awaited<ReturnType<typeof result.current.undo>> | null = null
    await act(async () => {
      undoResult = await result.current.undo("entry-a")
    })

    expect(undoResult!.ok).toBe(false)
    expect(undoResult!.reason).toBe("The file changed since this edit — undo refused.")
    expect(undoResult!.code).toBe("drifted")
    // No refresh on a refusal — the ledger GET call count is unchanged.
    expect(ledgerFetchCount).toBe(countAfterMount)
  })

  it("returns a 404's reason for an unknown id", async () => {
    editorFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/editor/ledger/missing/undo") {
        return failureResponse(404, { ok: false, reason: "No edit found with that id." })
      }
      return jsonResponse({ entries: [] })
    })

    const { result } = renderHook(() => useEditorLedger())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let undoResult: Awaited<ReturnType<typeof result.current.undo>> | null = null
    await act(async () => {
      undoResult = await result.current.undo("missing")
    })

    expect(undoResult!.ok).toBe(false)
    expect(undoResult!.reason).toBe("No edit found with that id.")
  })
})

/** A promise plus its own resolver, for controlling exactly when a mocked
 *  fetch call settles relative to another one. */
function deferredResponse(): {
  promise: Promise<Response>
  resolve: (r: Response) => void
} {
  let resolve!: (r: Response) => void
  const promise = new Promise<Response>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/**
 * F2 (codex review round 8, 2026-08-20): `refresh` had no request-
 * generation guard, so whichever call's RESPONSE landed last won,
 * regardless of which call was STARTED last. This drives the actual
 * interleaving the finding named rather than asserting the guard exists
 * in isolation: a background poll's fetch is held open (simulating a slow
 * response) past the point where a faster, LATER-started post-undo
 * refresh has already resolved and painted its rows. Only once that's
 * settled does the slow poll's stale response arrive.
 */
describe("useEditorLedger — request ordering (F2)", () => {
  it("does not let a slow poll clobber a faster refresh that started after it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    const poll = deferredResponse()
    let ledgerCallCount = 0
    editorFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/editor/ledger/entry-a/undo") {
        return jsonResponse({ ok: true })
      }
      ledgerCallCount += 1
      if (ledgerCallCount === 1) {
        // The mount fetch — resolves immediately with the starting row.
        return jsonResponse({ entries: [ROW_A] })
      }
      if (ledgerCallCount === 2) {
        // The background poll — held open. This is the SLOW response.
        return poll.promise
      }
      // The post-undo refresh (started AFTER the poll above) — resolves
      // immediately. This is the FAST response.
      return jsonResponse({ entries: [ROW_B] })
    })

    const { result } = renderHook(() => useEditorLedger())
    await waitFor(() => expect(result.current.rows).toEqual([ROW_A]))

    // Fire the background poll. Its fetch call starts (ledgerCallCount
    // becomes 2) and hangs on `poll.promise`, unresolved.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500)
    })
    expect(ledgerCallCount).toBe(2)

    // Undo starts AFTER the poll — its own refresh is the newer request —
    // and resolves before the poll does.
    await act(async () => {
      await result.current.undo("entry-a")
    })
    expect(result.current.rows).toEqual([ROW_B])

    // Now let the slow, OLDER poll response land. Its stale snapshot must
    // not overwrite the newer rows the undo's own refresh already applied.
    await act(async () => {
      poll.resolve(jsonResponse({ entries: [ROW_A] }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.rows).toEqual([ROW_B])
  })
})

/**
 * P2-1 (codex review finding, 2026-08-20): the module doc comment claims
 * this hook polls on the SAME CLOCK as `useEditorBranches`, not just the
 * same interval NUMBER. A test that merely mounts both hooks together
 * and advances by exactly one `POLL_INTERVAL_MS` cannot tell the two
 * apart — two INDEPENDENT `setInterval(fn, 2500)` timers started at the
 * same instant fire together too, coincidentally, on their very first
 * tick. The only way to distinguish "one shared tick" from "two timers
 * that happen to agree" is to mount the hooks at DIFFERENT times and
 * check whether the second one's poll fires on the FIRST hook's next
 * tick (shared clock) or waits out its own full period from ITS OWN
 * mount time (independent clocks).
 */
describe("useEditorLedger — coordinated polling with useEditorBranches (P2-1)", () => {
  function branchesResponse() {
    return jsonResponse({
      ok: true,
      branches: [{ name: "main", current: true, isDefault: true }],
      current: "main",
      defaultBranch: "main",
      dirty: false,
      changes: [],
      ahead: 0,
      behind: 0,
      hasRemote: false,
      unpushed: false,
    })
  }

  it("fires useEditorBranches's next poll on useEditorLedger's tick, not on a full period from useEditorBranches's own later mount", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    editorFetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/editor/branches")) return branchesResponse()
      return jsonResponse({ entries: [ROW_A] })
    })

    const callsTo = (prefix: string) =>
      editorFetchMock.mock.calls.filter(([url]) => (url as string).startsWith(prefix)).length

    // Mount the ledger hook first — this is what starts the shared timer.
    const { result: ledgerResult } = renderHook(() => useEditorLedger())
    await waitFor(() => expect(ledgerResult.current.rows).toHaveLength(1))
    expect(callsTo("/api/editor/ledger")).toBe(1)

    // Let 1000ms of the ledger hook's cycle elapse BEFORE the branches
    // hook mounts, so the two hooks have different mount times — the
    // premise this test needs to actually discriminate the two designs.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    const { result: branchesResult } = renderHook(() => useEditorBranches())
    await waitFor(() => expect(branchesResult.current.current).toBe("main"))
    expect(callsTo("/api/editor/branches")).toBe(1)

    // Advance the REMAINING 1500ms — 2500ms total since the ledger hook's
    // mount, but only 1500ms since the branches hook's own mount. Under
    // independent per-hook timers, the branches hook's own countdown
    // would not complete until 2500ms after ITS mount (t=3500 on this
    // clock) — its poll would NOT have fired yet. Under one shared tick,
    // both hooks' callbacks fire together on the tick already running,
    // which lands at t=2500 regardless of when the second hook joined.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })

    await waitFor(() => expect(callsTo("/api/editor/ledger")).toBe(2))
    // The load-bearing assertion: this is the ONE that a same-period-but-
    // independent-timer implementation would fail — the branches poll
    // fires on the shared tick, 1500ms after ITS OWN mount, not 2500ms.
    expect(callsTo("/api/editor/branches")).toBe(2)
  })
})
