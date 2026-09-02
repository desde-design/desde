import { describe, expect, it } from "vitest"
import {
  LOADER_DRAWING,
  PAPER_H,
  PAPER_W,
  pointAtFraction,
  projectDrawing,
  projectPaperPoint,
  resolveFrame,
  samplePaperStroke,
} from "./loader-drawings"

describe("projectPaperPoint", () => {
  it("draws the near edge at full size", () => {
    expect(projectPaperPoint(PAPER_W / 2, PAPER_H).s).toBeCloseTo(1, 6)
  })

  it("shrinks with distance, monotonically", () => {
    const scales = [0, 20, 40, 60, 80].map((y) => projectPaperPoint(60, y).s)
    // y = 0 is the FAR edge, so scale climbs as y does.
    for (let i = 1; i < scales.length; i++) expect(scales[i]).toBeGreaterThan(scales[i - 1])
    expect(scales[0]).toBeLessThan(0.6)
  })

  it("puts the far edge higher up the screen than the near edge", () => {
    expect(projectPaperPoint(60, 0).y).toBeLessThan(projectPaperPoint(60, PAPER_H).y)
  })

  it("narrows the paper toward the far edge", () => {
    const nearWidth = projectPaperPoint(PAPER_W, PAPER_H).x - projectPaperPoint(0, PAPER_H).x
    const farWidth = projectPaperPoint(PAPER_W, 0).x - projectPaperPoint(0, 0).x
    expect(farWidth).toBeLessThan(nearWidth)
    expect(farWidth).toBeGreaterThan(0)
  })

  it("keeps the centre line straight down the middle at every depth", () => {
    const centres = [0, 40, 80].map((y) => projectPaperPoint(PAPER_W / 2, y).x)
    expect(centres[0]).toBeCloseTo(centres[1], 6)
    expect(centres[1]).toBeCloseTo(centres[2], 6)
  })
})

describe("samplePaperStroke", () => {
  it("starts and ends on the authored endpoints of an open stroke", () => {
    const points = [
      [0, 0],
      [10, 20],
      [30, 10],
    ] as const
    const sampled = samplePaperStroke({ points })
    expect(sampled[0]).toEqual([0, 0])
    expect(sampled[sampled.length - 1]).toEqual([30, 10])
  })

  it("returns to the first point on a closed stroke", () => {
    const points = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ] as const
    const sampled = samplePaperStroke({ points, closed: true })
    expect(sampled[sampled.length - 1]).toEqual([0, 0])
  })

  it("passes through every authored control point", () => {
    const points = [
      [0, 0],
      [10, 20],
      [30, 10],
      [40, 40],
    ] as const
    const sampled = samplePaperStroke({ points })
    for (const [x, y] of points) {
      const hit = sampled.some((s) => Math.hypot(s[0] - x, s[1] - y) < 1e-6)
      expect(hit).toBe(true)
    }
  })

  it("handles degenerate strokes without throwing", () => {
    expect(samplePaperStroke({ points: [] })).toEqual([])
    expect(samplePaperStroke({ points: [[5, 5]] })).toEqual([[5, 5]])
    expect(
      samplePaperStroke({
        points: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).toEqual([
      [0, 0],
      [1, 1],
    ])
  })
})

describe("projectDrawing", () => {
  const drawing = projectDrawing(LOADER_DRAWING)

  it("lays out phases that tile [0, 1] with no gaps", () => {
    expect(drawing.phases[0].start).toBeCloseTo(0, 6)
    expect(drawing.phases[drawing.phases.length - 1].end).toBeCloseTo(1, 6)
    for (let i = 1; i < drawing.phases.length; i++) {
      expect(drawing.phases[i].start).toBeCloseTo(drawing.phases[i - 1].end, 6)
    }
  })

  it("gives every stroke exactly one draw phase, in order", () => {
    const drawn = drawing.phases.flatMap((p) => (p.kind === "draw" ? [p.stroke] : []))
    expect(drawn).toEqual(drawing.strokes.map((_, i) => i))
  })

  it("puts a pen-up travel phase between consecutive strokes", () => {
    const travels = drawing.phases.filter((p) => p.kind === "travel")
    expect(travels).toHaveLength(drawing.strokes.length - 1)
  })

  it("emits a renderable path and a positive length per stroke", () => {
    for (const stroke of drawing.strokes) {
      expect(stroke.d.startsWith("M")).toBe(true)
      expect(stroke.length).toBeGreaterThan(0)
      expect(stroke.cumulative[stroke.cumulative.length - 1]).toBeCloseTo(stroke.length, 6)
      expect(stroke.weight).toBeGreaterThan(0)
    }
  })

  it("carries authored line weights through", () => {
    // The tail is deliberately drawn lighter than the cat's outline.
    expect(drawing.strokes[1].weight).toBeLessThan(drawing.strokes[0].weight)
  })
})

describe("pointAtFraction", () => {
  const stroke = projectDrawing(LOADER_DRAWING).strokes[0]

  it("lands on the stroke's endpoints", () => {
    const start = pointAtFraction(stroke, 0)
    expect(start.x).toBeCloseTo(stroke.points[0].x, 6)
    const end = pointAtFraction(stroke, 1)
    expect(end.x).toBeCloseTo(stroke.points[stroke.points.length - 1].x, 6)
  })

  it("clamps outside [0, 1] instead of extrapolating", () => {
    expect(pointAtFraction(stroke, -5)).toEqual(pointAtFraction(stroke, 0))
    expect(pointAtFraction(stroke, 5)).toEqual(pointAtFraction(stroke, 1))
  })

  it("advances along the stroke as the fraction grows", () => {
    let travelled = 0
    let prev = pointAtFraction(stroke, 0)
    for (let i = 1; i <= 20; i++) {
      const next = pointAtFraction(stroke, i / 20)
      travelled += Math.hypot(next.x - prev.x, next.y - prev.y)
      prev = next
    }
    // Chords undercut the arc, so this is a lower bound, not an equality.
    expect(travelled).toBeGreaterThan(stroke.length * 0.8)
  })
})

describe("resolveFrame", () => {
  const drawing = projectDrawing(LOADER_DRAWING)

  it("starts with a blank page and the quill on the first stroke", () => {
    const frame = resolveFrame(drawing, 0)
    expect(frame.strokeProgress.every((p) => p === 0)).toBe(true)
    expect(frame.quill.x).toBeCloseTo(drawing.strokes[0].points[0].x, 6)
  })

  it("ends with every stroke fully inked", () => {
    expect(resolveFrame(drawing, 1).strokeProgress).toEqual(drawing.strokes.map(() => 1))
  })

  it("never un-draws a stroke as time moves forward", () => {
    let prev = resolveFrame(drawing, 0).strokeProgress
    for (let i = 1; i <= 50; i++) {
      const next = resolveFrame(drawing, i / 50).strokeProgress
      next.forEach((p, s) => expect(p).toBeGreaterThanOrEqual(prev[s] - 1e-9))
      prev = next
    }
  })

  it("only ever has one stroke part-drawn at a time", () => {
    for (let i = 0; i <= 60; i++) {
      const partial = resolveFrame(drawing, i / 60).strokeProgress.filter((p) => p > 0 && p < 1)
      expect(partial.length).toBeLessThanOrEqual(1)
    }
  })

  it("clamps out-of-range progress", () => {
    expect(resolveFrame(drawing, -1).strokeProgress).toEqual(resolveFrame(drawing, 0).strokeProgress)
    expect(resolveFrame(drawing, 2).strokeProgress).toEqual(resolveFrame(drawing, 1).strokeProgress)
  })

  it("scales the quill between the near and far extremes as it works", () => {
    const scales = Array.from({ length: 40 }, (_, i) => resolveFrame(drawing, i / 39).quill.s)
    const min = Math.min(...scales)
    const max = Math.max(...scales)
    // The whole point of the angled plane: the quill visibly changes size.
    expect(max / min).toBeGreaterThan(1.2)
    expect(max).toBeLessThanOrEqual(1)
    expect(min).toBeGreaterThan(0)
  })
})


describe("LOADER_DRAWING", () => {
  const drawing = projectDrawing(LOADER_DRAWING)

  it("is the cat-in-flowers scene", () => {
    expect(LOADER_DRAWING.name).toBe("cat-in-flowers")
  })

  it("keeps every authored point on the paper", () => {
    for (const stroke of LOADER_DRAWING.strokes) {
      for (const [x, y] of stroke.points) {
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(PAPER_W)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(PAPER_H)
      }
    }
  })

  it("leads with the cat's silhouette, so a half-drawn frame still reads", () => {
    const outline = drawing.strokes[0]
    for (const other of drawing.strokes.slice(1)) {
      expect(other.length).toBeLessThan(outline.length)
    }
  })

  it("draws the cat before the flower bed", () => {
    // The flowers sit in front of the cat, so they have to be laid down
    // after it, exactly as they would be on paper.
    const catStrokes = 12
    const catBottom = Math.max(
      ...LOADER_DRAWING.strokes.slice(0, catStrokes).flatMap((s) => s.points.map((p) => p[1])),
    )
    const flowerTop = Math.min(
      ...LOADER_DRAWING.strokes.slice(catStrokes).flatMap((s) => s.points.map((p) => p[1])),
    )
    expect(flowerTop).toBeLessThan(catBottom)
  })

  it("mirrors the cat left to right about its centre", () => {
    const outline = LOADER_DRAWING.strokes[0].points
    const xs = outline.map((p) => p[0])
    const centre = (Math.min(...xs) + Math.max(...xs)) / 2
    // Every point should have a partner reflected across the centre line.
    for (const [x, y] of outline) {
      const mirrored = outline.some(
        ([ox, oy]) => Math.abs(ox - (2 * centre - x)) < 0.51 && Math.abs(oy - y) < 0.51,
      )
      expect(mirrored).toBe(true)
    }
  })
})
