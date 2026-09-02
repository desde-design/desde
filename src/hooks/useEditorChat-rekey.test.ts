import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Regression coverage for the `session`-event bucket re-key gate
 * (`getSessionReKeyEnabled`).
 *
 * Branch mode is the default edit substrate, and in it detached-session
 * tracking is OFF: `getChatSessionId()` / `getVisibleSessionId()` return
 * `null` (→ SOLO_BUCKET) and `onSessionEvent()` is a no-op. The server still
 * emits a `session` SSE event first thing on every turn. Without the gate,
 * that event re-keys the active bucket from SOLO_BUCKET to the server id —
 * but nothing moves the visible pointer to follow, so the visible slice
 * keeps reading the now-empty SOLO_BUCKET and the entire conversation (user
 * bubble + streamed reply) silently vanishes. That was the "submit → nothing
 * happens" break. These tests drive the real SSE submit path.
 */

const fetchMock = vi.fn()
vi.mock("@/lib/editor-fetch", () => ({
  editorFetch: (...args: unknown[]) => fetchMock(...args),
}))

import { useEditorChat } from "./useEditorChat"

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

/** A minimal text-only turn: session → turn_start → text_delta → complete. */
const TURN_EVENTS = [
  { kind: "session", sessionId: "proj-1", projectId: "proj-1" },
  { kind: "turn_start", turnId: "turn-1" },
  { kind: "text_delta", turnId: "turn-1", delta: "hi there" },
  { kind: "turn_complete", turnId: "turn-1" },
]

describe("useEditorChat session re-key gate", () => {
  beforeEach(() => {
    fetchMock.mockImplementation(() => sseResponse(TURN_EVENTS))
  })
  afterEach(() => {
    fetchMock.mockReset()
  })

  it("keeps the conversation visible in solo/branch mode (re-key disabled)", async () => {
    const { result } = renderHook(() =>
      useEditorChat({
        bridgeHandlers: {},
        // Solo/branch mode: no session tracking, pointer never follows.
        getChatSessionId: () => null,
        getVisibleSessionId: () => null,
        onSessionEvent: () => {},
        getSessionReKeyEnabled: () => false,
      }),
    )

    await act(async () => {
      await result.current.submit("hello")
    })

    const kinds = result.current.messages.map((m) => m.kind)
    expect(kinds).toContain("user")
    expect(kinds).toContain("assistant")
    const assistant = result.current.messages.find((m) => m.kind === "assistant")
    expect(assistant).toMatchObject({
      blocks: [{ type: "text", text: "hi there" }],
    })
    expect(result.current.submitting).toBe(false)
  })

  it("(regression witness) orphans the conversation when re-key runs with no following pointer", async () => {
    const { result } = renderHook(() =>
      useEditorChat({
        bridgeHandlers: {},
        getChatSessionId: () => null,
        getVisibleSessionId: () => null, // never follows the re-key
        onSessionEvent: () => {}, // no-op, as in the disabled hook
        // getSessionReKeyEnabled omitted → defaults to true → re-key fires.
      }),
    )

    await act(async () => {
      await result.current.submit("hello")
    })

    // The pre-fix bug: the `session` event re-keyed the active bucket to
    // "proj-1", so every event AFTER it (the streamed assistant reply)
    // lands in a bucket the visible slice — still resolving to SOLO_BUCKET
    // — can't reach. The reply is silently lost ("nothing happens").
    const assistant = result.current.messages.find((m) => m.kind === "assistant")
    expect(assistant).toBeUndefined()
  })

  it("carries messages appended BEFORE the session event across the re-key", async () => {
    // The user's own prompt is appended the instant `submit` is called, which
    // is before the server has minted a sessionId. The re-key must bring it
    // along. It did not: the `setById` updater read the mutable `turnId`, and
    // React runs an updater at the NEXT render — by which time `turnId` had
    // already been reassigned to the server id, so the branch carried the
    // destination onto itself and left the prompt under the old key. The
    // streamed reply landed in the new bucket, so the pane showed an answer to
    // a question that was no longer on screen.
    let currentId: string | null = null
    const { result } = renderHook(() =>
      useEditorChat({
        bridgeHandlers: {},
        getChatSessionId: () => currentId,
        getVisibleSessionId: () => currentId,
        onSessionEvent: (id) => {
          currentId = id
        },
        getSessionReKeyEnabled: () => true,
      }),
    )

    await act(async () => {
      await result.current.submit("hello")
    })

    expect(
      result.current.messages.filter((m) => m.kind === "user").map((m) => m.text),
    ).toEqual(["hello"])
  })

  it("re-keys to the server id when the visible pointer follows (multi-session)", async () => {
    let currentId: string | null = null
    const { result } = renderHook(() =>
      useEditorChat({
        bridgeHandlers: {},
        getChatSessionId: () => currentId,
        getVisibleSessionId: () => currentId,
        onSessionEvent: (id) => {
          currentId = id
        },
        getSessionReKeyEnabled: () => true,
      }),
    )

    await act(async () => {
      await result.current.submit("hello")
    })

    const assistant = result.current.messages.find((m) => m.kind === "assistant")
    expect(assistant).toMatchObject({
      blocks: [{ type: "text", text: "hi there" }],
    })
  })
})
