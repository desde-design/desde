import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

const fetchMock = vi.fn()
vi.mock("@/lib/editor-fetch", () => ({
  editorFetch: (...args: unknown[]) => fetchMock(...args),
}))

import { useEditorChat } from "./useEditorChat"
import type { ChatTurn } from "@/editor/agent-chat/types"

/**
 * `dismissMessage` — the handler behind the status banners' X.
 *
 * Banners are transient UI, not transcript entries, so dismissal is purely
 * local to the visible session's bucket and nothing is persisted. These tests
 * seed state through `hydrateFromTranscript` (the same public path the tab
 * strip uses) rather than adding a test-only seam.
 */
describe("useEditorChat.dismissMessage", () => {
  const baseOpts = { bridgeHandlers: {} }

  /** A turn whose `error` produces a dismissible `error` status message. */
  function failedTurn(id: string, reason: string): ChatTurn {
    return {
      id,
      startedAt: "2026-08-07T00:00:00Z",
      userMessage: `ask ${id}`,
      assistantContent: [],
      toolResults: {},
      editProposals: [],
      error: reason,
    } as ChatTurn
  }

  it("removes only the targeted message", () => {
    const { result } = renderHook(() => useEditorChat(baseOpts))
    act(() => {
      result.current.hydrateFromTranscript([
        failedTurn("turn-1", "first boom"),
        failedTurn("turn-2", "second boom"),
      ])
    })

    const errorsBefore = result.current.messages.filter(
      (m) => m.kind === "error",
    )
    expect(errorsBefore).toHaveLength(2)

    act(() => result.current.dismissMessage(errorsBefore[0]!.id))

    const errorsAfter = result.current.messages.filter(
      (m) => m.kind === "error",
    )
    expect(errorsAfter.map((m) => m.id)).toEqual([errorsBefore[1]!.id])
  })

  it("leaves conversational messages untouched", () => {
    const { result } = renderHook(() => useEditorChat(baseOpts))
    act(() => {
      result.current.hydrateFromTranscript([failedTurn("turn-1", "boom")])
    })

    const errorId = result.current.messages.find((m) => m.kind === "error")!.id
    const userCountBefore = result.current.messages.filter(
      (m) => m.kind === "user",
    ).length

    act(() => result.current.dismissMessage(errorId))

    expect(result.current.messages.filter((m) => m.kind === "user")).toHaveLength(
      userCountBefore,
    )
    expect(result.current.messages.some((m) => m.kind === "error")).toBe(false)
  })

  it("is a no-op for an unknown id", () => {
    const { result } = renderHook(() => useEditorChat(baseOpts))
    act(() => {
      result.current.hydrateFromTranscript([failedTurn("turn-1", "boom")])
    })
    const before = result.current.messages.map((m) => m.id)

    act(() => result.current.dismissMessage("nope-not-here"))

    expect(result.current.messages.map((m) => m.id)).toEqual(before)
  })
})
