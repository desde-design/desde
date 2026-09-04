import { cn } from "@/lib/utils"

/**
 * A decorative illustration in a square box.
 *
 * Replaced `LottieAnimation` on 2026-09-04. MEASURED in the running Electron
 * app, with a controlled matrix and a clean control at both ends:
 *
 * | what is on screen                          | total CPU | renderer | GPU  |
 * | ------------------------------------------ | --------- | -------- | ---- |
 * | nothing                                    |      1.3% |      0.9 |  0.1 |
 * | this component (animated WebP)             |      5.2% |      2.3 |  3.9 |
 * | Lottie, canvas renderer                    |     39.4% |     12.9 | 26.4 |
 * | Lottie, SVG renderer                       |     74.6% |     48.0 | 26.4 |
 * | Lottie, SVG renderer + the launcher's blur |     99.3% |     64.6 | 34.4 |
 *
 * lottie-web's SVG renderer re-attributes 300-480 live SVG nodes 24 times a
 * second. That is the whole cost, and it is intrinsic to the animation rather
 * than to the surface it sits on: the loader cat still cost 67.7% in a small
 * opaque box with no overlay at all. The canvas renderer only halved it. An
 * animated `<img>` is decoded by the browser's image pipeline instead, which
 * is where this kind of work belongs.
 *
 * The old component's whole apparatus goes with it. There is no player to
 * import, so there is no jsdom `canvas.getContext` hazard, no
 * `canRenderAnimation` probe, no lazy-import dance, and no effect — which is
 * why this file has no `"use client"` and `CatAsleep` no longer needs one
 * either. It is a pure render, safe in a Server Component.
 *
 * On the Safari objection recorded in `project-loader.tsx`: it does not carry
 * over. WebM was rejected because Safari has no alpha channel for it, which
 * put the cat in a black square. Animated WebP has full alpha and Safari has
 * supported it since 14. GIF was the other candidate and was rejected here for
 * the opposite reason — its 1-bit alpha puts hard edges on every antialiased
 * line of a cat drawn on transparency.
 */
export interface ArtImageProps {
  /** From `@/assets/cat-art` — see that module for why it is not a static import. */
  src: string
  /** Rendered size of the square image, in px. */
  size: number
  className?: string
}

export function ArtImage({ src, size, className }: ArtImageProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- `blocks/` is bundled by Vite for the Editor UI and both galleries, not only by Next, so `next/image` does not exist in five of this file's six compile passes. Same reason as the three globs already exempted in eslint.config.mjs.
    <img
      src={src}
      width={size}
      height={size}
      // Decorative in every current use: whatever it conveys is said by the
      // words beside it.
      alt=""
      aria-hidden
      className={cn("shrink-0", className)}
      style={{ width: size, height: size }}
    />
  )
}
