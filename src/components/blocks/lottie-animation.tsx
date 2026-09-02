"use client"

import { useEffect, useRef } from "react"
import type { AnimationItem } from "lottie-web"
import { cn } from "@/lib/utils"

/**
 * A Lottie animation, loaded lazily and safely.
 *
 * Extracted from `project-loader.tsx` when a second animation arrived (the
 * sleeping cat on failure states, 2026-08-21). Everything here was learned
 * the hard way once already and should not have to be learned again per
 * animation.
 *
 * ## Both the player and the artwork load LAZILY, and that is not an
 * optimisation
 *
 * `lottie_light` calls `canvas.getContext("2d")` and writes to it AT IMPORT
 * TIME. Under jsdom `getContext` returns null, so a static import threw
 * `Cannot set properties of null (setting 'fillStyle')` while the module was
 * still being evaluated, taking down 34 test FILES at once — every one that
 * transitively reached the importing component. Nothing was even rendered.
 *
 * Deferring it is not sufficient on its own, and the first version of that fix
 * stopped there. A jsdom test that RENDERS the component still runs the
 * effect, still evaluates the player, and still throws, now as an unhandled
 * promise rejection reported below the summary rather than in it. The viewer
 * suite was raising 54 of them.
 *
 * **Lazy loading changes WHEN a module runs, never WHETHER it can run.** So
 * `canRenderAnimation` asks first, because a module that throws while
 * evaluating leaves nothing to catch afterwards.
 *
 * ## Why the artwork is a loader function
 *
 * `load` is `() => import("@/assets/whatever.json")` rather than the data
 * itself, so each animation's JSON stays out of the bundle until something
 * actually renders it. These files are 130-400KB raw.
 */
export interface LottieAnimationProps {
  /** Dynamic import of the animation JSON. */
  load: () => Promise<{ default: unknown }>
  /** Rendered size of the square animation, in px. */
  size: number
  /** Play once and hold the last frame, rather than looping. */
  loop?: boolean
  className?: string
}

export function LottieAnimation({ load, size, loop = true, className }: LottieAnimationProps) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = host.current
    if (!container) return
    if (!canRenderAnimation()) return

    let animation: AnimationItem | undefined
    let cancelled = false

    const build = Promise.all([import("lottie-web/build/player/lottie_light"), load()]).then(
      ([player, data]) => {
        // The component can unmount while these are in flight; without the
        // flag the animation would be built into a detached node and never
        // destroyed.
        if (cancelled || !host.current) return
        animation = player.default.loadAnimation({
          container: host.current,
          renderer: "svg",
          loop,
          autoplay: true,
          animationData: data.default,
        })
      },
    )

    // A different failure from the one above: a chunk that never arrives over
    // the network. That leaves an empty square, which is an acceptable state.
    // What it must not do is raise an unhandled rejection into a page that is
    // otherwise fine.
    void build.catch(() => {})

    return () => {
      cancelled = true
      animation?.destroy()
    }
  }, [load, loop])

  return (
    // Decorative in every current use: whatever it conveys is said by the
    // words beside it.
    <div ref={host} aria-hidden className={cn("shrink-0", className)} style={{ width: size, height: size }} />
  )
}

/**
 * Whether this environment can evaluate the Lottie player at all.
 *
 * The player builds a 2d canvas context during module evaluation and writes to
 * it immediately. jsdom hands back `null` there, so the import throws before
 * any of our code runs — there is no try/catch placement that helps, because
 * the failure is in the module body and not in a call we make.
 *
 * The probe performs the same operation the player performs, so it cannot
 * drift out of agreement with it. It is deliberately not a `typeof window`
 * check: jsdom has a window, a document, and a canvas element. What it lacks
 * is the context, and that is the thing to ask about.
 */
function canRenderAnimation(): boolean {
  try {
    return document.createElement("canvas").getContext("2d") != null
  } catch {
    return false
  }
}
