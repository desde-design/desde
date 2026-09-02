import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * Regression coverage for streamed-delta coalescing (audit Task 25).
 *
 * `useEditorChat` buffers `text_delta` / `reasoning_delta` events and
 * commits them in one state update per ~DELTA_FLUSH_INTERVAL_MS window
 * instead of one per token, so a long streamed reply doesn't re-render the
 * whole editor surface hundreds of times.
 *
 * Everything the buffer could plausibly break is pinned here:
 *   1. assembled text is byte-identical to the concatenated deltas;
 *   2. a non-delta event (tool_use_start) can't overtake buffered text;
 *   3. text/reasoning interleaving keeps its block boundaries;
 *   4. an abort mid-stream still lands what streamed before it;
 *   5. two concurrent sessions never cross-contaminate buckets;
 *   6. a stall after a burst can't strand the tail of the burst — the
 *      trailing flush makes it visible without any further event.
 *
 * The pre-change fixtures (`useEditorChat-rekey`,
 * `useEditorChat-hydration`) are single-delta turns and pass under ANY
 * buffering scheme, so they can't catch a coalescing regression.
 */

const fetchMock = vi.fn()
vi.mock("@/lib/editor-fetch", () => ({
  editorFetch: (...args: unknown[]) => fetchMock(...args),
}))

import { useEditorChat, type ChatMessage } from "./useEditorChat"

/** Mirrors DELTA_FLUSH_INTERVAL_MS in useEditorChat. */
const FLUSH_INTERVAL_MS = 50

type Block = { type: string; text?: string; name?: string }

const encoder = new TextEncoder()
const frame = (e: object): Uint8Array =>
  encoder.encode(`data:${JSON.stringify(e)}\n\n`)

/**
 * An SSE Response that yields to the event loop between events, so the
 * consumer's `for await` processes them across separate macrotasks (as it
 * does in the browser) rather than draining one synchronous chunk.
 */
function pacedSseResponse(events: object[], gapMs = 0): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const e of events) {
        await new Promise((r) => setTimeout(r, gapMs))
        controller.enqueue(frame(e))
      }
      controller.close()
    },
  })
  return { ok: true, body, text: async () => "" } as unknown as Response
}

function renderChat(overrides: Record<string, unknown> = {}) {
  return renderHook(() =>
    useEditorChat({
      bridgeHandlers: {},
      getChatSessionId: () => null,
      getVisibleSessionId: () => null,
      onSessionEvent: () => {},
      getSessionReKeyEnabled: () => false,
      ...overrides,
    }),
  )
}

function assistantBlocks(messages: ChatMessage[]): Block[] {
  const assistant = messages.find((m) => m.kind === "assistant")
  if (!assistant || assistant.kind !== "assistant") return []
  return assistant.blocks as unknown as Block[]
}

afterEach(() => {
  fetchMock.mockReset()
})

describe("useEditorChat — streamed-delta coalescing", () => {
  it("assembles 120 deltas byte-identically into a single text block", async () => {
    const deltas = Array.from({ length: 120 }, (_, i) => `tok${i} `)
    fetchMock.mockImplementation(() =>
      pacedSseResponse([
        { kind: "turn_start", turnId: "turn-1" },
        ...deltas.map((delta) => ({
          kind: "text_delta",
          turnId: "turn-1",
          delta,
        })),
        { kind: "turn_complete", turnId: "turn-1" },
      ]),
    )

    const { result } = renderChat()
    await act(async () => {
      await result.current.submit("hello")
    })

    const blocks = assistantBlocks(result.current.messages)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe("text")
    expect(blocks[0].text).toBe(deltas.join(""))
  })

  it("never lets a tool block overtake buffered text", async () => {
    fetchMock.mockImplementation(() =>
      pacedSseResponse([
        { kind: "turn_start", turnId: "turn-1" },
        { kind: "text_delta", turnId: "turn-1", delta: "before" },
        { kind: "text_delta", turnId: "turn-1", delta: "-more" },
        {
          kind: "tool_use_start",
          turnId: "turn-1",
          toolUseId: "tu-1",
          name: "Read",
          input: { file_path: "a.vue" },
        },
        { kind: "text_delta", turnId: "turn-1", delta: "after" },
        { kind: "turn_complete", turnId: "turn-1" },
      ]),
    )

    const { result } = renderChat()
    await act(async () => {
      await result.current.submit("hello")
    })

    const blocks = assistantBlocks(result.current.messages)
    expect(blocks.map((b) => b.type)).toEqual(["text", "tool_use", "text"])
    expect(blocks[0].text).toBe("before-more")
    expect(blocks[1].name).toBe("Read")
    expect(blocks[2].text).toBe("after")
  })

  it("preserves reasoning/text block boundaries when they interleave", async () => {
    fetchMock.mockImplementation(() =>
      pacedSseResponse([
        { kind: "turn_start", turnId: "turn-1" },
        { kind: "reasoning_delta", turnId: "turn-1", delta: "think1 " },
        { kind: "reasoning_delta", turnId: "turn-1", delta: "think2" },
        { kind: "text_delta", turnId: "turn-1", delta: "say" },
        { kind: "reasoning_delta", turnId: "turn-1", delta: "think3" },
        { kind: "turn_complete", turnId: "turn-1" },
      ]),
    )

    const { result } = renderChat()
    await act(async () => {
      await result.current.submit("hello")
    })

    const blocks = assistantBlocks(result.current.messages)
    expect(blocks.map((b) => b.type)).toEqual(["reasoning", "text", "reasoning"])
    expect(blocks[0].text).toBe("think1 think2")
    expect(blocks[1].text).toBe("say")
    expect(blocks[2].text).toBe("think3")
  })

  it("keeps buffered text when the user aborts mid-stream", async () => {
    // A stream that emits two deltas then hangs, so the abort lands with
    // text still in the buffer. Erroring the body on `abort` mirrors what
    // fetch does to a live response: the pending `reader.read()` rejects
    // with an AbortError rather than hanging forever.
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          init.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"))
          })
          controller.enqueue(frame({ kind: "turn_start", turnId: "turn-1" }))
          controller.enqueue(
            frame({ kind: "text_delta", turnId: "turn-1", delta: "partial" }),
          )
          await new Promise((r) => setTimeout(r, 5))
          controller.enqueue(
            frame({ kind: "text_delta", turnId: "turn-1", delta: "-tail" }),
          )
          // Never closes — the abort tears it down.
        },
      })
      return { ok: true, body, text: async () => "" } as unknown as Response
    })

    const { result } = renderChat()
    await act(async () => {
      const pending = result.current.submit("hello")
      await new Promise((r) => setTimeout(r, 30))
      result.current.abort()
      await pending
    })

    const blocks = assistantBlocks(result.current.messages)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe("partial-tail")
    expect(result.current.submitting).toBe(false)
  })

  it("keeps two concurrently streaming sessions in their own buckets", async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { sessionId?: string }
      const tag = body.sessionId === "s-a" ? "A" : "B"
      return pacedSseResponse([
        { kind: "turn_start", turnId: `turn-${tag}` },
        { kind: "text_delta", turnId: `turn-${tag}`, delta: `${tag}1` },
        { kind: "text_delta", turnId: `turn-${tag}`, delta: `${tag}2` },
        { kind: "turn_complete", turnId: `turn-${tag}` },
      ])
    })

    // Both turns are pinned at submit time; the visible pointer is moved
    // afterwards to read each bucket.
    let submitAs = "s-a"
    let visible = "s-a"
    const { result, rerender } = renderHook(() =>
      useEditorChat({
        bridgeHandlers: {},
        getChatSessionId: () => submitAs,
        getVisibleSessionId: () => visible,
        onSessionEvent: () => {},
        getSessionReKeyEnabled: () => false,
      }),
    )

    await act(async () => {
      const a = result.current.submit("hello A")
      submitAs = "s-b"
      const b = result.current.submit("hello B")
      await Promise.all([a, b])
    })

    visible = "s-a"
    rerender()
    expect(assistantBlocks(result.current.messages)[0].text).toBe("A1A2")

    visible = "s-b"
    rerender()
    expect(assistantBlocks(result.current.messages)[0].text).toBe("B1B2")
  })

  it("flushes a stalled burst on the trailing edge, with no further event", async () => {
    // Six deltas arrive back-to-back (only the first clears the leading-edge
    // gap gate), then the stream stalls. Without the trailing flush the tail
    // of the burst stays invisible for the whole pause.
    let stallController: ReadableStreamDefaultController<Uint8Array> | null =
      null
    fetchMock.mockImplementation(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stallController = controller
          controller.enqueue(frame({ kind: "turn_start", turnId: "turn-1" }))
          for (let i = 0; i < 6; i++) {
            controller.enqueue(
              frame({ kind: "text_delta", turnId: "turn-1", delta: `x${i}` }),
            )
          }
          // Deliberately left open — the stall.
        },
      })
      return { ok: true, body, text: async () => "" } as unknown as Response
    })

    const { result } = renderChat()
    let pending: Promise<void>
    await act(async () => {
      pending = result.current.submit("hello")
      // Let the consumer drain the six buffered deltas.
      await new Promise((r) => setTimeout(r, 10))
    })

    // Leading edge committed the first delta only; the rest are buffered.
    expect(assistantBlocks(result.current.messages)[0].text).toBe("x0")

    // Wait out the trailing-flush window WITHOUT emitting anything else.
    await act(async () => {
      await new Promise((r) => setTimeout(r, FLUSH_INTERVAL_MS + 20))
    })

    expect(assistantBlocks(result.current.messages)[0].text).toBe(
      "x0x1x2x3x4x5",
    )

    await act(async () => {
      stallController?.close()
      await pending!
    })
  })
})
