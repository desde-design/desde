/**
 * Unit tests for <ChatStatusBanners>.
 *
 * Focus areas:
 *   1. Renders only the 5 status kinds (error, queued, overwrite_warning,
 *      rate_limit_warning, api_retry) — user / assistant are NOT rendered.
 *   2. All 5 kinds produce their expected copy/indicators.
 *   3. rate_limit_warning shows reset-time text via formatResetTime.
 *   4. Returns null (nothing mounted) when there are no status messages.
 *   5. Multiple status messages all appear.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ChatStatusBanners } from "./chat-status-banners"
import type { ChatMessage } from "@/hooks/useEditorChat"

// ---------------------------------------------------------------------------
// Message factories
// ---------------------------------------------------------------------------

function user(id = "u1"): ChatMessage {
  return { kind: "user", id, text: "Hello" }
}

function assistant(id = "a1"): ChatMessage {
  return { kind: "assistant", id, blocks: [{ type: "text", text: "Hi" }] }
}

function errorMsg(id = "e1", reason = "Something broke"): ChatMessage {
  return { kind: "error", id, reason }
}

function queued(id = "q1", queuePosition = 1): ChatMessage {
  return { kind: "queued", id, queuePosition }
}

function overwriteWarning(id = "ow1"): ChatMessage {
  return {
    kind: "overwrite_warning",
    id,
    file: "src/components/App.vue",
    hashAtRead: "abc123",
    hashAtWrite: "def456",
    conflictingSessionPrompt: "Make the button blue",
  }
}

function rateLimitWarning(
  id = "rl1",
  overrides?: Partial<Extract<ChatMessage, { kind: "rate_limit_warning" }>>,
): ChatMessage {
  return {
    kind: "rate_limit_warning",
    id,
    status: "allowed_warning",
    ...overrides,
  }
}

function apiRetry(id = "ar1"): ChatMessage {
  return {
    kind: "api_retry",
    id,
    retryDelayMs: 3000,
    attempt: 2,
    maxRetries: 5,
    errorStatus: 429,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChatStatusBanners", () => {
  it("renders nothing when there are no messages", () => {
    const { container } = render(<ChatStatusBanners messages={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders nothing when all messages are user/assistant", () => {
    const { container } = render(
      <ChatStatusBanners messages={[user(), assistant()]} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("does NOT render user or assistant messages even in a mixed list", () => {
    render(
      <ChatStatusBanners
        messages={[user("u-check"), assistant("a-check"), errorMsg("e-check")]}
      />,
    )
    // User text shouldn't appear
    expect(screen.queryByText("Hello")).toBeNull()
    // Assistant text shouldn't appear
    expect(screen.queryByText("Hi")).toBeNull()
    // Error should appear
    expect(screen.getByText("Something broke")).toBeInTheDocument()
  })

  it("renders an error banner with the reason text", () => {
    render(<ChatStatusBanners messages={[errorMsg("e1", "Chat stream failed")]} />)
    expect(screen.getByText("Chat stream failed")).toBeInTheDocument()
  })

  it("renders a queued banner with waiting copy", () => {
    render(<ChatStatusBanners messages={[queued("q1", 1)]} />)
    expect(
      screen.getByText(/waiting for an open chat slot/i),
    ).toBeInTheDocument()
  })

  it("queued banner shows queue position when > 1", () => {
    render(<ChatStatusBanners messages={[queued("q2", 3)]} />)
    expect(screen.getByText(/position 3 in line/i)).toBeInTheDocument()
  })

  it("renders an overwrite_warning banner with file name", () => {
    render(<ChatStatusBanners messages={[overwriteWarning()]} />)
    expect(screen.getByText(/heads up/i)).toBeInTheDocument()
    expect(screen.getByText("src/components/App.vue")).toBeInTheDocument()
  })

  it("overwrite_warning names the session whose work was written over", () => {
    render(<ChatStatusBanners messages={[overwriteWarning()]} />)
    expect(
      screen.getByText(/wrote over changes made by "Make the button blue"/),
    ).toBeInTheDocument()
  })

  it("overwrite_warning does NOT send the reader to a save dialog", () => {
    // TRACED 2026-08-18: it used to say "Review in the save dialog", and no
    // such route exists. `SaveProgressDialog` is driven by the
    // direct-manipulation save path (`editing.saving` / `editing.conflict`);
    // this banner comes from the chat path, which pushes a message and sets
    // nothing. There is no click target here and nothing opens that dialog.
    render(<ChatStatusBanners messages={[overwriteWarning()]} />)
    expect(screen.queryByText(/save dialog/i)).toBeNull()
  })

  it("says whose limit it is and that the turn continues, while approaching", () => {
    render(
      <ChatStatusBanners
        messages={[rateLimitWarning("rl1", { status: "allowed_warning" })]}
      />,
    )
    expect(
      screen.getByText(/usage limit for this Claude account is nearly reached/i),
    ).toBeInTheDocument()
    expect(screen.getByText(/this turn is still running/i)).toBeInTheDocument()
  })

  it("says the request was DENIED and when to try again, once rejected", () => {
    // "Rate limit rejected" was the SDK's own word, printed as though the
    // reader shared that vocabulary. Mo read it and had to ask whether it
    // meant the limit was reached — which is exactly what it means. This
    // wording is Mo's own.
    render(
      <ChatStatusBanners
        messages={[
          rateLimitWarning("rl1", {
            status: "rejected",
            resetsAt: Date.now() + 38 * 60_000,
          }),
        ]}
      />,
    )
    expect(screen.getByText(/model request has been denied/i)).toBeInTheDocument()
    expect(
      screen.getByText(/usage limit for this Claude account has been reached/i),
    ).toBeInTheDocument()
    // The reset is stated as the thing to DO, not as a fact about the account.
    expect(screen.getByText(/try again in 38 mins when the limit resets/i)).toBeInTheDocument()
    expect(screen.queryByText(/rejected/i)).toBeNull()
  })

  it("says there are no extra credits only when the overage pool is gone too", () => {
    // "Reached, and nothing left to fall back on" is a different situation
    // from "reached", and it is the one that decides whether waiting helps.
    render(
      <ChatStatusBanners
        messages={[
          rateLimitWarning("rl1", { status: "rejected", overageStatus: "rejected" }),
        ]}
      />,
    )
    expect(screen.getByText(/no extra credits available/i)).toBeInTheDocument()
  })

  it("never prints the name of the sub-limit that ran out", () => {
    // `output_tokens` is which of Claude's limits was hit. It is not
    // something the reader sets, finds, or can act on.
    render(
      <ChatStatusBanners
        messages={[
          rateLimitWarning("rl1", {
            status: "rejected",
            rateLimitType: "output_tokens",
          }),
        ]}
      />,
    )
    expect(screen.queryByText(/output_tokens/)).toBeNull()
  })

  it("rate_limit_warning shows reset time text when resetsAt is provided", () => {
    // resetsAt = 30 seconds in the future → should render "in 30s" (or similar)
    const resetsAt = Date.now() + 30_000
    render(
      <ChatStatusBanners
        messages={[
          rateLimitWarning("rl2", { status: "allowed_warning", resetsAt }),
        ]}
      />,
    )
    // Words, not unit letters: "in 30 seconds", never "in 30s".
    expect(screen.getByText(/reset in \d+ seconds/i)).toBeInTheDocument()
  })

  it("rate_limit_warning shows 'shortly' when resetsAt is in the past", () => {
    const resetsAt = Date.now() - 10_000
    render(
      <ChatStatusBanners
        messages={[
          rateLimitWarning("rl3", { status: "allowed_warning", resetsAt }),
        ]}
      />,
    )
    expect(screen.getByText(/reset shortly/i)).toBeInTheDocument()
  })

  it("renders an api_retry banner with retry info", () => {
    render(<ChatStatusBanners messages={[apiRetry()]} />)
    expect(
      screen.getByText(/rate limit hit, waiting before retry/i),
    ).toBeInTheDocument()
    // "(2/5)" from attempt/maxRetries
    expect(screen.getByText(/\(2\/5\)/)).toBeInTheDocument()
    // "~3s" from retryDelayMs=3000
    expect(screen.getByText(/~3s/)).toBeInTheDocument()
  })

  it("api_retry shows 'Transient API error' for non-429 error status", () => {
    render(
      <ChatStatusBanners
        messages={[
          {
            kind: "api_retry",
            id: "ar2",
            retryDelayMs: 2000,
            attempt: 1,
            maxRetries: 3,
            errorStatus: 503,
          },
        ]}
      />,
    )
    expect(
      screen.getByText(/transient api error, retrying/i),
    ).toBeInTheDocument()
  })

  it("renders multiple status messages when present", () => {
    render(
      <ChatStatusBanners
        messages={[
          user(),
          errorMsg("e1", "First error"),
          assistant(),
          queued("q1", 2),
          overwriteWarning("ow1"),
        ]}
      />,
    )
    expect(screen.getByText("First error")).toBeInTheDocument()
    expect(screen.getByText(/waiting for an open chat slot/i)).toBeInTheDocument()
    expect(screen.getByText(/heads up/i)).toBeInTheDocument()
  })

  it("renders the wrapper element with data-testid when status messages present", () => {
    render(<ChatStatusBanners messages={[errorMsg()]} />)
    expect(screen.getByTestId("chat-status-banners")).toBeInTheDocument()
  })

  // -------------------------------------------------------------------------
  // Dismissal
  // -------------------------------------------------------------------------

  it("renders a dismiss button per banner and reports the message id", () => {
    const onDismiss = vi.fn()
    render(
      <ChatStatusBanners
        messages={[errorMsg("e1", "Boom")]}
        onDismiss={onDismiss}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalledWith("e1")
  })

  it("gives every status kind its own dismiss control", () => {
    const onDismiss = vi.fn()
    render(
      <ChatStatusBanners
        messages={[errorMsg("e1"), queued("q1"), overwriteWarning("ow1")]}
        onDismiss={onDismiss}
      />,
    )
    expect(screen.getAllByRole("button", { name: /dismiss/i })).toHaveLength(3)
  })

  it("renders no dismiss affordance when onDismiss is omitted", () => {
    render(<ChatStatusBanners messages={[errorMsg()]} />)
    expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull()
  })
})

describe("capability gap banner", () => {
  const gap = (over: Record<string, unknown> = {}) =>
    ({
      kind: "capability_gap",
      id: "g1",
      capabilityId: "figma",
      label: "Figma",
      detail: "https://figma.com/file/abc",
      requiresEnv: "FIGMA_API_KEY",
      envReady: false,
      activation: "next-message",
      ...over,
    }) as ChatMessage

  it("explains the gap and offers to enable it", () => {
    render(<ChatStatusBanners messages={[gap()]} onEnableCapability={vi.fn()} />)
    expect(screen.getByText(/Figma isn't enabled/i)).toBeInTheDocument()
    expect(screen.getByTestId("capability-gap-enable-figma")).toBeInTheDocument()
  })

  it("does not warn about a key before the user has chosen to care", () => {
    // The "Also needs an API key" line is gone (Mo, 2026-08-18). It raised a
    // requirement on an offer the user never asked for; the success state
    // says the same thing at the moment it starts mattering, with the key
    // form one click away.
    render(<ChatStatusBanners messages={[gap()]} onEnableCapability={vi.fn()} />)
    expect(screen.queryByText(/needs an API key/i)).toBeNull()
    // And never the variable name, wherever it appears.
    expect(screen.queryByText(/FIGMA_API_KEY/)).toBeNull()
  })

  it("passes only the capability id to the handler", async () => {
    const onEnable = vi.fn().mockResolvedValue({ ok: true, envMissing: null })
    render(<ChatStatusBanners messages={[gap()]} onEnableCapability={onEnable} />)
    fireEvent.click(screen.getByTestId("capability-gap-enable-figma"))
    await waitFor(() => expect(onEnable).toHaveBeenCalledWith("figma"))
    expect(onEnable.mock.calls[0]).toHaveLength(1)
  })

  it("does NOT claim success when the key is still missing", async () => {
    // The honesty property: config is written, but nothing works until a key
    // is supplied. Saying "Enabled!" here would send the user off to debug
    // silence.
    const onEnable = vi.fn().mockResolvedValue({ ok: true, envMissing: "FIGMA_API_KEY" })
    render(<ChatStatusBanners messages={[gap()]} onEnableCapability={onEnable} />)
    fireEvent.click(screen.getByTestId("capability-gap-enable-figma"))
    expect(
      await screen.findByText(/stays inactive until an API key is added/i),
    ).toBeInTheDocument()
    // It names WHERE to do that, and does not name a variable or a shell.
    expect(screen.getByText(/Settings under Extensions/i)).toBeInTheDocument()
    expect(screen.queryByText(/export /)).toBeNull()
  })

  it("says active-from-next-message when nothing else is needed", async () => {
    const onEnable = vi.fn().mockResolvedValue({ ok: true, envMissing: null })
    render(
      <ChatStatusBanners
        messages={[gap({ requiresEnv: null, envReady: true })]}
        onEnableCapability={onEnable}
      />,
    )
    fireEvent.click(screen.getByTestId("capability-gap-enable-figma"))
    expect(await screen.findByText(/Active from your next message/i)).toBeInTheDocument()
  })

  it("reports a failed enable and points at the panel", async () => {
    const onEnable = vi.fn().mockResolvedValue({ ok: false })
    render(<ChatStatusBanners messages={[gap()]} onEnableCapability={onEnable} />)
    fireEvent.click(screen.getByTestId("capability-gap-enable-figma"))
    expect(await screen.findByText(/Extensions panel/i)).toBeInTheDocument()
  })

  it("still explains the gap when no handler is available, without a dead button", () => {
    render(<ChatStatusBanners messages={[gap()]} />)
    expect(screen.getByText(/Figma isn't enabled/i)).toBeInTheDocument()
    expect(screen.getByTestId("capability-gap-enable-figma")).toBeDisabled()
  })
})

