import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Loader2 } from "lucide-react"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-normal whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border hover:bg-input/50 hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:bg-input/30",
        /*
          `outline-primary` — a teal-framed action (Mo, 2026-08-26). The
          review rail's "Add comment" is the first; more are expected, which
          is why this is a variant rather than the inline recipe it started
          as.
        
          Three deliberate values:
        
          - The border is `/25`, not full strength. It frames the label
            instead of competing with it; at full strength the outline read
            louder than the words inside it.
          - `font-medium` overrides the base's `font-normal`. It is safe to
            put a conflicting utility here because `Button` composes through
            `cn`, so tailwind-merge drops the loser rather than emitting both
            and letting source order decide.
          - Hover tints the GROUND (`bg-primary/5`) and leaves the text where
            it is. `outline` swaps text to `foreground` on hover, which for a
            teal button would mean the label changing colour on the way to
            being clicked.
        */
        "outline-primary":
          "border-primary/25 font-medium text-primary hover:bg-primary/5 hover:text-primary aria-expanded:bg-primary/10 aria-expanded:text-primary",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-7 gap-1 px-2 text-sm has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        xs: "h-5 gap-1 rounded-sm px-2 text-2xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-2.5",
        sm: "h-6 gap-1 px-2 text-sm has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        lg: "h-8 gap-1 px-2.5 text-sm has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-4",
        icon: "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-xs": "size-5 rounded-sm [&_svg:not([class*='size-'])]:size-2.5",
        "icon-sm": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-lg": "size-8 [&_svg:not([class*='size-'])]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/**
 * `busy` — the work this button started is still running.
 *
 * It puts a spinner before the label, disables the button, and marks it
 * `aria-busy`. Set by Mo as a rule on 2026-08-21: **when an action has no
 * full-page or full-modal loading indicator of its own, the button that
 * started it carries the spinner.**
 *
 * Without it, a busy button is a disabled button with different words in it,
 * and "Revoking" at 50% opacity reads as "this control is unavailable" rather
 * than "this is happening". The two states look identical and mean opposite
 * things.
 *
 * It lives on the primitive rather than at the call sites because the call
 * sites already had the state: every one of them was rendering
 * `disabled={busy}` and a swapped label, which is the whole pattern minus the
 * one part that makes it legible.
 *
 * The label stays in the present participle ("Revoking"), and never takes a
 * trailing ellipsis: the spinner says it is running, and so do the words.
 *
 * NOT for a surface that already shows a `BusyOverlay` or a full-page loader.
 * Two indicators for one wait is the thing docs/design.md warns about under
 * "One icon per header".
 *
 * Ignored under `asChild`, where this component renders someone else's
 * element and has nowhere to put a spinner.
 */
function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  busy = false,
  disabled,
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    busy?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"
  const showSpinner = busy && !asChild

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      aria-busy={showSpinner || undefined}
      disabled={disabled || showSpinner}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {/*
        Under `asChild`, `children` is passed through UNTOUCHED and un-wrapped.
        `Slot.Root` calls `React.Children.only`, so even `{null}{children}`
        is two children and throws — which it did, on every `asChild` Button
        in the app, the moment the spinner was added. Hence the branch rather
        than a fragment that "renders nothing" when idle.
      */}
      {asChild ? (
        children
      ) : (
        <>
          {showSpinner ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {children}
        </>
      )}
    </Comp>
  )
}

export { Button, buttonVariants }
