/**
 * Two things this file pins, both about copy rather than behaviour.
 *
 * First, the rate-limit banner is Anthropic's. Its status / overageStatus /
 * utilization fields model Anthropic's subscription overage credit pool and its
 * copy names "this Claude account". A provider whose descriptor says
 * vendorRateLimitEvents is false can never produce that event, so the banner
 * must not be reachable for it: rendering Anthropic's words over an OpenAI
 * session would be a confident lie rather than a missing feature.
 *
 * Second, the house copy rules apply to product strings, not only to the
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
})
