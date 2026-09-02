/**
 * Geometry for the launcher's drawing loader.
 *
 * **DORMANT since 2026-08-20** along with its only consumer — see
 * `quill-loader.tsx` for what that means here and why it was kept. Its tests
 * stay in the default run.
 *
 * The loader shows a quill drawing line art on a sheet of paper that lies
 * flat, receding away from the viewer. The sheet is never drawn, only used as
 * a coordinate space. Everything here is pure maths so it can be unit tested:
 * the component only drives time.
 *
 * Two coordinate spaces:
 *
 * - **Paper space** — where the animals are authored. `x` runs left to right
 *   over `PAPER_W`, `y` runs from the FAR edge (`y = 0`) to the NEAR edge
 *   (`y = PAPER_H`). Authoring here means you draw an animal the ordinary way,
 *   top-down, and the perspective is somebody else's problem.
 * - **Screen space** — the SVG viewBox. `projectPaperPoint` maps paper to
 *   screen and also reports `s`, how large something at that spot appears.
 *   `s` is what makes the quill grow as it draws toward the viewer.
 */

export const PAPER_W = 120
export const PAPER_H = 80

export const VIEW_W = 220
export const VIEW_H = 150

/** Screen centre line of the paper. */
const CX = VIEW_W / 2
/** Screen width of the paper at its NEAR edge. The far edge is narrower. */
const PLANE_W = 196
/** Screen y of the paper's near edge, then its far edge. */
const Y_NEAR = 136
const Y_FAR = 44
/**
 * Perspective strength. `s` falls from 1 at the near edge to `1 / (1 + K)` at
 * the far edge, so K = 1.15 makes the far edge roughly half-size. Bigger K is
 * a lower, more dramatic camera.
 */
const K = 1.15

/**
 * Where `s -> 0`. Solved from the two edge positions so the near and far edges
 * land exactly on Y_NEAR and Y_FAR: a plane's screen y is an affine function
 * of `s`, and this is the constant that anchors it.
 */
const HORIZON = (Y_FAR * (1 + K) - Y_NEAR) / K

export interface ScreenPoint {
  readonly x: number
  readonly y: number
  /** Foreshortening at this point: 1 at the near edge, smaller further away. */
  readonly s: number
}

/** Map a point on the paper to the SVG viewBox. */
export function projectPaperPoint(x: number, y: number): ScreenPoint {
  // v = 0 at the near edge, 1 at the far edge.
  const v = 1 - y / PAPER_H
  const s = 1 / (1 + K * v)
  return {
    x: CX + (x / PAPER_W - 0.5) * PLANE_W * s,
    y: HORIZON + (Y_NEAR - HORIZON) * s,
    s,
  }
}

export type PaperPoint = readonly [number, number]

export interface Stroke {
  /** Control points in paper space. Smoothed through, not interpolated linearly. */
  readonly points: readonly PaperPoint[]
  /** A closed stroke joins its last point back to its first. */
  readonly closed?: boolean
  /**
   * Line weight, relative to the outline's. Details and thin tails take less
   * than 1 so they read as detail rather than as more silhouette.
   */
  readonly weight?: number
}

export interface Drawing {
  readonly name: string
  readonly strokes: readonly Stroke[]
}

/** Catmull-Rom through p1 -> p2, using p0 and p3 only for the tangents. */
function catmullRom(
  p0: PaperPoint,
  p1: PaperPoint,
  p2: PaperPoint,
  p3: PaperPoint,
  t: number,
): PaperPoint {
  const t2 = t * t
  const t3 = t2 * t
  const axis = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
  return [axis(p0[0], p1[0], p2[0], p3[0]), axis(p0[1], p1[1], p2[1], p3[1])]
}

const SAMPLES_PER_SEGMENT = 14

/** Flatten a stroke's control points into a dense polyline in paper space. */
export function samplePaperStroke(stroke: Stroke, per = SAMPLES_PER_SEGMENT): PaperPoint[] {
  const pts = stroke.points
  if (pts.length === 0) return []
  if (pts.length === 1) return [pts[0]]
  if (pts.length === 2 && !stroke.closed) return [pts[0], pts[1]]

  const n = pts.length
  const closed = stroke.closed ?? false
  const at = (i: number): PaperPoint =>
    closed ? pts[((i % n) + n) % n] : pts[Math.min(Math.max(i, 0), n - 1)]

  const out: PaperPoint[] = []
  const segments = closed ? n : n - 1
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < per; j++) {
      out.push(catmullRom(at(i - 1), at(i), at(i + 1), at(i + 2), j / per))
    }
  }
  out.push(closed ? pts[0] : pts[n - 1])
  return out
}

export interface ProjectedStroke {
  /** SVG `d`, ready to render. */
  readonly d: string
  readonly points: readonly ScreenPoint[]
  /** Cumulative screen-space arc length at each point. Last entry is `length`. */
  readonly cumulative: readonly number[]
  readonly length: number
  /** Line weight relative to the outline's. */
  readonly weight: number
}

/**
 * One leg of the quill's journey. `draw` lays ink down along a stroke;
 * `travel` is the pen lifted, moving to where the next stroke starts.
 * `start` and `end` are fractions of the whole drawing's time.
 */
type Phase =
  | { readonly kind: "draw"; readonly stroke: number; readonly start: number; readonly end: number }
  | {
      readonly kind: "travel"
      readonly from: ScreenPoint
      readonly to: ScreenPoint
      readonly start: number
      readonly end: number
    }

export interface ProjectedDrawing {
  readonly name: string
  readonly strokes: readonly ProjectedStroke[]
  readonly phases: readonly Phase[]
}

/**
 * A lifted pen crosses the page faster than a drawing one, so travel legs cost
 * a fraction of their length. Without this, a drawing with far-apart details
 * spends most of its time with the pen up and nothing happening.
 */
const TRAVEL_COST_RATE = 0.22

function projectStroke(stroke: Stroke): ProjectedStroke {
  const paper = samplePaperStroke(stroke)
  const points = paper.map(([x, y]) => projectPaperPoint(x, y))

  const cumulative: number[] = [0]
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    cumulative.push(total)
  }

  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(" ")

  return { d, points, cumulative, length: total, weight: stroke.weight ?? 1 }
}

/** Project a drawing and lay out its timeline. */
export function projectDrawing(drawing: Drawing): ProjectedDrawing {
  const strokes = drawing.strokes.map(projectStroke)

  // Cost every leg first, then normalise, so the phases come out as fractions.
  const costs: number[] = []
  for (let i = 0; i < strokes.length; i++) {
    if (i > 0) {
      const from = strokes[i - 1].points[strokes[i - 1].points.length - 1]
      const to = strokes[i].points[0]
      costs.push(Math.hypot(to.x - from.x, to.y - from.y) * TRAVEL_COST_RATE)
    }
    costs.push(strokes[i].length)
  }
  const totalCost = costs.reduce((a, b) => a + b, 0) || 1

  const phases: Phase[] = []
  let cursor = 0
  let costIndex = 0
  for (let i = 0; i < strokes.length; i++) {
    if (i > 0) {
      const span = costs[costIndex++] / totalCost
      phases.push({
        kind: "travel",
        from: strokes[i - 1].points[strokes[i - 1].points.length - 1],
        to: strokes[i].points[0],
        start: cursor,
        end: cursor + span,
      })
      cursor += span
    }
    const span = costs[costIndex++] / totalCost
    phases.push({ kind: "draw", stroke: i, start: cursor, end: cursor + span })
    cursor += span
  }

  return { name: drawing.name, strokes, phases }
}

/** Point at a fraction along a projected stroke, with its foreshortening. */
export function pointAtFraction(stroke: ProjectedStroke, t: number): ScreenPoint {
  const { points, cumulative, length } = stroke
  if (points.length === 0) return { x: 0, y: 0, s: 1 }
  if (points.length === 1 || length === 0) return points[0]

  const target = Math.min(Math.max(t, 0), 1) * length

  // Binary search for the segment containing `target`.
  let lo = 0
  let hi = cumulative.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (cumulative[mid] <= target) lo = mid
    else hi = mid
  }

  const span = cumulative[hi] - cumulative[lo]
  const local = span === 0 ? 0 : (target - cumulative[lo]) / span
  const a = points[lo]
  const b = points[hi]
  return {
    x: a.x + (b.x - a.x) * local,
    y: a.y + (b.y - a.y) * local,
    s: a.s + (b.s - a.s) * local,
  }
}

export interface Frame {
  /** Where the nib is, and how big the quill should be there. */
  readonly quill: ScreenPoint
  /** How much of each stroke has been inked, 0 to 1, indexed like `strokes`. */
  readonly strokeProgress: readonly number[]
}

/** Resolve the drawing's state at `progress` (0 = blank page, 1 = finished). */
export function resolveFrame(drawing: ProjectedDrawing, progress: number): Frame {
  const strokeProgress = drawing.strokes.map(() => 0)
  const p = Math.min(Math.max(progress, 0), 1)

  let quill: ScreenPoint = drawing.strokes[0]?.points[0] ?? { x: 0, y: 0, s: 1 }

  for (const phase of drawing.phases) {
    if (p >= phase.end) {
      // Fully behind us.
      if (phase.kind === "draw") {
        strokeProgress[phase.stroke] = 1
        const stroke = drawing.strokes[phase.stroke]
        quill = stroke.points[stroke.points.length - 1] ?? quill
      } else {
        quill = phase.to
      }
      continue
    }

    // The active phase. Everything after it stays untouched.
    const span = phase.end - phase.start
    const t = span === 0 ? 1 : (p - phase.start) / span
    if (phase.kind === "draw") {
      strokeProgress[phase.stroke] = t
      quill = pointAtFraction(drawing.strokes[phase.stroke], t)
    } else {
      quill = {
        x: phase.from.x + (phase.to.x - phase.from.x) * t,
        y: phase.from.y + (phase.to.y - phase.from.y) * t,
        s: phase.from.s + (phase.to.s - phase.from.s) * t,
      }
    }
    break
  }

  return { quill, strokeProgress }
}


/* ------------------------------------------------------------------ *
 * The scene
 *
 * One drawing: a cat sitting in a row of flowers, in the style of a
 * small ink doodle. It is authored in paper space looking straight down
 * at the sheet, so the perspective is entirely the projection's job.
 *
 * Shapes come from builders rather than 200 hand-typed numbers. A daisy
 * is a scalloped closed curve, not six petals stuck together, so it
 * stays one stroke of the pen.
 * ------------------------------------------------------------------ */

/** Where every stem lands, and where the cat sits. */
const GROUND = 75

/** A closed ring. Used for eyes, flower centres, anything round. */
function circle(cx: number, cy: number, r: number, steps = 8): PaperPoint[] {
  return Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * Math.PI * 2 - Math.PI / 2
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as PaperPoint
  })
}

/**
 * A flower head: one closed curve whose radius rises and falls smoothly
 * around the circle, `petals` times.
 *
 * Sampling the cosine finely is what makes this a flower. Placing one
 * point at each tip and one in each valley and letting the smoother join
 * them draws a STAR, because the curve overshoots into a sharp corner at
 * every tip. Six samples per petal keeps the lobes round.
 */
function bloom(cx: number, cy: number, petals: number, tip: number, valley: number): PaperPoint[] {
  const mid = (tip + valley) / 2
  const swing = (tip - valley) / 2
  const steps = petals * 6
  return Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * Math.PI * 2 - Math.PI / 2
    const r = mid + swing * Math.cos(petals * (a + Math.PI / 2))
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as PaperPoint
  })
}

/** A tulip cup: a rounded vessel with three lobes across the top. */
function tulip(cx: number, baseY: number, w: number, h: number): PaperPoint[] {
  return [
    [cx, baseY],
    [cx - w, baseY - h * 0.55],
    [cx - w * 0.92, baseY - h],
    [cx - w * 0.34, baseY - h * 0.76],
    [cx, baseY - h * 1.06],
    [cx + w * 0.34, baseY - h * 0.76],
    [cx + w * 0.92, baseY - h],
    [cx + w, baseY - h * 0.55],
  ]
}

/**
 * A leaf, rooted at (x, y) and reaching out along `deg`.
 *
 * The two points at 72% of the way out are what give it a point rather
 * than a balloon: they sit close to the tip, so the smoother comes in
 * steeply on both sides instead of rounding across.
 */
function leaf(x: number, y: number, len: number, width: number, deg: number): PaperPoint[] {
  const a = (deg * Math.PI) / 180
  const [ux, uy] = [Math.cos(a), Math.sin(a)]
  const [px, py] = [-uy, ux]
  const at = (t: number, w: number): PaperPoint => [
    x + ux * len * t + px * width * w,
    y + uy * len * t + py * width * w,
  ]
  return [at(0, 0), at(0.32, 1), at(0.78, 0.5), at(1, 0), at(0.78, -0.5), at(0.32, -1)]
}

/** A stem, bowed sideways by `bend` so it never reads as a ruled line. */
function stem(x: number, topY: number, bend: number): PaperPoint[] {
  return [
    [x, topY],
    [x + bend, topY + (GROUND - topY) * 0.5],
    [x + bend * 0.3, GROUND],
  ]
}

/**
 * The cat, front on: two ear points, a body that widens all the way to
 * the ground, a hooked tail, and a face. Left and right are mirrored
 * about x = 56 on purpose; a lopsided doodle reads as a mistake rather
 * than as charm.
 */
const CAT_OUTLINE: PaperPoint[] = [
  [44, 12], // left ear tip
  [56, 25], // the notch between the ears
  [68, 12], // right ear tip
  [71, 27],
  [72, 36], // cheek
  [73, 46],
  [75, 57],
  [78, 67],
  [76, 73], // bottom corner
  [66, 75],
  [56, 75],
  [46, 75],
  [36, 73], // bottom corner
  [34, 67],
  [37, 57],
  [39, 46],
  [40, 36], // cheek
  [41, 27],
]

const SCENE: Drawing = {
  name: "cat-in-flowers",
  strokes: [
    // The cat comes first: it is the silhouette, so a half-drawn frame
    // still reads as something.
    { points: CAT_OUTLINE, closed: true },
    {
      // Tail, hooking up and over on the right.
      weight: 0.9,
      points: [
        [78, 71],
        [88, 71],
        [95, 62],
        [94, 51],
        [87, 48],
        [83, 53],
      ],
    },
    // Front legs, three strokes down the lower body.
    { weight: 0.6, points: [[46, 63], [46, 75]] },
    { weight: 0.6, points: [[56, 63], [56, 75]] },
    { weight: 0.6, points: [[66, 63], [66, 75]] },
    // Face. Eyes are tight rings drawn heavy, so they fill in as dots.
    { weight: 1.4, closed: true, points: circle(49, 38, 1.4) },
    { weight: 1.4, closed: true, points: circle(63, 38, 1.4) },
    {
      // A smile with a nose dipped into the middle of it.
      weight: 0.7,
      points: [
        [51, 45],
        [54, 49],
        [56, 45.5],
        [58, 49],
        [61, 45],
      ],
    },
    // Whiskers, running out past the cheeks.
    { weight: 0.5, points: [[47, 42], [33, 39]] },
    { weight: 0.5, points: [[47, 45], [33, 49]] },
    { weight: 0.5, points: [[65, 42], [79, 39]] },
    { weight: 0.5, points: [[65, 45], [79, 49]] },

    // The flower bed, left to right. Blooms sit in FRONT of the cat, so
    // their lines cross its outline exactly as they would on paper.
    { weight: 0.8, closed: true, points: tulip(15, 64, 4.5, 7) },
    { weight: 0.6, points: stem(15, 64, -1.5) },

    { weight: 0.8, closed: true, points: bloom(30, 51, 6, 6, 3) },
    { weight: 1.1, closed: true, points: circle(30, 51, 1.5) },
    { weight: 0.6, points: stem(30, 57, 1.8) },

    { weight: 0.8, closed: true, points: bloom(43, 64, 6, 4.4, 2.8) },
    { weight: 0.6, points: stem(43, 68.4, -1.2) },

    { weight: 0.8, closed: true, points: bloom(71, 53, 6, 6, 3) },
    { weight: 1.1, closed: true, points: circle(71, 53, 1.5) },
    { weight: 0.6, points: stem(71, 59, -1.8) },

    { weight: 0.8, closed: true, points: bloom(85, 62, 6, 4.4, 2.8) },
    { weight: 0.6, points: stem(85, 66.4, 1.2) },

    { weight: 0.8, closed: true, points: tulip(100, 67, 4.5, 8) },
    { weight: 0.6, points: stem(100, 67, 1.5) },

    // Leaves along the ground, alternating which way they lean.
    { weight: 0.6, closed: true, points: leaf(22, 74, 8, 2, -38) },
    { weight: 0.6, closed: true, points: leaf(37, 74.5, 7, 1.8, -142) },
    { weight: 0.6, closed: true, points: leaf(50, 74, 8, 2, -34) },
    { weight: 0.6, closed: true, points: leaf(64, 74.5, 7, 1.8, -146) },
    { weight: 0.6, closed: true, points: leaf(78, 74, 8, 2, -38) },
    { weight: 0.6, closed: true, points: leaf(93, 74.5, 7, 1.8, -142) },
    { weight: 0.6, closed: true, points: leaf(104, 74, 7, 1.8, -34) },
  ],
}

/** The one thing the loader draws, over and over. */
export const LOADER_DRAWING: Drawing = SCENE
