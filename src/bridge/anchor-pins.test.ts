/**
 * The click-to-fraction conversion behind click-placed comment pins.
 *
 * Both guards here exist for failures that are SILENT in a browser. A
 * degenerate rect divides to NaN, and `style.left = "NaNpx"` is discarded
 * without an error, leaving every affected pin stacked at the layer's origin.
 * An unclamped ratio places a pin an arbitrary distance from its anchor, which
 * looks like a positioning bug rather than a bad input. Neither shows up in a
 * typecheck, a lint, or the live smoke harness.
 */

import { describe, expect, it } from "vitest"
import { clickRatio } from "./anchor-pins"

const rectOf = (left: number, top: number, width: number, height: number): DOMRect =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect

describe("clickRatio", () => {
  it("reports where in the box the click fell, as a fraction per axis", () => {
    expect(clickRatio(rectOf(100, 200, 400, 100), 300, 250)).toEqual({
      offsetRatioX: 0.5,
      offsetRatioY: 0.5,
    })
    expect(clickRatio(rectOf(0, 0, 200, 50), 50, 10)).toEqual({
      offsetRatioX: 0.25,
      offsetRatioY: 0.2,
    })
  })

  it("returns the exact edges for a click on the corners", () => {
    const r = rectOf(10, 20, 100, 40)
    expect(clickRatio(r, 10, 20)).toEqual({ offsetRatioX: 0, offsetRatioY: 0 })
    expect(clickRatio(r, 110, 60)).toEqual({ offsetRatioX: 1, offsetRatioY: 1 })
  })

  it("clamps a click that lands outside the measured rect", () => {
    // Real: a CSS transform, an overflow-visible child painted outside its
    // parent, or an inline element whose union rect spans two lines can all
    // put the hit-tested point outside the box `getBoundingClientRect` reports.
    const r = rectOf(100, 100, 100, 100)
    expect(clickRatio(r, 50, 250)).toEqual({ offsetRatioX: 0, offsetRatioY: 1 })
    expect(clickRatio(r, 400, 10)).toEqual({ offsetRatioX: 1, offsetRatioY: 0 })
  })

  it("refuses a degenerate rect rather than returning NaN", () => {
    // A collapsed span, an image that has not loaded, a control mid-transition.
    expect(clickRatio(rectOf(10, 10, 0, 40), 10, 20)).toBeNull()
    expect(clickRatio(rectOf(10, 10, 40, 0), 20, 10)).toBeNull()
    expect(clickRatio(rectOf(10, 10, 0, 0), 10, 10)).toBeNull()
  })

  it("refuses a negative-size rect, which no ratio describes", () => {
    expect(clickRatio(rectOf(10, 10, -40, 20), 10, 10)).toBeNull()
  })
})
