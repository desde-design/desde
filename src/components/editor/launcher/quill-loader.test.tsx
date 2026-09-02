import { render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { QuillLoader } from "./quill-loader"
import { LOADER_DRAWING, projectDrawing } from "./loader-drawings"

function renderLoader() {
  const { container, unmount } = render(<QuillLoader />)
  const svg = container.querySelector("svg")
  if (!svg) throw new Error("no svg")
  return {
    svg,
    unmount,
    ink: () => svg.querySelector<SVGGElement>("g[data-ink]"),
    strokes: () => Array.from(svg.querySelectorAll<SVGPathElement>("g[data-ink] path")),
    quill: () => svg.querySelector<SVGGElement>("g[data-quill]"),
  }
}

/**
 * The setup file installs a real `matchMedia` evaluator, so a test that
 * wants a media query to answer differently has to put it back by hand.
 */
const realMatchMedia = window.matchMedia
function stubReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) =>
    ({
      matches: reduce && query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList) as typeof window.matchMedia
}
afterEach(() => {
  window.matchMedia = realMatchMedia
  vi.restoreAllMocks()
})

describe("QuillLoader", () => {
  const scene = projectDrawing(LOADER_DRAWING)

  it("renders one path per stroke in the scene", () => {
    expect(renderLoader().strokes()).toHaveLength(LOADER_DRAWING.strokes.length)
  })

  it("starts with a blank page", () => {
    for (const path of renderLoader().strokes()) {
      const [dash, gap] = path.style.strokeDasharray.split(/[\s,]+/).map(Number)
      const offset = Number(path.style.strokeDashoffset)
      // Nothing is inked when the offset covers the whole dash...
      expect(offset).toBeCloseTo(dash, 1)
      // ...and the gap outruns the stroke, so the pattern cannot wrap
      // back around and paint a tick at the start of a closed stroke.
      expect(gap).toBeGreaterThan(dash)
    }
  })

  it("thins the strokes that were authored thinner", () => {
    const widths = renderLoader().strokes().map((p) => Number(p.getAttribute("stroke-width")))
    // Stroke 0 is the cat's outline; stroke 1 is its lighter tail.
    expect(widths[1]).toBeLessThan(widths[0])
    expect(Math.min(...widths)).toBeGreaterThan(0)
  })

  it("places the quill on the page with a transform", () => {
    expect(renderLoader().quill()?.getAttribute("transform")).toMatch(
      /^translate\([\d.]+ [\d.]+\) scale\([\d.]+\)$/,
    )
  })

  it("is hidden from assistive tech, since the overlay carries the status text", () => {
    expect(renderLoader().svg.getAttribute("aria-hidden")).toBe("true")
  })

  it("merges a caller className over the default width", () => {
    const { container } = render(<QuillLoader className="text-foreground w-32" />)
    const cls = container.querySelector("svg")?.getAttribute("class") ?? ""
    expect(cls).toContain("text-foreground")
    expect(cls).toContain("w-32")
    expect(cls).not.toContain("w-64")
  })

  it("animates by default", () => {
    stubReducedMotion(false)
    const raf = vi.spyOn(window, "requestAnimationFrame")
    renderLoader()
    expect(raf).toHaveBeenCalled()
  })

  it("holds the finished drawing when the reader asks for reduced motion", () => {
    stubReducedMotion(true)
    const raf = vi.spyOn(window, "requestAnimationFrame")
    const { strokes, ink } = renderLoader()

    expect(raf).not.toHaveBeenCalled()
    expect(ink()?.style.opacity).toBe("1")
    strokes().forEach((path, i) => {
      expect(Number(path.style.strokeDashoffset)).toBeCloseTo(0, 6)
      // The dash still has to be long enough to cover the whole stroke.
      expect(Number(path.style.strokeDasharray.split(/[\s,]+/)[0])).toBeCloseTo(
        scene.strokes[i].length,
        1,
      )
    })
  })

  it("stops its animation loop when unmounted", () => {
    stubReducedMotion(false)
    const cancel = vi.spyOn(window, "cancelAnimationFrame")
    renderLoader().unmount()
    expect(cancel).toHaveBeenCalled()
  })
})
