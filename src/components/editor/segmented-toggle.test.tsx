import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { SegmentedToggle } from "./segmented-toggle"

const VIEW_OPTIONS = [
  { value: "editor" as const, label: "Editor" },
  { value: "canvas" as const, label: "Canvas" },
]

// SegmentedToggle now wraps shadcn's native Tabs (TabsList/TabsTrigger)
// used as a segmented control, so items render as role="tab" with
// data-state active/inactive. Keyboard roving is the primitive's
// responsibility (covered by radix/shadcn), so these tests focus on the
// wrapper's value/onChange contract.

describe("SegmentedToggle", () => {
  it("renders both options with correct selected state", () => {
    render(
      <SegmentedToggle
        value="editor"
        options={VIEW_OPTIONS}
        onChange={() => {}}
        ariaLabel="View"
      />,
    )
    const editor = screen.getByRole("tab", { name: /editor/i })
    const canvas = screen.getByRole("tab", { name: /canvas/i })
    expect(editor.getAttribute("data-state")).toBe("active")
    expect(canvas.getAttribute("data-state")).toBe("inactive")
  })

  it("fires onChange when clicking the unselected option", () => {
    const onChange = vi.fn()
    render(
      <SegmentedToggle
        value="editor"
        options={VIEW_OPTIONS}
        onChange={onChange}
        ariaLabel="View"
      />,
    )
    fireEvent.mouseDown(screen.getByRole("tab", { name: /canvas/i }))
    expect(onChange).toHaveBeenCalledWith("canvas")
  })

  it("does not fire onChange when clicking the already-selected option", () => {
    const onChange = vi.fn()
    render(
      <SegmentedToggle
        value="editor"
        options={VIEW_OPTIONS}
        onChange={onChange}
        ariaLabel="View"
      />,
    )
    // Radix Tabs does not fire onValueChange when the active tab is
    // re-clicked, so the control always keeps a selection.
    fireEvent.mouseDown(screen.getByRole("tab", { name: /editor/i }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("renders shortcut hints when provided", () => {
    render(
      <SegmentedToggle
        value="a"
        options={[
          { value: "a", label: "A", shortcut: "1" },
          { value: "b", label: "B", shortcut: "2" },
        ]}
        onChange={() => {}}
        ariaLabel="AB"
      />,
    )
    expect(screen.getByText("1")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
  })

  it("gives an icon-plus-label option an explicit aria-label (F-10 regression)", () => {
    // MEASURED live 2026-09-01 in the editor surface gallery: the toolbar's
    // Navigate/Select/Comment tabs (icon rendered ahead of the `<span>`
    // label, exactly this shape) reached the real browser's accessibility
    // tree with NO computed name at all — a screen reader announced "tab"
    // three times with nothing to tell them apart. A plain-text tab (no
    // icon) got its name fine, so the icon is what broke name-from-content
    // there. jsdom's own accessible-name computation does NOT reproduce
    // that (it folds the visible `<span>` text regardless of the icon), so
    // this test asserts the actual fix instead: each option gets an
    // explicit `aria-label` matching its visible text, which is what makes
    // the real browser stop depending on name-from-content at all. Without
    // it, `aria-label` is absent and this assertion fails.
    render(
      <SegmentedToggle
        value="navigate"
        options={[
          {
            value: "navigate",
            label: "Navigate",
            icon: <svg aria-hidden="true" />,
          },
          {
            value: "select",
            label: "Select",
            icon: <svg aria-hidden="true" />,
          },
        ]}
        onChange={() => {}}
        ariaLabel="Prototype tool"
      />,
    )
    expect(screen.getByRole("tab", { name: "Navigate" })).toHaveAttribute(
      "aria-label",
      "Navigate",
    )
    expect(screen.getByRole("tab", { name: "Select" })).toHaveAttribute(
      "aria-label",
      "Select",
    )
  })

  it("disabled options are disabled and don't fire onChange on click", () => {
    const onChange = vi.fn()
    render(
      <SegmentedToggle
        value="a"
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B", disabled: true },
        ]}
        onChange={onChange}
        ariaLabel="AB"
      />,
    )
    const b = screen.getByRole("tab", { name: /^b$/i })
    expect(b).toBeDisabled()
    fireEvent.click(b)
    expect(onChange).not.toHaveBeenCalled()
  })
})
