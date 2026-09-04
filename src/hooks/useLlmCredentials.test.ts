import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  everyProviderUncredentialed,
  isLlmCredentialsStatus,
  useLlmCredentials,
  type LlmCredentialsStatus,
} from "./useLlmCredentials"

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

const anthropicOnly = (source: "none" | "stored" | "env" | "subscription", extra = {}) => ({
  providers: {
    anthropic: {
      id: "anthropic",
      label: "Anthropic",
      source,
      hasStoredKey: false,
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
      consoleUrl: "https://console.anthropic.com/settings/keys",
      maskPrefix: "sk-ant-",
      hasSubscriptionRuntime: true,
      ...extra,
    },
  },
  devMode: false,
  promptDismissed: false,
})

describe("useLlmCredentials", () => {
  it("loads status on mount", async () => {
    stubFetch(anthropicOnly("stored", { maskedHint: "sk-ant-…4f2a" }))
    const { result } = renderHook(() => useLlmCredentials())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.status?.providers.anthropic.source).toBe("stored")
    expect(result.current.status?.providers.anthropic.maskedHint).toBe("sk-ant-…4f2a")
  })

  it("surfaces a save failure instead of silently succeeding", async () => {
    stubFetch(
      anthropicOnly("none"),
      () =>
        new Response(JSON.stringify({ error: "Anthropic rejected that key." }), {
          status: 400,
        }),
    )
    const { result } = renderHook(() => useLlmCredentials())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.saveKey("anthropic", "sk-ant-bad")
    })
    expect(ok).toBe(false)
    expect(result.current.error).toBe("Anthropic rejected that key.")
  })

  it("adopts the status the server returns after a successful save", async () => {
    stubFetch(
      anthropicOnly("none"),
      () =>
        new Response(
          JSON.stringify(anthropicOnly("stored", { maskedHint: "sk-ant-…9999" })),
          { status: 200 },
        ),
    )
    const { result } = renderHook(() => useLlmCredentials())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.saveKey("anthropic", "sk-ant-good9999")
    })
    expect(result.current.status?.providers.anthropic.source).toBe("stored")
    expect(result.current.error).toBeNull()
  })

  it("never keeps the submitted key in hook state", async () => {
    stubFetch(
      anthropicOnly("none"),
      () =>
        new Response(
          JSON.stringify(anthropicOnly("stored", { maskedHint: "sk-ant-…9999" })),
          { status: 200 },
        ),
    )
    const { result } = renderHook(() => useLlmCredentials())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.saveKey("anthropic", "sk-ant-supersecret9999")
    })
    expect(JSON.stringify(result.current.status)).not.toContain("supersecret")
  })

  it("sends dev mode to its own route", async () => {
    const impl = stubFetch(anthropicOnly("none"))
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

const bothNone = {
  providers: {
    anthropic: {
      id: "anthropic",
      label: "Anthropic",
      source: "none",
      hasStoredKey: false,
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
      consoleUrl: "https://console.anthropic.com/settings/keys",
      maskPrefix: "sk-ant-",
      hasSubscriptionRuntime: true,
    },
    openai: {
      id: "openai",
      label: "OpenAI",
      source: "none",
      hasStoredKey: false,
      apiKeyEnvVar: "OPENAI_API_KEY",
      baseUrlEnvVar: "OPENAI_BASE_URL",
      consoleUrl: "https://platform.openai.com/api-keys",
      maskPrefix: "sk-",
      hasSubscriptionRuntime: false,
    },
  },
  devMode: false,
  promptDismissed: false,
}

describe("useLlmCredentials: provider-scoped mutations", () => {
  it("saves to the named provider's route and forwards a base URL", async () => {
    const impl = stubFetch(bothNone)
    const { result } = renderHook(() => useLlmCredentials())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.saveKey("openai", "sk-new", "https://gateway.internal")
    })
    const [url, init] = impl.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(url).toBe("/api/editor/llm-credentials/openai")
    expect(init.method).toBe("PUT")
    expect(JSON.parse(init.body as string)).toEqual({
      apiKey: "sk-new",
      baseUrl: "https://gateway.internal",
    })
  })

  it("omits baseUrl entirely when none is given", async () => {
    const impl = stubFetch(bothNone)
    const { result } = renderHook(() => useLlmCredentials())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.saveKey("anthropic", "sk-ant-new")
    })
    const [, init] = impl.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ apiKey: "sk-ant-new" })
  })

  it("saveKey forwards an explicit empty base URL so the server can clear it", async () => {
    const impl = stubFetch(bothNone)
    const { result } = renderHook(() => useLlmCredentials())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.saveKey("openai", "sk-new", "")
    })
    const [, cleared] = impl.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(JSON.parse(cleared.body as string)).toEqual({ apiKey: "sk-new", baseUrl: "" })
    await act(async () => {
      await result.current.saveKey("openai", "sk-new")
    })
    const [, untouched] = impl.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(JSON.parse(untouched.body as string)).toEqual({ apiKey: "sk-new" })
  })

  it("removes from the named provider's route", async () => {
    const impl = stubFetch(bothNone)
    const { result } = renderHook(() => useLlmCredentials())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.removeKey("openai")
    })
    const [url, init] = impl.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(url).toBe("/api/editor/llm-credentials/openai")
    expect(init.method).toBe("DELETE")
  })

  it("keeps dev mode and dismissal on the base sub-routes", async () => {
    const impl = stubFetch(bothNone)
    const { result } = renderHook(() => useLlmCredentials())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.setDevMode(true)
      await result.current.dismissPrompt()
    })
    const urls = impl.mock.calls.map((c) => c[0])
    expect(urls).toContain("/api/editor/llm-credentials/dev-mode")
    expect(urls).toContain("/api/editor/llm-credentials/dismiss-prompt")
  })
})

describe("everyProviderUncredentialed", () => {
  it("is true only when no provider reports a credential", () => {
    expect(everyProviderUncredentialed(bothNone as never)).toBe(true)
  })

  it("is false when a provider other than the first one is configured", () => {
    const oneConfigured = {
      ...bothNone,
      providers: {
        ...bothNone.providers,
        openai: { ...bothNone.providers.openai, source: "stored", hasStoredKey: true },
      },
    }
    expect(everyProviderUncredentialed(oneConfigured as never)).toBe(false)
  })

  it("is false while the status has not loaded, so nothing flashes", () => {
    expect(everyProviderUncredentialed(null)).toBe(false)
  })
})

describe("a status the hook does not recognise", () => {
  it("everyProviderUncredentialed reports false rather than throwing", () => {
    expect(everyProviderUncredentialed({ ok: true } as unknown as LlmCredentialsStatus)).toBe(false)
  })

  it("refresh keeps status null and records an error when the server answers an unknown shape", async () => {
    stubFetch({ ok: true })
    const { result } = renderHook(() => useLlmCredentials())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.status).toBeNull()
    expect(result.current.error).toMatch(/unexpected|shape|update/i)
  })

  it("isLlmCredentialsStatus accepts the real shape and rejects the generic one", () => {
    expect(isLlmCredentialsStatus({ providers: {}, devMode: false, promptDismissed: false })).toBe(true)
    expect(isLlmCredentialsStatus({ ok: true })).toBe(false)
    expect(isLlmCredentialsStatus(null)).toBe(false)
  })

  it("rejects a status whose provider row is null or missing its source", () => {
    expect(
      isLlmCredentialsStatus({
        providers: { anthropic: null },
        devMode: false,
        promptDismissed: false,
      }),
    ).toBe(false)
    expect(
      isLlmCredentialsStatus({
        providers: { anthropic: { id: "anthropic", label: "Anthropic" } },
        devMode: false,
        promptDismissed: false,
      }),
    ).toBe(false)
    expect(
      isLlmCredentialsStatus({
        providers: {
          anthropic: {
            id: "anthropic",
            label: "Anthropic",
            source: "bogus",
            hasStoredKey: false,
            apiKeyEnvVar: "ANTHROPIC_API_KEY",
            consoleUrl: "https://x",
            maskPrefix: "sk-ant-",
            hasSubscriptionRuntime: true,
          },
        },
        devMode: false,
        promptDismissed: false,
      }),
    ).toBe(false)
  })
})
