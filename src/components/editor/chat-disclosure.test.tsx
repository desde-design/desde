/**
 * Unit tests for the shared chat transcript disclosure.
 *
 * The load-bearing assertion is the expanded body's container: it must read as
 * one enclosed block, not as content floating under an orphan top rule.
 */
import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { ChatDisclosure } from "./chat-disclosure"

describe("ChatDisclosure", () => {
  it("puts the border on the CARD, wrapping the header and the body together", () => {
    // Reversed 2026-08-18 (Mo). It used to assert the border belonged to the
    // BODY, which is what made the header a bare row floating above a box
    // that appeared near it. The card is now one object: border on the root,
    // header inside it, a rule between the two.
    render(
      <ChatDisclosure label="Grep" defaultOpen data-testid="d">
        <span>body content</span>
      </ChatDisclosure>,
    )
    const root = screen.getByTestId("d")
    expect(root.className).toContain("border")
    expect(root.className).toContain("rounded-md")

    // The body carries no chrome of its own — no second border to double up
    // against the card's, and no tint to seam it away from the header.
    const body = screen.getByText("body content").parentElement!
    expect(body.className).not.toMatch(/\bborder\b/)
    expect(body.className).not.toContain("bg-muted")
  })

  it("rules off the header only while it is open", () => {
    // Closed, the card is a single row; a rule along its bottom edge would
    // read as a section with nothing in it.
    // Two instances, not a rerender: `defaultOpen` is uncontrolled, so Radix
    // reads it once at mount and a rerender with a new value changes nothing.
    render(
      <>
        <ChatDisclosure label="Closed one" data-testid="closed">
          <span>a</span>
        </ChatDisclosure>
        <ChatDisclosure label="Open one" defaultOpen data-testid="open">
          <span>b</span>
        </ChatDisclosure>
      </>,
    )
    const closed = screen.getByRole("button", { name: /closed one/i })
    const open = screen.getByRole("button", { name: /open one/i })
    // One class, two states: the rule is conditional in CSS, so what has to
    // hold is that the class is present and the states differ.
    expect(closed.className).toContain("data-[state=open]:border-b")
    expect(closed).toHaveAttribute("data-state", "closed")
    expect(open).toHaveAttribute("data-state", "open")
  })

  it("carries the selectors that fuse a run of disclosures into one accordion", () => {
    // The fusing is pure CSS over DOM siblings, so there is nothing to observe
    // in jsdom (it computes no layout and applies no stylesheet). What CAN be
    // pinned is that the marker attribute and the three sibling rules are all
    // present — drop any one and a run silently un-fuses.
    render(
      <>
        <ChatDisclosure label="One" data-testid="d1">
          <span>a</span>
        </ChatDisclosure>
        <ChatDisclosure label="Two" data-testid="d2">
          <span>b</span>
        </ChatDisclosure>
      </>,
    )
    const second = screen.getByTestId("d2")
    expect(second).toHaveAttribute("data-chat-disclosure")
    expect(second.className).toContain("[[data-chat-disclosure]+&]:border-t-0")
    expect(second.className).toContain("[[data-chat-disclosure]+&]:rounded-t-none")
    expect(second.className).toContain("[&:has(+[data-chat-disclosure])]:rounded-b-none")
    // Siblings, or the CSS has nothing to match on.
    expect(screen.getByTestId("d1").nextElementSibling).toBe(second)
  })

  it("still honours a caller-supplied bodyClassName", () => {
    render(
      <ChatDisclosure label="Reasoning" defaultOpen bodyClassName="italic">
        <span>thinking</span>
      </ChatDisclosure>,
    )
    expect(screen.getByText("thinking").parentElement!.className).toContain(
      "italic",
    )
  })

  it("renders the label and keeps the body out of the DOM while collapsed", () => {
    render(
      <ChatDisclosure label="Bash">
        <span>hidden body</span>
      </ChatDisclosure>,
    )
    expect(screen.getByText("Bash")).toBeTruthy()
    expect(screen.queryByText("hidden body")).toBeNull()
  })
})
