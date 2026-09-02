"use client"

import type { ReactNode } from "react"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Stepper — a horizontal progress indicator for a multi-step page flow.
 *
 * Built for the New Project flow, which outgrew a dialog: five states and two
 * nested sub-flows inside a 36rem box meant the user could never see where
 * they were or how much was left. On a page there is room to say both.
 *
 * ## It reports, it does not navigate
 *
 * Steps are NOT buttons. A stepper that lets you jump to step 4 has to define
 * what happens to the unfilled steps 2 and 3, and this flow cannot answer that
 * (the name step needs a resolved path; the design-system step needs a name).
 * Back is the flow's own footer button, which already knows the legal
 * transitions. Making the labels clickable would put a second, dumber
 * navigation model beside the one that works.
 *
 * That is also why it renders as an ordered list with `aria-current="step"`
 * rather than a tablist: `role="tablist"` promises selectable tabs.
 *
 * ## Every step is a node, and every Next moves the bar
 *
 * Mo's rule, 2026-08-17: *"There shouldn't be a next in a stepper that doesn't
 * go to the next step."* A Next that advances the flow while the bar stays put
 * tells the user their progress did not count, and it makes the bar a
 * decoration rather than a report.
 *
 * This started as the opposite claim. The New Project source step had `local`
 * and `clone` as sub-steps hiding behind one `source` node, and this doc
 * argued that was fine because a sub-flow should not redraw the bar. That
 * confused two different things. The count staying fixed is right; a *step*
 * hiding inside a node is not, because the user still had to press Next to
 * reach it. The fix was to make it genuinely one step: the two cards side by
 * side, and the chosen one's form beneath them.
 *
 * The count still has to be knowable at the start, or it is not progress, it
 * is a changing story. A picker WITHIN a step is fine when nothing navigates:
 * the design-system step's installed/npm/git-repo choice swaps a form in place
 * without a Next, so it costs no node.
 */

export interface StepperStep {
  /** Stable key, and the value callers compare against `current`. */
  id: string
  /** Short label. Two or three words: this is a bar, not a description. */
  label: ReactNode
}

export interface StepperProps {
  steps: readonly StepperStep[]
  /** `id` of the step being shown. Anything before it renders as complete. */
  current: string
  className?: string
  /** Accessible name for the whole bar. */
  "aria-label"?: string
}

export function Stepper({
  steps,
  current,
  className,
  "aria-label": ariaLabel = "Progress",
}: StepperProps) {
  const currentIndex = steps.findIndex((s) => s.id === current)

  return (
    <ol
      aria-label={ariaLabel}
      data-slot="stepper"
      className={cn("flex w-full items-center gap-2", className)}
    >
      {steps.map((step, index) => {
        // An unknown `current` yields -1, which would mark every step complete.
        // Treat it as "nothing done yet" instead: a stepper that lies about
        // progress is worse than one that under-reports it.
        const done = currentIndex > -1 && index < currentIndex
        const active = index === currentIndex
        return (
          <li
            key={step.id}
            // Only the active step is `aria-current`. Marking the completed
            // ones too would give a screen reader several "current" steps.
            {...(active ? { "aria-current": "step" as const } : {})}
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <span
              aria-hidden
              className={cn(
                // `size-6` and `text-xs`: the markers grew with the labels, or
                // a 20px circle beside 13px text reads as a bullet rather than
                // a step number.
                "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs",
                // Teal for BOTH done and active. Only the fill differs, so the
                // bar reads as one continuous teal run up to where you are,
                // and grey only ahead of you.
                done && "border-primary bg-primary text-primary-foreground",
                active && "border-primary font-medium text-primary",
                !done && !active && "border-border text-muted-foreground",
              )}
            >
              {done ? <Check className="size-3" /> : index + 1}
            </span>
            <span
              className={cn(
                // `text-base`, the body size. It was `text-xs` — the rail
                // workhorse — which made the one element telling you where you
                // are in a four-step flow the smallest text on the page.
                "truncate text-base",
                active ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {step.label}
            </span>
            {/*
              The connector belongs to the step BEFORE the gap, and the last
              step has none. `flex-1` on it rather than a fixed width so the
              bar fills the page at any width without the labels reflowing.
            */}
            {index < steps.length - 1 ? (
              <span
                aria-hidden
                className={cn(
                  "h-px min-w-4 flex-1",
                  done ? "bg-primary" : "bg-border",
                )}
              />
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
