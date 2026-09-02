/**
 * Tests for IterationScopeDialog — the modal that forces an explicit
 * this-row / all-rows choice when editing an iterated element.
 */

import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { IterationScopeDialog } from "./iteration-scope-dialog"

function defaultProps() {
  return {
    open: true,
    editKind: "delete" as const,
    siblingCount: 8,
    rowIndex: 3,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  }
}

describe("IterationScopeDialog", () => {
  it("renders with item count and offers both scope choices", () => {
    render(<IterationScopeDialog {...defaultProps()} />)
    expect(screen.getByTestId("iteration-scope-dialog")).toBeInTheDocument()
    expect(screen.getByTestId("iteration-scope-this-row")).toBeInTheDocument()
    expect(screen.getByTestId("iteration-scope-all-rows")).toBeInTheDocument()
    expect(screen.getByText(/item 4 of 8/i)).toBeInTheDocument()
  })

  // The options are radio cards, so selecting one does NOT commit: the
  // footer button does. That separation is the point, because these choices
  // rewrite either one item's data or the loop every item comes from, and a
  // misclick should not be able to do either.
  it("does not confirm on selection alone", () => {
    const props = defaultProps()
    render(<IterationScopeDialog {...props} />)
    fireEvent.click(screen.getByTestId("iteration-scope-all-rows"))
    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it("emits 'this-row' when that card is selected and confirmed", () => {
    const props = defaultProps()
    render(<IterationScopeDialog {...props} />)
    fireEvent.click(screen.getByTestId("iteration-scope-this-row"))
    fireEvent.click(screen.getByTestId("iteration-scope-confirm"))
    expect(props.onConfirm).toHaveBeenCalledWith("this-row", false)
  })

  it("emits 'all-rows' when that card is selected and confirmed", () => {
    const props = defaultProps()
    render(<IterationScopeDialog {...props} />)
    fireEvent.click(screen.getByTestId("iteration-scope-all-rows"))
    fireEvent.click(screen.getByTestId("iteration-scope-confirm"))
    expect(props.onConfirm).toHaveBeenCalledWith("all-rows", false)
  })

  it("pre-selects this-row so the primary button is never dead on open", () => {
    const props = defaultProps()
    render(<IterationScopeDialog {...props} />)
    expect(screen.getByTestId("iteration-scope-confirm")).toBeEnabled()
    fireEvent.click(screen.getByTestId("iteration-scope-confirm"))
    expect(props.onConfirm).toHaveBeenCalledWith("this-row", false)
  })

  // The `thisRowEnabled` gate was deleted 2026-08-16 when the `patch-text`
  // lane gave dom-text a real this-row path. It was the last kind without one,
  // so a gate that could only ever be true is a gate someone has to re-read.
  // What replaces those two tests is the invariant they were guarding: the
  // narrower blast radius is offered, and preselected, for EVERY kind.
  it.each(["delete", "prop", "move", "dom-text"] as const)(
    "offers this-row for %s and preselects it",
    (editKind) => {
      const props = { ...defaultProps(), editKind }
      render(<IterationScopeDialog {...props} />)
      const card = screen.getByTestId("iteration-scope-this-row")
      expect(within(card).getByRole("radio", { hidden: true })).not.toBeDisabled()
      fireEvent.click(screen.getByTestId("iteration-scope-confirm"))
      expect(props.onConfirm).toHaveBeenCalledWith("this-row", false)
    },
  )

  // The "remember my choice" checkbox is DORMANT (EDITOR_REMEMBER_SCOPE_CHOICE).
  // The `remember` parameter and the caller's memory map stay wired, so this
  // pins BOTH halves: the control is gone, and the value it fed is now always
  // false — which is what stops `iterationScopeMemoryRef` from ever being
  // written while the flag is off.
  it("does not offer the remember checkbox, and always confirms remember=false", () => {
    const props = defaultProps()
    render(<IterationScopeDialog {...props} />)
    expect(screen.queryByTestId("iteration-scope-remember")).toBeNull()
    fireEvent.click(screen.getByTestId("iteration-scope-this-row"))
    fireEvent.click(screen.getByTestId("iteration-scope-confirm"))
    expect(props.onConfirm).toHaveBeenCalledWith("this-row", false)
  })


  // The option titles are deliberately kind-agnostic ("This item" / "All
  // items"); the verb lives in the heading, the confirm button and the hints.
  // Assert those, or this test passes for every kind and proves nothing.
  it("uses edit-kind-specific copy", () => {
    render(
      <IterationScopeDialog {...defaultProps()} editKind="duplicate" />,
    )
    expect(screen.getByRole("heading")).toHaveTextContent(/^Duplicate/)
    expect(screen.getByTestId("iteration-scope-confirm")).toHaveTextContent(
      "Duplicate",
    )
    expect(screen.getByText(/Duplicates the whole loop/i)).toBeInTheDocument()
  })

  it("calls onCancel when the cancel button is clicked", () => {
    const props = defaultProps()
    render(<IterationScopeDialog {...props} />)
    fireEvent.click(screen.getByTestId("iteration-scope-cancel"))
    expect(props.onCancel).toHaveBeenCalled()
  })
})
