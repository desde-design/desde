import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { CommentModeButton } from "./comment-mode-button"
import { useAppStore } from "@/stores"

beforeEach(() => useAppStore.setState({ toolMode: "navigate" }))
// Wrapped in act: RTL's auto-cleanup runs after this hook, so the reset
// lands while the buttons are still mounted.
afterEach(() => act(() => useAppStore.setState({ toolMode: "navigate" })))

describe("CommentModeButton", () => {
  it("asks to enter when it is off and to leave when it is on", () => {
    const onCommentModeChange = vi.fn()
    render(
      <CommentModeButton
        onCommentModeChange={onCommentModeChange}
        testId="one"
      />,
    )

    fireEvent.click(screen.getByTestId("one"))
    expect(onCommentModeChange).toHaveBeenLastCalledWith(true)

    act(() => useAppStore.setState({ toolMode: "comment" }))
    fireEvent.click(screen.getByTestId("one"))
    expect(onCommentModeChange).toHaveBeenLastCalledWith(false)
  })

  // The second half of this branch's Comment defect. There were two controls
  // for one action: a toolbar toggle with an active state, and the Comments
  // panel header's enter-only button on a different icon and a different
  // shape, which could not exit the mode it started. The toolbar's half is a
  // tool picker now, so only the panel mounts this — but the property that
  // fixed the defect is that the state is DERIVED from the store, not passed
  // in, so any two mounts agree without being told about each other. That is
  // what this asserts, and it is what a second caller would inherit.
  it("reports the same state everywhere it is mounted", () => {
    const onCommentModeChange = vi.fn()
    render(
      <>
        <CommentModeButton
          onCommentModeChange={onCommentModeChange}
          testId="first"
        />
        <CommentModeButton
          onCommentModeChange={onCommentModeChange}
          testId="second"
        />
      </>,
    )

    const first = screen.getByTestId("first")
    const second = screen.getByTestId("second")

    const agree = () =>
      first.getAttribute("aria-pressed") === second.getAttribute("aria-pressed")

    expect(agree()).toBe(true)
    expect(first.getAttribute("aria-pressed")).toBe("false")

    act(() => useAppStore.setState({ toolMode: "comment" }))
    expect(agree()).toBe(true)
    expect(first.getAttribute("aria-pressed")).toBe("true")

    // Select is a value of the same field, so it turns BOTH of them off.
    act(() => useAppStore.setState({ toolMode: "select" }))
    expect(agree()).toBe(true)
    expect(second.getAttribute("aria-pressed")).toBe("false")

    // Same icon and same label in both mounts, not just the same state.
    expect(first.textContent).toBe(second.textContent)
    expect(first.querySelector("svg")?.getAttribute("class")).toBe(
      second.querySelector("svg")?.getAttribute("class"),
    )
    expect(first.className).toBe(second.className)
  })

  it("names the action it will take", () => {
    render(<CommentModeButton onCommentModeChange={vi.fn()} testId="one" />)
    expect(screen.getByTestId("one").getAttribute("title")).toBe("Add comment")

    act(() => useAppStore.setState({ toolMode: "comment" }))
    expect(screen.getByTestId("one").getAttribute("title")).toBe(
      "Exit comment mode",
    )
  })
})
