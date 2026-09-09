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

  /**
   * A stream that never ends, i.e. an ordinary turn while the agent is still
   * working. `read()` returns a promise nobody resolves.
   */
  function neverEndingSseResponse() {
    const bytes = new TextEncoder().encode('data: {"type":"turn_start"}\n\n')
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

  it("reports true when the server answered 2xx with a stream", async () => {
    fetchMock.mockResolvedValue(
      sseResponse('data: {"type":"turn_complete"}\n\n'),
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

  it("leaves submit's void contract alone", async () => {
    fetchMock.mockResolvedValue(
      sseResponse('data: {"type":"turn_complete"}\n\n'),
    )
    const { result } = renderHook(() => useEditorChat(baseOpts))
    await act(async () => {
      expect(await result.current.submit("hello")).toBeUndefined()
    })
  })
})
