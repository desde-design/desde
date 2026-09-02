/**
 * Tests for useChatSessions — the Phase 3 shell-side state holder for
 * the detached chat sessions UI.
 *
 * Covers:
 *   - Initial mount triggers a fetch
 *   - Initial mount mints a session (opening lands in a NEW chat)
 *   - Fetch failure surfaces in `error`
 *   - onSessionEvent records the server-resolved id
 *   - onTurnComplete triggers a refetch
 *   - selectSession / newSession update currentSessionId
 *   - enabled: false makes the hook inert
 */

import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useChatSessions } from "./useChatSessions"

vi.mock("@/lib/editor-fetch", () => ({
  editorFetch: vi.fn(),
}))

import { editorFetch } from "@/lib/editor-fetch"

const editorFetchMock = editorFetch as ReturnType<typeof vi.fn>

function jsonResponse(body: unknown, init: Partial<Response> = {}): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    ...init,
  } as Response
}

beforeEach(() => {
  editorFetchMock.mockReset()
})

afterEach(() => {
  editorFetchMock.mockReset()
})

describe("useChatSessions", () => {
  it("triggers a fetch on mount and exposes the loaded session list", async () => {
    editorFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        sessions: [
          {
            sessionId: "a",
            projectId: "p",
            createdAt: "x",
            updatedAt: "y",
            turnCount: 1,
          },
        ],
      }),
    )
    const { result } = renderHook(() => useChatSessions())
    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1)
    })
    expect(result.current.sessions[0].sessionId).toBe("a")
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(editorFetchMock).toHaveBeenCalledWith(
      "/api/editor/chat/sessions",
      expect.objectContaining({ method: "GET" }),
    )
  })

  it("surfaces an HTTP-error response in `error`", async () => {
    editorFetchMock.mockResolvedValueOnce(
      jsonResponse(null, { ok: false, status: 500 }),
    )
    const { result } = renderHook(() => useChatSessions())
    await waitFor(() => {
      expect(result.current.error).toMatch(/HTTP 500/)
    })
    expect(result.current.sessions).toEqual([])
  })

  it("surfaces a network failure in `error`", async () => {
    editorFetchMock.mockRejectedValueOnce(new Error("offline"))
    const { result } = renderHook(() => useChatSessions())
    await waitFor(() => {
      expect(result.current.error).toMatch(/offline/)
    })
  })

  it("mints a session on mount so the first turn starts a NEW chat", async () => {
    // Inverted from "getChatSessionId returns null initially" when
    // opening a project stopped resuming the previous chat. Null is not
    // "no session" to the server — `chat-handler.ts` reads a missing
    // sessionId as the project's PERMANENT default session
    // (`body.sessionId ?? projectId`), so a blank pane used to resume a
    // month-old conversation on the user's first word. Minting on mount
    // is what makes the empty pane honest.
    editorFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        sessions: [
          {
            sessionId: "older",
            projectId: "p",
            createdAt: "x",
            updatedAt: "y",
            turnCount: 4,
          },
        ],
      }),
    )
    const { result } = renderHook(() => useChatSessions())
    await waitFor(() => expect(result.current.currentSessionId).not.toBeNull())
    // A fresh id, not the most recent persisted one.
    expect(result.current.currentSessionId).not.toBe("older")
    expect(result.current.currentSessionId).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(result.current.getChatSessionId()).toBe(
      result.current.currentSessionId,
    )
    // And it is marked as client-minted, so consumers know it has no
    // persisted record of its own.
    expect(result.current.currentSessionIsNew).toBe(true)
  })

  it("mints only once — a later render can't clobber the user's choice", async () => {
    editorFetchMock.mockResolvedValue(jsonResponse({ ok: true, sessions: [] }))
    const { result, rerender } = renderHook(() => useChatSessions())
    await waitFor(() => expect(result.current.currentSessionId).not.toBeNull())
    const minted = result.current.currentSessionId

    act(() => {
      result.current.selectSession("user-picked")
    })
    expect(result.current.currentSessionId).toBe("user-picked")

    rerender()
    await act(async () => {
      await result.current.refetch()
    })
    // Still the user's session — the mount mint is latched.
    expect(result.current.currentSessionId).toBe("user-picked")
    expect(result.current.currentSessionId).not.toBe(minted)
  })

  it("currentSessionIsNew is false for a session picked from the listing", async () => {
    // The flag is what tells a consumer it may fill an empty value (a
    // model choice) on the session's behalf. A persisted session must
    // never be treated that way: its own record is the authority.
    editorFetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, sessions: [] }),
    )
    const { result } = renderHook(() => useChatSessions())
    await waitFor(() => expect(result.current.currentSessionIsNew).toBe(true))
    act(() => {
      result.current.selectSession("persisted-1")
    })
    expect(result.current.currentSessionIsNew).toBe(false)
    // "+ New" mints again, so the flag comes back for that one.
    act(() => {
      result.current.newSession()
    })
    expect(result.current.currentSessionIsNew).toBe(true)
  })

  it("currentSessionIsNew goes false once the minted session is persisted", async () => {
    // The flag means "this chat has no record on disk", and consumers
    // read it as "it may inherit the project's model choice". Once the
    // session's first turn saves it, both stop being true. Leaving the
    // flag latched meant a chat that had been running for an hour was
    // still being offered another chat's model.
    //
    // The listing is the proof: a session that appears in it exists on
    // disk. Nothing else the client sees says that.
    editorFetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, sessions: [] }),
    )
    const { result } = renderHook(() => useChatSessions())
    await waitFor(() => expect(result.current.currentSessionIsNew).toBe(true))
    const minted = result.current.currentSessionId
    expect(minted).not.toBeNull()

    // The turn ran and the server saved it, so the post-stream refetch
    // comes back with the session in the listing.
    editorFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        sessions: [
          {
            sessionId: minted,
            projectId: "p",
            createdAt: "x",
            updatedAt: "y",
            turnCount: 1,
          },
        ],
      }),
    )
    act(() => {
      result.current.onStreamComplete()
    })

    await waitFor(() =>
      expect(result.current.currentSessionIsNew).toBe(false),
    )
    // Still the same chat — only the "is it new" claim changed.
    expect(result.current.currentSessionId).toBe(minted)

    // And "+ New" still mints a genuinely new one.
    act(() => {
      result.current.newSession()
    })
    expect(result.current.currentSessionIsNew).toBe(true)
    expect(result.current.currentSessionId).not.toBe(minted)
  })

  it("keeps currentSessionIsNew true when the listing is about someone else", async () => {
    // Guard against clearing on ANY refetch: the flag must only drop
    // when the listing names THIS session.
    editorFetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, sessions: [] }),
    )
    const { result } = renderHook(() => useChatSessions())
    await waitFor(() => expect(result.current.currentSessionIsNew).toBe(true))

    editorFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        sessions: [
          {
            sessionId: "somebody-else",
            projectId: "p",
            createdAt: "x",
            updatedAt: "y",
            turnCount: 3,
          },
        ],
      }),
    )
    await act(async () => {
      await result.current.refetch()
    })
    expect(result.current.currentSessionIsNew).toBe(true)
  })

  it("onSessionEvent records the server-resolved sessionId", async () => {
    editorFetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, sessions: [] }),
    )
    const { result } = renderHook(() => useChatSessions())
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => {
      result.current.onSessionEvent("new-sess-1", "proj-1")
    })
    expect(result.current.currentSessionId).toBe("new-sess-1")
    expect(result.current.getChatSessionId()).toBe("new-sess-1")
  })

  it("onSessionEvent is a no-op when the id is already current (avoids re-render)", async () => {
    editorFetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, sessions: [] }),
    )
    const { result } = renderHook(() => useChatSessions())
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => {
      result.current.onSessionEvent("sess-x", "p")
    })
    expect(result.current.currentSessionId).toBe("sess-x")
    // Second fire with the same id — currentSessionId already matches,
    // setter should not be called (we can't directly observe that, but
    // the value stays put).
    act(() => {
      result.current.onSessionEvent("sess-x", "p")
    })
    expect(result.current.currentSessionId).toBe("sess-x")
  })

  it("selectSession updates currentSessionId", async () => {
    editorFetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, sessions: [] }),
    )
    const { result } = renderHook(() => useChatSessions())
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => {
      result.current.selectSession("picked-id")
    })
    expect(result.current.currentSessionId).toBe("picked-id")
  })

  it("newSession swaps currentSessionId to a fresh id (NOT to null — codex round-1 #1)", async () => {
    // Pre-Phase-3 codex round-1, newSession() set currentSessionId to null.
    // That made the next submit omit sessionId, which the server resolves
    // to projectId — i.e. the legacy default session, NOT a fresh detached
    // one. The fix mints a real id here.
    editorFetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, sessions: [] }),
    )
    const { result } = renderHook(() => useChatSessions())
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => {
      result.current.selectSession("some-id")
    })
    expect(result.current.currentSessionId).toBe("some-id")
    act(() => {
      result.current.newSession()
    })
    expect(result.current.currentSessionId).not.toBeNull()
    expect(result.current.currentSessionId).not.toBe("some-id")
  })

  it("onStreamComplete triggers a refetch (renamed from onTurnComplete per codex round-1 #4)", async () => {
    editorFetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true, sessions: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          sessions: [
            {
              sessionId: "added",
              projectId: "p",
              createdAt: "x",
              updatedAt: "y",
              turnCount: 1,
            },
          ],
        }),
      )
    const { result } = renderHook(() => useChatSessions())
    await waitFor(() => expect(editorFetchMock).toHaveBeenCalledTimes(1))
    act(() => {
      result.current.onStreamComplete()
    })
    await waitFor(() => expect(editorFetchMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
  })

  it("refetch() can be invoked manually and re-loads the list", async () => {
    editorFetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true, sessions: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          sessions: [
            {
              sessionId: "z",
              projectId: "p",
              createdAt: "x",
              updatedAt: "y",
              turnCount: 1,
            },
          ],
        }),
      )
    const { result } = renderHook(() => useChatSessions())
    await waitFor(() => expect(editorFetchMock).toHaveBeenCalledTimes(1))
    await act(async () => {
      await result.current.refetch()
    })
    expect(editorFetchMock).toHaveBeenCalledTimes(2)
    expect(result.current.sessions[0].sessionId).toBe("z")
  })

  it("newSession mints a real UUID-shaped sessionId (codex round-1 #1 — null would resume default session)", async () => {
    editorFetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, sessions: [] }),
    )
    const { result } = renderHook(() => useChatSessions())
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => {
      result.current.newSession()
    })
    expect(result.current.currentSessionId).not.toBeNull()
    expect(result.current.currentSessionId).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    // Subsequent submits should resume this id, not be null again.
    expect(result.current.getChatSessionId()).toBe(result.current.currentSessionId)
  })

  it("each newSession() call mints a fresh distinct id", async () => {
    editorFetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, sessions: [] }),
    )
    const { result } = renderHook(() => useChatSessions())
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => {
      result.current.newSession()
    })
    const first = result.current.currentSessionId
    act(() => {
      result.current.newSession()
    })
    const second = result.current.currentSessionId
    expect(first).not.toBe(second)
    expect(second).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })

  it("concurrent refetches don't race: only the latest completion wins (codex round-1 #5)", async () => {
    // Set up: initial mount-fetch returns slow, manual refetch returns fast
    // with newer data. The latest (fast) request's body should be reflected
    // even though it RESOLVED before the slower initial-mount fetch.
    let resolveSlow!: (r: Response) => void
    const slowPromise = new Promise<Response>((res) => {
      resolveSlow = res
    })
    editorFetchMock
      .mockReturnValueOnce(slowPromise)
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          sessions: [
            {
              sessionId: "newer",
              projectId: "p",
              createdAt: "x",
              updatedAt: "y",
              turnCount: 1,
            },
          ],
        }),
      )
    const { result } = renderHook(() => useChatSessions())
    // The first fetch is in flight (slow). Trigger a manual refetch that
    // completes immediately.
    await act(async () => {
      await result.current.refetch()
    })
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    expect(result.current.sessions[0].sessionId).toBe("newer")
    // Now resolve the slow first fetch with STALE data. It must NOT
    // overwrite the fresh `newer` data.
    resolveSlow(
      jsonResponse({
        ok: true,
        sessions: [
          {
            sessionId: "stale",
            projectId: "p",
            createdAt: "x",
            updatedAt: "y",
            turnCount: 1,
          },
        ],
      }),
    )
    // Give the slow promise a tick to resolve internally.
    await new Promise((r) => setTimeout(r, 10))
    expect(result.current.sessions[0].sessionId).toBe("newer")
  })

  it("fires onSessionTransition for in-flight → idle, debounced", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      editorFetchMock
        // Mount fetch — session "a" is in-flight.
        .mockResolvedValueOnce(
          jsonResponse({
            ok: true,
            sessions: [
              {
                sessionId: "a",
                projectId: "p",
                createdAt: "x",
                updatedAt: "y1",
                turnCount: 1,
                status: "in-flight",
                firstUserMessagePreview: "Tweak button",
              },
            ],
          }),
        )
        // Stream-complete refetch — session "a" is now idle.
        .mockResolvedValueOnce(
          jsonResponse({
            ok: true,
            sessions: [
              {
                sessionId: "a",
                projectId: "p",
                createdAt: "x",
                updatedAt: "y2",
                turnCount: 2,
                status: "idle",
                firstUserMessagePreview: "Tweak button",
              },
            ],
          }),
        )
      const onTransition = vi.fn()
      const { result } = renderHook(() =>
        useChatSessions({
          onSessionTransition: onTransition,
          transitionDebounceMs: 100,
        }),
      )
      await waitFor(() => expect(result.current.sessions).toHaveLength(1))
      expect(onTransition).not.toHaveBeenCalled()
      act(() => {
        result.current.onStreamComplete()
      })
      await waitFor(() =>
        expect(result.current.sessions[0].status).toBe("idle"),
      )
      // No flush yet — within the debounce window.
      expect(onTransition).not.toHaveBeenCalled()
      // Advance past the window — flush fires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120)
      })
      expect(onTransition).toHaveBeenCalledTimes(1)
      expect(onTransition.mock.calls[0][0]).toEqual([
        { sessionId: "a", preview: "Tweak button", toStatus: "idle" },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("collapses multiple transitions within the debounce window into a single fire", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      editorFetchMock
        // Mount fetch — three in-flight.
        .mockResolvedValueOnce(
          jsonResponse({
            ok: true,
            sessions: [
              {
                sessionId: "a",
                projectId: "p",
                createdAt: "x",
                updatedAt: "1",
                turnCount: 1,
                status: "in-flight",
                firstUserMessagePreview: "Q1",
              },
              {
                sessionId: "b",
                projectId: "p",
                createdAt: "x",
                updatedAt: "1",
                turnCount: 1,
                status: "in-flight",
                firstUserMessagePreview: "Q2",
              },
              {
                sessionId: "c",
                projectId: "p",
                createdAt: "x",
                updatedAt: "1",
                turnCount: 1,
                status: "in-flight",
                firstUserMessagePreview: "Q3",
              },
            ],
          }),
        )
        // First completion — a is idle.
        .mockResolvedValueOnce(
          jsonResponse({
            ok: true,
            sessions: [
              { sessionId: "a", projectId: "p", createdAt: "x", updatedAt: "2", turnCount: 2, status: "idle", firstUserMessagePreview: "Q1" },
              { sessionId: "b", projectId: "p", createdAt: "x", updatedAt: "1", turnCount: 1, status: "in-flight", firstUserMessagePreview: "Q2" },
              { sessionId: "c", projectId: "p", createdAt: "x", updatedAt: "1", turnCount: 1, status: "in-flight", firstUserMessagePreview: "Q3" },
            ],
          }),
        )
        // Second completion — b is failed.
        .mockResolvedValueOnce(
          jsonResponse({
            ok: true,
            sessions: [
              { sessionId: "a", projectId: "p", createdAt: "x", updatedAt: "2", turnCount: 2, status: "idle", firstUserMessagePreview: "Q1" },
              { sessionId: "b", projectId: "p", createdAt: "x", updatedAt: "3", turnCount: 1, status: "failed", statusReason: "boom", firstUserMessagePreview: "Q2" },
              { sessionId: "c", projectId: "p", createdAt: "x", updatedAt: "1", turnCount: 1, status: "in-flight", firstUserMessagePreview: "Q3" },
            ],
          }),
        )
      const onTransition = vi.fn()
      const { result } = renderHook(() =>
        useChatSessions({
          onSessionTransition: onTransition,
          transitionDebounceMs: 100,
        }),
      )
      await waitFor(() => expect(result.current.sessions).toHaveLength(3))
      // First completion arrives.
      act(() => {
        result.current.onStreamComplete()
      })
      await waitFor(() =>
        expect(result.current.sessions[0].status).toBe("idle"),
      )
      // Within the window, second completion arrives — timer resets.
      act(() => {
        result.current.onStreamComplete()
      })
      await waitFor(() =>
        expect(result.current.sessions[1].status).toBe("failed"),
      )
      // No flush yet.
      expect(onTransition).not.toHaveBeenCalled()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120)
      })
      // One flush, batched into a single call.
      expect(onTransition).toHaveBeenCalledTimes(1)
      const transitions = onTransition.mock.calls[0][0] as Array<{
        sessionId: string
      }>
      expect(transitions.map((t) => t.sessionId).sort()).toEqual(["a", "b"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("does NOT fire transitions on the initial fetch (no in-flight baseline)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      editorFetchMock.mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          sessions: [
            {
              sessionId: "a",
              projectId: "p",
              createdAt: "x",
              updatedAt: "y",
              turnCount: 1,
              status: "idle",
            },
          ],
        }),
      )
      const onTransition = vi.fn()
      const { result } = renderHook(() =>
        useChatSessions({
          onSessionTransition: onTransition,
          transitionDebounceMs: 50,
        }),
      )
      await waitFor(() => expect(result.current.sessions).toHaveLength(1))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
      })
      expect(onTransition).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("drops pending transitions when the hook is disabled mid-debounce", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      editorFetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            ok: true,
            sessions: [
              {
                sessionId: "a",
                projectId: "p",
                createdAt: "x",
                updatedAt: "1",
                turnCount: 1,
                status: "in-flight",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            ok: true,
            sessions: [
              {
                sessionId: "a",
                projectId: "p",
                createdAt: "x",
                updatedAt: "2",
                turnCount: 2,
                status: "idle",
              },
            ],
          }),
        )
      const onTransition = vi.fn()
      let enabled = true
      const { result, rerender } = renderHook(
        ({ on }: { on: boolean }) =>
          useChatSessions({
            enabled: on,
            onSessionTransition: onTransition,
            transitionDebounceMs: 100,
          }),
        { initialProps: { on: enabled } },
      )
      await waitFor(() => expect(result.current.sessions).toHaveLength(1))
      act(() => {
        result.current.onStreamComplete()
      })
      await waitFor(() =>
        expect(result.current.sessions[0].status).toBe("idle"),
      )
      // Disable before the debounce flushes — pending transitions
      // should be dropped.
      enabled = false
      rerender({ on: enabled })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200)
      })
      expect(onTransition).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancels the pending flush on unmount", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      editorFetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            ok: true,
            sessions: [
              {
                sessionId: "a",
                projectId: "p",
                createdAt: "x",
                updatedAt: "1",
                turnCount: 1,
                status: "in-flight",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            ok: true,
            sessions: [
              {
                sessionId: "a",
                projectId: "p",
                createdAt: "x",
                updatedAt: "2",
                turnCount: 2,
                status: "idle",
              },
            ],
          }),
        )
      const onTransition = vi.fn()
      const { result, unmount } = renderHook(() =>
        useChatSessions({
          onSessionTransition: onTransition,
          transitionDebounceMs: 100,
        }),
      )
      await waitFor(() => expect(result.current.sessions).toHaveLength(1))
      act(() => {
        result.current.onStreamComplete()
      })
      await waitFor(() =>
        expect(result.current.sessions[0].status).toBe("idle"),
      )
      // Unmount before the flush would fire.
      unmount()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200)
      })
      expect(onTransition).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("fires onSessionTransition for a NEW session whose first refetch lands at terminal (codex round-1 #1)", async () => {
    // The previous detector-only path missed this: a brand-new
    // session never appears as `in-flight` in the listing baseline
    // because the only refetch that happens between submit and
    // stream-complete is the one fired BY stream-complete (which
    // observes the FINAL status). The local in-flight set, primed
    // by `onSessionEvent`, bridges that gap.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      editorFetchMock
        // Mount fetch — listing is empty.
        .mockResolvedValueOnce(jsonResponse({ ok: true, sessions: [] }))
        // Stream-complete refetch — the new session has already
        // terminated (status: idle) when we observe it.
        .mockResolvedValueOnce(
          jsonResponse({
            ok: true,
            sessions: [
              {
                sessionId: "new",
                projectId: "p",
                createdAt: "x",
                updatedAt: "y",
                turnCount: 1,
                status: "idle",
                firstUserMessagePreview: "Brand-new prompt",
              },
            ],
          }),
        )
      const onTransition = vi.fn()
      const { result } = renderHook(() =>
        useChatSessions({
          onSessionTransition: onTransition,
          transitionDebounceMs: 50,
        }),
      )
      await waitFor(() => expect(result.current.sessions).toHaveLength(0))
      // Simulate the chat hook receiving the `session` SSE event.
      act(() => {
        result.current.onSessionEvent("new", "p")
      })
      // Stream completes; listing now contains the (already-idle)
      // session.
      act(() => {
        result.current.onStreamComplete()
      })
      await waitFor(() => expect(result.current.sessions).toHaveLength(1))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(80)
      })
      expect(onTransition).toHaveBeenCalledTimes(1)
      expect(onTransition.mock.calls[0][0]).toEqual([
        { sessionId: "new", preview: "Brand-new prompt", toStatus: "idle" },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("retries that succeed within the debounce window flip the toast from failed to idle (codex round-1 #3)", async () => {
    // The scenario: session A fails, queues a 'failed' transition.
    // User immediately retries; the retry succeeds within the 1s
    // window. The retry's stream-complete refetch sees a 'failed'
    // → 'idle' transition, which the pure detector suppresses.
    // The pending entry would otherwise still be 'failed' and the
    // toast would lie. Deferring toStatus resolution to flush time
    // picks up the listing's truth (idle).
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      editorFetchMock
        // Mount — A is in-flight.
        .mockResolvedValueOnce(
          jsonResponse({
            ok: true,
            sessions: [
              {
                sessionId: "a",
                projectId: "p",
                createdAt: "x",
                updatedAt: "1",
                turnCount: 1,
                status: "in-flight",
                firstUserMessagePreview: "Q",
              },
            ],
          }),
        )
        // First stream-complete — A failed.
        .mockResolvedValueOnce(
          jsonResponse({
            ok: true,
            sessions: [
              {
                sessionId: "a",
                projectId: "p",
                createdAt: "x",
                updatedAt: "2",
                turnCount: 1,
                status: "failed",
                statusReason: "boom",
                firstUserMessagePreview: "Q",
              },
            ],
          }),
        )
        // Second stream-complete — A succeeded on retry. Detector
        // sees failed → idle, suppresses. But the local in-flight
        // set has 'a' from the retry's onSessionEvent.
        .mockResolvedValueOnce(
          jsonResponse({
            ok: true,
            sessions: [
              {
                sessionId: "a",
                projectId: "p",
                createdAt: "x",
                updatedAt: "3",
                turnCount: 2,
                status: "idle",
                firstUserMessagePreview: "Q",
              },
            ],
          }),
        )
      const onTransition = vi.fn()
      const { result } = renderHook(() =>
        useChatSessions({
          onSessionTransition: onTransition,
          transitionDebounceMs: 100,
        }),
      )
      await waitFor(() => expect(result.current.sessions).toHaveLength(1))
      // First completion.
      act(() => {
        result.current.onStreamComplete()
      })
      await waitFor(() =>
        expect(result.current.sessions[0].status).toBe("failed"),
      )
      // Retry — onSessionEvent re-arms local in-flight before the
      // next completion arrives.
      act(() => {
        result.current.onSessionEvent("a", "p")
      })
      act(() => {
        result.current.onStreamComplete()
      })
      await waitFor(() =>
        expect(result.current.sessions[0].status).toBe("idle"),
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120)
      })
      // One fire, and the toStatus is `idle` (the final observed
      // state), not the stale `failed`.
      expect(onTransition).toHaveBeenCalledTimes(1)
      expect(onTransition.mock.calls[0][0]).toEqual([
        { sessionId: "a", preview: "Q", toStatus: "idle" },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("invalidates an in-flight fetch when disabled before the response resolves (codex round-1 #2)", async () => {
    // Race: refetch is in flight, hook is disabled, then re-enabled
    // before the original fetch resolves. Without `fetchGenRef`
    // being bumped on disable, the original fetch's response would
    // pass both gen and enabled checks and overwrite
    // `prevSessionsRef` with stale data — fouling the next
    // detector run.
    let resolveFirst!: (r: Response) => void
    const firstPromise = new Promise<Response>((res) => {
      resolveFirst = res
    })
    editorFetchMock
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          sessions: [
            {
              sessionId: "post-enable",
              projectId: "p",
              createdAt: "x",
              updatedAt: "1",
              turnCount: 1,
              status: "idle",
            },
          ],
        }),
      )
    let enabled = true
    const { result, rerender } = renderHook(
      ({ on }: { on: boolean }) =>
        useChatSessions({
          enabled: on,
          transitionDebounceMs: 50,
        }),
      { initialProps: { on: enabled } },
    )
    // Toggle off, then back on, while the first fetch is still
    // pending.
    enabled = false
    rerender({ on: enabled })
    enabled = true
    rerender({ on: enabled })
    // Wait for the re-enable fetch to land.
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    expect(result.current.sessions[0].sessionId).toBe("post-enable")
    // Now resolve the stale first fetch with data that would
    // overwrite the listing if the guards didn't fire.
    resolveFirst(
      jsonResponse({
        ok: true,
        sessions: [
          {
            sessionId: "stale-pre-disable",
            projectId: "p",
            createdAt: "x",
            updatedAt: "0",
            turnCount: 1,
            status: "idle",
          },
        ],
      }),
    )
    // Allow microtasks / pending then() to run.
    await new Promise((r) => setTimeout(r, 10))
    // The post-enable listing must NOT be overwritten by the stale
    // fetch — verifies fetchGenRef was bumped on disable.
    expect(result.current.sessions.map((s) => s.sessionId)).toEqual([
      "post-enable",
    ])
  })

  it("enabled: false makes the hook inert — no fetch, no state changes", async () => {
    const { result } = renderHook(() => useChatSessions({ enabled: false }))
    // No fetch.
    expect(editorFetchMock).not.toHaveBeenCalled()
    // And no mount mint: with detached sessions off, a null sessionId
    // resolving to the project's default session IS the correct legacy
    // single-chat behaviour.
    expect(result.current.currentSessionId).toBeNull()
    expect(result.current.currentSessionIsNew).toBe(false)
    // Setters are no-ops.
    act(() => {
      result.current.selectSession("nope")
      result.current.onSessionEvent("nope", "p")
    })
    expect(result.current.currentSessionId).toBeNull()
    expect(result.current.getChatSessionId()).toBeNull()
    // Even an explicit refetch is a no-op when disabled.
    await act(async () => {
      await result.current.refetch()
    })
    expect(editorFetchMock).not.toHaveBeenCalled()
  })
})
