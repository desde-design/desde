import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  useLlmCredentials,
  type LlmCredentialsStatus,
  type ProviderCredentialStatus,
  type UseLlmCredentials,
} from "@/hooks/useLlmCredentials"
import { LlmCredentialDialog, shouldRevealDevMode } from "./llm-credential-dialog"

/** The dialog takes credential state from its caller; this supplies it. */
function Harness() {
  const credentials = useLlmCredentials()
  return <LlmCredentialDialog open onOpenChange={() => {}} credentials={credentials} />
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Builds the `{ providers: { anthropic: ... } }` map the hook now returns,
 * from just the Anthropic fields a given test cares about. The dialog reads
 * Anthropic's row out of the map (Task 7 adds tabs for the rest).
 */
function anthropicStatus(
  provider: Pick<ProviderCredentialStatus, "source"> &
    Partial<Omit<ProviderCredentialStatus, "id" | "label" | "source">>,
  rest: Partial<Pick<LlmCredentialsStatus, "devMode" | "promptDismissed">> = {},
): LlmCredentialsStatus {
  return {
    providers: {
      anthropic: {
        id: "anthropic",
        label: "Anthropic",
        hasStoredKey: false,
        apiKeyEnvVar: "ANTHROPIC_API_KEY",
        consoleUrl: "https://console.anthropic.com/settings/keys",
        maskPrefix: "sk-ant-",
        hasSubscriptionRuntime: true,
        ...provider,
      },
    },
    devMode: false,
    promptDismissed: false,
    ...rest,
  }
}

function stubStatus(status: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })),
  )
}

describe("shouldRevealDevMode", () => {
  const press = (over: Partial<Parameters<typeof shouldRevealDevMode>[0]>) =>
    shouldRevealDevMode({
      key: "?",
      code: "Slash",
      ctrlKey: true,
      shiftKey: true,
      metaKey: false,
      ...over,
    })

  it("reveals on Ctrl+?", () => {
    expect(press({})).toBe(true)
  })

  it("reveals on Ctrl+Shift+/ when the OS reports the unshifted key", () => {
    // Measured in the macOS desktop app 2026-09-02: Chromium reports
    // key "/" (not "?") while Control is held, so matching on `key` alone
    // never fired there.
    expect(press({ key: "/" })).toBe(true)
  })

  it("does not reveal on a bare ?", () => {
    expect(press({ ctrlKey: false, shiftKey: false })).toBe(false)
    expect(press({ ctrlKey: false })).toBe(false)
  })

  it("does not reveal on Cmd+?, which is the macOS Help shortcut", () => {
    expect(press({ ctrlKey: false, metaKey: true })).toBe(false)
  })

  it("does not reveal on Ctrl+/ without Shift", () => {
    expect(press({ key: "/", shiftKey: false })).toBe(false)
  })

  it("does not reveal on Ctrl with any other key", () => {
    expect(press({ key: "k", code: "KeyK" })).toBe(false)
    expect(press({ key: "K", code: "KeyK" })).toBe(false)
  })

  it("does not reveal when Cmd is held alongside Ctrl", () => {
    expect(press({ metaKey: true })).toBe(false)
  })
})

describe("LlmCredentialDialog", () => {
  it("hides the dev mode toggle until it is revealed", async () => {
    stubStatus(anthropicStatus({ source: "none" }))
    render(<Harness />)
    await waitFor(() => expect(screen.getByText("AI provider keys")).toBeInTheDocument())
    expect(screen.queryByLabelText("Dev mode")).toBeNull()
  })

  it("always shows the dev mode toggle when dev mode is on", async () => {
    stubStatus(anthropicStatus({ source: "subscription" }, { devMode: true }))
    render(<Harness />)
    await waitFor(() => expect(screen.getByLabelText("Dev mode")).toBeInTheDocument())
  })

  it("offers no key controls when the key comes from the environment", async () => {
    stubStatus(anthropicStatus({ source: "env", maskedHint: "sk-ant-…4f2a" }))
    render(<Harness />)
    await waitFor(() =>
      expect(screen.getByText(/environment variable/i)).toBeInTheDocument(),
    )
    // Query the control, not a label: the dialog's own `aria-labelledby`
    // points at the title "AI provider keys" and matches a loose regex.
    expect(screen.queryByPlaceholderText("sk-ant-...")).toBeNull()
    expect(screen.queryByRole("button", { name: "Save key" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Remove key" })).toBeNull()
  })

  it("offers Remove only when a key is stored", async () => {
    stubStatus(
      anthropicStatus({
        source: "stored",
        maskedHint: "sk-ant-…4f2a",
        storedHint: "sk-ant-…4f2a",
        hasStoredKey: true,
      }),
    )
    render(<Harness />)
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove key" })).toBeInTheDocument(),
    )
  })

  it("renders the masked hint and never a full key", async () => {
    stubStatus(
      anthropicStatus({
        source: "stored",
        maskedHint: "sk-ant-…4f2a",
        storedHint: "sk-ant-…4f2a",
        hasStoredKey: true,
      }),
    )
    const { container } = render(<Harness />)
    await waitFor(() => expect(screen.getByText(/sk-ant-…4f2a/)).toBeInTheDocument())
    expect(container.ownerDocument.body.textContent).not.toMatch(/sk-ant-api/)
  })
})

/**
 * Codex review P2: gating Remove on `source === "stored"` stranded a key that
 * dev mode had made inactive. Spec section 5 requires management to stay
 * available in dev mode.
 */
describe("LlmCredentialDialog in dev mode with a key stored", () => {
  it("still offers Remove, and labels the stored key as unused", async () => {
    stubStatus(
      anthropicStatus(
        { source: "subscription", hasStoredKey: true, storedHint: "sk-ant-…4f2a" },
        { devMode: true },
      ),
    )
    render(<Harness />)
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove key" })).toBeInTheDocument(),
    )
    expect(screen.getByText(/unused while dev mode is on/i)).toBeInTheDocument()
  })
})

/**
 * Codex review round four: validation is a network round-trip, and Close,
 * Escape and the backdrop stay live during it. A save resolving after the
 * user closed and reopened the dialog closed the NEW instance and wiped the
 * key they had just started typing.
 */
describe("LlmCredentialDialog save race", () => {
  it("does not close a reopened dialog when an earlier save resolves", async () => {
    let releaseSave: (() => void) | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (!init?.method || init.method === "GET") {
          return new Response(
            JSON.stringify(anthropicStatus({ source: "none" })),
            { status: 200 },
          )
        }
        // Hold the save open so the close-and-reopen can interleave.
        await new Promise<void>((resolve) => {
          releaseSave = resolve
        })
        return new Response(
          JSON.stringify(
            anthropicStatus({
              source: "stored",
              maskedHint: "sk-ant-…1111",
              storedHint: "sk-ant-…1111",
              hasStoredKey: true,
            }),
          ),
          { status: 200 },
        )
      }),
    )

    const onOpenChange = vi.fn()
    function ControlledHarness() {
      const credentials = useLlmCredentials()
      return (
        <LlmCredentialDialog open onOpenChange={onOpenChange} credentials={credentials} />
      )
    }
    render(<ControlledHarness />)
    await waitFor(() =>
      expect(screen.getByPlaceholderText("sk-ant-...")).toBeInTheDocument(),
    )

    fireEvent.change(screen.getByPlaceholderText("sk-ant-..."), {
      target: { value: "sk-ant-firstattempt1111" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save key" }))

    // The user gives up waiting and closes, then reopens.
    fireEvent.click(screen.getByTestId("llm-credential-close"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    onOpenChange.mockClear()

    // Now the original save lands.
    await act(async () => {
      releaseSave?.()
      await Promise.resolve()
    })

    // It must NOT close the instance the user is now looking at.
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})

const twoProviders = {
  providers: {
    anthropic: {
      id: "anthropic",
      label: "Anthropic",
      source: "none" as const,
      hasStoredKey: false,
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
      consoleUrl: "https://console.anthropic.com/settings/keys",
      maskPrefix: "sk-ant-",
      hasSubscriptionRuntime: true,
    },
    openai: {
      id: "openai",
      label: "OpenAI",
      source: "none" as const,
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

function credentials(overrides: Partial<UseLlmCredentials> = {}): UseLlmCredentials {
  return {
    status: twoProviders,
    loading: false,
    error: null,
    saveKey: vi.fn(async () => true),
    removeKey: vi.fn(async () => true),
    setDevMode: vi.fn(async () => true),
    dismissPrompt: vi.fn(async () => true),
    refresh: vi.fn(async () => {}),
    ...overrides,
  }
}

describe("LlmCredentialDialog: one tab per provider", () => {
  it("renders a tab for every provider the server served", () => {
    render(<LlmCredentialDialog open onOpenChange={() => {}} credentials={credentials()} />)
    expect(screen.getByRole("tab", { name: "Anthropic" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "OpenAI" })).toBeInTheDocument()
  })

  it("saves against the provider whose tab is open", async () => {
    const saveKey = vi.fn(async () => true)
    render(
      <LlmCredentialDialog open onOpenChange={() => {}} credentials={credentials({ saveKey })} />,
    )
    fireEvent.mouseDown(screen.getByRole("tab", { name: "OpenAI" }))
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-typed" } })
    fireEvent.click(screen.getByRole("button", { name: "Save key" }))
    await waitFor(() =>
      expect(saveKey).toHaveBeenCalledWith("openai", "sk-typed", undefined),
    )
  })

  it("keeps each tab's draft separate", async () => {
    render(<LlmCredentialDialog open onOpenChange={() => {}} credentials={credentials()} />)
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-ant-draft" } })
    fireEvent.mouseDown(screen.getByRole("tab", { name: "OpenAI" }))
    expect(screen.getByLabelText("API key")).toHaveValue("")
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Anthropic" }))
    expect(screen.getByLabelText("API key")).toHaveValue("sk-ant-draft")
  })

  it("offers a base URL field only for a provider that takes one", async () => {
    render(<LlmCredentialDialog open onOpenChange={() => {}} credentials={credentials()} />)
    expect(screen.queryByLabelText("Base URL")).not.toBeInTheDocument()
    fireEvent.mouseDown(screen.getByRole("tab", { name: "OpenAI" }))
    expect(screen.getByLabelText("Base URL")).toBeInTheDocument()
  })

  const openaiStoredWithBaseUrl = {
    ...twoProviders,
    providers: {
      ...twoProviders.providers,
      openai: {
        ...twoProviders.providers.openai,
        baseUrl: "https://gateway.internal/v1",
      },
    },
  }

  it("sends no baseUrl when a provider with a stored one goes untouched", () => {
    const saveKey = vi.fn().mockResolvedValue(true)
    render(
      <LlmCredentialDialog
        open
        onOpenChange={() => {}}
        credentials={credentials({ status: openaiStoredWithBaseUrl, saveKey })}
      />,
    )
    fireEvent.mouseDown(screen.getByRole("tab", { name: "OpenAI" }))
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: "sk-new" } })
    fireEvent.click(screen.getByRole("button", { name: "Save key" }))
    // Synchronous, deliberately: `saveKey` is called at the top of
    // `handleSave`, before its first `await` suspends the function, so the
    // call already happened by the time `fireEvent.click` returns.
    expect(saveKey).toHaveBeenLastCalledWith("openai", "sk-new", undefined)
  })

  it("sends an explicit empty baseUrl when the user clears a previously stored value", () => {
    const saveKey = vi.fn().mockResolvedValue(true)
    render(
      <LlmCredentialDialog
        open
        onOpenChange={() => {}}
        credentials={credentials({ status: openaiStoredWithBaseUrl, saveKey })}
      />,
    )
    fireEvent.mouseDown(screen.getByRole("tab", { name: "OpenAI" }))
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: "sk-new" } })
    fireEvent.change(screen.getByLabelText(/Base URL/), { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: "Save key" }))
    expect(saveKey).toHaveBeenLastCalledWith("openai", "sk-new", "")
  })

  it("names the provider's own environment variable when it manages the key", () => {
    const envManaged = {
      ...twoProviders,
      providers: {
        ...twoProviders.providers,
        openai: { ...twoProviders.providers.openai, source: "env" as const },
      },
    }
    render(
      <LlmCredentialDialog
        open
        onOpenChange={() => {}}
        credentials={credentials({ status: envManaged })}
      />,
    )
    fireEvent.mouseDown(screen.getByRole("tab", { name: "OpenAI" }))
    expect(screen.getByText("OPENAI_BASE_URL", { exact: false })).toBeDefined()
    expect(screen.getByText("OPENAI_API_KEY")).toBeInTheDocument()
  })
})

describe("the console link names the provider without an article", () => {
  it("names the console link without an article that can disagree with the provider", () => {
    render(<LlmCredentialDialog open onOpenChange={() => {}} credentials={credentials()} />)
    expect(screen.getByRole("link", { name: "Get a key from Anthropic" })).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByRole("tab", { name: "OpenAI" }))
    expect(screen.getByRole("link", { name: "Get a key from OpenAI" })).toBeInTheDocument()
  })
})

describe("dev mode stays inside the Anthropic tab", () => {
  it("does not reveal the toggle from a tab with no subscription runtime", async () => {
    render(<LlmCredentialDialog open onOpenChange={() => {}} credentials={credentials()} />)
    fireEvent.mouseDown(screen.getByRole("tab", { name: "OpenAI" }))
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "?",
      code: "Slash",
      ctrlKey: true,
      shiftKey: true,
    })
    expect(screen.queryByLabelText("Dev mode")).not.toBeInTheDocument()
  })

  it("reveals it from the Anthropic tab", async () => {
    render(<LlmCredentialDialog open onOpenChange={() => {}} credentials={credentials()} />)
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "?",
      code: "Slash",
      ctrlKey: true,
      shiftKey: true,
    })
    expect(await screen.findByLabelText("Dev mode")).toBeInTheDocument()
  })
})
