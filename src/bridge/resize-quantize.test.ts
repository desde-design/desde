import { describe, expect, it } from "vitest"
import { quantizeWidthClass } from "./resize-quantize"

describe("quantizeWidthClass", () => {
  it("snaps near-fraction widths to fraction classes", () => {
    expect(quantizeWidthClass(500, 1000)).toBe("w-1/2") // exactly half
    expect(quantizeWidthClass(510, 1000)).toBe("w-1/2") // within tolerance
    expect(quantizeWidthClass(1000, 1000)).toBe("w-full")
    expect(quantizeWidthClass(330, 1000)).toBe("w-1/3")
    expect(quantizeWidthClass(740, 1000)).toBe("w-3/4")
  })

  it("falls back to the nearest fixed scale step when not near a fraction", () => {
    // 0.41 of parent is squarely between 1/3 (0.333) and 1/2 (0.5) — outside
    // tolerance → fixed scale. 410/4 = 102.5 steps → nearest scale step 96.
    expect(quantizeWidthClass(410, 1000)).toBe("w-96")
    // 0.176 isn't within 6% of 1/4 (0.25) → fixed. 176/4 = 44 → w-44.
    expect(quantizeWidthClass(176, 1000)).toBe("w-44")
  })

  it("snaps off-scale fixed widths to the nearest step", () => {
    // 250px → 62.5 steps → nearest scale step is 64 → w-64.
    expect(quantizeWidthClass(250, 99999)).toBe("w-64")
    // 50px → 12.5 steps → nearest is 12 → w-12.
    expect(quantizeWidthClass(50, 99999)).toBe("w-12")
  })

  it("uses the fixed scale when no parent width is given", () => {
    expect(quantizeWidthClass(64)).toBe("w-16") // 64/4 = 16 steps
    expect(quantizeWidthClass(500)).toMatch(/^w-\d/) // no fraction without parent
  })

  it("clamps negative drags to 0", () => {
    expect(quantizeWidthClass(-40, 1000)).toBe("w-0")
  })
})
