import type { ComponentProps } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { TONE_SURFACE } from "@/lib/tone-surface"

/**
 * Callout — an inline banner for warnings, errors and info notes inside
 * panels and dialogs. Tokens only: the tinted-surface recipe comes from
 * `TONE_SURFACE`, so this file no longer carries its own copy of it.
 *
 * Body copy inside can reset to `text-foreground` where the tone color is
 * too loud for long text; the container stays the semantic signal.
 *
 * ## Why this is still a separate component from `Alert`
 *
 * The duplication worth ending was the tone recipe, and that is now shared.
 * The two components are not otherwise the same thing, and folding one into
 * the other would trade a styling bug for an accessibility one.
 *
 * `Alert` announces itself with `role="alert"`, which is assertive: it
 * interrupts whatever a screen reader is currently saying. That is right for
 * a chat banner reporting that the turn failed. `Callout` announces with
 * `role="status"`, which is polite and waits its turn. That is right for a
 * paragraph of context sitting inside an open dialog, which is most of what
 * Callout is used for. Rebuilding Callout on Alert would make every one of
 * those interrupt, and passing `role="status"` back in at each call site is
 * the same duplication one level down.
 *
 * They also differ in geometry, which is the cheaper half of the argument:
 * Alert is a grid with an icon column, an action slot and title/description
 * slots at `rounded-lg`; Callout is a plain padded box with an `lg` size for
 * dialog copy. Merging them would move every existing Callout call site.
 */
const calloutVariants = cva("rounded-md border", {
  variants: {
    tone: {
      warning: TONE_SURFACE.warning,
      destructive: TONE_SURFACE.destructive,
      info: TONE_SURFACE.info,
      success: TONE_SURFACE.success,
    },
    size: {
      default: "px-2.5 py-2 text-sm",
      lg: "p-3 text-base",
    },
  },
  defaultVariants: { tone: "info", size: "default" },
})

export interface CalloutProps
  extends ComponentProps<"div">,
    VariantProps<typeof calloutVariants> {
  /**
   * Renders a dismiss button at the top right and calls this on click.
   *
   * It lives here rather than at the call site because a hand-assembled one
   * lands in a different place every time. The Viewer's public-link banner
   * built its own with `flex items-start gap-2` and a bare `icon-xs` Button,
   * which put the glyph's optical edge about 15px inside the banner while
   * every other right-hand affordance in the product sits on the content
   * edge. Editor and Viewer banners are the same component; their dismiss
   * buttons should not be two different pieces of markup.
   */
  onDismiss?: () => void
  /** Accessible name for the dismiss button. */
  dismissLabel?: string
}

export function Callout({
  tone,
  size,
  className,
  role = "status",
  onDismiss,
  dismissLabel = "Dismiss",
  children,
  ...props
}: CalloutProps) {
  return (
    <div
      data-slot="callout"
      role={role}
      className={cn(calloutVariants({ tone, size }), onDismiss && "flex items-start gap-2", className)}
      {...props}
    >
      {onDismiss ? (
        <>
          <div className="min-w-0 flex-1">{children}</div>
          {/*
            `-mr-1.5` and `-mt-1` pull the button's own padding back out of the
            banner's. An `icon-xs` Button centres a 14px glyph in a 20px box,
            so aligning the BUTTON to the content edge leaves the glyph three
            pixels short of it, on top of the banner's 10px padding. Negative
            margins put the glyph where the eye expects the edge, which is
            what "more to the right" means here.

            `text-current` so the X takes the banner's tone rather than
            arriving as a neutral grey inside an amber box.
          */}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={dismissLabel}
            onClick={onDismiss}
            data-slot="callout-dismiss"
            className="-mt-1 -mr-1.5 flex-none text-current hover:bg-foreground/10"
          >
            <X />
          </Button>
        </>
      ) : (
        children
      )}
    </div>
  )
}

export { calloutVariants }
