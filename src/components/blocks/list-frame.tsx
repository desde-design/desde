"use client"

import { createContext, useContext, type ReactNode } from "react"
import { Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"

/**
 * ListFrame — one bordered container whose children read as rows of a single
 * list. The frame draws the border, the rounding and the row dividers; the
 * rows draw none of that themselves. Extracted 2026-08-31 from the Comments
 * panel's search-in-list group (`review-shell.tsx`, Mo 2026-08-28: "merge
 * search into the comments, so that Search is like the first item") once the
 * same shape was needed by the repo and prototype pickers.
 *
 * Composition, not configuration: the frame takes arbitrary rows. The two
 * recurring rows have blocks of their own — `ListFrameSearch` below for the
 * filter-as-first-row, and `OptionCardGroup`, which detects the frame via
 * context and stops drawing its own border so the cards join this list
 * instead of nesting a box in a box.
 *
 * `overflow-hidden` is load-bearing twice: it clips row fills (hover,
 * selection) to the rounded corners, and it clips the search `Input`'s
 * outset focus ring, which is why `ListFrameSearch` replaces that ring with
 * a background tint.
 */

/**
 * True inside a `ListFrame`. Read by `OptionCardGroup` so a group dropped
 * into a frame sheds its own border instead of stacking two.
 */
export const ListFrameContext = createContext(false)

export interface ListFrameProps {
  children: ReactNode
  className?: string
  "data-testid"?: string
}

export function ListFrame({ children, className, ...props }: ListFrameProps) {
  return (
    <ListFrameContext.Provider value={true}>
      <div
        className={cn(
          "flex flex-col divide-y divide-border overflow-hidden rounded-lg border",
          className,
        )}
        data-slot="list-frame"
        {...props}
      >
        {children}
      </div>
    </ListFrameContext.Provider>
  )
}

export interface ListFrameSearchProps {
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  /**
   * Required, not optional-with-a-default: the field has no visible label and
   * no generic name would survive two frames on one screen.
   */
  "aria-label": string
  autoFocus?: boolean
  disabled?: boolean
  size?: "sm" | "default"
  className?: string
  "data-testid"?: string
}

/**
 * The filter field as the frame's FIRST ROW, not a control floating above the
 * list. It strips the `Input`'s own border, background and radius so it reads
 * as a row rather than a box inside a box.
 *
 * The focus RING is replaced, not deleted (Mo, 2026-08-28: "the highlight on
 * the search is a bit odd"): the ring is a box-shadow drawn OUTSIDE the
 * element, the frame clips it, and all that escaped was a stray teal line
 * along one edge. A background tint cannot be clipped and reads the way a
 * focused row should. A field with no focus indicator at all fails keyboard
 * users.
 *
 * Keep this row mounted across the list's states (loading, rows, no matches).
 * `autoFocus` only fires on mount, so remounting drops the caret, and an
 * unmounted field takes the only way to EDIT a too-narrow query off screen.
 */
export function ListFrameSearch({
  value,
  onValueChange,
  placeholder,
  autoFocus,
  disabled,
  size = "default",
  className,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: ListFrameSearchProps) {
  return (
    <div className={cn("relative", className)}>
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        size={size}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        disabled={disabled}
        className="rounded-none border-0 bg-transparent pl-8 focus-visible:bg-muted/50 focus-visible:ring-0"
        data-testid={testId}
      />
    </div>
  )
}

/** Hook form, for blocks (not call sites) that adapt to being framed. */
export function useInsideListFrame(): boolean {
  return useContext(ListFrameContext)
}
