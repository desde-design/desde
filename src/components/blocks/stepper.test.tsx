import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { Stepper } from "./stepper"

const STEPS = [
  { id: "source", label: "Source" },
  { id: "name", label: "Name" },
  { id: "design-systems", label: "Design systems" },
  { id: "reference-dirs", label: "Reference folders" },
]

describe("Stepper", () => {
  it("marks exactly one step as current", () => {
    render(<Stepper steps={STEPS} current="name" />)
    const items = screen.getAllByRole("listitem")
    const currents = items.filter((li) => li.getAttribute("aria-current") === "step")
    // Several "current" steps is what a screen reader gets if completed ones
    // are marked too.
    expect(currents).toHaveLength(1)
    expect(currents[0]).toHaveTextContent("Name")
  })

  it("shows a check for completed steps and a number for the rest", () => {
    render(<Stepper steps={STEPS} current="design-systems" />)
    const items = screen.getAllByRole("listitem")
    // Source and Name are done, so their markers are checks, not "1"/"2".
    expect(items[0].textContent).not.toMatch(/1/)
    expect(items[1].textContent).not.toMatch(/2/)
    // The current one and the one after it still show their numbers.
    expect(items[2].textContent).toMatch(/3/)
    expect(items[3].textContent).toMatch(/4/)
  })

  /**
   * Guard for the `findIndex` miss. An unknown `current` returns -1, and
   * `index < -1` is false for every step, so nothing renders complete. The
   * failure mode being prevented is the opposite: an off-by-one that made
   * `-1` mean "past the end" and marked the whole bar done.
   */
  it("reports no progress at all for an unknown current step", () => {
    render(<Stepper steps={STEPS} current="nope" />)
    const items = screen.getAllByRole("listitem")
    expect(items.filter((li) => li.getAttribute("aria-current"))).toHaveLength(0)
    for (const [i, li] of items.entries()) {
      expect(li.textContent).toMatch(String(i + 1))
    }
  })

  /**
   * The steps must not be interactive. A clickable stepper has to define what
   * happens to the steps you skipped, and this flow cannot: the name step
   * needs a resolved path, the design-system step needs a name. Back is the
   * footer's job, which knows the legal transitions.
   */
  it("renders no buttons or links", () => {
    render(<Stepper steps={STEPS} current="source" />)
    const list = screen.getByRole("list")
    expect(within(list).queryAllByRole("button")).toHaveLength(0)
    expect(within(list).queryAllByRole("link")).toHaveLength(0)
    expect(within(list).queryAllByRole("tab")).toHaveLength(0)
  })

  it("names the bar for assistive tech", () => {
    render(<Stepper steps={STEPS} current="source" aria-label="New project progress" />)
    expect(screen.getByRole("list", { name: "New project progress" })).toBeInTheDocument()
  })
})
