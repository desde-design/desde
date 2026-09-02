import { cn } from "@/lib/utils"

/**
 * The product wordmark — "Desde", set in Chillax, in brand teal.
 *
 * Shared by the Editor launcher header and the Viewer dashboard header so the
 * two surfaces cannot drift. Before this existed the Editor's copy carried
 * ~30 lines of comment justifying its face, size and weight, and the Viewer
 * had no wordmark at all — it said "DESDE" in the muted eyebrow style.
 * Every reason below applied to both surfaces; only one of them had it.
 *
 * **The one place `font-display` (Chillax) is allowed.** A display face at UI
 * sizes is decoration, not information.
 *
 * Chillax replaced Playfair Display on 2026-08-26 (Mo). It is the only
 * SELF-HOSTED face in the product — see the `@font-face` at the top of
 * `globals.css` for why that was forced, and why it is the better posture
 * anyway.
 *
 * **Size.** `text-2xl` (19px). 18px was asked for and is NOT on the ramp — it
 * falls exactly between `text-xl` (17) and `text-2xl` (19), one pixel from
 * each. Broken UPWARD (Mo's call, 2026-08-13). The page `h1` beside it is
 * also `text-2xl`, so wordmark and page title are the same SIZE and are told
 * apart by face and colour ALONE: teal Chillax 500 against foreground DM Sans
 * 500 (both dropped to 500 on 2026-08-26). Same size, same weight, both sans
 * — where the original pairing had a serif against a sans at different
 * weights, and every one of those differences has since been spent.
 *
 * That is deliberate, not drift, but it means there is nothing left to give:
 * if the two ever read as a tie, the only levers are the SIZE (drop this to
 * `text-xl`) or the colour. Do not reach for weight — it was tried in both
 * directions and Mo chose 500 for each. If that ever reads as a tie rather than a contrast,
 * drop this to `text-xl` rather than growing the h1. `text-[18px]` is not the
 * escape hatch — the ban on arbitrary sizes is what keeps the ramp from
 * re-fragmenting, and a tie is exactly the case that tempts you to break it.
 *
 * **Weight is pinned, not inherited.** `body` sets `font-weight: 300`
 * app-wide (globals.css). Chillax's variable range is wght 200-700, so 300
 * IS answerable here — but pinning stays, because the wordmark's weight is a
 * design decision and should not move when the body default does. 500 (Mo,
 * 2026-08-26) sits inside the axis, so it is interpolated by the variable
 * font rather than synthesised.
 *
 * **Teal comes from `text-primary`, not a literal.** This theme's `--primary`
 * IS the brand teal (`oklch(0.575 0.135 190)`), and the token carries its own
 * dark-mode value, so the wordmark lightens with the rest of the UI instead
 * of going muddy on a dark ground. NOTE: that token only resolves teal under
 * `[data-theme="teal"]`, which the host document must set — bare `:root` is a
 * near-black stone. The Viewer shipped without it until 2026-08-19.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "font-display text-2xl font-medium tracking-tight text-primary select-none",
        className,
      )}
    >
      Desde
    </span>
  )
}
