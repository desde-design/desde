"use client"

import { useEffect, useMemo, useRef } from "react"
import { cn } from "@/lib/utils"
import {
  LOADER_DRAWING,
  projectDrawing,
  resolveFrame,
  VIEW_H,
  VIEW_W,
} from "./loader-drawings"

/**
 * **DORMANT since 2026-08-20** (Mo's call). Nothing renders this.
 *
 * Its one production caller was the Editor launcher's busy overlay, which now
 * shows `blocks/project-loader.tsx` — a Lottie of a cat in a cardboard box —
 * so that the Editor and the Viewer present the same wait. This component was
 * kept rather than deleted: it is a distinctive piece of the product's
 * character, and the decision to retire it for good is a separate one from
 * the decision to stop showing it here.
 *
 * Dormant in this repo means RETAINED AND GREEN, not commented out. This file
 * and `loader-drawings.ts` keep their tests in the default run, for the reason
 * CLAUDE.md gives about dormant lanes: one whose tests rot is one that cannot
 * be woken up. There is no feature flag, because there is no dispatch to
 * gate — waking it is a one-line import swap in whichever surface wants it.
 *
 * Nothing here is load-bearing, so nothing needs guarding. If you are deleting
 * dead code and land on this file, it is dormant on purpose; check with Mo
 * before removing it.
 *
 * ---
 *
 * Looping "quill drawing" loader. A feather quill draws a cat sitting in
 * a bed of flowers, holds it for a moment, lets it fade, and starts over.
 *
 * It is drawn on a plane lying flat and receding away from the viewer, so
 * the quill grows as it draws toward you and shrinks as it works into the
 * distance. The plane itself is not drawn: an outline of the sheet was there
 * until 2026-08-14 and read as a stray box, because the perspective is
 * already legible from the quill's changing size and the drawing's own
 * foreshortening.
 *
 * All of that geometry lives in `loader-drawings.ts`; this component owns
 * only time. One requestAnimationFrame loop writes straight to the DOM,
 * so a loader that may sit on screen for a minute never re-renders React.
 *
 * Ink is the app's primary color; the quill inherits `currentColor`. Size
 * via `className` (width drives height through the viewBox aspect).
 */
export function QuillLoader({ className }: { className?: string }) {
  const drawing = useMemo(() => projectDrawing(LOADER_DRAWING), [])

  const pathRefs = useRef<(SVGPathElement | null)[]>([])
  const inkRef = useRef<SVGGElement | null>(null)
  const quillRef = useRef<SVGGElement | null>(null)

  useEffect(() => {
    const apply = (progress: number, opacity: number) => {
      const frame = resolveFrame(drawing, progress)

      frame.strokeProgress.forEach((done, i) => {
        const path = pathRefs.current[i]
        if (path) path.style.strokeDashoffset = String(drawing.strokes[i].length * (1 - done))
      })

      if (inkRef.current) inkRef.current.style.opacity = String(opacity)

      const quill = quillRef.current
      if (quill) {
        quill.setAttribute(
          "transform",
          `translate(${frame.quill.x.toFixed(2)} ${frame.quill.y.toFixed(2)}) scale(${(frame.quill.s * QUILL_SCALE).toFixed(3)})`,
        )
        quill.style.opacity = String(opacity)
      }
    }

    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches

    if (reduced) {
      // Show the drawing finished and leave it there. A page-covering
      // loader is exactly where an unwanted animation is least welcome.
      apply(1, 1)
      return
    }

    let raf = 0
    let start: number | null = null

    const tick = (now: number) => {
      if (start === null) start = now
      const withinCycle = (now - start) % CYCLE_MS
      const fadeStart = DRAW_MS + HOLD_MS
      apply(
        Math.min(withinCycle / DRAW_MS, 1),
        withinCycle <= fadeStart ? 1 : Math.max(0, 1 - (withinCycle - fadeStart) / FADE_MS),
      )
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [drawing])

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("w-64", className)}
      aria-hidden="true"
    >
      <g ref={inkRef} data-ink="" className="text-primary">
        {drawing.strokes.map((stroke, i) => (
          <path
            key={i}
            ref={(el) => {
              pathRefs.current[i] = el
            }}
            d={stroke.d}
            strokeWidth={(OUTLINE_WIDTH * stroke.weight).toFixed(2)}
            strokeOpacity="0.9"
            style={{
              strokeDasharray: dashPattern(stroke.length),
              strokeDashoffset: stroke.length,
            }}
          />
        ))}
      </g>

      {/* The quill. Its nib sits at (0,0), so the group transform puts the
          nib exactly where the line is being laid down. */}
      <g ref={quillRef} data-quill="" transform={`translate(${VIEW_W / 2} ${VIEW_H / 2}) scale(1)`}>
        <g strokeWidth="1.8">
          {/* handwriting wobble */}
          <animateTransform
            attributeName="transform"
            type="rotate"
            dur="1.1s"
            repeatCount="indefinite"
            values="-2.5 0 0;2.5 0 0;-2.5 0 0"
          />
          {/* vane: closed + softly filled */}
          <path
            d="M8 -13 C16 -17 26 -28 30 -42 C32 -48 28 -51 23 -48 C13 -42 5 -27 4 -15 C3.6 -11.5 5 -10.5 8 -13 Z"
            fill="currentColor"
            fillOpacity="0.12"
          />
          {/* spine + pointed nib down to (0,0) */}
          <path d="M0 0 C6 -12 14 -28 27 -45" />
          {/* barbs */}
          <path d="M11 -20 L19 -26" strokeWidth="1.2" strokeOpacity="0.65" />
          <path d="M14 -26 L22 -32" strokeWidth="1.2" strokeOpacity="0.65" />
          <path d="M17 -32 L25 -38" strokeWidth="1.2" strokeOpacity="0.65" />
        </g>
      </g>
    </svg>
  )
}

/**
 * The dash pattern that lets a stroke be drawn in: one dash as long as
 * the stroke, then a gap that is LONGER than the stroke.
 *
 * The long gap is the whole point. With the usual `dasharray: length`,
 * the gap is exactly the stroke's length, so the pattern repeats the
 * moment the offset pushes past the end, and the next dash wraps back
 * onto the path. On a closed stroke, whose end is also its start, that
 * paints a visible tick at the origin of all 33 strokes at once, every
 * time the loop restarts. A gap of `length + 4` cannot wrap.
 */
function dashPattern(length: number): string {
  return `${length} ${length + 4}`
}

/**
 * Time to ink the scene, then admire it, then let it fade out.
 *
 * Slowed to roughly a third of its first speed (2026-08-14). 33 strokes in
 * 4.2s is 127ms each, which does not read as drawing: it reads as scribbling,
 * and the eye cannot follow the nib. At this pace a stroke lands about every
 * third of a second, which is close to the speed of a hand.
 *
 * A long cycle is affordable here. This covers a clone and a first build, so
 * the loader is on screen for tens of seconds and most people never see it
 * loop at all.
 */
const DRAW_MS = 12000
const HOLD_MS = 1800
const FADE_MS = 900
const CYCLE_MS = DRAW_MS + HOLD_MS + FADE_MS

/** Quill size at the plane's near edge. Foreshortening scales it from there. */
const QUILL_SCALE = 1.12

/** Stroke width of the scene's outline. Detail strokes scale down off it. */
const OUTLINE_WIDTH = 2
