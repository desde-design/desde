"use client"

import { LottieAnimation } from "./lottie-animation"
import { cn } from "@/lib/utils"

/**
 * The one loading animation for "a whole thing is arriving" — a project
 * opening in the Editor, a prototype booting in the Viewer's iframe.
 *
 * It exists as a block so both surfaces show the SAME wait. Before it, the
 * Editor had a bespoke drawing loader and the Viewer's iframe had nothing at
 * all: a reviewer opening a review link watched a blank rectangle until the
 * prototype painted.
 *
 * That bespoke loader — `editor/launcher/quill-loader.tsx`, a quill drawing a
 * cat in flowers — is DORMANT rather than deleted. Read its header before
 * removing it as dead code.
 *
 * It also covers the Viewer dashboard's project list (Mo, 2026-08-25). This
 * header used to carve out an exception for it — "a list arriving inside a
 * page that is already there" earns less than "the main object of the screen
 * is missing" — and that line did not survive contact with the Editor
 * launcher, which has always shown this same cat while loading somebody's
 * list of projects. The exception existed only here, in prose, while the two
 * surfaces showed different waits for the same act.
 *
 * ## Why Lottie and not the WebM
 *
 * Both were supplied. MEASURED on the two files:
 *
 * | | WebM | Lottie |
 * | --- | --- | --- |
 * | over the wire | 320KB | **44KB** gzipped |
 * | copies in the repo | two | **one** |
 * | Safari transparency | **broken** | fine |
 *
 * The transparency is what decided it rather than the size. The WebM carries
 * a real alpha channel (its corner pixels sample `[0,0,0,0]`), and Safari
 * does not support alpha in WebM — the cat would render inside a black square
 * for anyone opening a review link in Safari, which is not a browser this
 * product gets to opt out of.
 *
 * The packaging followed: a Lottie is JSON, and both bundlers import JSON
 * natively, so it is ONE tracked file that Vite (Editor) and Next (Viewer)
 * share. The WebM would have needed a copy in each bundler's static
 * directory — two binaries that can drift apart with nothing to catch it.
 *
 * The cost is a runtime dependency, which this repo does not take lightly.
 * It is the `lottie_light` build (SVG renderer only, no canvas/HTML
 * renderers) for that reason.
 *
 * The loading mechanics — why the player and the JSON are both pulled in
 * lazily, and why that alone was not enough — live in `LottieAnimation`.
 */
export interface ProjectLoaderProps {
  /**
   * Said under the animation. Keep it a fragment naming the wait ("Opening
   * your project"), never a sentence, and never with a trailing ellipsis —
   * the animation already says it is running.
   */
  label?: string
  /**
   * Rendered size of the square animation, in px. Defaults to 120.
   *
   * There are two sizes in the product and only two. Thirteen inline and
   * panel waits pass `80` explicitly; the three FULL-PAGE waits (the Editor
   * launcher's overlay, the Viewer loading a prototype over its iframe, and
   * the project list) take this default. So the default IS the full-page
   * size, and changing it reaches exactly those three and nothing else.
   *
   * 120, not 160 (Mo, 2026-09-01: "a little large ... let's make it a little
   * smaller"). Not 80: a full-screen overlay and a row inside a settings card
   * should not wear the same size.
   */
  size?: number
  className?: string
}

export function ProjectLoader({ label, size = 120, className }: ProjectLoaderProps) {
  return (
    <div
      // `status` + `polite`: this reports progress, it does not interrupt.
      role="status"
      aria-live="polite"
      data-testid="project-loader"
      className={cn("flex flex-col items-center justify-center gap-3", className)}
    >
      <LottieAnimation load={loadCat} size={size} />
      {label ? <p className="text-base text-muted-foreground">{label}</p> : null}
      {label ? null : <span className="sr-only">Loading</span>}
    </div>
  )
}

/**
 * Hoisted out of the render so its identity is stable.
 *
 * `LottieAnimation` lists `load` in its effect deps, so an inline arrow would
 * be a new function every render, tearing down and rebuilding the animation
 * on each one.
 */
const loadCat = () => import("@/assets/loading-cat.json")
