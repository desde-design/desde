/**
 * Tests for DeleteScopeDialog — the modal that forces an explicit
 * definition-vs-callsite choice when deleting an element inside a reused
 * component. Dumb component: open/node/onConfirm/onCancel props in,
 * scope choice out.
 */

import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { OutlineNode } from "@/types/bridge"
import { DeleteScopeDialog } from "./delete-scope-dialog"

function makeNode(overrides: Partial<OutlineNode> = {}): OutlineNode {
  return {
    id: "n1",
    name: "div",
    type: "element",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    selector: ".row",
    authoredAt: { file: "src/components/Card.vue", line: 8, column: 5 },
    editTarget: {
      file: "src/pages/Dashboard.vue",
      line: 12,
      column: 5,
    },
    ...overrides,
  }
}

function defaultProps() {
  return {
    open: true,
    node: makeNode(),
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  }
}

describe("DeleteScopeDialog", () => {
  /**
   * editor-surface keeps this dialog mounted and toggles `open`, so a
   * `useState` initializer runs once with `node === null`. Left that way the
   * default was never computed for any real node (the Delete button opened
   * dead), and a scope chosen for one element survived into the next one.
   */
  it("seeds the default for the first real node, and re-seeds per node", () => {
    const onConfirm = vi.fn()
    const { rerender } = render(
      <DeleteScopeDialog
        open={false}
        node={null}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    )
    rerender(
      <DeleteScopeDialog
        open
        node={makeNode()}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByTestId("delete-scope-confirm")).not.toBeDisabled()

    // Pick the wider scope, then hand the dialog a different element.
    fireEvent.click(screen.getByTestId("delete-scope-definition"))
    rerender(
      <DeleteScopeDialog
        open
        node={makeNode({ id: "n2", selector: ".other" })}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId("delete-scope-confirm"))
    // Back to the narrower default, not the previous element's choice.
    expect(onConfirm.mock.calls[0][0]).toBe("callsite")
  })

  it("renders both scope options with file basenames", () => {
    render(<DeleteScopeDialog {...defaultProps()} />)
    expect(screen.getByTestId("delete-scope-dialog")).toBeInTheDocument()
    const callsite = screen.getByTestId("delete-scope-callsite")
    const definition = screen.getByTestId("delete-scope-definition")
    expect(callsite).toHaveTextContent("Delete this instance")
    expect(callsite).toHaveTextContent("Dashboard.vue")
    expect(definition).toHaveTextContent("Delete from component")
    expect(definition).toHaveTextContent("Card.vue")
  })

  it("clicking 'Delete this instance' confirms with callsite scope", () => {
    const props = defaultProps()
    render(<DeleteScopeDialog {...props} />)
    fireEvent.click(screen.getByTestId("delete-scope-callsite"))
    fireEvent.click(screen.getByTestId("delete-scope-confirm"))
    expect(props.onConfirm).toHaveBeenCalledWith("callsite")
  })

  it("clicking 'Delete from component' confirms with definition scope", () => {
    const props = defaultProps()
    render(<DeleteScopeDialog {...props} />)
    fireEvent.click(screen.getByTestId("delete-scope-definition"))
    fireEvent.click(screen.getByTestId("delete-scope-confirm"))
    expect(props.onConfirm).toHaveBeenCalledWith("definition")
  })

  it("clicking Cancel calls onCancel without confirming", () => {
    const props = defaultProps()
    render(<DeleteScopeDialog {...props} />)
    fireEvent.click(screen.getByTestId("delete-scope-cancel"))
    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it("disables 'Delete from component' when the definition is library source", () => {
    const props = defaultProps()
    props.node = makeNode({
      authoredAt: {
        file: "node_modules/@acme/design-system/dist/UiCard.vue",
        line: 3,
        column: 1,
      },
    })
    render(<DeleteScopeDialog {...props} />)
    const definition = screen.getByTestId("delete-scope-definition")
    // The testid is on the card <label>; disabled lives on the radio inside.
    expect(within(definition).getByRole("radio", { hidden: true })).toBeDisabled()
    // Same vocabulary as the dead end: the hint names the package it belongs
    // to, and keeps the file name, which is what tells the two cards apart.
    expect(definition).toHaveTextContent(
      /Can't edit UiCard\.vue: it's part of @acme\/design-system, an external library/,
    )
    expect(definition).not.toHaveTextContent(/library source/i)
    fireEvent.click(definition)
    expect(props.onConfirm).not.toHaveBeenCalled()
    // The call-site option stays available.
    fireEvent.click(screen.getByTestId("delete-scope-callsite"))
    fireEvent.click(screen.getByTestId("delete-scope-confirm"))
    expect(props.onConfirm).toHaveBeenCalledWith("callsite")
  })

  it("renders nothing when closed", () => {
    render(<DeleteScopeDialog {...defaultProps()} open={false} node={null} />)
    expect(screen.queryByTestId("delete-scope-dialog")).not.toBeInTheDocument()
  })

  /**
   * The dead end. Both files library source, so neither scope is expressible.
   * This used to render two greyed option cards above a greyed Delete: three
   * controls, none of them live. It is now a message with one way out.
   */
  describe("when no scope is available", () => {
    function deadEndProps() {
      const props = defaultProps()
      props.node = makeNode({
        name: "UiButton",
        authoredAt: {
          file: "node_modules/@acme/ds/dist/UiButton.vue",
          line: 3,
          column: 1,
        },
        editTarget: {
          file: "node_modules/@acme/ds/dist/UiCard.vue",
          line: 9,
          column: 2,
        },
      })
      return props
    }

    it("offers no options and no delete button", () => {
      render(<DeleteScopeDialog {...deadEndProps()} />)
      expect(screen.queryByTestId("delete-scope-callsite")).not.toBeInTheDocument()
      expect(
        screen.queryByTestId("delete-scope-definition"),
      ).not.toBeInTheDocument()
      expect(screen.queryByTestId("delete-scope-confirm")).not.toBeInTheDocument()
      // Not a disabled radio anywhere either — the point is absence, not greying.
      expect(screen.queryAllByRole("radio", { hidden: true })).toHaveLength(0)
    })

    /**
     * The vocabulary rule, pinned. "library source" said two things wrong at
     * once: "source" reads as origin rather than as files, and a designer
     * coming from Figma reads "library" as a shared asset they CAN edit. The
     * assertions below are deliberately negative as well as positive, because
     * the failure mode is the old phrase creeping back into one branch.
     */
    it("names the external library, not the files, and never says 'library source'", () => {
      render(<DeleteScopeDialog {...deadEndProps()} />)
      expect(screen.getByRole("heading")).toHaveTextContent(
        /can't delete\s*<?UiButton>?/i,
      )
      const reason = screen.getByTestId("delete-scope-unavailable-reason")
      expect(reason).toHaveTextContent(/@acme\/ds, an external library/)
      expect(reason).not.toHaveTextContent(/library source/i)
      // The designer has never opened these and cannot place them. The package
      // name replaces them; it does not sit beside them.
      expect(reason).not.toHaveTextContent(/UiCard\.vue/)
      expect(reason).not.toHaveTextContent(/node_modules/)
    })

    it("gives one next step, and it is one the product supports", () => {
      render(<DeleteScopeDialog {...deadEndProps()} />)
      const reason = screen.getByTestId("delete-scope-unavailable-reason")
      expect(reason).toHaveTextContent(/Ask chat how to remove/)
      // The product is never the subject. Copy is about the user's work, not
      // about what the tool can or cannot do.
      expect(reason).not.toHaveTextContent(/\bDesde\b|\bEditor\b/)
      // Detach and swap are both default-OFF lanes refused at dispatch, and
      // "fork it into your prototype" is a manual workaround, not a feature.
      // None of them may be offered here as if they were.
      expect(reason).not.toHaveTextContent(/detach|fork|swap/i)
    })

    it("falls back to the file names when the path yields no package name", () => {
      const props = deadEndProps()
      props.node = makeNode({
        name: "UiButton",
        // Directly under node_modules, so there is no package directory to
        // name. The files carry the identity instead of a fragment.
        authoredAt: { file: "node_modules/stray.vue", line: 3, column: 1 },
        editTarget: { file: "node_modules/other.vue", line: 9, column: 2 },
      })
      render(<DeleteScopeDialog {...props} />)
      const reason = screen.getByTestId("delete-scope-unavailable-reason")
      expect(reason).toHaveTextContent(/an external library, not from your project/)
      expect(reason).toHaveTextContent(/other\.vue and stray\.vue/)
      expect(reason).not.toHaveTextContent(/undefined/)
    })

    it("dedupes when the call site and the definition are the same file", () => {
      const props = deadEndProps()
      const file = "node_modules/stray.vue"
      props.node = makeNode({
        name: "UiButton",
        authoredAt: { file, line: 3, column: 1 },
        editTarget: { file, line: 3, column: 1 },
      })
      render(<DeleteScopeDialog {...props} />)
      const reason = screen.getByTestId("delete-scope-unavailable-reason")
      expect(reason).toHaveTextContent(/\(stray\.vue\)/)
      expect(reason).not.toHaveTextContent(/stray\.vue and stray\.vue/)
    })

    it("does not claim it came from a package when no file resolved at all", () => {
      const props = deadEndProps()
      props.node = makeNode({
        name: "UiButton",
        authoredAt: undefined,
        editTarget: undefined,
      })
      render(<DeleteScopeDialog {...props} />)
      const reason = screen.getByTestId("delete-scope-unavailable-reason")
      expect(reason).not.toHaveTextContent(/external library/i)
      expect(reason).not.toHaveTextContent(/library source/i)
      expect(reason).toHaveTextContent(/couldn't be traced back to a file/i)
      expect(reason).not.toHaveTextContent(/\bDesde\b|\bEditor\b/)
    })

    it("Close is the only action, and it cancels", () => {
      const props = deadEndProps()
      render(<DeleteScopeDialog {...props} />)
      fireEvent.click(screen.getByTestId("delete-scope-close"))
      expect(props.onCancel).toHaveBeenCalledTimes(1)
      expect(props.onConfirm).not.toHaveBeenCalled()
    })
  })
})
