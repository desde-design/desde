import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

const fetchMock = vi.fn()
vi.mock("@/lib/editor-fetch", () => ({
  editorFetch: (...args: unknown[]) => fetchMock(...args),
}))

import { useEditorChat } from "./useEditorChat"

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
