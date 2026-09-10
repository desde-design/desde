"use client"

/**
 * Inline UI for the `ask_user_question` SDK tool. Slotted into the chat
 * panel's footer, directly above the composer, when the agent is waiting
 * for the user to pick among a set of options.
 *
 * It sat BELOW the input until 2026-09-10, as a sibling after the whole
 * right rail. A form the agent is blocked on has to come before the box
 * you could answer it in instead; underneath it, it read as leftover
 * output from a turn that had moved on. The container styling changed
 * with the position: it was a full-bleed strip with a top rule, which is
 * what a pinned bottom bar looks like, and is now a card matching the
 * composer it stands on, so the two read as one block.
 *
 * Single-select: clicking an option immediately calls `onAnswer`.
 * Multi-select: toggle buttons + a "Submit" button (disabled until
 * at least one option is checked). A small "Dismiss" affordance calls
 * `onDismiss` (resolves the pending promise with `ok: false`).
 *
 * Renders nothing when `pending` is null.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { CheckOptionCard, ListFrame, OptionCard, OptionCardGroup } from "@/components/blocks"

export interface PendingQuestion {
  question: string
  options: string[]
  multiSelect: boolean
  resolve: (
    r:
      | { ok: true; output: { selected: string[] } }
      | { ok: false; error: string },
  ) => void
}

interface ChatPendingQuestionProps {
  pending: PendingQuestion | null
  onAnswer: (selected: string[]) => void
  onDismiss: () => void
}

export function ChatPendingQuestion({
  pending,
  onAnswer,
  onDismiss,
}: ChatPendingQuestionProps) {
  const [checked, setChecked] = useState<Set<string>>(new Set())
  // Reset multi-select state whenever a new question arrives (or the panel
  // clears). editor-surface mints a fresh PendingQuestion object per
  // ask_user_question call, so an identity change means a new question —
  // without this, checkboxes from a prior multi-select prompt carry over and
  // could submit stale selections against the new question (React's
  // "reset all state when a prop changes" in-render pattern).
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const [seenPending, setSeenPending] = useState(pending)
  if (pending !== seenPending) {
    setSeenPending(pending)
    setChecked(new Set())
    setPicked(undefined)
  }

  if (!pending) return null

  const { question, options, multiSelect } = pending

  if (!multiSelect) {
    // Single-select: radio cards, then Submit. The control is what tells the
    // user only one answer is possible — a row of buttons that each commit on
    // click reads as "several things you could do", and does not survive a
    // misclick.
    return (
      <div
        className="mb-1.5 rounded-lg border bg-card p-2"
        data-testid="chat-pending-question"
      >
        <p className="mb-2 text-sm font-normal leading-snug text-foreground">
          {question}
        </p>
        <OptionCardGroup
          value={picked}
          onValueChange={setPicked}
          aria-label={question}
        >
          {options.map((opt) => (
            <OptionCard key={opt} value={opt} title={opt} />
          ))}
        </OptionCardGroup>
        {/*
          Right-aligned, Dismiss then Submit (Mo, 2026-08-18) — the same order
          and edge every dialog footer in the product uses. Left-aligned with
          the commit action first, these two read as a toolbar under the
          options rather than as the end of a form.
        */}
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
          <Button size="sm" disabled={!picked} onClick={() => picked && onAnswer([picked])}>
            Submit
          </Button>
        </div>
      </div>
    )
  }

  // Multi-select: toggle buttons + Submit.
  const toggle = (opt: string): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(opt)) {
        next.delete(opt)
      } else {
        next.add(opt)
      }
      return next
    })
  }

  return (
    <div
      className="mb-1.5 rounded-lg border bg-card p-2"
      data-testid="chat-pending-question"
    >
      <p className="mb-2 text-sm font-normal leading-snug text-foreground">
        {question}
      </p>
      {/* The frame, matching OptionCardGroup's fused block: checkbox cards
          have no group component, so the container is ours to draw. */}
      <ListFrame>
        {options.map((opt) => (
          <CheckOptionCard
            key={opt}
            id={`pending-opt-${opt}`}
            checked={checked.has(opt)}
            onCheckedChange={() => toggle(opt)}
            title={opt}
          />
        ))}
      </ListFrame>
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
        <Button
          size="sm"
          disabled={checked.size === 0}
          onClick={() => {
            onAnswer([...checked])
          }}
        >
          Submit
        </Button>
      </div>
    </div>
  )
}
