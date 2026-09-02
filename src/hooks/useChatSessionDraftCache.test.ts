import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { useChatSessionDraftCache } from "./useChatSessionDraftCache"

describe("useChatSessionDraftCache", () => {
  it("returns empty draft and atBottom=true for an unknown sessionId", () => {
    const { result } = renderHook(() => useChatSessionDraftCache())
    expect(result.current.getDraft("unknown")).toBe("")
    expect(result.current.getAtBottom("unknown")).toBe(true)
  })

  it("scopes drafts per sessionId so different sessions don't bleed", () => {
    const { result } = renderHook(() => useChatSessionDraftCache())
    act(() => {
      result.current.setDraft("a", "hello from A")
      result.current.setDraft("b", "hello from B")
    })
    expect(result.current.getDraft("a")).toBe("hello from A")
    expect(result.current.getDraft("b")).toBe("hello from B")
  })

  it("stores the new-chat draft under a distinct null bucket", () => {
    const { result } = renderHook(() => useChatSessionDraftCache())
    act(() => {
      result.current.setDraft(null, "draft for new chat")
      result.current.setDraft("real-id", "draft for real session")
    })
    expect(result.current.getDraft(null)).toBe("draft for new chat")
    expect(result.current.getDraft("real-id")).toBe("draft for real session")
  })

  it("promotes the null-bucket draft to a real sessionId on first submit", () => {
    const { result } = renderHook(() => useChatSessionDraftCache())
    act(() => {
      result.current.setDraft(null, "carry-over draft")
    })
    act(() => {
      result.current.promoteNewBucket("session-123")
    })
    // The null bucket has been emptied so a fresh "new chat" starts blank.
    expect(result.current.getDraft(null)).toBe("")
    // The promoted draft is now keyed by the real sessionId.
    expect(result.current.getDraft("session-123")).toBe("carry-over draft")
  })

  it("promoteNewBucket is a no-op when there's nothing in the null bucket", () => {
    const { result } = renderHook(() => useChatSessionDraftCache())
    act(() => {
      result.current.setDraft("session-123", "existing draft")
      result.current.promoteNewBucket("session-123")
    })
    expect(result.current.getDraft("session-123")).toBe("existing draft")
  })

  it("forget drops a session's entry", () => {
    const { result } = renderHook(() => useChatSessionDraftCache())
    act(() => {
      result.current.setDraft("session-x", "draft")
      result.current.forget("session-x")
    })
    expect(result.current.getDraft("session-x")).toBe("")
  })

  it("tracks atBottom independently of draft", () => {
    const { result } = renderHook(() => useChatSessionDraftCache())
    act(() => {
      result.current.setDraft("s1", "typing…")
      result.current.setAtBottom("s1", false)
    })
    expect(result.current.getDraft("s1")).toBe("typing…")
    expect(result.current.getAtBottom("s1")).toBe(false)
  })

  it("evicts the least-recently-used entry past capacity", () => {
    const { result } = renderHook(() => useChatSessionDraftCache())
    // Cap is 32 in the implementation. Write 33 distinct sessions so
    // the very first one falls out. Touch the second-to-last just
    // before the overflow to confirm "least recently touched" wins
    // (not "first inserted").
    act(() => {
      for (let i = 0; i < 32; i++) {
        result.current.setDraft(`s${i}`, `draft-${i}`)
      }
      // Touch s0 so it's no longer the oldest.
      result.current.setDraft("s0", "touched")
      // Now overflow — s1 should be the LRU since we touched s0.
      result.current.setDraft("s32", "overflow")
    })
    expect(result.current.getDraft("s0")).toBe("touched")
    expect(result.current.getDraft("s32")).toBe("overflow")
    expect(result.current.getDraft("s1")).toBe("")
  })

  it("reads also promote the entry in LRU order (codex round-1 minor #1)", () => {
    const { result } = renderHook(() => useChatSessionDraftCache())
    act(() => {
      for (let i = 0; i < 32; i++) {
        result.current.setDraft(`s${i}`, `draft-${i}`)
      }
    })
    // Read s0 — its draft hasn't changed, but its LRU position should
    // be promoted to "most recent".
    expect(result.current.getDraft("s0")).toBe("draft-0")
    act(() => {
      // Now overflow. The LRU before this read-touch was s0; after
      // promotion, s1 should be the LRU and get evicted.
      result.current.setDraft("s32", "overflow")
    })
    expect(result.current.getDraft("s0")).toBe("draft-0")
    expect(result.current.getDraft("s1")).toBe("")
  })
})
