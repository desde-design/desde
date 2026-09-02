/**
 * Gap bands.
 *
 * The size of a gap comes from `column-gap`/`row-gap`; the PLACE comes from
 * where the children landed. These pin the placement, because that is the part
 * a computed-style read cannot tell you and the part that breaks silently when
 * a layout wraps.
 */

import { describe, expect, it } from "vitest"
import { gapBands } from "./inspector-overlay"

/** A child whose `getBoundingClientRect` returns the given box. */
function child(left: number, top: number, width: number, height: number): Element {
  return {
    getBoundingClientRect: () => ({
      left, top, width, height, right: left + width, bottom: top + height,
    }),
  } as unknown as Element
}

function host(children: Element[]): Element {
  return { children } as unknown as Element
}

function style(over: Partial<Record<string, string>> = {}): CSSStyleDeclaration {
  return { display: "flex", columnGap: "0px", rowGap: "0px", ...over } as CSSStyleDeclaration
}

describe("gapBands", () => {
  it("puts a band in each space between columns of a flex row", () => {
    // Three 100px children at x=0/120/240 — two 20px gaps.
    const el = host([child(0, 0, 100, 50), child(120, 0, 100, 50), child(240, 0, 100, 50)])
    const bands = gapBands(el, style({ columnGap: "20px" }))
    expect(bands).toHaveLength(2)
    expect(bands[0]).toMatchObject({ left: 100, width: 20, top: 0, height: 50 })
    expect(bands[1]).toMatchObject({ left: 220, width: 20 })
  })

  it("puts a band between rows of a flex column", () => {
    const el = host([child(0, 0, 100, 40), child(0, 56, 100, 40)])
    const bands = gapBands(el, style({ rowGap: "16px" }))
    expect(bands).toHaveLength(1)
    expect(bands[0]).toMatchObject({ top: 40, height: 16, left: 0, width: 100 })
  })

  it("covers both axes of a grid at once", () => {
    // 2x2, 10px both ways.
    const el = host([
      child(0, 0, 50, 50), child(60, 0, 50, 50),
      child(0, 60, 50, 50), child(60, 60, 50, 50),
    ])
    const bands = gapBands(el, style({ display: "grid", columnGap: "10px", rowGap: "10px" }))
    expect(bands).toHaveLength(2)
    // One vertical band spanning both rows, one horizontal spanning both cols.
    expect(bands).toContainEqual({ left: 50, top: 0, width: 10, height: 110 })
    expect(bands).toContainEqual({ left: 0, top: 50, width: 110, height: 10 })
  })

  it("bands a wrapped flex line without being told it wrapped", () => {
    // Two on the first line, one below: the row cluster falls out of the
    // children's tops, so wrapping needs no special case.
    const el = host([
      child(0, 0, 100, 30), child(110, 0, 100, 30),
      child(0, 40, 100, 30),
    ])
    const bands = gapBands(el, style({ columnGap: "10px", rowGap: "10px" }))
    expect(bands).toContainEqual({ left: 100, top: 0, width: 10, height: 70 })
    expect(bands).toContainEqual({ left: 0, top: 30, width: 210, height: 10 })
  })

  it("tolerates subpixel drift within a column", () => {
    // Real layouts rarely give two children the same left to the pixel.
    const el = host([
      child(0, 0, 50, 20), child(0.4, 30, 50, 20),
      child(60, 0, 50, 20),
    ])
    const bands = gapBands(el, style({ columnGap: "10px", rowGap: "10px" }))
    // 0 and 0.4 are one column, not two, so there is a single vertical band.
    // Its width is the real distance between the tracks (9.6, not the declared
    // 10) — the band shows where the space IS, and asserting the declared
    // value would be asserting the number we already had.
    const vertical = bands.filter((b) => b.height > b.width)
    expect(vertical).toHaveLength(1)
    expect(vertical[0].width).toBeCloseTo(9.6, 5)
  })

  it("draws nothing without a gap, without children, or on a block", () => {
    const two = [child(0, 0, 50, 50), child(60, 0, 50, 50)]
    expect(gapBands(host(two), style())).toEqual([])
    expect(gapBands(host([child(0, 0, 50, 50)]), style({ columnGap: "10px" }))).toEqual([])
    expect(gapBands(host(two), style({ display: "block", columnGap: "10px" }))).toEqual([])
  })

  it("ignores zero-sized children, which would drag a band to the origin", () => {
    const el = host([child(0, 0, 0, 0), child(0, 0, 100, 50), child(120, 0, 100, 50)])
    const bands = gapBands(el, style({ columnGap: "20px" }))
    expect(bands).toHaveLength(1)
    expect(bands[0]).toMatchObject({ left: 100, width: 20 })
  })
})
