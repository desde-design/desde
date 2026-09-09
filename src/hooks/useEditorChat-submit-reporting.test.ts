import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

const fetchMock = vi.fn()
vi.mock("@/lib/editor-fetch", () => ({
  editorFetch: (...args: unknown[]) => fetchMock(...args),
}))

import { HANDOFF_NOT_SENT_REASON, useEditorChat } from "./useEditorChat"
import type { ChatMessage } from "./useEditorChat"

/**
 * `submit` is void, so every caller had to assume the turn started.
 * `submitChatInNewSession` did assume it, and reported success to
 * `generateFlowOntoCanvas` on an HTTP or network refusal. That left the canvas
 * flow spinning on "generating" for a turn that never began, waiting for a
 * `turn_complete` that could not arrive.
 *
 * Same POST mock the other `useEditorChat` suites use.
 */
describe("useEditorChat — submitReporting", () => {
  const baseOpts = { bridgeHandlers: {} }

  function sseResponse(body: string) {
    const bytes = new TextEncoder().encode(body)
    let sent = false
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true, value: undefined }
            sent = true
            return { done: false, value: bytes }
          },
          cancel: () => {},
          releaseLock: () => {},
        }),
      },
      text: async () => body,
    }
  }

  /** One SSE frame, in the wire shape the server writes. */
  function frame(event: object): string {
    return `data:${JSON.stringify(event)}\n\n`
  }

  /**
   * The server's durable acceptance signal. Emitted after the session is
   * loaded and the in-flight turn persisted, which is everything that can
   * still refuse a turn whose headers already flushed.
   */
  const ACCEPTED = frame({ kind: "accepted", sessionId: "s1" })

  /**
   * A stream that never ends, i.e. an ordinary turn while the agent is still
   * working. `read()` returns a promise nobody resolves.
   */
  function neverEndingSseResponse(prefix = ACCEPTED) {
    const bytes = new TextEncoder().encode(prefix)
    let sent = false
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return new Promise<never>(() => {})
            sent = true
            return { done: false, value: bytes }
          },
          cancel: () => {},
          releaseLock: () => {},
        }),
      },
      text: async () => "",
    }
  }

  it("reports true when the server accepted the turn on the stream", async () => {
    fetchMock.mockResolvedValue(
      sseResponse(ACCEPTED + frame({ kind: "turn_complete", turnId: "t1" })),
    )
    const { result } = renderHook(() => useEditorChat(baseOpts))
    let accepted: boolean | undefined
    await act(async () => {
      accepted = await result.current.submitReporting("hello")
    })
    expect(accepted).toBe(true)
  })

  /**
   * The gap this seam used to report through. `openSseStream` flushes the
   * response headers as the first thing the route does, BEFORE it loads the
   * session or persists the in-flight turn. A cancelled session and a
   * `saveSession` that throws both refuse the turn after that flush, and both
   * report it only as an `error` event. Latching acceptance on `response.ok`
   * told the caller "accepted" for a turn the server never took, and every
   * caller on this seam has already dropped the thing it would need to retry
   * with by then.
   */
  it("reports false when the stream refuses the turn after the headers flushed", async () => {
    fetchMock.mockResolvedValue(
      sseResponse(
        frame({
          kind: "error",
          reason:
            "This chat session was cancelled (restart-clear). Start a new chat to continue.",
        }),
      ),
    )
    const { result } = renderHook(() => useEditorChat(baseOpts))
    let accepted: boolean | undefined
    await act(async () => {
      accepted = await result.current.submitReporting("hello")
    })
    expect(accepted).toBe(false)
  })

  /**
   * A note that rides the `error` kind (a stale persisted model falling back
   * to the default) is emitted BEFORE the persist, on a turn that then runs
   * normally. So an `error` frame is not itself a refusal: only the absence of
   * `accepted` by the end of the stream is.
   */
  it("still reports true when an error-kind note precedes acceptance", async () => {
    fetchMock.mockResolvedValue(
      sseResponse(
        frame({ kind: "error", reason: "Saved model for this chat is no longer available." }) +
          ACCEPTED +
          frame({ kind: "turn_complete", turnId: "t1" }),
      ),
    )
    const { result } = renderHook(() => useEditorChat(baseOpts))
    let accepted: boolean | undefined
    await act(async () => {
      accepted = await result.current.submitReporting("hello")
    })
    expect(accepted).toBe(true)
  })

  it("reports false on an HTTP refusal, where submit reported nothing at all", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      body: null,
      text: async () => "boom",
    })
    const { result } = renderHook(() => useEditorChat(baseOpts))
    let accepted: boolean | undefined
    await act(async () => {
      accepted = await result.current.submitReporting("hello")
    })
    expect(accepted).toBe(false)
  })

  it("reports false when the fetch throws", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"))
    const { result } = renderHook(() => useEditorChat(baseOpts))
    let accepted: boolean | undefined
    await act(async () => {
      accepted = await result.current.submitReporting("hello")
    })
    expect(accepted).toBe(false)
  })

  /**
   * The point of the seam. Every caller awaiting it holds something open while
   * it waits (a Save spinner, a bridge draft, an in-flight prop, an open
   * comment thread), and a real turn runs for tens of seconds. Settling at the
   * END of the stream held all of them for the whole turn.
   */
  it("reports true at acceptance, without waiting for the stream to end", async () => {
    // Accepted, then the agent works forever. The report must not wait for it.
    fetchMock.mockResolvedValue(neverEndingSseResponse())
    const { result } = renderHook(() => useEditorChat(baseOpts))
    let raced: boolean | "timed-out" | undefined
    await act(async () => {
      // No `await` on the whole turn: the stream never completes, so awaiting
      // it would hang forever. That hang is the regression this guards.
      const reported = result.current.submitReporting("hello")
      const timeout = new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 1000)
      })
      raced = await Promise.race<boolean | "timed-out">([reported, timeout])
    })
    expect(raced).toBe(true)
  })

  /**
   * The complement: a stream that hangs BEFORE accepting reports nothing yet.
   * It is not allowed to report `true` on the strength of the headers alone,
   * and it must not report `false` either — the turn may still be accepted.
   */
  it("reports nothing while a stream that has not yet accepted stays open", async () => {
    fetchMock.mockResolvedValue(neverEndingSseResponse(""))
    const { result } = renderHook(() => useEditorChat(baseOpts))
    let raced: boolean | "timed-out" | undefined
    await act(async () => {
      const reported = result.current.submitReporting("hello")
      const timeout = new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 300)
      })
      raced = await Promise.race<boolean | "timed-out">([reported, timeout])
    })
    expect(raced).toBe("timed-out")
  })

  /** The last `init` the mocked `editorFetch` was called with. */
  function lastFetchInit(): { signal: AbortSignal } {
    const init = fetchMock.mock.calls.at(-1)?.[1]
    return init as { signal: AbortSignal }
  }

  /** Let the submit's own awaits run before reading the fetch mock. */
  async function settleMicrotasks(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  /**
   * The hand-off seam's deadline. `settleHandOff` parks the edit in the
   * deterministic dialog after 30 s; if the POST keeps going the server can
   * accept the turn afterwards and the agent writes the same element the
   * designer is at that moment choosing a scope for. Giving up on the WAIT is
   * not enough, so the caller's signal has to reach the fetch.
   */
  it("aborts the turn's request when the caller's signal aborts", async () => {
    fetchMock.mockResolvedValue(neverEndingSseResponse(""))
    const { result } = renderHook(() => useEditorChat(baseOpts))
    const controller = new AbortController()
    await act(async () => {
      void result.current.submitReporting("hello", undefined, { signal: controller.signal })
      await settleMicrotasks()
    })
    const init = lastFetchInit()
    expect(init.signal.aborted).toBe(false)
    await act(async () => {
      controller.abort()
      await settleMicrotasks()
    })
    expect(init.signal.aborted).toBe(true)
  })

  it("carries an already-aborted signal into the request rather than ignoring it", async () => {
    fetchMock.mockResolvedValue(neverEndingSseResponse(""))
    const { result } = renderHook(() => useEditorChat(baseOpts))
    const controller = new AbortController()
    controller.abort()
    let accepted: boolean | undefined
    await act(async () => {
      accepted = await result.current.submitReporting("hello", undefined, {
        signal: controller.signal,
      })
    })
    expect(lastFetchInit().signal.aborted).toBe(true)
    expect(accepted).toBe(false)
  })

  it("leaves the turn alone when no signal is passed", async () => {
    fetchMock.mockResolvedValue(neverEndingSseResponse(""))
    const { result } = renderHook(() => useEditorChat(baseOpts))
    await act(async () => {
      void result.current.submitReporting("hello")
      await settleMicrotasks()
    })
    expect(lastFetchInit().signal.aborted).toBe(false)
  })

  /**
   * A fetch that never answers and rejects the way a real aborted `fetch`
   * does. The SSE-shaped mocks above resolve immediately and ignore the
   * signal, so none of them can reach the submit's AbortError path.
   */
  function abortingFetch(): (url: string, init: { signal: AbortSignal }) => Promise<never> {
    return (_url, init) =>
      new Promise<never>((_resolve, reject) => {
        const fail = (): void => {
          reject(new DOMException("The operation was aborted.", "AbortError"))
        }
        if (init.signal.aborted) fail()
        else init.signal.addEventListener("abort", fail, { once: true })
      })
  }

  type ErrorMessage = Extract<ChatMessage, { kind: "error" }>
  const errors = (msgs: readonly ChatMessage[]): ErrorMessage[] =>
    msgs.filter((m): m is ErrorMessage => m.kind === "error")
  const users = (msgs: readonly ChatMessage[]): ChatMessage[] =>
    msgs.filter((m) => m.kind === "user")

  /**
   * The bubble is drawn BEFORE the fetch. A hand-off that runs out of time
   * aborts the POST, and without a marker the new session is left showing a
   * message that looks sent and never was; retrying the hand-off then stacks
   * a second one beside it.
   */
  it("marks the optimistic bubble when the caller's deadline cancelled the turn", async () => {
    fetchMock.mockImplementation(abortingFetch())
    const { result } = renderHook(() => useEditorChat(baseOpts))
    const controller = new AbortController()
    let accepted: boolean | undefined
    await act(async () => {
      const reported = result.current.submitReporting("do the thing", undefined, {
        signal: controller.signal,
      })
      await settleMicrotasks()
      controller.abort()
      accepted = await reported
    })
    expect(accepted).toBe(false)
    // The bubble stays: it carries the text the designer would have sent, and
    // this is the same shape a refused POST leaves behind.
    expect(users(result.current.messages)).toHaveLength(1)
    expect(errors(result.current.messages).map((e) => e.reason)).toEqual([
      HANDOFF_NOT_SENT_REASON,
    ])
  })

  /**
   * Stop is a deliberate act on a turn the user watched start, and it has
   * never been surfaced as a failure. Only the CALLER's signal marks.
   */
  it("says nothing when the user's own Stop cancelled the turn", async () => {
    fetchMock.mockImplementation(abortingFetch())
    const { result } = renderHook(() => useEditorChat(baseOpts))
    await act(async () => {
      void result.current.submitReporting("do the thing")
      await settleMicrotasks()
      result.current.abort()
      await settleMicrotasks()
    })
    expect(errors(result.current.messages)).toHaveLength(0)
  })

  it("marks the bubble once per attempt, so a retry does not accumulate silent ones", async () => {
    fetchMock.mockImplementation(abortingFetch())
    const { result } = renderHook(() => useEditorChat(baseOpts))
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController()
      await act(async () => {
        const reported = result.current.submitReporting("do the thing", undefined, {
          signal: controller.signal,
        })
        await settleMicrotasks()
        controller.abort()
        await reported
      })
    }
    expect(users(result.current.messages)).toHaveLength(2)
    expect(errors(result.current.messages)).toHaveLength(2)
  })

  it("uses no em dash and no first person in the marker", () => {
    expect(HANDOFF_NOT_SENT_REASON).not.toMatch(/\u2014/)
    expect(HANDOFF_NOT_SENT_REASON).not.toMatch(/\b(me|my)\b/i)
  })

  it("leaves submit's void contract alone", async () => {
    fetchMock.mockResolvedValue(
      sseResponse(ACCEPTED + frame({ kind: "turn_complete", turnId: "t1" })),
    )
    const { result } = renderHook(() => useEditorChat(baseOpts))
    await act(async () => {
      expect(await result.current.submit("hello")).toBeUndefined()
    })
  })
})
