import type { ComponentProps } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

/**
 * Eyebrow — the uppercase micro-label that captions a group inside a menu,
 * panel or dialog ("Recent", "Design systems", "Sessions", …).
 *
 * Canonical recipe: `text-xs uppercase tracking-wide text-muted-foreground`,
 * normal weight. `size="sm"` (10px) is for dense dropdown/menu contexts.
 * This is the UPPERCASE convention — the sentence-case right-rail section
 * titles keep using `SectionHeader` / `sectionHeaderTextClass`.
 *
 * Replaces eight divergent hand-rolled recipes (3 sizes × 2 weights ×
 * 3 opacities) across the editor panels.
 */
const eyebrowVariants = cva(
  "block font-normal uppercase tracking-wide text-muted-foreground",
  {
    variants: {
      size: {
        default: "text-xs",
        sm: "text-2xs",
      },
    },
    defaultVariants: { size: "default" },
  },
)

export interface EyebrowProps
  extends ComponentProps<"h3">,
    VariantProps<typeof eyebrowVariants> {
  /** Render as a different element when `<h3>` semantics don't fit. */
  as?: "h2" | "h3" | "h4" | "div" | "span"
}

export function Eyebrow({
  as: Comp = "h3",
  size,
  className,
  ...props
}: EyebrowProps) {
  return (
    <Comp
      data-slot="eyebrow"
      className={cn(eyebrowVariants({ size }), className)}
      {...props}
    />
  )
}

export { eyebrowVariants }
