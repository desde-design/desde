import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const fetchMock = vi.fn()
vi.mock("@/lib/editor-fetch", () => ({
  editorFetch: (...args: unknown[]) => fetchMock(...args),
}))

import { useEditorChat } from "./useEditorChat"
import type { ChatTurn } from "@/editor/agent-chat/types"

/** A one-shot SSE Response streaming the given events as `data:` frames. */
function sseResponse(events: object[]): Response {
  const text = events.map((e) => `data:${JSON.stringify(e)}\n\n`).join("")
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  return { ok: true, body, text: async () => "" } as unknown as Response
}

const TURN_EVENTS = [
  { kind: "session", sessionId: "s1", projectId: "s1" },
  { kind: "turn_start", turnId: "turn-1" },
  { kind: "text_delta", turnId: "turn-1", delta: "hi there" },
  { kind: "turn_complete", turnId: "turn-1" },
]

/**
 * Focused tests for `hydrateFromTranscript` — the path the tab strip
 * uses on session switch to seed the chat pane from persisted turns.
 * Streaming + bridge handling are exercised by integration tests of
 * the chat panel against the SSE endpoint; this suite only covers
 * the pure ChatTurn → ChatMessage conversion shape so a future
 * change to the persisted format gets caught by a unit assertion.
 */
describe("useEditorChat.hydrateFromTranscript", () => {
  const baseOpts = {
    bridgeHandlers: {},
  }

  it("converts a single user/assistant turn into matching messages", () => {
    const turn: ChatTurn = {
      id: "turn-1",
      startedAt: "2026-05-26T00:00:00Z",
      userMessage: "hello",
      assistantContent: [{ type: "text", text: "hi there" }],
      toolResults: {},
      editProposals: [],
    }
    const { result } = renderHook(() => useEditorChat(baseOpts))
    act(() => {
      result.current.hydrateFromTranscript([turn])
    })
    expect(result.current.messages).toEqual([
      { kind: "user", id: "turn-1:user", text: "hello" },
      {
        kind: "assistant",
        id: "turn-1",
        blocks: [{ type: "text", text: "hi there" }],
      },
    ])
    expect(result.current.submitting).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it("merges tool_use blocks with their tool results", () => {
    const turn: ChatTurn = {
      id: "turn-1",
      startedAt: "2026-05-26T00:00:00Z",
      userMessage: "what's the page",
      assistantContent: [
        { type: "text", text: "Let me check." },
        {
          type: "tool_use",
          toolUseId: "tu-1",
          name: "get_page_info",
          input: {},
        },
      ],
      toolResults: {
        "tu-1": { ok: true, output: { route: "/" } },
      },
      editProposals: [],
    }
    const { result } = renderHook(() => useEditorChat(baseOpts))
    act(() => {
      result.current.hydrateFromTranscript([turn])
    })
    const assistant = result.current.messages[1]
    if (assistant.kind !== "assistant") {
      throw new Error("expected assistant message")
    }
    expect(assistant.blocks).toEqual([
      { type: "text", text: "Let me check." },
      {
        type: "tool_use",
        toolUseId: "tu-1",
        name: "get_page_info",
        input: {},
        result: { ok: true, output: { route: "/" } },
      },
    ])
  })

  it("preserves a failed tool result with its error reason", () => {
    const turn: ChatTurn = {
      id: "turn-1",
      startedAt: "2026-05-26T00:00:00Z",
      userMessage: "do a thing",
      assistantContent: [
        {
          type: "tool_use",
          toolUseId: "tu-1",
          name: "broken_tool",
          input: {},
        },
      ],
      toolResults: {
        "tu-1": { ok: false, error: "boom" },
      },
      editProposals: [],
    }
    const { result } = renderHook(() => useEditorChat(baseOpts))
    act(() => {
      result.current.hydrateFromTranscript([turn])
    })
    const assistant = result.current.messages[1]
    if (assistant.kind !== "assistant") throw new Error("expected assistant")
    const block = assistant.blocks[0]
    if (block.type !== "tool_use") throw new Error("expected tool_use")
    expect(block.result).toEqual({ ok: false, error: "boom" })
  })

  it("appends a trailing error message when the turn ended with error", () => {
    const turn: ChatTurn = {
      id: "turn-1",
      startedAt: "2026-05-26T00:00:00Z",
      userMessage: "x",
      assistantContent: [{ type: "text", text: "partial" }],
      toolResults: {},
      editProposals: [],
      error: "model returned error",
    }
    const { result } = renderHook(() => useEditorChat(baseOpts))
    act(() => {
      result.current.hydrateFromTranscript([turn])
    })
    expect(result.current.messages).toHaveLength(3)
    expect(result.current.messages[2]).toEqual({
      kind: "error",
      id: "turn-1:error",
      reason: "model returned error",
    })
  })

  it("replaces (does not append to) any existing messages", () => {
    const turnA: ChatTurn = {
      id: "ta",
      startedAt: "2026-05-26T00:00:00Z",
      userMessage: "first",
      assistantContent: [{ type: "text", text: "answer A" }],
      toolResults: {},
      editProposals: [],
    }
    const turnB: ChatTurn = {
      id: "tb",
      startedAt: "2026-05-26T00:00:00Z",
      userMessage: "second",
      assistantContent: [{ type: "text", text: "answer B" }],
      toolResults: {},
      editProposals: [],
    }
    const { result } = renderHook(() => useEditorChat(baseOpts))
    act(() => {
      result.current.hydrateFromTranscript([turnA])
    })
    expect(result.current.messages).toHaveLength(2)
    act(() => {
      result.current.hydrateFromTranscript([turnB])
    })
    // Replaced, not appended.
    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[0]).toMatchObject({ text: "second" })
  })

  it("renders a steered message as a user bubble where it was sent", () => {
    // The user typed this while the turn was running, after the first block of
    // the reply and before the second. Appending it at the end would show the
    // model answering a question the transcript has not asked yet.
    const turn: ChatTurn = {
      id: "turn-1",
      startedAt: "2026-08-14T00:00:00Z",
      userMessage: "fix the footer",
      assistantContent: [
        { type: "text", text: "looking at the footer" },
        { type: "text", text: "header updated too" },
      ],
      toolResults: {},
      editProposals: [],
      steers: [{ text: "also fix the header", afterAssistantBlocks: 1 }],
    }
    const { result } = renderHook(() => useEditorChat(baseOpts))
    act(() => {
      result.current.hydrateFromTranscript([turn])
    })
    expect(result.current.messages).toEqual([
      { kind: "user", id: "turn-1:user", text: "fix the footer" },
      {
        kind: "assistant",
        id: "turn-1",
        blocks: [{ type: "text", text: "looking at the footer" }],
      },
      { kind: "user", id: "turn-1:steer:0", text: "also fix the header" },
      {
        kind: "assistant",
        id: "turn-1:cont-1",
        blocks: [{ type: "text", text: "header updated too" }],
      },
    ])
  })

  it("keeps two steers in order and renders both", () => {
    const turn: ChatTurn = {
      id: "turn-1",
      startedAt: "2026-08-14T00:00:00Z",
      userMessage: "start",
      assistantContent: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
        { type: "text", text: "c" },
      ],
      toolResults: {},
      editProposals: [],
      steers: [
        { text: "one", afterAssistantBlocks: 1 },
        { text: "two", hadImages: true, afterAssistantBlocks: 2 },
      ],
    }
    const { result } = renderHook(() => useEditorChat(baseOpts))
    act(() => {
      result.current.hydrateFromTranscript([turn])
    })
    expect(
      result.current.messages.map((m) =>
        m.kind === "user"
          ? `user:${m.text}`
          : m.kind === "assistant"
            ? `assistant:${m.blocks.map((b) => (b.type === "text" ? b.text : b.type)).join(",")}`
            : m.kind,
      ),
    ).toEqual([
      "user:start",
      "assistant:a",
      "user:one",
      "assistant:b",
      "user:two",
      "assistant:c",
    ])
  })

  it("renders a steer that arrived before any reply, and one at the very end", () => {
    const turn: ChatTurn = {
      id: "turn-1",
      startedAt: "2026-08-14T00:00:00Z",
      userMessage: "start",
      assistantContent: [{ type: "text", text: "only block" }],
      toolResults: {},
      editProposals: [],
      steers: [
        { text: "before anything", afterAssistantBlocks: 0 },
        // Past the end: a steer the turn accepted after its last block. It
        // must still be shown — losing it here is the same loss as dropping
        // it on the wire.
        { text: "after everything", afterAssistantBlocks: 9 },
      ],
    }
    const { result } = renderHook(() => useEditorChat(baseOpts))
    act(() => {
      result.current.hydrateFromTranscript([turn])
    })
    expect(result.current.messages).toEqual([
      { kind: "user", id: "turn-1:user", text: "start" },
      { kind: "user", id: "turn-1:steer:0", text: "before anything" },
      {
        kind: "assistant",
        id: "turn-1",
        blocks: [{ type: "text", text: "only block" }],
      },
      { kind: "user", id: "turn-1:steer:1", text: "after everything" },
      // No `turn-1:cont-1` here. The steer is past the last block, so the
      // trailing segment would hold nothing, and an assistant message with
      // zero blocks renders as a blank bubble. RE-POINTED (not weakened): the
      // assertion still pins that the steer itself survives, which is the
      // loss this test guards. The live path suppresses the same empty tail,
      // so the two stay in agreement.
    ])
  })

  it("renders every assistant block exactly once even if positions go backwards", () => {
    // Defensive: a hand-edited or future-written session file cannot make the
    // renderer swallow content. Ordering may degrade; nothing may disappear.
    const turn: ChatTurn = {
      id: "turn-1",
      startedAt: "2026-08-14T00:00:00Z",
      userMessage: "start",
      assistantContent: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
      toolResults: {},
      editProposals: [],
      steers: [
        { text: "one", afterAssistantBlocks: 2 },
        { text: "two", afterAssistantBlocks: 0 },
      ],
    }
    const { result } = renderHook(() => useEditorChat(baseOpts))
    act(() => {
      result.current.hydrateFromTranscript([turn])
    })
    const texts = result.current.messages.flatMap((m) =>
      m.kind === "assistant"
        ? m.blocks.map((b) => (b.type === "text" ? b.text : b.type))
        : [],
    )
    expect(texts).toEqual(["a", "b"])
    const users = result.current.messages.filter((m) => m.kind === "user")
    expect(users).toHaveLength(3)
  })

  it("hydrates a turn with no steers field exactly as before", () => {
    // Old session files have no `steers`. They must render identically to the
    // way they did before the field existed — same ids included.
    const turn = JSON.parse(
      JSON.stringify({
        id: "turn-1",
        startedAt: "2026-05-26T00:00:00Z",
        userMessage: "hello",
        assistantContent: [{ type: "text", text: "hi there" }],
        toolResults: {},
        editProposals: [],
      }),
    ) as ChatTurn
    expect(turn.steers).toBeUndefined()
    const { result } = renderHook(() => useEditorChat(baseOpts))
    act(() => {
      result.current.hydrateFromTranscript([turn])
    })
    expect(result.current.messages).toEqual([
      { kind: "user", id: "turn-1:user", text: "hello" },
      {
        kind: "assistant",
        id: "turn-1",
        blocks: [{ type: "text", text: "hi there" }],
      },
    ])
  })

  it("clears messages when handed an empty turns array", () => {
    const { result } = renderHook(() => useEditorChat(baseOpts))
    act(() => {
      result.current.hydrateFromTranscript([
        {
          id: "t1",
          startedAt: "2026-05-26T00:00:00Z",
          userMessage: "x",
          assistantContent: [],
          toolResults: {},
          editProposals: [],
        },
      ])
      result.current.hydrateFromTranscript([])
    })
    expect(result.current.messages).toEqual([])
  })
})

/**
 * PR1 multi-session bucketing: messages live in per-session buckets so
 * background streams + tab switches don't clobber each other. These
 * tests exercise the bucket isolation directly through
 * `hydrateFromTranscript(turns, sessionId)` + `getVisibleSessionId` —
 * the SSE submission path is integration-tested elsewhere.
 */
describe("useEditorChat session bucketing", () => {
  const turnFor = (id: string, text: string): ChatTurn => ({
    id,
    startedAt: "2026-05-26T00:00:00Z",
    userMessage: text,
    assistantContent: [{ type: "text", text: `re: ${text}` }],
    toolResults: {},
    editProposals: [],
  })

  it("hydrates per-sessionId without clobbering other buckets", () => {
    let visible = "session-a"
    const { result, rerender } = renderHook(() =>
      useEditorChat({
        bridgeHandlers: {},
        getVisibleSessionId: () => visible,
      }),
    )

    // Hydrate session A while it's visible.
    act(() => {
      result.current.hydrateFromTranscript([turnFor("t1", "hello A")], "session-a")
    })
    expect(result.current.messages).toEqual([
      { kind: "user", id: "t1:user", text: "hello A" },
      {
        kind: "assistant",
        id: "t1",
        blocks: [{ type: "text", text: "re: hello A" }],
      },
    ])

    // Hydrate session B explicitly — A's bucket must stay intact.
    act(() => {
      result.current.hydrateFromTranscript([turnFor("t2", "hello B")], "session-b")
    })
    // Still viewing A, so the visible slice is unchanged.
    expect(result.current.messages[0]).toMatchObject({ text: "hello A" })

    // Flip the visible session — pane now reflects B.
    visible = "session-b"
    rerender()
    expect(result.current.messages[0]).toMatchObject({ text: "hello B" })

    // Flip back — A's messages were not lost.
    visible = "session-a"
    rerender()
    expect(result.current.messages[0]).toMatchObject({ text: "hello A" })
  })

  it("hasSessionBucket reports false until a bucket exists", () => {
    const visible: string | null = null
    const { result } = renderHook(() =>
      useEditorChat({
        bridgeHandlers: {},
        getVisibleSessionId: () => visible,
      }),
    )
    expect(result.current.hasSessionBucket("session-a")).toBe(false)
    act(() => {
      result.current.hydrateFromTranscript([turnFor("t1", "x")], "session-a")
    })
    expect(result.current.hasSessionBucket("session-a")).toBe(true)
    expect(result.current.hasSessionBucket("session-b")).toBe(false)
  })

  it("clearLocal scopes to the visible session only", () => {
    let visible = "session-a"
    const { result, rerender } = renderHook(() =>
      useEditorChat({
        bridgeHandlers: {},
        getVisibleSessionId: () => visible,
      }),
    )
    act(() => {
      result.current.hydrateFromTranscript([turnFor("t1", "A")], "session-a")
      result.current.hydrateFromTranscript([turnFor("t2", "B")], "session-b")
    })
    // Clear the visible (A) bucket.
    act(() => {
      result.current.clearLocal()
    })
    expect(result.current.messages).toEqual([])
    expect(result.current.hasSessionBucket("session-a")).toBe(false)
    // B is untouched.
    visible = "session-b"
    rerender()
    expect(result.current.messages[0]).toMatchObject({ text: "B" })
  })
})

/**
 * Task 6 — per-session `modelConfig` state. Lives on the same
 * per-session bucket as `messages`/`submitting`/`error` so it rides the
 * bucket re-key/carry machinery for free. `setModelConfig` writes the
 * VISIBLE bucket; the value sent with a turn is read from the turn's
 * PINNED bucket at submit time (via a `byId` ref, since `submit` is a
 * `useCallback` and can't read state directly without staling).
 */
describe("useEditorChat modelConfig", () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockImplementation(() => sseResponse(TURN_EVENTS))
  })

  it("setModelConfig writes to the visible bucket and submit sends it", async () => {
    const { result } = renderHook(() =>
      useEditorChat({
        bridgeHandlers: {},
        // Real callers (editor-surface.tsx) point both getters at the
        // same currentSessionId — mirror that here so the turn's pinned
        // bucket (from getChatSessionId) matches the bucket setModelConfig
        // wrote to (via getVisibleSessionId).
        getChatSessionId: () => "s1",
        getVisibleSessionId: () => "s1",
      }),
    )

    act(() => {
      result.current.setModelConfig({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        effort: "low",
      })
    })
    expect(result.current.modelConfig).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      effort: "low",
    })

    await act(async () => {
      await result.current.submit("hello")
    })

    const bodyRaw = fetchMock.mock.calls[0][1]?.body as string
    expect(JSON.parse(bodyRaw).modelConfig).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      effort: "low",
    })
  })

  it("submit omits modelConfig when unset", async () => {
    const { result } = renderHook(() =>
      useEditorChat({
        bridgeHandlers: {},
        getChatSessionId: () => "s1",
        getVisibleSessionId: () => "s1",
      }),
    )

    expect(result.current.modelConfig).toBeNull()

    await act(async () => {
      await result.current.submit("hello")
    })

    const bodyRaw = fetchMock.mock.calls[0][1]?.body as string
    expect("modelConfig" in JSON.parse(bodyRaw)).toBe(false)
  })

  it("seedModelConfig hydrates but does not clobber a user-set value", () => {
    const { result } = renderHook(() =>
      useEditorChat({
        bridgeHandlers: {},
        getVisibleSessionId: () => "s1",
      }),
    )

    act(() => {
      result.current.seedModelConfig("s1", {
        provider: "anthropic",
        model: "claude-haiku-4-5",
      })
    })
    expect(result.current.modelConfig).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    })

    act(() => {
      result.current.setModelConfig({
        provider: "anthropic",
        model: "claude-opus-4-8",
      })
      result.current.seedModelConfig("s1", {
        provider: "anthropic",
        model: "claude-haiku-4-5",
      })
    })
    expect(result.current.modelConfig).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
    })
  })

  it("the turn's pinned bucket config is sent even if the visible session changes mid-flight", async () => {
    let visible = "s1"
    const { result, rerender } = renderHook(() =>
      useEditorChat({
        bridgeHandlers: {},
        getChatSessionId: () => "s1",
        getVisibleSessionId: () => visible,
      }),
    )

    act(() => {
      result.current.setModelConfig({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      })
    })

    // Switch the visible session away from s1 before the turn's fetch
    // body is built — the config sent must still be s1's (the turn's
    // pinned bucket), not whatever the now-visible bucket holds.
    visible = "s2"
    rerender()

    await act(async () => {
      await result.current.submit("hello")
    })

    const bodyRaw = fetchMock.mock.calls[0][1]?.body as string
    expect(JSON.parse(bodyRaw).modelConfig).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    })
  })
})
