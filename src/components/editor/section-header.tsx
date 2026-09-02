import type { ReactNode } from "react"
import { Info } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/**
 * Shared text style for right-rail section headers (Layers, Variants and
 * props, Attributes, Spacing, …). Deliberately quieter than body content:
 * UPPERCASE at 11px, normal weight, muted. Same size as the items below
 * them — case is what marks them as headings, because a 1px difference
 * never could. This is the `Eyebrow` recipe; they are the same thing.
 */
export const sectionHeaderTextClass =
  "text-2xs font-medium uppercase tracking-wide text-muted-foreground"

/**
 * The rule between two sections of one panel.
 *
 * Lighter than a plain `<Separator />`: a boundary inside a panel should not
 * carry the same weight as the boundary between panels. The Structure/component
 * split keeps full-strength `bg-border` for exactly that reason, and the rail's
 * own `border-l` sits between the two at /60.
 */
export const sectionDividerClass = "bg-border/50"

/**
 * A PANEL's title — "Structure", and the selected component's name — as
 * opposed to a section header inside one. 13px at 500, sitting two steps above
 * the 11px rail so the panel it names is obvious without shouting.
 *
 * Separate from {@link sectionHeaderTextClass} because the two roles moved in
 * opposite directions: panel titles got bigger and section headers smaller, on
 * the same day. A single "header" class would have had to pick one.
 */
export const panelTitleClass = "text-base font-medium"

/**
 * Shared text style for inspector field labels (Padding, Width, Box shadow,
 * Alignment, …). Same 12px size as the field values (fieldValueClass) but
 * muted and normal weight, sentence case — distinguished from values by tone,
 * not size. `break-words` lets a long label wrap within its column instead of
 * overflowing into the control beside it.
 */
export const fieldLabelClass = "text-2xs text-muted-foreground break-words"

/**
 * Shared layout for an inspector field row: label above, control full width.
 *
 * It used to be a two-column grid, with the label taking up to 40% of the row.
 * In a rail that narrow the control got the remainder, which was not enough to
 * read a file path or a sentence in — the Description field truncated
 * mid-word. Stacking gives the control the full width and costs one line,
 * and it matches Spacing / Border / Typography, which already put their
 * labels above.
 *
 * Callers that used to add `items-center` for a vertically-centred row no
 * longer need it; there is no second column to centre against.
 */
// 4px — the scale step nearest the 3px this wants. Exact 3px is unreachable
// (Tailwind's steps are .5 multiples of 0.25rem; `gap-0.75` generates
// nothing), and it is not worth the rail's only arbitrary length.
export const fieldRowClass = "flex flex-col gap-1"

/**
 * Shared text style for labels stacked ABOVE an input/select (rather than
 * sitting beside it in a row). Slightly smaller than the side-by-side
 * {@link fieldLabelClass} so a stacked label reads as a caption for the
 * control beneath it instead of competing with it.
 */
export const stackedLabelClass = "text-2xs text-muted-foreground"

/**
 * Shared text style for inspector field VALUES — dropdown text, input text,
 * numeric values, the true/false beside a switch. Matches the shadcn Select
 * value and the small Input (12px, relaxed leading, foreground). No mono:
 * numbers read in the same sans face as every other value so the rail stays
 * visually uniform.
 */
export const fieldValueClass = "text-xs"

export function SectionHeader({
  title,
  description,
  action,
  className,
  variant = "section",
}: {
  title: string
  /**
   * Optional one-line explanation of the section. Rendered as an info icon
   * beside the title that reveals the text on hover/focus — keeps the rail
   * dense by moving the caption off the always-visible surface.
   */
  description?: string
  /**
   * Optional trailing control (e.g. a refresh button) pinned to the end of
   * the header row. When present the row spreads title and action apart.
   */
  action?: ReactNode
  className?: string
  /**
   * `section` (default) is a header inside a panel; `panel` is the panel's
   * own title, which is bigger and not uppercase.
   */
  variant?: "section" | "panel"
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1",
        action && "justify-between",
        className,
      )}
    >
      <div className="flex items-center gap-1">
        <h3 className={variant === "panel" ? panelTitleClass : sectionHeaderTextClass}>
          {title}
        </h3>
        {description ? (
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger
                className="text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:text-foreground"
                aria-label={`About ${title}`}
              >
                <Info className="size-3" />
              </TooltipTrigger>
              <TooltipContent>{description}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>
      {action}
    </div>
  )
}
