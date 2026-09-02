/**
 * Component tests for AlignSizeSection (direct-manip Phase 1). Asserts the
 * box-with-dots + segment rows commit the right class diff through
 * onClassesChange (the inherited dispatch path).
 */

import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { AlignSizeSection } from "./align-size-section"

describe("AlignSizeSection", () => {
  it("shows the flex grid only for flex/grid containers", () => {
    const { rerender } = render(
      <AlignSizeSection classes={["block"]} computedStyles={{ display: "block" }} onClassesChange={vi.fn()} />,
    )
    expect(screen.queryByTestId("align-grid")).not.toBeInTheDocument()
    rerender(
      <AlignSizeSection classes={["flex"]} computedStyles={{ display: "flex" }} onClassesChange={vi.fn()} />,
    )
    expect(screen.getByTestId("align-grid")).toBeInTheDocument()
  })

  it("picking a grid cell commits both justify- and items- classes", () => {
    const onClassesChange = vi.fn()
    render(
      <AlignSizeSection
        classes={["flex", "gap-2"]}
        computedStyles={{ display: "flex" }}
        onClassesChange={onClassesChange}
      />,
    )
    fireEvent.click(screen.getByTestId("align-cell-center-end"))
    expect(onClassesChange).toHaveBeenCalledTimes(1)
    const next = onClassesChange.mock.calls[0][0] as string[]
    expect(next).toContain("justify-center")
    expect(next).toContain("items-end")
    expect(next).toContain("flex")
    expect(next).toContain("gap-2")
  })

  it("reflects the current value as the active cell", () => {
    render(
      <AlignSizeSection
        classes={["flex", "justify-end", "items-start"]}
        computedStyles={{ display: "flex" }}
        onClassesChange={vi.fn()}
      />,
    )
    expect(screen.getByTestId("align-cell-end-start")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("align-cell-start-start")).toHaveAttribute("aria-pressed", "false")
  })

  it("does NOT render a text-align row (TypographySection owns it, scope-gated)", () => {
    render(
      <AlignSizeSection
        classes={["text-center"]}
        computedStyles={{ display: "block" }}
        onClassesChange={vi.fn()}
      />,
    )
    expect(screen.queryByTestId("text-align-row")).not.toBeInTheDocument()
  })

  it("width preset replaces a prior fixed width", () => {
    const onClassesChange = vi.fn()
    render(
      <AlignSizeSection
        classes={["w-64", "rounded"]}
        computedStyles={{ display: "block" }}
        onClassesChange={onClassesChange}
      />,
    )
    fireEvent.click(screen.getByTestId("width-full"))
    const next = onClassesChange.mock.calls[0][0] as string[]
    expect(next).toContain("w-full")
    expect(next).not.toContain("w-64")
    expect(next).toContain("rounded")
  })
})
