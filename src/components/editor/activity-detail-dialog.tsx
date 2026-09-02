"use client"

/**
 * Activity detail dialog (Plan B, Task 5). Opened by clicking a row in the
 * Activity panel (`activity-row.tsx`) — the row's two lines are a summary;
 * this is where the rest of what a row knows lives.
 *
 * Mo, specifying the panel: "I am realizing that each item could have a lot
 * of info. We can also add click on item to see full details in a modal.
 * The modal would also have the undo option."
 *
 * Three sections, the house maximum (`docs/design.md` § "2 good, 3 max"):
 *
 * 1. **What changed** — the header. The title is the row's own description
 *    (mono when it's a literal value, prose otherwise — `descriptionForRow`,
 *    shared with the row); the description line under it says the kind of
 *    change and, for a ledger row, when it happened.
 * 2. **Where it landed** — a `ValueReadout` for the path(s), plus a plain
 *    sentence for the commit state and sha.
 * 3. **Verification** — a single bordered block: status pill, expected vs.
 *    observed, the failure cause in plain words, and the detail sentence.
 *    Omitted ENTIRELY (not rendered empty) when the row has no verification
 *    record, which keeps the common case at 2 sections, not 3.
 *
 * Worst reachable state is exactly 3 (header + location + verification) —
 * at the house maximum, not over it.
 *
 * ## Reuse, not a second copy
 *
 * `undoAvailability`, `descriptionForRow`, `commitStateLabel`,
 * `changeTypeForRow` and `pathsForRow` are all imported from `activity-row.tsx`
 * — the same functions the row's own `⋮` menu uses. The Undo button in the
 * footer below is disabled by the exact same call, with the exact same
 * reason text, as the menu item. Clicking it fires the same
 * `onUndoRequested` callback the menu item fires, which the panel already
 * wires to its one shared confirm dialog — so "the same confirm" is not a
 * second dialog, it is the same callback reaching the same place.
 *
 * `describeState` (verification pill tone/label) is imported from
 * `verification-checks-list.tsx` for the same reason Task 4 reused it on
 * the row: one vocabulary for a verification state, not two.
 */

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { StatusPill, ValueReadout } from "@/components/blocks"
import { describeState } from "@/components/editor/verification-checks-list"
import {
  changeTypeForRow,
  commitStateLabel,
  descriptionForRow,
  pathsForRow,
  undoAvailability,
} from "@/components/editor/activity-row"
import type { ActivityRow as ActivityRowModel } from "@/components/editor/activity-rows"
import type { VerificationRecord } from "@/stores/editor-slice"
import type { FailureCause, VerificationResult } from "@/editor/verification"
import { formatRelativeTimeShort } from "@/lib/relative-time"

/**
 * Plain-word explanation for each `FailureCause`. The enum values
 * themselves (`bound-binding`, `hmr-stale`, …) are internal classification
 * names the reader never typed, so they never render directly — see the
 * copy rule against printing an identifier the reader didn't type.
 * `Record<FailureCause, string>` keeps this exhaustive: a new cause added
 * to the type is a compile error here until it has words.
 */
const FAILURE_CAUSE_LABEL: Record<FailureCause, string> = {
  "bound-binding": "The value comes from a dynamic binding, not a fixed one.",
  "v-model": "The field is bound both ways, so a fixed value doesn't stick.",
  "dynamic-vbind": "The attribute is set dynamically, not with a fixed value.",
  conditional: "The element isn't in the page right now.",
  "css-hidden": "The element is in the page but not visible.",
  "css-overridden": "Another style rule is winning over this one.",
  "hmr-stale": "The change hasn't shown up in the running page yet.",
  "selector-missing": "The element couldn't be found on the page.",
  unknown: "The cause couldn't be determined.",
}

/** "Changed, 2h ago." / "Deleted." (git-only rows carry no timestamp). */
function whenAndKindText(row: ActivityRowModel): string {
  const changeType = changeTypeForRow(row)
  if (row.source === "git") return `${changeType}.`
  return `${changeType}, ${formatRelativeTimeShort(row.row.at)}.`
}

function CommitState({ row }: { row: ActivityRowModel }) {
  const label = commitStateLabel(row)
  if (label !== "Committed") return <>Not committed.</>
  const sha = row.source === "ledger" ? row.row.sha : undefined
  if (!sha) return <>Committed.</>
  return (
    <>
      Committed as{" "}
      <span className="font-mono text-code text-foreground">{sha}</span>.
    </>
  )
}

function VerificationSection({ verification }: { verification: VerificationRecord }) {
  const { tone, label, pulse } = describeState(verification)
  const result: VerificationResult | undefined = verification.result
  return (
    <div
      className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3"
      data-testid="activity-detail-verification"
    >
      <StatusPill tone={tone} pulse={pulse} className="w-fit text-xs">
        {label}
      </StatusPill>
      {result ? (
        <>
          <p className="text-sm text-foreground">
            Expected{" "}
            <span className="font-mono text-code text-foreground">
              {result.expectedValue}
            </span>
            {result.observedValue !== undefined ? (
              <>
                , observed{" "}
                {result.observedValue === null ? (
                  "nothing"
                ) : (
                  <span className="font-mono text-code text-foreground">
                    {result.observedValue}
                  </span>
                )}
              </>
            ) : null}
            .
          </p>
          {result.cause ? (
            <p className="text-sm text-muted-foreground">
              {FAILURE_CAUSE_LABEL[result.cause]}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">{result.detail}</p>
        </>
      ) : null}
    </div>
  )
}

export interface ActivityDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  row: ActivityRowModel
  /** The verification record for this row's edit, if one exists. Absent is
   *  the common case — see the module doc comment: no record, no section. */
  verification?: VerificationRecord
  /** A prior failed-undo reason for this exact row, remembered by the
   *  panel. Same contract as `ActivityRow`'s own prop of the same name. */
  cachedUndoRefusalReason?: string
  /** Fires when the user picks Undo on an ENABLED row. Same callback the
   *  row's `⋮` menu item fires — see the module doc comment. */
  onUndoRequested: (row: ActivityRowModel) => void
}

export function ActivityDetailDialog({
  open,
  onOpenChange,
  row,
  verification,
  cachedUndoRefusalReason,
  onUndoRequested,
}: ActivityDetailDialogProps) {
  const { text: description, mono } = descriptionForRow(row)
  const undo = undoAvailability(row, cachedUndoRefusalReason)
  // P2-2 (codex review finding, 2026-08-20): read the source arrays
  // directly via `pathsForRow` — NOT `pathForRow(row).split(", ")`. A
  // repo-relative path may legally contain `", "`, so splitting the
  // joined display string back apart could turn one path into two.
  const paths = pathsForRow(row)

  function handleClose() {
    onOpenChange(false)
  }

  function handleUndoClick() {
    if (undo.disabled) return
    // Close this dialog first: Undo reaches the SAME shared confirm dialog
    // the row's `⋮` menu opens, and closing here keeps only one dialog on
    // screen at a time rather than stacking this one behind the confirm.
    onOpenChange(false)
    onUndoRequested(row)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" data-testid="activity-detail-dialog">
        <DialogHeader>
          <DialogTitle className={mono ? "font-mono text-code-lg" : undefined}>
            {description}
          </DialogTitle>
          <DialogDescription>{whenAndKindText(row)}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <ValueReadout
            label={paths.length > 1 ? "Paths" : "Path"}
            data-testid="activity-detail-path"
          >
            {paths.map((path) => (
              <span key={path}>{path}</span>
            ))}
          </ValueReadout>
          <p
            className="text-sm text-muted-foreground"
            data-testid="activity-detail-commit-state"
          >
            <CommitState row={row} />
          </p>
        </div>

        {verification ? (
          <VerificationSection verification={verification} />
        ) : null}

        {/* One row: the undo-disabled reason sits to the LEFT of the buttons,
            left-aligned, instead of stacked above them (Mo, 2026-08-29:
            buttons right, description left of the button). */}
        <DialogFooter className="sm:items-center">
          {undo.disabled && undo.reason ? (
            <p
              className="mr-auto min-w-0 text-2xs text-muted-foreground"
              data-testid="activity-detail-undo-reason"
            >
              {undo.reason}
            </p>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClose}
            data-testid="activity-detail-close"
          >
            Close
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={undo.disabled}
            onClick={handleUndoClick}
            data-testid="activity-detail-undo"
          >
            Undo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
