"use client"

import { createContext, useContext, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ListFrameContext } from "./list-frame"

/**
 * OptionCard — a selectable card with a real radio or checkbox control.
 *
 * **Not the same thing as `ChoiceTile`, and the difference is the interaction:**
 *
 * | | `ChoiceTile` | `OptionCard` |
 * |---|---|---|
 * | Click does | commits immediately | selects; a footer button commits |
 * | Reads as | a big button | one of a set you choose between |
 * | Use for | "Local folder" vs "Clone a repo" | "This row" vs "All rows" |
 *
 * A decision dialog — where the whole point is that the options are mutually
 * exclusive and consequential — uses `OptionCard`. The control is the affordance
 * that says "pick one of these": a card that commits on click looks identical to
 * one that merely selects, so the user cannot tell how much a click costs until
 * they have already paid.
 *
 * Both variants wrap the real primitives (Radix `RadioGroup` / `Checkbox`), so
 * keyboard behaviour, roving focus and `aria-checked` come from the primitive
 * rather than being re-implemented on a `<button>`.
 */

/*
 * One container, not a stack of cards (Mo, 2026-08-18).
 *
 * The fused look: a stacked run of options reads as a single bordered block
 * with hairline dividers, not as N floating cards. Since 2026-08-31 the FRAME
 * draws all of that — border, rounding, `divide-y`, `overflow-hidden` — and
 * the cards draw none of it. The first cut put the frame on the cards
 * themselves (`border-t-0 first:rounded-t-lg last:rounded-b-lg`), which
 * encoded "the previous sibling is above me": laid out side by side (the New
 * Project source step), the last card lost its top border and the run had no
 * gaps, because first/last say nothing about direction. Position-dependent
 * chrome belongs to the thing that owns the positions.
 *
 * **Selection is a fill, not an edge.** On a fused run an edge highlight has
 * nowhere to go: it either doubles up against the shared divider or repaints
 * a line the neighbour also owns. A background says the same thing over the
 * whole row and cannot collide with anything.
 *
 * Focus keeps a ring, but `ring-inset` — an outset ring on a fused row paints
 * over the neighbour above and below it, and the frame's `overflow-hidden`
 * would clip it anyway.
 */
const cardBase = cn(
  // Tightened 2026-08-18 (Mo: "reduce the font size in the radio cards and
  // also the padding, make it all a bit more compact"). Was `gap-3 p-3` with
  // a `text-base` title. A stack of three or four of these is the whole
  // content of a decision dialog, and at the old geometry the options took
  // more vertical space than the question that framed them.
  "flex w-full items-start gap-2.5 px-3 py-2 text-left",
  // Hover is a fill only, for the same reason selection is: a border change
  // would move the shared divider.
  "hover:bg-muted/50",
  "has-focus-visible:ring-2 has-focus-visible:ring-inset has-focus-visible:ring-ring/40",
  // `/10`, up from `/5`. The tint used to share the work with a teal border;
  // now it does the whole job, so it has to be visible on its own.
  "has-data-checked:bg-primary/10",
  "has-disabled:cursor-not-allowed has-disabled:opacity-50",
  "has-disabled:hover:bg-transparent",
)

/** The chrome a `separate` card adds back: its own frame, since no container
 * draws one for it. */
const separateCardChrome = "rounded-lg border"

/**
 * How the surrounding group renders its cards. Provided by `OptionCardGroup`;
 * the default covers `CheckOptionCard` call sites, which have no group and
 * fuse inside a `ListFrame` (or an equivalent container) instead.
 */
const OptionCardChromeContext = createContext<"fused" | "separate">("fused")

function CardBody({ title, hint }: { title: ReactNode; hint?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="text-sm">{title}</span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </span>
  )
}

export interface OptionCardProps {
  /** Value submitted for this option. Must be unique within its group. */
  value: string
  title: ReactNode
  /** Secondary line — also where a disabled option explains itself. */
  hint?: ReactNode
  disabled?: boolean
  id?: string
  className?: string
  "data-testid"?: string
}

/**
 * One radio option. Must be inside an {@link OptionCardGroup}.
 *
 * Rendered as a `<label>` so the whole card is the hit target — clicking the
 * hint text selects, which is what a card-shaped control implies.
 */
export function OptionCard({
  value,
  title,
  hint,
  disabled,
  id,
  className,
  ...props
}: OptionCardProps) {
  const chrome = useContext(OptionCardChromeContext)
  const inputId = id ?? `option-card-${value}`
  return (
    <label
      htmlFor={inputId}
      className={cn(cardBase, chrome === "separate" && separateCardChrome, className)}
      data-slot="option-card"
      {...props}
    >
      <RadioGroupItem id={inputId} value={value} disabled={disabled} className="mt-0.5" />
      <CardBody title={title} hint={hint} />
    </label>
  )
}

export interface OptionCardGroupProps {
  value: string | undefined
  onValueChange: (value: string) => void
  children: ReactNode
  className?: string
  /**
   * Detached bordered cards with a gap, instead of the fused block. The ONE
   * layout that needs this is a side-by-side row (the New Project source
   * step): fused chrome cannot survive there, because dividers and shared
   * borders assume a stack. The row's grid classes still come through
   * `className` — this prop is chrome, not layout, which is why it is not
   * the `orientation` prop that was removed in 2026-08 (that one changed
   * layout the call site could already express; this changes card borders
   * the call site must not reach into the cards to redraw).
   */
  separate?: boolean
  /** Accessible name for the set of options. */
  "aria-label"?: string
}

/**
 * Single-select container. Renders the Radix `RadioGroup` role, and draws
 * the fused frame around its cards — unless it sits inside a `ListFrame`,
 * which it detects via context: there the frame already draws the border and
 * the dividers, and the group joins that list (this is how a filter field
 * becomes the list's first row) instead of nesting a second border.
 *
 * **Cards stack by default.** Stacking is the better default on its own
 * terms: side by side, each hint gets half the width, so a two-line hint
 * becomes four lines and the cards grow to match the longest. Scanning two
 * titles vertically is one eye movement; horizontally it is two. The one
 * sanctioned exception passes `separate` plus grid classes — see that prop.
 */
export function OptionCardGroup({
  value,
  onValueChange,
  children,
  className,
  separate = false,
  ...props
}: OptionCardGroupProps) {
  const framed = useContext(ListFrameContext)
  return (
    <RadioGroup
      // "" not undefined: Radix reads undefined as "uncontrolled", so a group
      // that legitimately starts with nothing selected would flip from
      // uncontrolled to controlled on the first pick and warn.
      value={value ?? ""}
      onValueChange={onValueChange}
      className={cn(
        separate
          ? "gap-3"
          : cn(
              // `gap-0` — any gap reopens the seam the divider closes.
              "gap-0 divide-y divide-border",
              !framed && "overflow-hidden rounded-lg border",
            ),
        className,
      )}
      {...props}
    >
      <OptionCardChromeContext.Provider value={separate ? "separate" : "fused"}>
        {children}
      </OptionCardChromeContext.Provider>
    </RadioGroup>
  )
}

export interface CheckOptionCardProps extends Omit<OptionCardProps, "value"> {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

/**
 * The multi-select sibling. Same card, checkbox semantics — use it wherever
 * more than one option can be chosen, so the control itself tells the user
 * that before they start clicking.
 *
 * No group component exists for these, so the container is the call site's:
 * wrap a run of them in a `ListFrame` to get the fused block the radio
 * version draws for itself.
 */
export function CheckOptionCard({
  checked,
  onCheckedChange,
  title,
  hint,
  disabled,
  id,
  className,
  ...props
}: CheckOptionCardProps) {
  const chrome = useContext(OptionCardChromeContext)
  const inputId = id ?? `check-option-card-${String(title)}`
  return (
    <label
      htmlFor={inputId}
      className={cn(cardBase, chrome === "separate" && separateCardChrome, className)}
      data-slot="check-option-card"
      {...props}
    >
      <Checkbox
        id={inputId}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        disabled={disabled}
        className="mt-0.5"
      />
      <CardBody title={title} hint={hint} />
    </label>
  )
}
