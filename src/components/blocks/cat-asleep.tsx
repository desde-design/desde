import { ArtImage } from "./art-image"
import { SLEEPING_CAT_SRC } from "@/assets/cat-art"

/**
 * A sleeping cat, for "this went wrong" and "this couldn't load".
 *
 * The counterpart to `CatEmptyBowl`, and deliberately a different picture:
 * "nothing here" and "something broke" are different facts, and one
 * illustration for both would flatten them into "no content".
 *
 * ## It is a still image (Mo, 2026-09-04)
 *
 * It used to loop, as a Lottie animation. The rule that made it loop is
 * recorded in `docs/design.md`: it had played once and held, on the argument
 * that a failure can sit on screen for a long time and a cat breathing on a
 * loop becomes motion in the corner of the eye of someone reading an error.
 * That was overruled on 2026-08-25 because "a still cat next to a live one on
 * the loading screen read as a broken animation rather than a deliberate one".
 *
 * Two facts overturned it back.
 *
 * The first is that the premise was not true of the code. `CatEmptyBowl` — the
 * picture this component sits beside, for `EmptyState`'s DEFAULT tone — has
 * always been static inline SVG. A frozen cat was already the common case in
 * the same component, and nobody read it as broken.
 *
 * The second is cost. MEASURED in the running Electron app: the looping Lottie
 * held **44.9% CPU** for as long as it was on screen, and an empty state is a
 * screen you leave open. This is the one illustration in the product with no
 * time limit on it, which makes it the worst possible place to spend a frame
 * budget. The still image costs nothing and is 15KB rather than 135KB.
 *
 * The Zzz is drawn into the picture, so it reads as "asleep" without motion.
 *
 * No `"use client"`: it is a pure render now that there is no player to load,
 * which is what lets `EmptyState` stay Server-safe without a client boundary.
 */
export function CatAsleep({ size = 128, className }: { size?: number; className?: string }) {
  return <ArtImage src={SLEEPING_CAT_SRC} size={size} className={className} />
}
