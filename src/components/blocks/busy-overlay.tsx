"use client"

import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * BusyOverlay — a light scrim with a spinner, covering the surface it sits in.
 *
 * For a step that is waiting on something and has no partial result to show:
 * checking a picked folder, cloning, declaring design systems. Mo's preference
 * over a spinner in the button (2026-08-17), and it is the better fit here for
 * a reason the button cannot cover: the whole step is inert while it waits, not
 * just the control you pressed. A disabled button and live radio cards behind
 * it says the opposite.
 *
 * ## Placement
 *
 * The parent must be a containing block. `DialogContent` is `fixed`, which
 * qualifies, so dropping this in as a direct child covers the dialog and its
 * footer. Anywhere else, add `relative` to the parent.
 *
 * ## Why the scrim is translucent and not opaque
 *
 * The user should still see what they were doing. An opaque cover reads as a
 * new screen, and if the wait is short it flashes as a whole-surface swap.
 * `bg-popover/70` keeps the content legible-but-inactive, which is what it is.
 *
 * ## Blocking is the point
 *
 * This intercepts pointer events, so it does the work that scattering
 * `disabled` across every control in the step used to do. Anything still
 * reachable underneath is a bug: a second submit while the first is in flight
 * is exactly what the overlay is for.
 *
 * Keyboard is NOT covered by this: it is a paint, not a focus trap. Keep the
 * controls' own `disabled` for that, or focus is still tabbable behind the
 * scrim.
 */
export interface BusyOverlayProps {
  /**
   * Announced to screen readers, and shown under the spinner when set. Keep it
   * a fragment naming the wait ("Checking the folder"), never a sentence, and
   * never with a trailing ellipsis: the spinner already says it is running.
   */
  label?: string
  className?: string
}

export function BusyOverlay({ label, className }: BusyOverlayProps) {
  return (
    <div
      // `status` + `polite`: this reports progress, it does not interrupt.
      role="status"
      aria-live="polite"
      data-testid="busy-overlay"
      className={cn(
        "absolute inset-0 z-10 flex flex-col items-center justify-center gap-2",
        // `rounded-xl` matches DialogContent so the scrim does not square off
        // the dialog's corners while it is up.
        "rounded-xl bg-popover/70 backdrop-blur-[1px]",
        className,
      )}
    >
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
      {label ? <span className="text-muted-foreground">{label}</span> : null}
      {/* With no visible label there is still something to announce, or a
          screen-reader user gets silence while the surface goes inert. */}
      {label ? null : <span className="sr-only">Working</span>}
    </div>
  )
}
