"use client"

import { LottieAnimation } from "./lottie-animation"

/**
 * A sleeping cat, for "this went wrong" and "this couldn't load".
 *
 * The counterpart to `CatEmptyBowl`, and deliberately a different picture:
 * "nothing here" and "something broke" are different facts, and one
 * illustration for both would flatten them into "no content".
 *
 * It loops (Mo, 2026-08-25). It used to play once and hold the last frame,
 * on the argument that a failure can sit on screen for a long time and a cat
 * breathing on a loop becomes motion in the corner of the eye of someone
 * reading an error. Overruled: a still cat next to a live one on the loading
 * screen read as a broken animation rather than a deliberate one.
 *
 * `"use client"` is what lets `EmptyState` stay a pure Server-safe component
 * while still rendering this. A client component imported by a Server one is
 * fine; the directive is a no-op under Vite.
 */
export function CatAsleep({ size = 128, className }: { size?: number; className?: string }) {
  return <LottieAnimation load={loadSleepingCat} size={size} className={className} />
}

/** Hoisted so its identity is stable across renders — see `LottieAnimation`. */
const loadSleepingCat = () => import("@/assets/sleeping-cat.json")
