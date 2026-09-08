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

/**
 * The grid's cells (Mo, 2026-09-08): no border on each cell, a plain-words
 * tooltip saying where the children go, and a selected cell that can be
 * seen. The old selected state was the Toggle's grey `on` fill on the grid's
 * own grey ground, with a WHITE dot on it: three greys and a white, which
 * is why "the value is set but nothing is highlighted".
 */
describe("AlignSizeSection — the grid's cells", () => {
  function renderGrid(classes: string[]) {
    return render(
      <AlignSizeSection classes={classes} computedStyles={{ display: "flex" }} onClassesChange={vi.fn()} />,
    )
  }
  const cells = () => screen.getAllByTestId(/^align-cell-/)

  it("draws no border around a cell", () => {
    renderGrid(["flex"])
    for (const cell of cells()) expect(cell.className).not.toMatch(/(^|\s)border(\s|$)/)
  })

  it("names each cell by where it puts the children, not by its classes", () => {
    renderGrid(["flex"])
    expect(screen.getByTestId("align-cell-end-start")).toHaveAttribute("aria-label", "Align top right")
    expect(screen.getByTestId("align-cell-start-center")).toHaveAttribute("aria-label", "Align middle left")
    expect(screen.getByTestId("align-cell-center-center")).toHaveAttribute("aria-label", "Align center")
    expect(screen.getByTestId("align-cell-center-end")).toHaveAttribute("aria-label", "Align bottom center")
    for (const cell of cells()) expect(cell).not.toHaveAttribute("title")
  })

  it("shows that name as a tooltip", async () => {
    renderGrid(["flex"])
    // Focus opens a Radix tooltip without the hover delay.
    fireEvent.focus(screen.getByTestId("align-cell-end-start"))
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Align top right")
  })

  it("fills the selected cell with the accent and colours its dot", () => {
    renderGrid(["flex", "justify-end", "items-start"])
    const on = screen.getByTestId("align-cell-end-start")
    const off = screen.getByTestId("align-cell-start-start")
    // `aria-pressed`, not `data-state`: the tooltip trigger wrapping each
    // cell writes its own open/closed `data-state` over the toggle's.
    expect(on).toHaveAttribute("aria-pressed", "true")
    expect(on.className).toContain("aria-pressed:bg-primary/10")
    expect(on.querySelector("span")!.className).toContain("bg-primary")
    expect(off.querySelector("span")!.className).not.toMatch(/(^|\s)bg-primary(\s|$)/)
  })

  it("reads an unset justify as the CSS default, start", () => {
    // `flex items-center` with no justify class lays children out at the
    // middle left, so that is the cell to light.
    renderGrid(["flex", "items-center"])
    expect(screen.getByTestId("align-cell-start-center")).toHaveAttribute("aria-pressed", "true")
  })

  it("lights nothing when justify is set to something the grid cannot show", () => {
    renderGrid(["flex", "justify-between", "items-center"])
    for (const cell of cells()) expect(cell).toHaveAttribute("aria-pressed", "false")
  })
})
