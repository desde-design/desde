import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Coverage for chat steering — sending a message INTO a running turn — and in
 * particular for the pending-steer ledger, which is where the no-loss
 * guarantee lives.
 *
 * The guarantee cannot live on the server. Its `resubmit_required` report
 * travels on the owning turn's SSE stream, and the likeliest way a steer dies
 * unconsumed is Stop — which closes that stream (`SseStream.send` starts with
 * `if (closed) return false` and drops the frame). So the single most likely
 * loss path is exactly the path where the server cannot tell us. The client
 * survives its own Stop, so the client holds the payload.
 *
 * "STOP mid-turn resubmits the steer" is therefore THE test for the whole
 * design, not one case among many.
 */

const fetchMock = vi.fn()
vi.mock("@/lib/editor-fetch", () => ({
  editorFetch: (...args: unknown[]) => fetchMock(...args),
}))

import type { ChatTurn } from "@/editor/agent-chat/types"
import {
  useEditorChat,
  type ChatMessage,
  type UseEditorChatOptions,
} from "./useEditorChat"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface LiveStream {
  response: Response
  /** Enqueue one SSE frame. */
  push(event: object): void
  /** End the stream normally — the server's reconciliation ran. */
  close(): void
  /** Kill the stream, as a real aborted fetch does. */
  fail(err: Error): void
}

/** An SSE Response whose frames this test pushes by hand, mid-turn. */
function liveSse(): LiveStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  const encoder = new TextEncoder()
  return {
    response: { ok: true, body, text: async () => "" } as unknown as Response,
    push(event) {
      controller.enqueue(encoder.encode(`data:${JSON.stringify(event)}\n\n`))
    },
    close() {
      controller.close()
    },
    fail(err) {
      controller.error(err)
    },
  }
}

/** A one-shot SSE Response that delivers `events` and ends cleanly. */
function completedSse(events: object[]): Response {
  const text = events.map((e) => `data:${JSON.stringify(e)}\n\n`).join("")
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  return { ok: true, body, text: async () => "" } as unknown as Response
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

/** A turn that streams nothing and ends — enough for a resubmit to complete. */
function silentTurn(id: string): Response {
  return completedSse([
    { kind: "turn_start", turnId: id },
    { kind: "turn_complete", turnId: id },
  ])
}

/** An abort rejection in the shape a real cancelled fetch produces. */
function abortError(): Error {
  const err = new Error("The operation was aborted")
  err.name = "AbortError"
  return err
}

const chatResponses: Response[] = []
const steerResponses: Array<Response | Error> = []

/** Let queued microtasks + the stream reader make progress. */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function callsTo(url: string): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([u]) => u === url)
    .map(([, init]) => JSON.parse((init as { body: string }).body) as Record<string, unknown>)
}

const chatCalls = (): Array<Record<string, unknown>> => callsTo("/api/editor/chat")
const steerCalls = (): Array<Record<string, unknown>> => callsTo("/api/editor/chat/steer")

/** Solo/branch-mode wiring: no session tracking, one bucket. */
const soloOptions: UseEditorChatOptions = {
  bridgeHandlers: {},
  getChatSessionId: () => null,
  getVisibleSessionId: () => null,
  onSessionEvent: () => {},
  getSessionReKeyEnabled: () => false,
}

const SESSION_EVENT = { kind: "session", sessionId: "s1", projectId: "p1" }

beforeEach(() => {
  chatResponses.length = 0
  steerResponses.length = 0
  fetchMock.mockImplementation((url: string) => {
    if (url === "/api/editor/chat/steer") {
      const next = steerResponses.shift() ?? jsonResponse(200, { accepted: true })
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
    }
    if (url === "/api/editor/chat") {
      const next = chatResponses.shift()
      if (!next) return Promise.reject(new Error("unexpected extra POST /api/editor/chat"))
      return Promise.resolve(next)
    }
    // bridge-reply / edit-ack are fire-and-forget; nothing in these turns emits them.
    return Promise.resolve(jsonResponse(200, { ok: true }))
  })
})

afterEach(() => {
  fetchMock.mockReset()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useEditorChat.steer", () => {
  it("posts to the steer route and shows the user's message immediately", async () => {
    const turn = liveSse()
    chatResponses.push(turn.response)
    const { result } = renderHook(() => useEditorChat(soloOptions))

    let running!: Promise<void>
    await act(async () => {
      running = result.current.submit("first")
      await settle()
    })
    await act(async () => {
      turn.push(SESSION_EVENT)
      turn.push({ kind: "turn_start", turnId: "t1" })
      await settle()
    })

    await act(async () => {
      await result.current.steer("second")
    })

    // The sessionId comes from the `session` event — solo mode never knows one
    // otherwise, and the steer route refuses to default one.
    expect(steerCalls()).toEqual([{ sessionId: "s1", userMessage: "second" }])
    expect(
      result.current.messages.filter((m) => m.kind === "user").map((m) => m.text),
    ).toEqual(["first", "second"])

    await act(async () => {
      turn.push({ kind: "turn_complete", turnId: "t1" })
      turn.close()
      await running
    })

    // Accepted + the stream closed cleanly, so the server's reconciliation ran
    // and said nothing about it: confirmed consumed, never resent.
    expect(chatCalls()).toHaveLength(1)
  })

  it("resubmits as a normal turn when the steer is not accepted", async () => {
    const turn = liveSse()
    chatResponses.push(turn.response, silentTurn("t2"))
    steerResponses.push(jsonResponse(409, { accepted: false, reason: "no-live-turn" }))
    const { result } = renderHook(() => useEditorChat(soloOptions))

    let running!: Promise<void>
    await act(async () => {
      running = result.current.submit("first")
      await settle()
    })
    await act(async () => {
      turn.push(SESSION_EVENT)
      await settle()
    })
    await act(async () => {
      await result.current.steer("second")
    })

    // Still nothing resent: the turn is live, and submitting into it would
    // abort the very turn we are reading.
    expect(chatCalls()).toHaveLength(1)

    await act(async () => {
      turn.close()
      await running
    })

    expect(chatCalls().map((c) => c.userMessage)).toEqual(["first", "second"])
    // One bubble for one thing the user typed — the resubmit must not append a
    // second copy of a message that is already on screen.
    expect(
      result.current.messages.filter((m) => m.kind === "user").map((m) => m.text),
    ).toEqual(["first", "second"])
  })

  it("resubmits when the steer request fails outright", async () => {
    const turn = liveSse()
    chatResponses.push(turn.response, silentTurn("t2"))
    steerResponses.push(new Error("network down"))
    const { result } = renderHook(() => useEditorChat(soloOptions))

    let running!: Promise<void>
    await act(async () => {
      running = result.current.submit("first")
      await settle()
    })
    await act(async () => {
      turn.push(SESSION_EVENT)
      await settle()
    })
    await act(async () => {
      await result.current.steer("second")
      turn.close()
      await running
    })

    expect(chatCalls().map((c) => c.userMessage)).toEqual(["first", "second"])
  })

  it("resubmits an accepted steer when the user hits Stop (the server can never report this)", async () => {
    const turn = liveSse()
    chatResponses.push(turn.response, silentTurn("t2"))
    const { result } = renderHook(() => useEditorChat(soloOptions))

    let running!: Promise<void>
    await act(async () => {
      running = result.current.submit("first")
      await settle()
    })
    await act(async () => {
      turn.push(SESSION_EVENT)
      turn.push({ kind: "turn_start", turnId: "t1" })
      await settle()
    })
    await act(async () => {
      await result.current.steer("second")
    })
    expect(steerCalls()).toHaveLength(1)

    // Stop. The stream dies here, so `resubmit_required` for this steer is
    // written into a closed stream and dropped on the server side — nothing
    // about this message's fate can ever reach us over the wire.
    await act(async () => {
      result.current.abort()
      turn.fail(abortError())
      await running
    })

    expect(chatCalls().map((c) => c.userMessage)).toEqual(["first", "second"])
    // A user cancellation is not an error, and the resubmit is not a failure.
    expect(result.current.messages.some((m) => m.kind === "error")).toBe(false)
  })

  it("resubmits two steers in order, one at a time", async () => {
    const turn = liveSse()
    const firstResubmit = liveSse()
    chatResponses.push(turn.response, firstResubmit.response, silentTurn("t3"))
    steerResponses.push(
      jsonResponse(409, { accepted: false, reason: "no-live-turn" }),
      jsonResponse(409, { accepted: false, reason: "no-live-turn" }),
    )
    const { result } = renderHook(() => useEditorChat(soloOptions))

    let running!: Promise<void>
    await act(async () => {
      running = result.current.submit("first")
      await settle()
    })
    await act(async () => {
      turn.push(SESSION_EVENT)
      await settle()
    })
    await act(async () => {
      await result.current.steer("one")
      await result.current.steer("two")
    })

    await act(async () => {
      turn.close()
      await settle()
    })

    // Only the FIRST resubmit has been sent — its turn is still streaming.
    // Sending both now would abort the first, because submit() cancels an
    // in-flight turn on the same bucket.
    expect(chatCalls().map((c) => c.userMessage)).toEqual(["first", "one"])

    await act(async () => {
      firstResubmit.close()
      await running
    })

    expect(chatCalls().map((c) => c.userMessage)).toEqual(["first", "one", "two"])
  })

  it("resubmits a steer the turn reported as unaccounted for", async () => {
    const turn = liveSse()
    chatResponses.push(turn.response, silentTurn("t2"))
    const { result } = renderHook(() => useEditorChat(soloOptions))

    let running!: Promise<void>
    await act(async () => {
      running = result.current.submit("first")
      await settle()
    })
    await act(async () => {
      turn.push(SESSION_EVENT)
      await settle()
    })
    await act(async () => {
      await result.current.steer("second")
    })

    // The turn accepted it but could not show the model read it.
    await act(async () => {
      turn.push({
        kind: "resubmit_required",
        sessionId: "s1",
        userMessage: "second",
      })
      await settle()
    })
    // Reported mid-stream, but not resent until the turn is over.
    expect(chatCalls()).toHaveLength(1)

    await act(async () => {
      turn.close()
      await running
    })

    expect(chatCalls().map((c) => c.userMessage)).toEqual(["first", "second"])
  })

  it("adopts a resubmit_required for a steer this client never sent", async () => {
    const turn = liveSse()
    chatResponses.push(turn.response, silentTurn("t2"))
    const { result } = renderHook(() => useEditorChat(soloOptions))

    let running!: Promise<void>
    await act(async () => {
      running = result.current.submit("first")
      await settle()
    })
    await act(async () => {
      turn.push(SESSION_EVENT)
      // Typed in another tab: this client has no ledger entry and no bubble.
      turn.push({
        kind: "resubmit_required",
        sessionId: "s1",
        userMessage: "from another tab",
      })
      turn.close()
      await running
    })

    expect(chatCalls().map((c) => c.userMessage)).toEqual(["first", "from another tab"])
    // No bubble existed for it, so the resubmit has to draw one.
    expect(
      result.current.messages.filter((m) => m.kind === "user").map((m) => m.text),
    ).toEqual(["first", "from another tab"])
  })

  it("steers the session that owns the running turn, not the visible one", async () => {
    let visible = "B"
    const turn = liveSse()
    chatResponses.push(turn.response)
    const { result, rerender } = renderHook(() =>
      useEditorChat({
        bridgeHandlers: {},
        // The turn (and therefore the steer) belongs to A; the user is looking
        // at B's tab.
        getChatSessionId: () => "A",
        getVisibleSessionId: () => visible,
        onSessionEvent: () => {},
        getSessionReKeyEnabled: () => false,
      }),
    )

    let running!: Promise<void>
    await act(async () => {
      running = result.current.submit("first")
      await settle()
    })
    await act(async () => {
      turn.push({ kind: "session", sessionId: "A", projectId: "p1" })
      await settle()
    })
    await act(async () => {
      await result.current.steer("second")
    })

    expect(steerCalls()).toEqual([{ sessionId: "A", userMessage: "second" }])
    // Nothing landed in the visible tab.
    expect(result.current.messages).toHaveLength(0)

    visible = "A"
    rerender()
    expect(
      result.current.messages.filter((m) => m.kind === "user").map((m) => m.text),
    ).toEqual(["first", "second"])

    await act(async () => {
      turn.close()
      await running
    })
  })

  it("carries the ledger across a session re-key", async () => {
    let currentId: string | null = null
    const turn = liveSse()
    chatResponses.push(turn.response, silentTurn("t2"))
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

    let running!: Promise<void>
    await act(async () => {
      running = result.current.submit("first")
      await settle()
    })

    // Steered BEFORE the server minted the session id, so the entry is filed
    // under the provisional bucket. Without the carry it would be stranded
    // there and no sweep would ever reach it.
    await act(async () => {
      await result.current.steer("second")
    })
    expect(steerCalls()).toHaveLength(0) // no sessionId to steer with yet

    await act(async () => {
      turn.push(SESSION_EVENT)
      await settle()
    })
    await act(async () => {
      turn.close()
      await running
    })

    expect(chatCalls().map((c) => c.userMessage)).toEqual(["first", "second"])
    expect(
      result.current.messages.filter((m) => m.kind === "user").map((m) => m.text),
    ).toEqual(["first", "second"])
  })

  // The `steered` event exists so a client reading the transcript can show a
  // steer it did not send — otherwise it renders an answer to a question it
  // never saw. It must not double the bubble for the client that DID send it.
  it("draws a bubble for a steered event this client never sent", async () => {
    const turn = liveSse()
    chatResponses.push(turn.response)
    const { result } = renderHook(() => useEditorChat(soloOptions))

    let running!: Promise<void>
    await act(async () => {
      running = result.current.submit("first")
      await settle()
    })
    await act(async () => {
      turn.push(SESSION_EVENT)
      turn.push({ kind: "turn_start", turnId: "t1" })
      turn.push({ kind: "text_delta", turnId: "t1", delta: "before" })
      // Typed in ANOTHER tab; this client's ledger knows nothing about it.
      turn.push({
        kind: "steered",
        sessionId: "s1",
        userMessage: "from another tab",
        imageCount: 0,
      })
      turn.push({ kind: "text_delta", turnId: "t1", delta: "after" })
      await settle()
    })
    await act(async () => {
      turn.push({ kind: "turn_complete", turnId: "t1" })
      turn.close()
      await running
    })

    expect(
      result.current.messages.filter((m) => m.kind === "user").map((m) => m.text),
    ).toEqual(["first", "from another tab"])
    // The reply is cut at the bubble, exactly as a locally-sent steer cuts it,
    // so the question is shown before the answer to it.
    expect(
      result.current.messages
        .filter((m) => m.kind === "assistant")
        .map((m) => m.blocks.map((b) => (b.type === "text" ? b.text : b.type))),
    ).toEqual([["before"], ["after"]])
  })

  it("does not duplicate the bubble for a steer this client sent itself", async () => {
    const turn = liveSse()
    chatResponses.push(turn.response)
    const { result } = renderHook(() => useEditorChat(soloOptions))

    let running!: Promise<void>
    await act(async () => {
      running = result.current.submit("first")
      await settle()
    })
    await act(async () => {
      turn.push(SESSION_EVENT)
      turn.push({ kind: "turn_start", turnId: "t1" })
      await settle()
    })
    await act(async () => {
      await result.current.steer("second")
    })
    // The server echoes the steer back on the owning turn's stream — which is
    // this same client's stream.
    await act(async () => {
      turn.push({
        kind: "steered",
        sessionId: "s1",
        userMessage: "second",
        imageCount: 0,
      })
      await settle()
    })
    await act(async () => {
      turn.push({ kind: "turn_complete", turnId: "t1" })
      turn.close()
      await running
    })

    expect(
      result.current.messages.filter((m) => m.kind === "user").map((m) => m.text),
    ).toEqual(["first", "second"])
  })

  // `steered` carries text and no id, so identical texts cannot be told apart.
  // The tie is broken towards showing the message, never towards hiding it.
  it("shows a second identical steer from another client rather than swallowing it", async () => {
    const turn = liveSse()
    chatResponses.push(turn.response)
    const { result } = renderHook(() => useEditorChat(soloOptions))

    let running!: Promise<void>
    await act(async () => {
      running = result.current.submit("first")
      await settle()
    })
    await act(async () => {
      turn.push(SESSION_EVENT)
      turn.push({ kind: "turn_start", turnId: "t1" })
      await settle()
    })
    await act(async () => {
      await result.current.steer("yes")
    })
    await act(async () => {
      // This client's own steer, echoed…
      turn.push({ kind: "steered", sessionId: "s1", userMessage: "yes", imageCount: 0 })
      // …then the SAME word typed in another tab.
      turn.push({ kind: "steered", sessionId: "s1", userMessage: "yes", imageCount: 0 })
      await settle()
    })
    await act(async () => {
      turn.push({ kind: "turn_complete", turnId: "t1" })
      turn.close()
      await running
    })

    expect(
      result.current.messages.filter((m) => m.kind === "user").map((m) => m.text),
    ).toEqual(["first", "yes", "yes"])
  })

  // A re-key DURING a resubmit used to start a second, nested sweep on the new
  // bucket: the sweep marker was keyed by bucket id and was not carried across,
  // so the resubmitted turn's `finally` saw an unmarked bucket. The outer sweep
  // still held the ledger entry (it only clears after `runSubmit` returns), so
  // the nested sweep sent the same message again. MEASURED before the fix:
  // three POSTs, the third carrying `sessionId: "s1"`.
  it("does not resubmit a steer twice when the resubmitted turn re-keys the bucket", async () => {
    let currentId: string | null = null
    const turn = liveSse()
    // The FIRST turn never emits `session` — that is what leaves the bucket
    // provisional so the resubmit is the turn that re-keys it. A third
    // response is queued so the bug produces an assertable extra call rather
    // than a rejected fetch.
    chatResponses.push(
      turn.response,
      completedSse([
        { kind: "session", sessionId: "s1", projectId: "p1" },
        { kind: "turn_start", turnId: "t2" },
        { kind: "turn_complete", turnId: "t2" },
      ]),
      silentTurn("t3"),
    )
    steerResponses.push(jsonResponse(409, { accepted: false, reason: "no-live-turn" }))
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

    let running!: Promise<void>
    await act(async () => {
      running = result.current.submit("first")
      await settle()
    })
    await act(async () => {
      await result.current.steer("second")
    })
    await act(async () => {
      turn.close()
      await running
      await settle()
    })

    expect(chatCalls().map((c) => c.userMessage)).toEqual(["first", "second"])
    // One bubble per thing the user typed, in the bucket the turn re-keyed to.
    expect(
      result.current.messages.filter((m) => m.kind === "user").map((m) => m.text),
    ).toEqual(["first", "second"])
  })

  it("keeps an image-only steer resubmittable with its images", async () => {
    const turn = liveSse()
    chatResponses.push(turn.response, silentTurn("t2"))
    steerResponses.push(jsonResponse(409, { accepted: false, reason: "no-live-turn" }))
    const image = "data:image/png;base64,AAAA"
    const { result } = renderHook(() => useEditorChat(soloOptions))

    let running!: Promise<void>
    await act(async () => {
      running = result.current.submit("first")
      await settle()
    })
    await act(async () => {
      turn.push(SESSION_EVENT)
      await settle()
    })
    await act(async () => {
      await result.current.steer("", [image])
      turn.close()
      await running
    })

    expect(chatCalls()[1]).toEqual({ userMessage: "", images: [image] })
    // An image-only message must never render as a blank bubble.
    expect(
      result.current.messages.filter((m) => m.kind === "user").map((m) => m.text),
    ).toEqual(["first", "📎 1 image"])
  })

  // D1 — the sweep must resubmit into the session that OWNS the steer, not
  // into whatever session the user has switched to by the time it fires.
  it("resubmits a swept steer into its owning session, not the visible one", async () => {
    // Production wiring: BOTH callbacks follow the tab the user is on.
    let current = "A"
    const turn = liveSse()
    chatResponses.push(turn.response, silentTurn("t2"))
    steerResponses.push(jsonResponse(409, { accepted: false, reason: "no-live-turn" }))
    const { result, rerender } = renderHook(() =>
      useEditorChat({
        bridgeHandlers: {},
        getChatSessionId: () => current,
        getVisibleSessionId: () => current,
        onSessionEvent: () => {},
        getSessionReKeyEnabled: () => true,
      }),
    )

    let running!: Promise<void>
    await act(async () => {
      running = result.current.submit("first")
      await settle()
    })
    await act(async () => {
      turn.push({ kind: "session", sessionId: "A", projectId: "p1" })
      await settle()
    })
    // Typed while looking at A; refused, so the end-of-turn sweep must resend it.
    await act(async () => {
      await result.current.steer("second")
    })

    // The user switches to B before A's turn ends.
    current = "B"
    rerender()

    await act(async () => {
      turn.close()
      await running
    })

    // The resubmit belongs to A — posted with A's sessionId…
    expect(chatCalls().map((c) => c.sessionId)).toEqual(["A", "A"])
    // …and nothing of it landed in B's thread.
    expect(result.current.messages).toHaveLength(0)
    // The bubble is in A, where the user typed it.
    current = "A"
    rerender()
    expect(
      result.current.messages.filter((m) => m.kind === "user").map((m) => m.text),
    ).toEqual(["first", "second"])
  })

  // D2 — on Stop the server still holds the per-session turn lock, so the
  // first resubmit 409s. The entry must survive that and be retried, because
  // removing it on attempt is what made the failure terminal.
  it("retries a resubmit that 409s on the turn lock instead of dropping it", async () => {
    vi.useFakeTimers()
    try {
      const turn = liveSse()
      chatResponses.push(
        turn.response,
        // First resubmit: the lock is still held.
        jsonResponse(409, { error: "turn in flight" }),
        // Retry after backoff: the lock cleared.
        silentTurn("t2"),
      )
      const { result } = renderHook(() => useEditorChat(soloOptions))

      let running!: Promise<void>
      await act(async () => {
        running = result.current.submit("first")
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => {
        turn.push(SESSION_EVENT)
        turn.push({ kind: "turn_start", turnId: "t1" })
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => {
        await result.current.steer("second")
      })

      // Stop — the exact path the ledger exists for.
      await act(async () => {
        result.current.abort()
        turn.fail(abortError())
        await vi.advanceTimersByTimeAsync(0)
        await vi.advanceTimersByTimeAsync(0)
      })
      // The first resubmit went out and was refused with 409.
      expect(chatCalls().map((c) => c.userMessage)).toEqual(["first", "second"])

      // Advance past the first backoff step: the retry delivers it. This is
      // the entry-stays-in-the-ledger-until-acceptance assertion in observable
      // form — a dropped entry would have nothing left to retry.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })
      expect(chatCalls().map((c) => c.userMessage)).toEqual([
        "first",
        "second",
        "second",
      ])
      // A retried 409 that then succeeds is not a failure — no banner.
      expect(result.current.messages.some((m) => m.kind === "error")).toBe(false)
      await act(async () => {
        await running
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // D2b — the bounded retry giving up must surface the text, never drop it.
  it("surfaces the user's text when the bounded 409 retries are exhausted", async () => {
    vi.useFakeTimers()
    try {
      const turn = liveSse()
      chatResponses.push(turn.response)
      // Initial attempt + every retry is refused.
      for (let i = 0; i < 6; i++) {
        chatResponses.push(jsonResponse(409, { error: "turn in flight" }))
      }
      const { result } = renderHook(() => useEditorChat(soloOptions))

      let running!: Promise<void>
      await act(async () => {
        running = result.current.submit("first")
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => {
        turn.push(SESSION_EVENT)
        turn.push({ kind: "turn_start", turnId: "t1" })
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => {
        await result.current.steer("please add a footer")
      })
      await act(async () => {
        result.current.abort()
        turn.fail(abortError())
        await vi.advanceTimersByTimeAsync(0)
        await vi.advanceTimersByTimeAsync(0)
      })

      // Walk through the full backoff schedule (kept in sync by the final
      // no-more-attempts assertion below, which fails loudly if it drifts).
      for (const delayMs of [500, 1000, 2000, 4000, 8000]) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(delayMs)
        })
      }
      // 1 original turn + 6 refused resubmit attempts.
      expect(chatCalls()).toHaveLength(7)
      // No further retry is ever scheduled.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(chatCalls()).toHaveLength(7)
      // The failure is visible and carries the user's text, so it is
      // recoverable by hand. Never a silent drop.
      const errors = result.current.messages.filter((m) => m.kind === "error")
      expect(errors.length).toBeGreaterThan(0)
      expect(errors.some((e) => e.reason.includes("please add a footer"))).toBe(true)
      await act(async () => {
        await running
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // D2 re-entrancy companion: a retry timer must not outlive an unmount.
  it("cancels a pending resubmit retry when the hook unmounts", async () => {
    vi.useFakeTimers()
    try {
      const turn = liveSse()
      chatResponses.push(
        turn.response,
        jsonResponse(409, { error: "turn in flight" }),
      )
      const { result, unmount } = renderHook(() => useEditorChat(soloOptions))

      let running!: Promise<void>
      await act(async () => {
        running = result.current.submit("first")
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => {
        turn.push(SESSION_EVENT)
        turn.push({ kind: "turn_start", turnId: "t1" })
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => {
        await result.current.steer("second")
      })
      await act(async () => {
        result.current.abort()
        turn.fail(abortError())
        await vi.advanceTimersByTimeAsync(0)
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(chatCalls()).toHaveLength(2)

      unmount()
      // The backoff window elapses after unmount: nothing may fire.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(chatCalls()).toHaveLength(2)
      await running
    } finally {
      vi.useRealTimers()
    }
  })

  // D3 — a mid-stream steer renders below the assistant text that preceded it
  // and above what follows, and the live order equals the re-hydrated order.
  // Both orders are asserted in ONE test so the two paths can never drift
  // apart again.
  // A steer typed after the model's last block leaves an assistant segment
  // with nothing in it — `turn_complete` opens the segment, and hydration
  // slices an empty tail at the same position. Both used to render a blank
  // assistant bubble under the user's text.
  it("renders no empty assistant bubble for a steer at the very end, live or hydrated", async () => {
    const turn = liveSse()
    chatResponses.push(turn.response, silentTurn("t2"))
    steerResponses.push(jsonResponse(409, { accepted: false, reason: "no-live-turn" }))
    const { result } = renderHook(() => useEditorChat(soloOptions))

    let running!: Promise<void>
    await act(async () => {
      running = result.current.submit("first")
      await settle()
    })
    await act(async () => {
      turn.push(SESSION_EVENT)
      turn.push({ kind: "turn_start", turnId: "t1" })
      turn.push({ kind: "text_delta", turnId: "t1", delta: "all of it" })
      await settle()
    })
    // Typed after the model's last block. Refused, so it also goes back out as
    // its own turn — which is what puts a SECOND user bubble on screen.
    await act(async () => {
      await result.current.steer("one more thing")
    })
    await act(async () => {
      turn.push({ kind: "turn_complete", turnId: "t1" })
      turn.close()
      await running
    })

    const shape = (messages: readonly ChatMessage[]) =>
      messages.map((m) =>
        m.kind === "user"
          ? { kind: "user", text: m.text }
          : m.kind === "assistant"
            ? {
                kind: "assistant",
                texts: m.blocks.map((b) => (b.type === "text" ? b.text : b.type)),
              }
            : { kind: m.kind },
      )

    // No `{ kind: "assistant", texts: [] }` anywhere.
    const live = shape(result.current.messages)
    expect(live).toEqual([
      { kind: "user", text: "first" },
      { kind: "assistant", texts: ["all of it"] },
      { kind: "user", text: "one more thing" },
    ])

    // The same conversation as the server persisted it: one turn whose steer
    // sits past the last block, then the resubmitted turn.
    act(() => {
      result.current.hydrateFromTranscript([
        {
          id: "t1",
          startedAt: "2026-08-14T00:00:00.000Z",
          userMessage: "first",
          assistantContent: [{ type: "text", text: "all of it" }],
          toolResults: {},
          editProposals: [],
          steers: [{ text: "one more thing", afterAssistantBlocks: 1 }],
        },
      ])
    })
    // Byte-for-byte the live list: the two paths agree, and neither shows an
    // empty assistant bubble.
    expect(shape(result.current.messages)).toEqual(live)
  })

  it("orders a mid-stream steer the same live and after re-hydrate", async () => {
    const turn = liveSse()
    chatResponses.push(turn.response)
    const { result } = renderHook(() => useEditorChat(soloOptions))

    let running!: Promise<void>
    await act(async () => {
      running = result.current.submit("first")
      await settle()
    })
    await act(async () => {
      turn.push(SESSION_EVENT)
      turn.push({ kind: "turn_start", turnId: "t1" })
      turn.push({ kind: "text_delta", turnId: "t1", delta: "before" })
      await settle()
    })
    await act(async () => {
      await result.current.steer("mid-turn steer")
      // The frame an accepted steer ALWAYS produces: the route pushes the
      // message onto the turn's channel and announces it on the same stream in
      // the next statement, and the runtime stamps the steer's persisted
      // position at that instant. The assistant-message cut is taken from this
      // frame, not from `steer()`, so that the live split and the recorded
      // position are one moment rather than two. Omitting it here modelled a
      // steer the server never acknowledged.
      turn.push({
        kind: "steered",
        sessionId: "s1",
        userMessage: "mid-turn steer",
        imageCount: 0,
      })
      await settle()
    })
    await act(async () => {
      turn.push({ kind: "text_delta", turnId: "t1", delta: "after" })
      await settle()
    })
    await act(async () => {
      turn.push({ kind: "turn_complete", turnId: "t1" })
      turn.close()
      await running
    })

    // Content-shape view: ids differ between the live and hydrated user
    // bubbles by construction, so compare kinds + text content.
    const shape = (messages: readonly ChatMessage[]) =>
      messages.map((m) =>
        m.kind === "user"
          ? { kind: "user", text: m.text }
          : m.kind === "assistant"
            ? {
                kind: "assistant",
                texts: m.blocks.map((b) => (b.type === "text" ? b.text : b.type)),
              }
            : { kind: m.kind },
      )

    const live = shape(result.current.messages)
    expect(live).toEqual([
      { kind: "user", text: "first" },
      { kind: "assistant", texts: ["before"] },
      { kind: "user", text: "mid-turn steer" },
      { kind: "assistant", texts: ["after"] },
    ])
    // The live segment ids must be the ones hydration will mint for the same
    // turn, or a re-hydrate would re-key every rendered message.
    expect(
      result.current.messages
        .filter((m) => m.kind === "assistant")
        .map((m) => m.id),
    ).toEqual(["t1", "t1:cont-1"])

    // Re-hydrate the SAME conversation from its persisted form.
    const persisted: ChatTurn = {
      id: "t1",
      startedAt: "2026-08-14T00:00:00.000Z",
      userMessage: "first",
      assistantContent: [
        { type: "text", text: "before" },
        { type: "text", text: "after" },
      ],
      toolResults: {},
      editProposals: [],
      steers: [{ text: "mid-turn steer", afterAssistantBlocks: 1 }],
    }
    act(() => {
      result.current.hydrateFromTranscript([persisted])
    })
    expect(shape(result.current.messages)).toEqual(live)
    expect(
      result.current.messages
        .filter((m) => m.kind === "assistant")
        .map((m) => m.id),
    ).toEqual(["t1", "t1:cont-1"])
  })
})

/**
 * The resend indicator — `resendingSteers`.
 *
 * The ledger's recovery after Stop is correct and was completely invisible.
 * Measured live: about 25 seconds between the user pressing Stop and the agent
 * answering the steered message, with nothing on screen for any of it, because
 * the first resubmit 409s on the server's still-held turn lock and the retry
 * backs off. The person watching had BUILT the ledger and still read the
 * silence as the ledger failing.
 *
 * So these tests are about one thing: while a resend is happening, the hook has
 * to say so, and when it stops happening it has to stop saying so.
 */
describe("useEditorChat.resendingSteers", () => {
  /**
   * Start a turn, steer into it, then Stop — the state the ledger exists for.
   *
   * Hands the turn's still-pending promise back INSIDE an object. Returning it
   * bare would make this `async` function await it, and it does not settle
   * until the resubmit the caller is about to inspect has already finished.
   */
  async function steerThenStop(
    result: { current: ReturnType<typeof useEditorChat> },
    text: string,
  ): Promise<{ running: Promise<void> }> {
    const turn = liveSse()
    chatResponses.unshift(turn.response)
    let running!: Promise<void>
    await act(async () => {
      running = result.current.submit("first")
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      turn.push(SESSION_EVENT)
      turn.push({ kind: "turn_start", turnId: "t1" })
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      await result.current.steer(text)
    })
    await act(async () => {
      result.current.abort()
      turn.fail(abortError())
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
    })
    return { running }
  }

  it("reports a steer whose resubmit 409'd, while the backoff is still waiting", async () => {
    vi.useFakeTimers()
    try {
      chatResponses.push(
        // First resubmit: the server still holds the turn lock.
        jsonResponse(409, { error: "turn in flight" }),
        // The retry lands.
        silentTurn("t2"),
      )
      const { result } = renderHook(() => useEditorChat(soloOptions))
      const { running } = await steerThenStop(result, "second")

      // The 409 has come back and the backoff is running. This window is the
      // one that used to be silent, and it is where the spinner belongs.
      expect(result.current.resendingSteers).toEqual([
        { id: expect.any(String), text: "second", attempt: 1 },
      ])

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })
      await act(async () => {
        await running
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("increments the attempt number across retries", async () => {
    vi.useFakeTimers()
    try {
      chatResponses.push(
        jsonResponse(409, { error: "turn in flight" }),
        jsonResponse(409, { error: "turn in flight" }),
        silentTurn("t2"),
      )
      const { result } = renderHook(() => useEditorChat(soloOptions))
      const { running } = await steerThenStop(result, "second")

      expect(result.current.resendingSteers.map((s) => s.attempt)).toEqual([1])

      // Past the first backoff step: attempt 2 goes out and is refused too.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })
      expect(result.current.resendingSteers.map((s) => s.attempt)).toEqual([2])
      // The text stays attached to the row across retries — it is what the
      // user needs to recognise which message is being recovered.
      expect(result.current.resendingSteers[0].text).toBe("second")

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100)
      })
      await act(async () => {
        await running
      })
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * THE regression test for the indicator outliving what it reports.
   *
   * This test used to end the resubmitted turn with `silentTurn()`, whose
   * stream closes in the same tick it opens. That made the
   * accepted-but-still-running window ZERO WIDE, so the assertion below passed
   * against code that only cleared the mark when the whole turn ended — which
   * is exactly the defect. A fixture that cannot exhibit the bug is not
   * coverage, so the resubmit now gets a turn that STAYS OPEN and streams,
   * which is what a real recovered turn does.
   *
   * What the defect looked like: the row saying "resending, the previous turn
   * ended before this could be confirmed" sat on screen for the whole
   * recovered turn, immediately above the agent's streaming answer to that
   * very message.
   */
  it("stops reporting a resend the moment the server accepts it, not when the resent turn ends", async () => {
    vi.useFakeTimers()
    try {
      const resent = liveSse()
      chatResponses.push(
        jsonResponse(409, { error: "turn in flight" }),
        // The retry is accepted and then keeps streaming, like a real turn.
        resent.response,
      )
      const { result } = renderHook(() => useEditorChat(soloOptions))
      const { running } = await steerThenStop(result, "use 12px not 8px")
      expect(result.current.resendingSteers).toHaveLength(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })

      // Accepted. The turn is still open and has streamed nothing yet, and the
      // row must already be gone: the message HAS reached the agent.
      expect(result.current.resendingSteers).toEqual([])

      // And it stays gone while the agent answers that exact message — the
      // state in which the old row was actively asserting something false.
      await act(async () => {
        resent.push({ kind: "turn_start", turnId: "t2" })
        resent.push({
          kind: "text_delta",
          delta: "Sure — changing the padding to 12px now.",
        })
        await vi.advanceTimersByTimeAsync(100)
      })
      expect(result.current.resendingSteers).toEqual([])

      await act(async () => {
        resent.push({ kind: "turn_complete", turnId: "t2" })
        resent.close()
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(result.current.resendingSteers).toEqual([])
      expect(chatCalls().map((c) => c.userMessage)).toEqual([
        "first",
        "use 12px not 8px",
        "use 12px not 8px",
      ])
      await act(async () => {
        await running
      })
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * The case where nothing went wrong at all. A resubmit accepted on the FIRST
   * attempt still put the row up under the old code — and left it up for the
   * entire turn, with `attempt: 1`. So the indicator fired at full duration on
   * a recovery that hit no 409 and needed no explaining.
   */
  it("does not leave the row up for a resubmit accepted on the first attempt", async () => {
    vi.useFakeTimers()
    try {
      const resent = liveSse()
      // No 409: the lock had already cleared by the time the sweep fired.
      chatResponses.push(resent.response)
      const { result } = renderHook(() => useEditorChat(soloOptions))
      const { running } = await steerThenStop(result, "second")

      // The POST has been accepted; the turn is still running.
      expect(result.current.resendingSteers).toEqual([])

      await act(async () => {
        resent.push({ kind: "turn_start", turnId: "t2" })
        resent.push({ kind: "text_delta", delta: "on it" })
        await vi.advanceTimersByTimeAsync(100)
      })
      expect(result.current.resendingSteers).toEqual([])

      await act(async () => {
        resent.push({ kind: "turn_complete", turnId: "t2" })
        resent.close()
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => {
        await running
      })
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * The `finally` backstop, on the one exit that never reaches a 2xx AND stays
   * observable: the user starts a fresh turn while a resend is in its backoff.
   * `resubmitSteer` stands down rather than aborting the user's own turn, and
   * the entry stays ledgered for a later sweep — so the mark has to come down,
   * or that later sweep's first attempt renders as a continuation of this one.
   */
  it("clears the row when a fresh user submit takes the bucket mid-backoff", async () => {
    vi.useFakeTimers()
    try {
      const fresh = liveSse()
      chatResponses.push(
        jsonResponse(409, { error: "turn in flight" }),
        fresh.response,
      )
      const { result } = renderHook(() => useEditorChat(soloOptions))
      const { running } = await steerThenStop(result, "second")
      expect(result.current.resendingSteers).toHaveLength(1)

      // The user types something new while the backoff is still waiting.
      let userTurn!: Promise<void>
      await act(async () => {
        userTurn = result.current.submit("something else")
        await vi.advanceTimersByTimeAsync(0)
      })

      // The backoff expires; the resend sees the bucket is taken and stands
      // down without posting.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })
      expect(result.current.resendingSteers).toEqual([])
      expect(chatCalls().map((c) => c.userMessage)).toEqual([
        "first",
        "second",
        "something else",
      ])

      await act(async () => {
        fresh.push({ kind: "turn_complete", turnId: "t2" })
        fresh.close()
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => {
        await running
        await userTurn
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("clears the indicator on terminal failure, leaving the error that carries the text", async () => {
    vi.useFakeTimers()
    try {
      // Initial attempt + every retry refused: the bounded schedule gives up.
      for (let i = 0; i < 6; i++) {
        chatResponses.push(jsonResponse(409, { error: "turn in flight" }))
      }
      const { result } = renderHook(() => useEditorChat(soloOptions))
      const { running } = await steerThenStop(result, "please add a footer")
      expect(result.current.resendingSteers).toHaveLength(1)

      for (const delayMs of [500, 1000, 2000, 4000, 8000]) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(delayMs)
        })
      }

      // Nothing is being resent any more, so the spinner must not linger —
      // a permanent spinner on a message that has stopped moving is a lie.
      expect(result.current.resendingSteers).toEqual([])
      // The failure is still surfaced, still carrying the user's words.
      const errors = result.current.messages.filter((m) => m.kind === "error")
      expect(errors.some((e) => e.reason.includes("please add a footer"))).toBe(
        true,
      )
      await act(async () => {
        await running
      })
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * Unmount mid-backoff — the other exit that only the `finally` covers.
   *
   * The honest limit of this test, stated so nobody reads more into it: once
   * the hook is unmounted, `result.current` is frozen at its last render and
   * React drops the `setState` the clear performs, so the cleared value is not
   * observable from out here. What IS observable is that the loop stands down
   * without posting again and that the clearing path runs to completion
   * without throwing — a `publishResendingSteers` that blew up after unmount
   * would surface as a rejected `running` promise below.
   */
  it("stands down without resending, and without throwing, when the hook unmounts mid-backoff", async () => {
    vi.useFakeTimers()
    try {
      chatResponses.push(jsonResponse(409, { error: "turn in flight" }))
      const { result, unmount } = renderHook(() => useEditorChat(soloOptions))
      const { running } = await steerThenStop(result, "second")

      // The row is up: the 409 landed and the backoff is waiting.
      expect(result.current.resendingSteers).toHaveLength(1)
      const callsBefore = chatCalls().length

      unmount()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(chatCalls()).toHaveLength(callsBefore)
      // Rejects if the post-unmount clear threw.
      await running
    } finally {
      vi.useRealTimers()
    }
  })

  // A background session recovering its own steer must not paint a row into
  // the session the user is reading — same rule the message buckets follow.
  it("does not surface session B's resend while session A is visible", async () => {
    vi.useFakeTimers()
    try {
      let current = "A"
      const turn = liveSse()
      chatResponses.push(
        turn.response,
        jsonResponse(409, { error: "turn in flight" }),
        silentTurn("t2"),
      )
      const { result, rerender } = renderHook(() =>
        useEditorChat({
          bridgeHandlers: {},
          getChatSessionId: () => current,
          getVisibleSessionId: () => current,
          onSessionEvent: () => {},
          getSessionReKeyEnabled: () => true,
        }),
      )

      let running!: Promise<void>
      await act(async () => {
        running = result.current.submit("first")
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => {
        turn.push({ kind: "session", sessionId: "A", projectId: "p1" })
        turn.push({ kind: "turn_start", turnId: "t1" })
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => {
        await result.current.steer("second")
      })

      // The user switches to B, then A's turn is stopped.
      current = "B"
      rerender()
      await act(async () => {
        result.current.abort()
        turn.fail(abortError())
        await vi.advanceTimersByTimeAsync(0)
        await vi.advanceTimersByTimeAsync(0)
      })

      // A's resend is in its backoff — and B, which is on screen, says nothing.
      expect(result.current.resendingSteers).toEqual([])

      current = "A"
      rerender()
      expect(result.current.resendingSteers).toEqual([
        { id: expect.any(String), text: "second", attempt: 1 },
      ])

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })
      await act(async () => {
        await running
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
