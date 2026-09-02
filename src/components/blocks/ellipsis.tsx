"use client"

/**
 * The three dots after a live label — "Thinking", "Working" — animated so the
 * label itself carries the sense of activity.
 *
 * Added 2026-08-18 to replace a spinner beside the word (Mo: "remove the
 * spinning loader before thinking, replace the ... after Thinking with an
 * animated version"). A spinner is a second object saying what the pulsing
 * label already said, and at any size it either overshoots the cap height or
 * disappears.
 *
 * Each dot is a real character, so the text still reads "Thinking..." to a
 * screen reader and to a copy-paste. Only the opacity animates — no layout
 * shift, no reflow of the row while it runs, which a width or a
 * character-swap animation would both cause.
 *
 * `aria-hidden` on the dots and a period in the label's own accessible name is
 * NOT done: three literal dots are already what a reader would announce, and
 * hiding them would make the label end mid-word.
 */

import { cn } from "@/lib/utils"

/** One dot per step, staggered by a third of the cycle. */
const DELAYS = ["0ms", "200ms", "400ms"] as const

export function AnimatedEllipsis({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex", className)} data-testid="animated-ellipsis">
      {DELAYS.map((delay) => (
        <span
          key={delay}
          className="animate-pulse"
          // The stagger is the whole effect and there is no Tailwind step for
          // it — an arbitrary `[animation-delay:200ms]` per dot would be three
          // one-off classes for one idea. This is the "genuinely dynamic
          // value" case inline style exists for.
          style={{ animationDelay: delay }}
        >
          .
        </span>
      ))}
    </span>
  )
}
