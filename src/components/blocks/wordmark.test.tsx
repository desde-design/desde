// @vitest-environment jsdom

/**
 * `Wordmark` — the one rendering rule that a pixel measurement, not a type,
 * decided.
 *
 * The `viewBox` is tight to the ink, so the bottom of the round letters (the
 * overshoot below the baseline on D, e, s, d) sits exactly on the SVG's
 * bottom edge. Inline `<svg>` clips to its viewport by default, and Chromium
 * snaps that clip to whole device pixels while the box itself lands at a
 * fractional height (0.727em of 19px is 13.8125px). The last sub-pixel row
 * of the bowls fell outside the snapped clip and every round letter rendered
 * with a flat bottom. Seen in the desktop launcher's project list, 2026-09-08,
 * and reproduced at 4x scale: the same path with the clip off draws the bowls
 * whole.
 *
 * The box is for layout only; nothing needs to clip the mark. Keep the
 * viewBox tight and let the ink spill the sub-pixel it needs.
 */

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"
import { Wordmark } from "./wordmark"

afterEach(cleanup)

describe("Wordmark", () => {
  it("does not clip the glyphs to the SVG viewport", () => {
    const { container } = render(<Wordmark />)
    const svg = container.querySelector("svg")
    expect(svg).not.toBeNull()
    expect(svg!.style.overflow).toBe("visible")
  })

  it("keeps the box tight to the ink so layout is unchanged", () => {
    const { container } = render(<Wordmark />)
    const svg = container.querySelector("svg")!
    expect(svg.getAttribute("viewBox")).toBe("100.59 -714.9 2767.07 727.16")
    expect(svg.style.height).toBe("0.727em")
  })
})
