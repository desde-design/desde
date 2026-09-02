import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useLlmCredentials } from "./useLlmCredentials"

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Answers the mount GET with `status`, and any mutation with `onMutate`. */
function stubFetch(
  status: unknown,
  onMutate?: (init: RequestInit | undefined) => Response,
) {
  const impl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.method || init.method === "GET") {
      return new Response(JSON.stringify(status), { status: 200 })
    }
    return onMutate
      ? onMutate(init)
      : new Response(JSON.stringify(status), { status: 200 })
  })
  vi.stubGlobal("fetch", impl)
  return impl
}

describe("useLlmCredentials", () => {
  it("loads status on mount", async () => {
    stubFetch({ source: "stored", maskedHint: "sk-ant-…4f2a", devMode: false })
    const { result } = renderHook(() => useLlmCredentials())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.status?.source).toBe("stored")
    expect(result.current.status?.maskedHint).toBe("sk-ant-…4f2a")
  })

  it("surfaces a save failure instead of silently succeeding", async () => {
    stubFetch(
      { source: "none", devMode: false },
      () =>
        new Response(JSON.stringify({ error: "Anthropic rejected that key." }), {
          status: 400,
        }),
    )
    const { result } = renderHook(() => useLlmCredentials())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.saveKey("sk-ant-bad")
    })
    expect(ok).toBe(false)
    expect(result.current.error).toBe("Anthropic rejected that key.")
  })

  it("adopts the status the server returns after a successful save", async () => {
    stubFetch(
      { source: "none", devMode: false },
      () =>
        new Response(
          JSON.stringify({
            source: "stored",
            maskedHint: "sk-ant-…9999",
            devMode: false,
          }),
          { status: 200 },
        ),
    )
    const { result } = renderHook(() => useLlmCredentials())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.saveKey("sk-ant-good9999")
    })
    expect(result.current.status?.source).toBe("stored")
    expect(result.current.error).toBeNull()
  })

  it("never keeps the submitted key in hook state", async () => {
    stubFetch(
      { source: "none", devMode: false },
      () =>
        new Response(
          JSON.stringify({ source: "stored", maskedHint: "sk-ant-…9999", devMode: false }),
          { status: 200 },
        ),
    )
    const { result } = renderHook(() => useLlmCredentials())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.saveKey("sk-ant-supersecret9999")
    })
    expect(JSON.stringify(result.current.status)).not.toContain("supersecret")
  })

  it("sends dev mode to its own route", async () => {
    const impl = stubFetch({ source: "none", devMode: false })
    const { result } = renderHook(() => useLlmCredentials())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.setDevMode(true)
    })
    const target = impl.mock.calls.at(-1)?.[0]
    expect(String(target)).toBe("/api/editor/llm-credentials/dev-mode")
  })

  it("reports a network failure rather than throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline")
      }),
    )
    const { result } = renderHook(() => useLlmCredentials())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe("offline")
    expect(result.current.status).toBeNull()
  })
})
