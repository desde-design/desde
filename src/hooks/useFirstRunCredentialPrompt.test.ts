import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useFirstRunCredentialPrompt } from "./useFirstRunCredentialPrompt"
import type { LlmCredentialsStatus, ProviderCredentialStatus } from "./useLlmCredentials"

const ANTHROPIC_BASE: Omit<ProviderCredentialStatus, "source" | "hasStoredKey"> = {
  id: "anthropic",
  label: "Anthropic",
  apiKeyEnvVar: "ANTHROPIC_API_KEY",
  consoleUrl: "https://console.anthropic.com/settings/keys",
  maskPrefix: "sk-ant-",
  hasSubscriptionRuntime: true,
}

/** Fills the fields each case does not care about, on a single Anthropic provider. */
function status(
  overrides: Partial<Pick<ProviderCredentialStatus, "source" | "hasStoredKey">> &
    Partial<Pick<LlmCredentialsStatus, "devMode" | "promptDismissed">> = {},
): LlmCredentialsStatus {
  return {
    providers: {
      anthropic: {
        ...ANTHROPIC_BASE,
        source: overrides.source ?? "none",
        hasStoredKey: overrides.hasStoredKey ?? false,
      },
    },
    devMode: overrides.devMode ?? false,
    promptDismissed: overrides.promptDismissed ?? false,
  }
}

const noopPersist = async () => {}

describe("useFirstRunCredentialPrompt", () => {
  it("prompts when there is no credential", () => {
    const { result } = renderHook(() =>
      useFirstRunCredentialPrompt(status({ source: "none" }), noopPersist),
    )
    expect(result.current.shouldPrompt).toBe(true)
  })

  it("does not prompt while status is still loading", () => {
    const { result } = renderHook(() => useFirstRunCredentialPrompt(null, noopPersist))
    expect(result.current.shouldPrompt).toBe(false)
  })

  it("does not prompt in dev mode", () => {
    const { result } = renderHook(() =>
      useFirstRunCredentialPrompt(
        status({ source: "subscription", devMode: true }),
        noopPersist,
      ),
    )
    expect(result.current.shouldPrompt).toBe(false)
  })

  it("does not prompt when a key is stored", () => {
    const { result } = renderHook(() =>
      useFirstRunCredentialPrompt(
        status({ source: "stored", hasStoredKey: true }),
        noopPersist,
      ),
    )
    expect(result.current.shouldPrompt).toBe(false)
  })

  it("does not prompt when a key comes from the environment", () => {
    const { result } = renderHook(() =>
      useFirstRunCredentialPrompt(status({ source: "env" }), noopPersist),
    )
    expect(result.current.shouldPrompt).toBe(false)
  })

  it("stops prompting immediately on dismiss, without waiting for the write", () => {
    const persist = vi.fn(async () => {})
    const { result } = renderHook(() =>
      useFirstRunCredentialPrompt(status({ source: "none" }), persist),
    )
    act(() => result.current.dismiss())
    expect(result.current.shouldPrompt).toBe(false)
    expect(persist).toHaveBeenCalledOnce()
  })

  /**
   * The dismissal is machine-level, not `localStorage`: the launcher and the
   * desktop app pick a free port per project, and `localStorage` is scoped by
   * origin including the port, so a browser-side flag was forgotten whenever
   * a project reopened on a different port.
   */
  it("honours a dismissal the server already recorded, on a fresh mount", () => {
    const { result } = renderHook(() =>
      useFirstRunCredentialPrompt(
        status({ source: "none", promptDismissed: true }),
        noopPersist,
      ),
    )
    expect(result.current.shouldPrompt).toBe(false)
  })

  it("still closes the dialog when persisting the dismissal fails", () => {
    const persist = vi.fn(async () => {
      throw new Error("offline")
    })
    const { result } = renderHook(() =>
      useFirstRunCredentialPrompt(status({ source: "none" }), persist),
    )
    act(() => result.current.dismiss())
    expect(result.current.shouldPrompt).toBe(false)
  })
})

const OPENAI_BASE: Omit<ProviderCredentialStatus, "source" | "hasStoredKey"> = {
  id: "openai",
  label: "OpenAI",
  apiKeyEnvVar: "OPENAI_API_KEY",
  consoleUrl: "https://platform.openai.com/api-keys",
  maskPrefix: "sk-",
  hasSubscriptionRuntime: false,
}

describe("first run across providers", () => {
  it("does not prompt when only OpenAI is configured", () => {
    const twoProviderStatus: LlmCredentialsStatus = {
      providers: {
        anthropic: { ...ANTHROPIC_BASE, source: "none", hasStoredKey: false },
        openai: { ...OPENAI_BASE, source: "stored", hasStoredKey: true },
      },
      devMode: false,
      promptDismissed: false,
    }
    const { result } = renderHook(() =>
      useFirstRunCredentialPrompt(twoProviderStatus, async () => {}),
    )
    expect(result.current.shouldPrompt).toBe(false)
  })

  it("prompts when every provider reports none", () => {
    const twoProviderStatus: LlmCredentialsStatus = {
      providers: {
        anthropic: { ...ANTHROPIC_BASE, source: "none", hasStoredKey: false },
        openai: { ...OPENAI_BASE, source: "none", hasStoredKey: false },
      },
      devMode: false,
      promptDismissed: false,
    }
    const { result } = renderHook(() =>
      useFirstRunCredentialPrompt(twoProviderStatus, async () => {}),
    )
    expect(result.current.shouldPrompt).toBe(true)
  })
})
