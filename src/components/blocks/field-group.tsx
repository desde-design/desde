import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

/**
 * A stack of `Field`s with the canonical gap between them.
 *
 * The gap is the whole point, and it is a ratio rather than a number. Inside a
 * `Field`, the label sits `gap-1.5` (6px) above its control. If the gap
 * BETWEEN fields is `gap-2` (8px), those two spacings are close enough to read
 * as the same, and a form stops looking like a list of questions and starts
 * looking like an undifferentiated column of controls and text. The reader has
 * to work out which label belongs to which input.
 *
 * `gap-4` (16px) is a little under three times the intra-field gap, which is
 * enough that the grouping is read rather than deduced.
 *
 * Asked for by Mo, 2026-08-21, looking at the Viewer's token form: "Form
 * elements should have more vertical spacing between them. This is across
 * forms." It is a component rather than a documented number because a number
 * has to be remembered at every new form, and the ones that forget it are
 * exactly the forms nobody looked at closely.
 *
 * Use it for the vertical stack of fields. It is NOT for the gap between a
 * form and what follows it, and not for laying two fields out side by side.
 */
export function FieldGroup({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="field-group" className={cn("flex flex-col gap-4", className)} {...props} />
}
