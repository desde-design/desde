import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { TONE_SURFACE, type ToneName } from "@/lib/tone-surface"

/**
 * Build a tinted variant: the shared tone triple from `TONE_SURFACE`, plus the
 * two things that belong to Alert rather than to the tone. The description
 * slot drops to /90 of the tone so it still reads as secondary inside an
 * already-coloured box, and svg children take the tone instead of the
 * primitive's default colour.
 *
 * `descriptionTint` is handed in as a literal instead of being built from
 * `tone`, because Tailwind generates classes by scanning source text. A
 * template string like `text-${tone}/90` produces no CSS at all.
 */
const tinted = (tone: ToneName, descriptionTint: string) =>
  `${TONE_SURFACE[tone]} ${descriptionTint} *:[svg]:text-current`

const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-lg border px-2 py-1.5 text-left text-sm has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-1.5 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      // Every tone is a named variant. There is no supported way to tint an
      // Alert by hand: a `border-x/40 bg-x/10 text-x` triple in a className is
      // a second copy of `TONE_SURFACE` that will drift from it.
      //
      // The tones are filled, not just coloured text on the card ground. A
      // failure should be findable without reading it, and while `destructive`
      // was the only tinted variant the other four sat at the same weight as
      // every neutral Alert around them.
      variant: {
        // Neutral, and the only variant that is NOT a tone. Reach for it when
        // the banner reports plain status the user does not have to judge.
        default: "bg-card text-card-foreground",
        destructive: tinted(
          "destructive",
          "*:data-[slot=alert-description]:text-destructive/90",
        ),
        warning: tinted(
          "warning",
          "*:data-[slot=alert-description]:text-warning/90",
        ),
        success: tinted(
          "success",
          "*:data-[slot=alert-description]:text-success/90",
        ),
        info: tinted("info", "*:data-[slot=alert-description]:text-info/90"),
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "font-normal group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-sm text-balance text-muted-foreground md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className
      )}
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("absolute top-1.5 right-2", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }
