import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * BeforeAfter — the two-row "this becomes that" pair.
 *
 * Two surfaces showed the same thing and showed it differently: the save
 * trace listed lowercase `before` / `after` labels beside mono values, while
 * the disambiguation dialog struck the old value through and put the new one
 * bare underneath, with no labels at all. Same information, two vocabularies,
 * and the struck version needed decoding.
 *
 * One presentation now: "Before" and "After" in sentence case, sans, muted. No
 * colons, because the grid column already separates label from value and the
 * punctuation only adds a ragged edge between them. No strikethrough either,
 * because the label says which is which and a line through mono text at this
 * size is mostly noise.
 */
export interface BeforeAfterProps {
  before: ReactNode
  after: ReactNode
  className?: string
}

/** Rendered for an empty side, so a blank row can't read as a missing one. */
function orEmpty(value: ReactNode): ReactNode {
  if (value === "" || value === null || value === undefined) {
    return <em className="not-italic text-muted-foreground">(empty)</em>
  }
  return value
}

export function BeforeAfter({ before, after, className }: BeforeAfterProps) {
  return (
    <span
      data-slot="before-after"
      className={cn(
        "grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-0.5",
        className,
      )}
    >
      <span className="font-sans text-sm text-muted-foreground">Before</span>
      <span className="break-words whitespace-pre-wrap">{orEmpty(before)}</span>
      <span className="font-sans text-sm text-muted-foreground">After</span>
      <span className="break-words whitespace-pre-wrap">{orEmpty(after)}</span>
    </span>
  )
}
