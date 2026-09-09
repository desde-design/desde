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

  // Both ends of one gate. `dispatchIterationEdit` refuses a remove or a
  // reorder when the picked element sits inside the item rather than being
  // the item, and hands it to chat; the dialog must not promise the data edit
  // it will not make.
  describe("when the picked element sits inside the item", () => {
    it("says a delete goes to chat instead of describing a data edit", () => {
      render(
        <IterationScopeDialog {...defaultProps()} thisItemGoesToChat />,
      )
      const thisItem = screen.getByTestId("iteration-scope-this-row")
      expect(within(thisItem).getByText(/Goes to chat/i)).toBeInTheDocument()
      expect(
        screen.queryByText(/Removes one entry from the data/i),
      ).toBeNull()
    })

    it("says a move goes to chat instead of describing a reorder", () => {
      render(
        <IterationScopeDialog
          {...defaultProps()}
          editKind="move"
          thisItemGoesToChat
        />,
      )
      const thisItem = screen.getByTestId("iteration-scope-this-row")
      expect(within(thisItem).getByText(/Goes to chat/i)).toBeInTheDocument()
      expect(screen.queryByText(/Reorders this entry/i)).toBeNull()
    })

    it("leaves the data hint alone for the kinds that name a field", () => {
      // `prop` and `dom-text` patch a named field of the entry, so the loop
      // redirection is right for them and the flag never arrives set. Even if
      // it did, there is no chat hint to swap in.
      render(
        <IterationScopeDialog
          {...defaultProps()}
          editKind="prop"
          thisItemGoesToChat
        />,
      )
      expect(
        screen.getByText(/Changes one entry in the data/i),
      ).toBeInTheDocument()
      expect(screen.queryByText(/Goes to chat/i)).toBeNull()
    })

    it("shows the ordinary hint when the flag is not set", () => {
      render(<IterationScopeDialog {...defaultProps()} />)
      expect(
        screen.getByText(/Removes one entry from the data/i),
      ).toBeInTheDocument()
      expect(screen.queryByText(/Goes to chat/i)).toBeNull()
    })

    /**
     * "All items" edits the shared template, and WHAT that edit is depends on
     * which element in the template was picked. On the loop element it is the
     * loop. On something nested inside a row it is that element in every item,
     * and every item goes on rendering. The plain hints described only the
     * first, so this card promised the set would disappear when one label
     * inside each item was about to.
     */
    it("says a delete takes the element out of every item, not the loop", () => {
      render(<IterationScopeDialog {...defaultProps()} clickedInsideItem />)
      const allItems = screen.getByTestId("iteration-scope-all-rows")
      expect(
        within(allItems).getByText(
          "Removes this element from every item. The items themselves stay.",
        ),
      ).toBeInTheDocument()
      expect(screen.queryByText(/Removes the loop that renders them/i)).toBeNull()
    })

    it("says a move moves the element within every item, not the whole set", () => {
      render(
        <IterationScopeDialog {...defaultProps()} editKind="move" clickedInsideItem />,
      )
      const allItems = screen.getByTestId("iteration-scope-all-rows")
      expect(
        within(allItems).getByText("Moves this element within every item."),
      ).toBeInTheDocument()
      expect(screen.queryByText(/Moves the whole set/i)).toBeNull()
    })

    it("leaves the all-items hint alone for the kinds that name a field", () => {
      // `prop` and `dom-text` write one named field of the shared template
      // either way, so nesting does not change what the edit is.
      render(
        <IterationScopeDialog {...defaultProps()} editKind="prop" clickedInsideItem />,
      )
      expect(screen.getByText(/Changes the loop itself/i)).toBeInTheDocument()
    })

    it("shows the ordinary all-items hint when the click was on the item itself", () => {
      render(<IterationScopeDialog {...defaultProps()} />)
      expect(
        screen.getByText(/Removes the loop that renders them/i),
      ).toBeInTheDocument()
      expect(screen.queryByText(/from every item/i)).toBeNull()
    })

    it("neither nested hint uses an em dash or the first person", () => {
      for (const editKind of ["delete", "move"] as const) {
        const { unmount } = render(
          <IterationScopeDialog {...defaultProps()} editKind={editKind} clickedInsideItem />,
        )
        const hint = screen.getByTestId("iteration-scope-all-rows").textContent ?? ""
        expect(hint).not.toMatch(/—/)
        expect(hint).not.toMatch(/\b(me|my)\b/i)
        unmount()
      }
    })
  })
})
