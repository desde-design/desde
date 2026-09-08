/**
 * Tests for the alignment & sizing class helpers (direct-manip Phase 1).
 * Pure mapping: parse a group out of a class list (last-wins, all raws
 * collected) + set* → ClassMutation applied via applyClassMutation.
 */

import { describe, expect, it } from "vitest"
import {
  applyClassMutation,
  cellToAxes,
  axesToCell,
  isFlexLikeContainer,
  parseFlexAxes,
  parseAlignItems,
  parseJustify,
  parseTextAlign,
  parseWidth,
  setAlignItems,
  setJustify,
  setTextAlign,
  setWidth,
} from "./align-size"

describe("parse* (last-wins + raws)", () => {
  it("parses the representable value and collects every matching class", () => {
    const classes = ["flex", "justify-start", "justify-center", "p-4"]
    const j = parseJustify(classes)
    expect(j.value).toBe("center") // last representable wins
    expect(j.raws).toEqual(["justify-start", "justify-center"]) // both removed on set
    expect(j.unrepresentable).toBe(false)
  })

  it("shows custom when a trailing unrepresentable utility wins (last-match convention)", () => {
    // `justify-start justify-between` — between is last so it wins; the control
    // must show custom (value null), not falsely highlight start (codex).
    const j = parseJustify(["flex", "justify-start", "justify-between"])
    expect(j.value).toBeNull()
    expect(j.unrepresentable).toBe(true)
    expect(j.raws).toEqual(["justify-start", "justify-between"])
    // ...but a representable utility AFTER an unrepresentable one wins normally.
    expect(parseJustify(["justify-between", "justify-end"]).value).toBe("end")
    // Width: w-full then w-64 → custom.
    const w = parseWidth(["w-full", "w-64"])
    expect(w.value).toBeNull()
    expect(w.unrepresentable).toBe(true)
  })

  it("flags an unrepresentable value (justify-between) but still tracks it for removal", () => {
    const j = parseJustify(["flex", "justify-between"])
    expect(j.value).toBeNull()
    expect(j.raws).toEqual(["justify-between"])
    expect(j.unrepresentable).toBe(true)
  })

  it("maps logical text-align aliases (text-start/text-end) to left/right", () => {
    expect(parseTextAlign(["text-start"]).value).toBe("left")
    expect(parseTextAlign(["text-end"]).value).toBe("right")
    expect(parseTextAlign(["text-center"]).value).toBe("center")
  })

  it("parses items- and width presets; ignores min-w-/max-w-", () => {
    expect(parseAlignItems(["items-stretch"]).unrepresentable).toBe(true)
    expect(parseAlignItems(["items-center"]).value).toBe("center")
    const w = parseWidth(["w-full", "min-w-0", "max-w-lg"])
    expect(w.value).toBe("full")
    expect(w.raws).toEqual(["w-full"]) // min-w/max-w excluded
  })

  it("captures a fixed/fractional width for removal even though it's not a v1 preset", () => {
    const w = parseWidth(["w-64"])
    expect(w.value).toBeNull()
    expect(w.unrepresentable).toBe(true)
    expect(w.raws).toEqual(["w-64"])
  })
})

describe("set* → ClassMutation (via applyClassMutation)", () => {
  it("replaces an existing justify value (removes all, adds the new)", () => {
    const classes = ["flex", "justify-start", "justify-between", "p-4"]
    const j = parseJustify(classes)
    const next = applyClassMutation(classes, setJustify(j, "end"))
    expect(next).toContain("justify-end")
    expect(next).not.toContain("justify-start")
    expect(next).not.toContain("justify-between")
    expect(next).toContain("flex")
    expect(next).toContain("p-4")
  })

  it("clears a group when value is null", () => {
    const classes = ["items-center", "gap-2"]
    const a = parseAlignItems(classes)
    const next = applyClassMutation(classes, setAlignItems(a, null))
    expect(next).not.toContain("items-center")
    expect(next).toEqual(["gap-2"])
  })

  it("sets width preset, replacing a prior fixed width", () => {
    const classes = ["w-64", "rounded"]
    const w = parseWidth(classes)
    const next = applyClassMutation(classes, setWidth(w, "full"))
    expect(next).toContain("w-full")
    expect(next).not.toContain("w-64")
    expect(next).toContain("rounded")
  })

  it("sets text-align", () => {
    const classes = ["text-left"]
    const t = parseTextAlign(classes)
    const next = applyClassMutation(classes, setTextAlign(t, "center"))
    expect(next).toEqual(["text-center"])
  })

  it("round-trips: parse(after a set) reflects the new value", () => {
    let classes = ["flex"]
    classes = applyClassMutation(classes, setJustify(parseJustify(classes), "center"))
    classes = applyClassMutation(classes, setAlignItems(parseAlignItems(classes), "end"))
    expect(parseJustify(classes).value).toBe("center")
    expect(parseAlignItems(classes).value).toBe("end")
  })
})

describe("isFlexLikeContainer", () => {
  it("is true for flex/grid displays, false otherwise / when absent", () => {
    expect(isFlexLikeContainer({ display: "flex" })).toBe(true)
    expect(isFlexLikeContainer({ display: "inline-flex" })).toBe(true)
    expect(isFlexLikeContainer({ display: "grid" })).toBe(true)
    expect(isFlexLikeContainer({ display: "block" })).toBe(false)
    expect(isFlexLikeContainer({})).toBe(false)
    expect(isFlexLikeContainer(undefined)).toBe(false)
  })
})

/**
 * The 3×3 grid draws SCREEN positions, but it writes CSS properties whose
 * meaning depends on `flex-direction`. In a row, `justify-content` runs left
 * to right and `align-items` runs top to bottom. In a column those swap, and
 * the `-reverse` variants mirror their axis on top of that.
 *
 * The grid ignored direction until 2026-09-08, so on a `flex-col` container
 * clicking the top-right cell wrote `justify-end items-start`, which puts the
 * children BOTTOM-LEFT. Every cell but the exact centre landed wrong, and the
 * highlight read the same swap back, so nothing looked broken from inside the
 * grid. These are the tables that fix it, kept pure and here rather than in
 * the section so all sixteen direction/cell combinations are cheap to state.
 */
describe("parseFlexAxes", () => {
  it("defaults to row when the direction is absent or unknown", () => {
    expect(parseFlexAxes(undefined)).toEqual({ column: false, mainReversed: false, crossReversed: false })
    expect(parseFlexAxes({})).toEqual({ column: false, mainReversed: false, crossReversed: false })
    expect(parseFlexAxes({ "flex-direction": "sideways" })).toEqual({ column: false, mainReversed: false, crossReversed: false })
  })

  it("reads the four directions", () => {
    expect(parseFlexAxes({ "flex-direction": "row" }).column).toBe(false)
    expect(parseFlexAxes({ "flex-direction": "column" }).column).toBe(true)
    expect(parseFlexAxes({ "flex-direction": "row-reverse" })).toEqual({ column: false, mainReversed: true, crossReversed: false })
    expect(parseFlexAxes({ "flex-direction": "column-reverse" })).toEqual({ column: true, mainReversed: true, crossReversed: false })
  })

  it("reads wrap-reverse as the cross axis flipping", () => {
    expect(parseFlexAxes({ "flex-direction": "row", "flex-wrap": "wrap-reverse" }).crossReversed).toBe(true)
    expect(parseFlexAxes({ "flex-direction": "row", "flex-wrap": "wrap" }).crossReversed).toBe(false)
  })
})

describe("cellToAxes / axesToCell", () => {
  const ROW = { column: false, mainReversed: false, crossReversed: false }
  const COL = { column: true, mainReversed: false, crossReversed: false }
  const ROW_REV = { column: false, mainReversed: true, crossReversed: false }
  const COL_REV = { column: true, mainReversed: true, crossReversed: false }

  it("in a row, columns are justify and rows are items", () => {
    expect(cellToAxes("end", "start", ROW)).toEqual({ justify: "end", align: "start" })
    expect(cellToAxes("start", "end", ROW)).toEqual({ justify: "start", align: "end" })
  })

  it("in a column, the two axes swap", () => {
    // Top-right on screen: children at the END of the cross axis (right) and
    // the START of the main axis (top).
    expect(cellToAxes("end", "start", COL)).toEqual({ justify: "start", align: "end" })
    expect(cellToAxes("start", "end", COL)).toEqual({ justify: "end", align: "start" })
  })

  it("mirrors the main axis when the direction is reversed", () => {
    // row-reverse runs right to left, so the LEFT column is justify-end.
    expect(cellToAxes("start", "start", ROW_REV)).toEqual({ justify: "end", align: "start" })
    // column-reverse runs bottom to top, so the TOP row is justify-end. Only
    // the MAIN axis mirrors: the cross axis is still left-to-right, so the
    // left column stays items-start.
    expect(cellToAxes("start", "start", COL_REV)).toEqual({ justify: "end", align: "start" })
  })

  it("round-trips every cell in every direction", () => {
    const values = ["start", "center", "end"] as const
    for (const axes of [ROW, COL, ROW_REV, COL_REV]) {
      for (const col of values) {
        for (const row of values) {
          const css = cellToAxes(col, row, axes)
          expect(axesToCell(css.justify, css.align, axes)).toEqual({ col, row })
        }
      }
    }
  })

  it("reads a stored value back to the cell it lays out", () => {
    // The bug, stated as a value: `flex-col justify-end items-start` puts the
    // children bottom-left, so that is the cell that lights.
    expect(axesToCell("end", "start", COL)).toEqual({ col: "start", row: "end" })
    expect(axesToCell("end", "start", ROW)).toEqual({ col: "end", row: "start" })
  })

  it("lights nothing when either axis is unset in a way the grid cannot show", () => {
    expect(axesToCell(null, "start", ROW)).toBeNull()
    expect(axesToCell("start", null, ROW)).toBeNull()
  })
})

/**
 * The mapping tables, checked against what a browser ACTUALLY does.
 *
 * `cellToAxes` is a claim about CSS: that in a column container
 * `justify-content` runs vertically, that `-reverse` mirrors one axis, and so
 * on. A hand-written table can be self-consistent and still wrong about the
 * spec, which is exactly the failure it was written to fix, so asserting it
 * against itself proves nothing.
 *
 * `MEASURED` below is Chromium's answer, not ours. Each row is one
 * (direction, justify-content, align-items) triple, and the value is which
 * third of the container the child's centre landed in, as `column,row` on
 * SCREEN. Regenerate by laying a 20px child in a 200px flex box for all 36
 * combinations and reading `getBoundingClientRect`; the script that produced
 * it is in the 2026-09-08 session notes. Rows measured once, in Chromium,
 * with a left-to-right writing mode, which is the only mode the grid claims
 * to handle.
 */
const MEASURED: Record<string, string> = {
  "row|start|start": "start,start",
  "row|start|center": "start,center",
  "row|start|end": "start,end",
  "row|center|start": "center,start",
  "row|center|center": "center,center",
  "row|center|end": "center,end",
  "row|end|start": "end,start",
  "row|end|center": "end,center",
  "row|end|end": "end,end",
  "column|start|start": "start,start",
  "column|start|center": "center,start",
  "column|start|end": "end,start",
  "column|center|start": "start,center",
  "column|center|center": "center,center",
  "column|center|end": "end,center",
  "column|end|start": "start,end",
  "column|end|center": "center,end",
  "column|end|end": "end,end",
  "row-reverse|start|start": "end,start",
  "row-reverse|start|center": "end,center",
  "row-reverse|start|end": "end,end",
  "row-reverse|center|start": "center,start",
  "row-reverse|center|center": "center,center",
  "row-reverse|center|end": "center,end",
  "row-reverse|end|start": "start,start",
  "row-reverse|end|center": "start,center",
  "row-reverse|end|end": "start,end",
  "column-reverse|start|start": "start,end",
  "column-reverse|start|center": "center,end",
  "column-reverse|start|end": "end,end",
  "column-reverse|center|start": "start,center",
  "column-reverse|center|center": "center,center",
  "column-reverse|center|end": "end,center",
  "column-reverse|end|start": "start,start",
  "column-reverse|end|center": "center,start",
  "column-reverse|end|end": "end,start"
}

describe("cellToAxes agrees with the browser", () => {
  const values = ["start", "center", "end"] as const

  it("writes classes that land the children in the cell the user clicked", () => {
    const mismatches: string[] = []
    for (const dir of ["row", "column", "row-reverse", "column-reverse"]) {
      const axes = parseFlexAxes({ "flex-direction": dir })
      for (const col of values) {
        for (const row of values) {
          const { justify, align } = cellToAxes(col, row, axes)
          const landed = MEASURED[`${dir}|${justify}|${align}`]
          if (landed !== `${col},${row}`) {
            mismatches.push(`${dir}: cell ${col},${row} wrote justify-${justify} items-${align}, browser laid it out at ${landed}`)
          }
        }
      }
    }
    expect(mismatches).toEqual([])
  })

  it("lights the cell the children are actually in", () => {
    const mismatches: string[] = []
    for (const dir of ["row", "column", "row-reverse", "column-reverse"]) {
      const axes = parseFlexAxes({ "flex-direction": dir })
      for (const justify of values) {
        for (const align of values) {
          const landed = MEASURED[`${dir}|${justify}|${align}`]
          const lit = axesToCell(justify, align, axes)
          if (!lit || `${lit.col},${lit.row}` !== landed) {
            mismatches.push(`${dir}: justify-${justify} items-${align} lays out at ${landed}, grid lit ${lit ? `${lit.col},${lit.row}` : "nothing"}`)
          }
        }
      }
    }
    expect(mismatches).toEqual([])
  })

  it("would have caught the pre-2026-09-08 bug", () => {
    // The old code used the cell's column as justify and its row as items,
    // whatever the direction. In a column container that lays the children
    // out in the opposite corner along one diagonal.
    const column = parseFlexAxes({ "flex-direction": "column" })
    const oldWrite = { justify: "end" as const, align: "start" as const } // top-right, read as a row
    expect(MEASURED[`column|${oldWrite.justify}|${oldWrite.align}`]).toBe("start,end") // bottom-left
    expect(cellToAxes("end", "start", column)).not.toEqual(oldWrite)
  })
})
