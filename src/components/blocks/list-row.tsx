import type { ComponentProps } from "react"
import { Slot } from "radix-ui"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

/**
 * ListRow — a full-width clickable row for panel lists (layers, annotations,
 * pages, pickers). The canonical hover/selected recipe:
 *
 * - hover: `bg-muted/50`
 * - selected: `bg-muted`
 *
 * Replaces the divergent hand-rolled rows (`hover:bg-muted` vs
 * `hover:bg-accent`, `bg-accent/70` vs `bg-muted` selected states) that
 * previously lived in layers-panel, comments-list-panel,
 * swap-dialog and design-systems-panel.
 *
 * `density="dense"` is the tight tree-row form (layers panel).
 * `asChild` renders the row styles onto a custom element (e.g. a `<div>`
 * carrying drag handlers) via Radix Slot, same contract as Button.
 */
const listRowVariants = cva(
  cn(
    "flex w-full items-center text-left",
    "hover:bg-muted/50",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
    "disabled:pointer-events-none disabled:opacity-50",
  ),
  {
    variants: {
      density: {
        default: "gap-2 rounded-md px-2 py-1.5 text-sm",
        dense: "gap-1 rounded-sm py-1 pr-2 text-xs",
      },
      selected: {
        true: "bg-muted",
        false: "",
      },
    },
    defaultVariants: { density: "default", selected: false },
  },
)

export interface ListRowProps
  extends ComponentProps<"button">,
    VariantProps<typeof listRowVariants> {
  asChild?: boolean
}

export function ListRow({
  className,
  density,
  selected,
  asChild = false,
  type,
  ...props
}: ListRowProps) {
  // ListRow IS the sanctioned raw-button list row (Button's centering, height
  // and whitespace-nowrap are wrong for full-width multi-line rows) — use
  // ListRow at call sites instead of eslint-disabling react/forbid-elements.
  const Comp = asChild ? Slot.Root : "button"
  return (
    <Comp
      data-slot="list-row"
      aria-selected={selected === true ? true : undefined}
      type={asChild ? undefined : (type ?? "button")}
      className={cn(listRowVariants({ density, selected }), className)}
      {...props}
    />
  )
}

export { listRowVariants }
