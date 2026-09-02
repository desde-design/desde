import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * ValueReadout — the boxed "here is what this dialog is about" panel.
 *
 * A decision dialog usually has to show the thing being decided on before it
 * shows the choices: the text about to change, the cascade a value came from.
 * Two dialogs grew their own version of that box and they disagreed on
 * everything, including whether the box said what it was showing. One opened
 * with a bare "From:" prefix inside the value; the other had no label at all,
 * so a struck-through line followed by a plain one had to be decoded.
 *
 * The shape is fixed here: a sans label on top, the value underneath in mono at
 * a single size. Mono because these are values and identifiers, selectors,
 * token names, package names, and the exact string a user typed. At `text-sm`,
 * matching the save trace, and not the `text-xs` one of them used, which is
 * where mono stopped being readable and started being decorative.
 */
export interface ValueReadoutProps {
  /** What the value IS: "From", "Change", … Sentence case, no colon. */
  label: string
  children: ReactNode
  className?: string
  "data-testid"?: string
}

export function ValueReadout({
  label,
  children,
  className,
  ...props
}: ValueReadoutProps) {
  return (
    <div
      data-slot="value-readout"
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-md border bg-muted/30 px-3 py-2",
        className,
      )}
      {...props}
    >
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="flex min-w-0 flex-col gap-0.5 font-mono text-code-lg text-foreground">
        {children}
      </span>
    </div>
  )
}
