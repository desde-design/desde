import { ArtImage } from "./art-image"
import { LOADING_CAT_SRC } from "@/assets/cat-art"
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
 * ## Why an animated WebP and not Lottie
 *
 * This shipped as a Lottie animation until 2026-09-04, when it was measured
 * as the single most expensive thing in the product: **99.3% CPU**, sustained,
 * for as long as the loader was on screen. See `art-image.tsx` for the full
 * matrix and the mechanism. The replacement costs 5.2%.
 *
 * The artwork and its timing are unchanged — same 45 frames at 33fps, from the
 * vendor's own 800×800 export, downscaled to 240px (2x the 120px default) with
 * its transparent margin trimmed so the cat fills the box at the size it used
 * to. Downscaling from 800px is also what recovers a real alpha channel from
 * the export's 1-bit transparency: 211 distinct alpha levels at 240px,
 * measured.
 *
 * The old header argued Lottie over a WebM on three counts — 44KB gzipped vs
 * 320KB, one file rather than two, and Safari's missing WebM alpha channel.
 * Only the size count still stands, and it now costs 305KB rather than 43KB.
 * That was accepted deliberately (Mo, 2026-09-04) in exchange for the CPU:
 * full frame rate, no visual compromise. The Safari count is answered rather
 * than ignored — animated WebP has full alpha and Safari has supported it
 * since 14, which is exactly what WebM could not offer.
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
   *
   * The asset is 240px, so 120 is exactly 1:1 on a 2x display and every
   * smaller call site is oversampled. Going ABOVE 120 starts to soften it.
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
      <ArtImage src={LOADING_CAT_SRC} size={size} />
      {label ? <p className="text-base text-muted-foreground">{label}</p> : null}
      {/* With no visible label there is still something to announce, or a
          screen-reader user gets silence while the surface goes inert. The
          gallery's `project-loader/bare` state also asserts this block renders
          SOME content with no label — an image-only loader fails it. */}
      {label ? null : <span className="sr-only">Loading</span>}
    </div>
  )
}
