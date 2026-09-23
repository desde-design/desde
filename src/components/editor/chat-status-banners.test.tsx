/**
 * Three things this file pins, all about copy rather than behaviour.
 *
 * First, the rate-limit banner is provider-neutral (fixed 2026-09-22, fix
 * round 1 on the rate-limit-events task). It used to be Anthropic's only:
 * `status` / `overageStatus` / `utilization` model Anthropic's subscription
 * overage credit pool, and the copy used to hard-code "this Claude account".
 * That stopped being safe once the neutral loop started raising the same
 * event kind off a bare 429 (see `run-chat-turn-neutral.ts`'s
 * `streamStepWithRetry`), so an OpenAI session can reach this banner now.
 * Two things carry the fix: `providerLabel` names the right account, and the
 * overage-credit sentence only appears when the event actually carries an
 * Anthropic-specific field (`rateLimitType` or `overageStatus`).
 *
 * Second, `vendorRateLimitEvents` is still a belt-and-braces gate: a
 * provider whose descriptor says it is false can never produce this event in
 * the first place, so the banner must not be reachable for it.
 *
 * Third, the house copy rules apply to product strings, not only to the
 * marketing site: no em dashes, and no first person.
 */
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { ChatStatusBanners } from "./chat-status-banners"

const rateLimitMessage = {
  id: "m1",
  kind: "rate_limit_warning" as const,
  status: "rejected" as const,
  overageStatus: "rejected" as const,
  utilization: 1,
  resetsAt: undefined,
}

describe("ChatStatusBanners — rate limit", () => {
  it("renders the banner for a provider that reports vendor rate-limit events", () => {
    render(
      <ChatStatusBanners
        messages={[rateLimitMessage]}
        vendorRateLimitEvents
        onDismiss={() => {}}
      />,
    )
    expect(screen.getByText(/usage limit for this Claude account/i)).toBeInTheDocument()
  })

  it("renders nothing for a provider that cannot produce the event", () => {
    render(
      <ChatStatusBanners
        messages={[rateLimitMessage]}
        vendorRateLimitEvents={false}
        onDismiss={() => {}}
      />,
    )
    expect(screen.queryByText(/Claude account/i)).not.toBeInTheDocument()
  })

  it("keeps the banner's copy free of em dashes and first person", () => {
    const { container } = render(
      <ChatStatusBanners
        messages={[rateLimitMessage, { ...rateLimitMessage, id: "m2", status: "allowed_warning" as const }]}
        vendorRateLimitEvents
        onDismiss={() => {}}
      />,
    )
    const text = container.textContent ?? ""
    expect(text).not.toMatch(/—/)
    expect(text).not.toMatch(/\b(?:my|me)\b/i)
  })

  it("renders an OpenAI 429 with the OpenAI label and no overage-credit sentence", () => {
    // The shape the neutral loop's streamStepWithRetry actually emits for a
    // 429: status and retryAfterSeconds only, none of the Anthropic
    // structured fields (no rateLimitType, no overageStatus, no utilization).
    const openAiMessage = {
      id: "m-openai",
      kind: "rate_limit_warning" as const,
      status: "rejected" as const,
      retryAfterSeconds: 7,
    }
    render(
      <ChatStatusBanners
        messages={[openAiMessage]}
        vendorRateLimitEvents
        providerLabel="OpenAI"
        onDismiss={() => {}}
      />,
    )
    expect(screen.getByText(/usage limit for this OpenAI account/i)).toBeInTheDocument()
    expect(screen.queryByText(/Claude account/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/extra credits/i)).not.toBeInTheDocument()
  })

  it("still renders the Anthropic overage-credit sentence when the vendor fields are present", () => {
    render(
      <ChatStatusBanners
        messages={[rateLimitMessage]}
        vendorRateLimitEvents
        providerLabel="Anthropic"
        onDismiss={() => {}}
      />,
    )
    expect(screen.getByText(/usage limit for this Anthropic account/i)).toBeInTheDocument()
    expect(screen.getByText(/no extra credits available/i)).toBeInTheDocument()
  })
})
