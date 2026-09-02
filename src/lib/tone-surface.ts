/**
 * The tinted-surface recipe, defined once.
 *
 * `border-{tone}/40 bg-{tone}/10 text-{tone}` is the house treatment for any
 * box that carries a semantic tone: an `Alert` banner, a `Callout` in a panel
 * or a dialog. It used to live in two places at once (the `destructive`
 * variant of `Alert`, and every tone of `Callout`) and was hand-written inline
 * in six chat status banners besides.
 *
 * That duplication is what produced the bug this file closes. `Alert` shipped
 * exactly two named variants, `default` and `destructive`, so a banner needing
 * warning, success or info had to hand-write the triple. Any banner whose
 * author did not hand-write it fell through to `default`, which is the neutral
 * card ground: white. The only tone you got for free was "no tone at all".
 *
 * Both components compose these strings rather than restating them, so the
 * numbers move in one edit. The strings must stay literal. Tailwind generates
 * classes by scanning source text, so a class assembled from a variable at
 * runtime is never emitted, and the box renders untinted.
 *
 * Border opacity is /40 for every tone. It was /30 on `Alert`'s destructive
 * variant alone; /40 is what `Callout` and all six inline banners already
 * used, so unifying on /30 would have shifted every existing Callout call site
 * in order to hold one variant still.
 *
 * The two components stay separate on purpose. The reason is written down in
 * `src/components/blocks/callout.tsx`.
 */
/*
 * `font-medium` on ALL FOUR tones (Mo, 2026-08-18).
 *
 * It was on `warning` alone, on the reasoning that the other three sit at
 * L<=0.63 and read fine at normal weight. True in isolation, and wrong in a
 * stack: coloured copy on a 10% tint of its own hue is lower-contrast than
 * neutral copy on the page whatever the lightness, and the one banner carrying
 * the extra weight read as a different component from the three beside it.
 */
export const TONE_SURFACE = {
  /** A failure the user has to act on. */
  destructive:
    "border-destructive/40 bg-destructive/10 text-destructive font-medium",
  /** Something already happened and is recoverable. */
  /* `text-warning-strong`, not `text-warning`: the base amber is L=0.769
     against an L=0.976 page, so amber-on-amber-tint was the lowest-contrast
     copy in the product. See `--warning-strong` in globals.css — which is now
     an ORANGE rather than the brown it started as, because a dark low-chroma
     amber is a brown by definition and read as one. */
  warning:
    "border-warning/40 bg-warning/10 text-warning-strong font-medium",
  /** An action completed. */
  success: "border-success/40 bg-success/10 text-success font-medium",
  /** Context the user did not ask for and does not have to act on. */
  info: "border-info/40 bg-info/10 text-info font-medium",
} as const

export type ToneName = keyof typeof TONE_SURFACE
