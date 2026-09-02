"use client"

/**
 * Shared compact disclosure for the chat transcript's collapsible rows
 * (reasoning, tool calls, edit/write diffs).
 *
 * ## The header is INSIDE the card (Mo, 2026-08-18)
 *
 * The border wraps the header AND the body, with a hairline under the header
 * when it is open. It used to be the other way round: a bare row floating on
 * the chat ground, with a separately bordered `bg-muted/30` panel appearing
 * beneath it. That read as two objects — a label, and a box that showed up
 * near it — and on a run of tool calls the boxes lined up under labels they
 * were not obviously attached to.
 *
 * Nothing is filled. The chat's own ground shows through both halves, so the
 * card is defined by its border and the rule, not by a tint. A tinted body
 * under an untinted header would put the seam back.
 *
 * ## Consecutive disclosures fuse into an accordion
 *
 * Two adjacent cards would otherwise show a doubled 1px rule and a gap. A run
 * of them now shares one border: each drops its top border and top rounding
 * when it directly follows another, and drops its bottom rounding when
 * another directly follows it.
 *
 * This is DOM-sibling based (`[data-chat-disclosure]+&`), so it only fuses
 * rows that really are siblings. A call site that wraps each disclosure in its
 * own div gets separate cards — correct rather than broken, but worth knowing
 * if a run looks unfused.
 *
 * Built on the shadcn `Collapsible` (Radix) primitive, so it supports both
 * controlled (`open` + `onOpenChange`) and uncontrolled (`defaultOpen`)
 * use — reasoning needs the controlled form to follow the model's
 * running state.
 */

import type { ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { AnimatedEllipsis } from "@/components/blocks"
import { cn } from "@/lib/utils"

interface ChatDisclosureProps {
  /** Left-aligned label — tool name, file path, or "Reasoning". */
  label: ReactNode
  /** Right-aligned status node (e.g. <ChatToolStatus />). Optional. */
  status?: ReactNode
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** Body, revealed under a hairline divider when open. */
  children: ReactNode
  className?: string
  /** Extra classes on the revealed body wrapper. */
  bodyClassName?: string
  "data-testid"?: string
}

export function ChatDisclosure({
  label,
  status,
  open,
  defaultOpen,
  onOpenChange,
  children,
  className,
  bodyClassName,
  "data-testid": dataTestId,
}: ChatDisclosureProps) {
  return (
    <Collapsible
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      data-chat-disclosure=""
      className={cn(
        "overflow-hidden rounded-md border text-xs",
        // `overflow-hidden` so a diff's tinted rows clip to the rounding
        // rather than squaring off the bottom corners.
        //
        // Spacing lives here, not on the call site, because fusing a run
        // means being able to take it away again — `my-1` passed in as a
        // className would win the merge and reopen the gap.
        "mt-1",
        "[[data-chat-disclosure]+&]:mt-0 [[data-chat-disclosure]+&]:rounded-t-none [[data-chat-disclosure]+&]:border-t-0",
        "[&:has(+[data-chat-disclosure])]:rounded-b-none",
        className,
      )}
      data-testid={dataTestId}
    >
      {/*
        Chevron AFTER the label, matching the save dialog's disclosures. It used
        to lead, which indented every label in the chat and made the glyph
        rather than the text the first thing scanned down a column of tool
        calls.
      */}
      {/*
        `data-[state=open]:border-b` — the rule exists only when there is a
        body under it. Closed, the card is a single bordered row and a rule
        along its bottom edge would read as an empty section.
      */}
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-muted-foreground hover:text-foreground data-[state=open]:border-b">
        <span className="min-w-0 truncate">{label}</span>
        {status != null ? (
          <span className="flex shrink-0 items-center">{status}</span>
        ) : null}
        <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className={cn("overflow-hidden", bodyClassName)}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Status for a tool-call / diff header.
 *
 * **Only failure is indicated, and only by colour** (Mo, 2026-08-18: "no need
 * for the check or any icon when it is successful or failed. Only indicate if
 * failed and do that by making the header text red").
 *
 * The tick is gone. It marked the case that needs no marking — a tool call in
 * the transcript ran, that is why it is there, and a column of green ticks
 * down a long turn is decoration that scrolls. What has to stand out is the
 * one row that did NOT work, and it stands out better with the ticks gone.
 *
 * Failure returns `null` too, so the header renders nothing extra; the ROW
 * turns red instead, via `chatDisclosureStatusClass` on the label. Colour on
 * the text the reader is already looking at beats a glyph beside it.
 *
 * `running` keeps its word, because it says something the row does not: this
 * one has not finished.
 */
export function ChatToolStatus({
  statusType,
}: {
  statusType: string
  /** Kept for call-site symmetry with `chatDisclosureStatusClass`. */
  isError?: boolean
}) {
  if (statusType === "running") {
    return (
      <span className="animate-pulse text-2xs text-muted-foreground">
        running
        <AnimatedEllipsis />
      </span>
    )
  }
  return null
}

/**
 * The header's own colour, given a status.
 *
 * Pairs with `ChatToolStatus`: that says what is still happening, this says
 * what went wrong. An error paints the whole label `text-destructive`, which
 * is the only failure signal on the row.
 *
 * `incomplete` without an explicit error stays neutral, matching the rule the
 * removed glyph followed — a cancelled or unfinished part is not a failure,
 * and colouring it red would report one on every stopped turn.
 */
export function chatDisclosureStatusClass(isError?: boolean): string | undefined {
  return isError ? "text-destructive" : undefined
}
