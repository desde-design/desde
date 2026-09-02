import type { ComponentProps, ReactNode } from "react"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

/**
 * Field — a form control group: Label above the control, optional hint or
 * error line beneath. The canonical recipe (`flex flex-col gap-1.5`, shadcn
 * `Label` at `text-sm`, hint at `text-xs text-muted-foreground`) — replaces
 * the four divergent gap systems and the raw-`<label>` variants across the
 * editor dialogs.
 */
export interface FieldProps extends ComponentProps<"div"> {
  label: ReactNode
  /** id of the control inside — wires the Label's htmlFor. */
  htmlFor?: string
  /** Muted helper line under the control. */
  hint?: ReactNode
  /** Error line (replaces the hint when present). */
  error?: ReactNode
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  className,
  children,
  ...props
}: FieldProps) {
  return (
    <div
      data-slot="field"
      className={cn("flex flex-col gap-1.5", className)}
      {...props}
    >
      <Label htmlFor={htmlFor} className="text-sm">
        {label}
      </Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}
