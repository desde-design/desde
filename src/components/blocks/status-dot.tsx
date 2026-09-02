import type { ComponentProps, ReactNode } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

/**
 * StatusDot / StatusPill — the colored status indicator, alone or with a
 * label. Tones map to theme tokens only (no raw palette colors); sizes are
 * `sm` (6px) for inline/tab contexts and `default` (8px) beside text.
 *
 * Replaces the hand-rolled dots that ranged over three sizes and mixed
 * tokens with `bg-green-500` / `bg-amber-500`.
 */
const statusDotVariants = cva("inline-block shrink-0 rounded-full", {
  variants: {
    tone: {
      success: "bg-success",
      warning: "bg-warning",
      info: "bg-info",
      destructive: "bg-destructive",
      muted: "bg-muted-foreground/40",
    },
    size: {
      default: "size-2",
      sm: "size-1.5",
    },
    pulse: {
      true: "animate-pulse",
      false: "",
    },
  },
  defaultVariants: { tone: "muted", size: "default", pulse: false },
})

export type StatusTone = NonNullable<
  VariantProps<typeof statusDotVariants>["tone"]
>

export interface StatusDotProps
  extends ComponentProps<"span">,
    VariantProps<typeof statusDotVariants> {}

export function StatusDot({
  tone,
  size,
  pulse,
  className,
  ...props
}: StatusDotProps) {
  return (
    <span
      data-slot="status-dot"
      aria-hidden
      className={cn(statusDotVariants({ tone, size, pulse }), className)}
      {...props}
    />
  )
}

export interface StatusPillProps
  extends ComponentProps<"span">,
    VariantProps<typeof statusDotVariants> {
  children: ReactNode
}

/** Dot + 12px label, the "Deployed / Building / Conflict" readout. */
export function StatusPill({
  tone,
  size,
  pulse,
  className,
  children,
  ...props
}: StatusPillProps) {
  return (
    <span
      data-slot="status-pill"
      className={cn(
        "inline-flex items-center gap-1.5 text-sm font-normal",
        className,
      )}
      {...props}
    >
      <StatusDot tone={tone} size={size} pulse={pulse} />
      {children}
    </span>
  )
}

export { statusDotVariants }
