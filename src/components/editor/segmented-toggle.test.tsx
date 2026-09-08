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

/**
 * `stacked` is a SIZE the list declares, not a pile of forced overrides.
 *
 * Until 2026-09-08 the stacked look was `h-auto! flex-col! … text-2xs!` on
 * every trigger, fighting the primitive's own size classes with Tailwind's
 * trailing `!`. The Tabs primitive now carries a `stacked` size beside
 * `default` and `sm`, so exactly one size's classes ever apply and nothing
 * needs to win a specificity fight. The wrapper's whole job here is to say
 * which size the list is.
 */
describe("SegmentedToggle — stacked", () => {
  const TOOLS = [
    { value: "navigate" as const, label: "Navigate", icon: <svg aria-hidden="true" /> },
    { value: "select" as const, label: "Select", icon: <svg aria-hidden="true" /> },
  ]

  it("declares the stacked size on the list", () => {
    render(
      <SegmentedToggle value="navigate" options={TOOLS} onChange={() => {}} ariaLabel="Tool" variant="plain" stacked />,
    )
    expect(screen.getByRole("tablist").getAttribute("data-size")).toBe("stacked")
  })

  it("forces nothing: no `!` override on the list or its triggers", () => {
    render(
      <SegmentedToggle value="navigate" options={TOOLS} onChange={() => {}} ariaLabel="Tool" variant="plain" stacked />,
    )
    const list = screen.getByRole("tablist")
    const classes = [list, ...screen.getAllByRole("tab")].map((el) => el.className)
    for (const cls of classes) expect(cls).not.toMatch(/!(\s|$)/)
  })

  it("captions at the 8px step, touching the icon", () => {
    // `text-3xs` exists for this caption and nothing else; see the ramp in
    // globals.css. The gate is the list's size, so it is asserted on the
    // trigger's class list rather than on a computed style jsdom cannot give.
    render(
      <SegmentedToggle value="navigate" options={TOOLS} onChange={() => {}} ariaLabel="Tool" variant="plain" stacked />,
    )
    const cls = screen.getAllByRole("tab")[0].className
    expect(cls).toContain("group-data-[size=stacked]/tabs-list:text-3xs")
    expect(cls).toContain("group-data-[size=stacked]/tabs-list:gap-0 ")
    expect(cls).not.toContain("group-data-[size=stacked]/tabs-list:text-2xs")
  })

  it("stays on the default size when not stacked", () => {
    render(<SegmentedToggle value="editor" options={VIEW_OPTIONS} onChange={() => {}} ariaLabel="View" />)
    expect(screen.getByRole("tablist").getAttribute("data-size")).toBe("default")
  })
})
