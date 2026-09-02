"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Tabs as TabsPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center text-muted-foreground group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
      /**
       * `sm` is for rails and panels where the 32px `default` is a step
       * taller than everything around it.
       *
       * The ACTIVE PILL is 19px here, exactly what it was when this variant
       * was a 24px strip with `p-[2px]`. What changed on 2026-08-28 is the
       * gap between that pill and the track around it: 2.5px, which read as
       * the pill touching the container top and bottom, now 3.5px (Mo: "add
       * 1 px or more vertical spacing between the tab button and the tab
       * container top and bottom", then "make it 3.5px").
       *
       * The three numbers are locked together, so read them as one sum
       * rather than as three choices. The trigger is `h-[calc(100%-1px)]` of
       * this height, so the pill is `height - 2 × padding - 1`. Holding the
       * pill at 19 while the gap goes to `padding + 0.5` means:
       *
       *     padding 3px  ->  gap 3.5px  ->  height 19 + 6 + 1 = 26px
       *
       * `h-6.5` IS 26px (the v4 spacing unit is 4px). The height moves only
       * to keep the pill still; on a FIXED track every pixel of new padding
       * would come straight out of the pill, which is the one thing that had
       * to stay the same size. A `py-*` on the TRIGGER does nothing either
       * way.
       *
       * The height MUST live here and not in the base, and a caller MUST
       * NOT try to override it with an `h-*` class. `group-data-horizontal`
       * wraps both its guards in `:where()`, so the emitted rule has the
       * same 0,1,0 specificity as a plain `.h-6` and simply wins on source
       * order; `tailwind-merge` does not treat the two as conflicting
       * either, because their modifiers differ, so it keeps both. Making
       * the two heights mutually exclusive variants is what stops that.
       */
      size: {
        default: "rounded-lg p-[3px] group-data-horizontal/tabs:h-8",
        sm: "rounded-md p-[3px] group-data-horizontal/tabs:h-6.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      data-size={size}
      className={cn(tabsListVariants({ variant, size }), className)}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center border border-transparent font-normal whitespace-nowrap text-foreground/60 transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start group-data-vertical/tabs:py-[calc(--spacing(1.25))] hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
        // Everything the strip's size decides. These read off the list's
        // `data-size`, so exactly one set ever applies and the two never
        // compete on specificity or on source order.
        "group-data-[size=default]/tabs-list:gap-1.5 group-data-[size=default]/tabs-list:rounded-md group-data-[size=default]/tabs-list:px-1.5 group-data-[size=default]/tabs-list:py-0.5 group-data-[size=default]/tabs-list:text-sm group-data-[size=default]/tabs-list:[&_svg:not([class*='size-'])]:size-3.5",
        // `sm` is text-sm with size-3 icons. The pill's own height comes
        // from the list; see that size variant's doc comment.
        "group-data-[size=sm]/tabs-list:gap-1 group-data-[size=sm]/tabs-list:rounded-sm group-data-[size=sm]/tabs-list:px-2 group-data-[size=sm]/tabs-list:text-sm group-data-[size=sm]/tabs-list:[&_svg:not([class*='size-'])]:size-3",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
