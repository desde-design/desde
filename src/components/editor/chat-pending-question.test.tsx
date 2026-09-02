/**
 * Unit tests for <ChatPendingQuestion>.
 *
 * Focus areas:
 *   1. Renders nothing when pending is null.
 *   2. Single-select: clicking an option calls onAnswer with a 1-element array.
 *   3. Multi-select: toggling options then clicking Submit calls onAnswer
 *      with all selected options.
 *   4. Dismiss button calls onDismiss.
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import {
  ChatPendingQuestion,
  type PendingQuestion,
} from "./chat-pending-question"

function makePending(
  overrides: Partial<PendingQuestion> = {},
): PendingQuestion {
  return {
    question: "Which style do you prefer?",
    options: ["Option A", "Option B", "Option C"],
    multiSelect: false,
    resolve: vi.fn(),
    ...overrides,
  }
}

describe("ChatPendingQuestion", () => {
  it("renders nothing when pending is null", () => {
    const { container } = render(
      <ChatPendingQuestion
        pending={null}
        onAnswer={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("single-select: selection alone does not answer", () => {
    const onAnswer = vi.fn()
    render(
      <ChatPendingQuestion
        pending={makePending()}
        onAnswer={onAnswer}
        onDismiss={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText("Option B"))
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it("single-select: selecting an option then submitting answers with a 1-element array", () => {
    const onAnswer = vi.fn()
    render(
      <ChatPendingQuestion
        pending={makePending()}
        onAnswer={onAnswer}
        onDismiss={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText("Option B"))
    fireEvent.click(screen.getByRole("button", { name: /submit/i }))
    expect(onAnswer).toHaveBeenCalledOnce()
    expect(onAnswer).toHaveBeenCalledWith(["Option B"])
  })

  it("single-select: each option is independently selectable", () => {
    const onAnswer = vi.fn()
    render(
      <ChatPendingQuestion
        pending={makePending()}
        onAnswer={onAnswer}
        onDismiss={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText("Option C"))
    fireEvent.click(screen.getByRole("button", { name: /submit/i }))
    expect(onAnswer).toHaveBeenCalledWith(["Option C"])
  })

  it("multi-select: selecting options then clicking Submit calls onAnswer with all selected", () => {
    const onAnswer = vi.fn()
    render(
      <ChatPendingQuestion
        pending={makePending({ multiSelect: true })}
        onAnswer={onAnswer}
        onDismiss={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText("Option A"))
    fireEvent.click(screen.getByText("Option C"))
    fireEvent.click(screen.getByRole("button", { name: /submit/i }))

    expect(onAnswer).toHaveBeenCalledOnce()
    const selected = onAnswer.mock.calls[0][0] as string[]
    expect(selected).toHaveLength(2)
    expect(selected).toContain("Option A")
    expect(selected).toContain("Option C")
  })

  it("multi-select: Submit button is disabled when no option is selected", () => {
    render(
      <ChatPendingQuestion
        pending={makePending({ multiSelect: true })}
        onAnswer={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    const submit = screen.getByRole("button", { name: /submit/i })
    expect(submit).toBeDisabled()
  })

  it("multi-select: Submit becomes enabled after selecting at least one option", () => {
    render(
      <ChatPendingQuestion
        pending={makePending({ multiSelect: true })}
        onAnswer={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    const submit = screen.getByRole("button", { name: /submit/i })
    expect(submit).toBeDisabled()

    fireEvent.click(screen.getByText("Option B"))
    expect(submit).not.toBeDisabled()
  })

  it("multi-select: deselecting an option removes it from the selection", () => {
    const onAnswer = vi.fn()
    render(
      <ChatPendingQuestion
        pending={makePending({ multiSelect: true })}
        onAnswer={onAnswer}
        onDismiss={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText("Option A"))
    fireEvent.click(screen.getByText("Option B"))
    // Deselect Option A
    fireEvent.click(screen.getByText("Option A"))

    fireEvent.click(screen.getByRole("button", { name: /submit/i }))
    expect(onAnswer).toHaveBeenCalledWith(["Option B"])
  })

  it("single-select: dismiss button calls onDismiss", () => {
    const onDismiss = vi.fn()
    render(
      <ChatPendingQuestion
        pending={makePending()}
        onAnswer={vi.fn()}
        onDismiss={onDismiss}
      />,
    )

    fireEvent.click(screen.getByText(/dismiss/i))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it("multi-select: dismiss button calls onDismiss", () => {
    const onDismiss = vi.fn()
    render(
      <ChatPendingQuestion
        pending={makePending({ multiSelect: true })}
        onAnswer={vi.fn()}
        onDismiss={onDismiss}
      />,
    )

    fireEvent.click(screen.getByText(/dismiss/i))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it("multi-select: selection does NOT carry over when a new question arrives (codex P2 regression)", () => {
    const onAnswer = vi.fn()
    // Two distinct PendingQuestion objects, as editor-surface mints per call.
    const qA = makePending({
      multiSelect: true,
      options: ["A1", "A2"],
      question: "First multi-select?",
    })
    const qB = makePending({
      multiSelect: true,
      options: ["B1", "B2"],
      question: "Second multi-select?",
    })
    const { rerender } = render(
      <ChatPendingQuestion
        pending={qA}
        onAnswer={onAnswer}
        onDismiss={vi.fn()}
      />,
    )
    // Select in question A.
    fireEvent.click(screen.getByRole("checkbox", { name: "A1" }))
    expect(screen.getByRole("checkbox", { name: "A1" })).toHaveAttribute(
      "aria-checked",
      "true",
    )

    // A new question arrives (different object identity).
    rerender(
      <ChatPendingQuestion
        pending={qB}
        onAnswer={onAnswer}
        onDismiss={vi.fn()}
      />,
    )
    // No B option should be pre-checked, and Submit is disabled (nothing
    // carried over from question A).
    expect(screen.getByRole("checkbox", { name: "B1" })).toHaveAttribute(
      "aria-checked",
      "false",
    )
    expect(screen.getByRole("checkbox", { name: "B2" })).toHaveAttribute(
      "aria-checked",
      "false",
    )
    expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled()
  })

  it("renders the question text", () => {
    render(
      <ChatPendingQuestion
        pending={makePending({ question: "What color should the button be?" })}
        onAnswer={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    expect(
      screen.getByText("What color should the button be?"),
    ).toBeInTheDocument()
  })

  it("renders all option labels", () => {
    render(
      <ChatPendingQuestion
        pending={makePending({ options: ["Red", "Blue", "Green"] })}
        onAnswer={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    expect(screen.getByText("Red")).toBeInTheDocument()
    expect(screen.getByText("Blue")).toBeInTheDocument()
    expect(screen.getByText("Green")).toBeInTheDocument()
  })
})
