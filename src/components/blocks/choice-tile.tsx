import type { ComponentProps, ReactNode } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

/**
 * ChoiceTile — a full-area, card-style choice button: icon + title + hint.
 *
 * The canonical recipe for "pick one of these options" surfaces (scope
 * dialogs, source pickers, launcher empty state). Extracted from the
 * verbatim-identical hand-rolled buttons in iteration-scope-dialog,
 * delete-scope-dialog and style-scope-dialog — use this instead of
 * re-assembling the pattern.
 *
 * `size="lg"` is the page-level variant (larger icon/padding) for
 * non-dialog surfaces like the launcher home page.
 */
const choiceTileVariants = cva(
  cn(
    "flex w-full items-start text-left rounded-lg border",
    "hover:border-primary hover:bg-muted/50",
    "focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
    "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-transparent",
  ),
  {
    variants: {
      size: {
        default: "gap-3 p-3",
        lg: "gap-4 p-5",
      },
    },
    defaultVariants: { size: "default" },
  },
)

const choiceTileIconVariants = cva("shrink-0 text-muted-foreground", {
  variants: {
    size: {
      default: "mt-0.5 size-4",
      // 20px, not 24 (Mo, 2026-09-02: "the icons should be smaller"). At 24
      // the glyph outweighed the 15px title beside it. `mt-0.5` centres it on
      // the title's first line.
      lg: "mt-0.5 size-5",
    },
  },
  defaultVariants: { size: "default" },
})

const choiceTileTitleVariants = cva("font-normal", {
  variants: {
    size: {
      default: "text-base",
      lg: "text-lg font-medium",
    },
  },
  defaultVariants: { size: "default" },
})

export interface ChoiceTileProps
  extends Omit<ComponentProps<"button">, "title">,
    VariantProps<typeof choiceTileVariants> {
  /** Leading icon — pass the element (e.g. `<Rows3 />`); the tile sizes it. */
  icon?: ReactNode
  title: ReactNode
  /** Secondary line under the title (also used for disabled reasons). */
  hint?: ReactNode
}

export function ChoiceTile({
  icon,
  title,
  hint,
  size,
  className,
  type = "button",
  ...props
}: ChoiceTileProps) {
  return (
    // eslint-disable-next-line react/forbid-elements -- ChoiceTile IS the sanctioned full-area choice button; Button's inline-flex centering and fixed heights break the card layout. Use ChoiceTile at call sites instead of disabling this rule again.
    <button
      type={type}
      data-slot="choice-tile"
      className={cn(choiceTileVariants({ size }), className)}
      {...props}
    >
      {icon ? (
        <span aria-hidden className={cn(choiceTileIconVariants({ size }), "[&_svg]:size-full")}>
          {icon}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={choiceTileTitleVariants({ size })}>{title}</span>
        {hint ? (
          <span className="text-sm text-muted-foreground">{hint}</span>
        ) : null}
      </span>
    </button>
  )
}
