import { describe, expect, it } from "vitest"
import { summarizeStyleProperties } from "./summarize-style-properties"
import type { StyleProperty } from "@/types/bridge"

const p = (name: string, value: string, rawValue?: string): StyleProperty =>
  rawValue === undefined ? { name, value } : { name, value, rawValue }

const names = (rows: { name: string }[]) => rows.map((r) => r.name)

const BORDER_SIDES = ["top", "right", "bottom", "left"]
const borderRows = (widths: string[], styles = "solid", colors = "rgb(1, 2, 3)") => [
  ...BORDER_SIDES.map((s, i) => p(`border-${s}-width`, widths[i])),
  ...BORDER_SIDES.map((s) => p(`border-${s}-style`, styles)),
  ...BORDER_SIDES.map((s) => p(`border-${s}-color`, colors)),
]

describe("summarizeStyleProperties", () => {
  it("collapses a family whose sides all agree", () => {
    const out = summarizeStyleProperties(borderRows(["1px", "1px", "1px", "1px"]))
    expect(names(out)).toEqual(["border-width", "border-style", "border-color"])
    expect(out[0].value).toBe("1px")
  })

  it("leaves the longhands alone when one side differs", () => {
    const out = summarizeStyleProperties(borderRows(["1px", "2px", "1px", "1px"]))
    // Width disagrees so its four rows stay; style and color still collapse.
    expect(names(out)).toEqual([
      "border-top-width",
      "border-right-width",
      "border-bottom-width",
      "border-left-width",
      "border-style",
      "border-color",
    ])
  })

  it("compares the DISPLAYED value, not the computed one", () => {
    // Same computed px, different authored values. Collapsing here would
    // claim an equality the reader cannot see on screen.
    const rows = [
      p("margin-top", "16px", "1rem"),
      p("margin-right", "16px", "16px"),
      p("margin-bottom", "16px", "1rem"),
      p("margin-left", "16px", "1rem"),
    ]
    expect(names(summarizeStyleProperties(rows))).toEqual(names(rows))
  })

  it("carries rawValue onto the collapsed row when the sides were authored", () => {
    const rows = BORDER_SIDES.map((s) => p(`padding-${s === "top" ? "top" : s}`, "8px", "0.5rem"))
    const out = summarizeStyleProperties(rows)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ name: "padding", value: "8px", rawValue: "0.5rem" })
  })

  it("keeps the collapsed row where its family started", () => {
    const rows = [
      p("display", "flex"),
      ...BORDER_SIDES.map((s) => p(`margin-${s}`, "0px")),
      p("opacity", "1"),
    ]
    expect(names(summarizeStyleProperties(rows))).toEqual(["display", "margin", "opacity"])
  })

  it("lists the longhands it stands for, so the filter can still find them", () => {
    const out = summarizeStyleProperties(BORDER_SIDES.map((s) => p(`margin-${s}`, "0px")))
    expect(out[0].members).toEqual(["margin-top", "margin-right", "margin-bottom", "margin-left"])
  })

  it("drops the radius corners in favour of the shorthand the bridge already sends", () => {
    const rows = [
      p("border-radius", "10px"),
      p("border-top-left-radius", "10px"),
      p("border-top-right-radius", "10px"),
      p("border-bottom-right-radius", "10px"),
      p("border-bottom-left-radius", "10px"),
    ]
    const out = summarizeStyleProperties(rows)
    expect(names(out)).toEqual(["border-radius"])
    // The surviving row is the bridge's own, not a synthesised duplicate.
    expect(out[0].members).toBeUndefined()
  })

  it("hides outline width, colour and offset when there is no outline", () => {
    const rows = [
      p("outline-width", "3px"),
      p("outline-style", "none"),
      p("outline-color", "rgb(22, 25, 29)"),
      p("outline-offset", "0px"),
    ]
    // The `-style` row survives: it is what explains the absence.
    expect(names(summarizeStyleProperties(rows))).toEqual(["outline-style"])
  })

  it("keeps the outline rows when there IS an outline", () => {
    const rows = [
      p("outline-width", "3px"),
      p("outline-style", "solid"),
      p("outline-color", "rgb(22, 25, 29)"),
    ]
    expect(names(summarizeStyleProperties(rows))).toEqual(names(rows))
  })

  it("hides border width and colour when the border style is none", () => {
    const out = summarizeStyleProperties(borderRows(["0px", "0px", "0px", "0px"], "none"))
    expect(names(out)).toEqual(["border-style"])
  })

  it("hides uncollapsed border longhands too when the style is none", () => {
    // Widths disagree, so they never collapse — they are still inert.
    const out = summarizeStyleProperties(borderRows(["0px", "2px", "0px", "0px"], "none"))
    expect(names(out)).toEqual(["border-style"])
  })

  it("returns an empty list unchanged", () => {
    expect(summarizeStyleProperties([])).toEqual([])
  })

  it("leaves a partial family alone", () => {
    // Three of four sides present: not a family, so nothing collapses.
    const rows = BORDER_SIDES.slice(0, 3).map((s) => p(`padding-${s}`, "4px"))
    expect(names(summarizeStyleProperties(rows))).toEqual(names(rows))
  })
})
