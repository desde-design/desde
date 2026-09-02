"use client"

import * as React from "react"
import { Undo2, Redo2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { BranchesApi } from "@/hooks/useEditorBranches"

/**
 * Toolbar Undo/Redo buttons. Thin wrapper over `BranchesApi.history` +
 * `undoEdit`/`redoEdit` (Task 7) — no local history state, the server is
 * the source of truth. Both buttons disable while a request is in flight
 * so a second click can't race the first.
 */
export function UndoRedoControls({ branches }: { branches: BranchesApi }) {
  const [busy, setBusy] = React.useState(false)

  const run = React.useCallback(
    async (action: "undo" | "redo") => {
      setBusy(true)
      try {
        const fn = action === "undo" ? branches.undoEdit : branches.redoEdit
        const result = await fn()
        if (!result.ok) {
          const reason = result.reason ?? `Could not ${action === "undo" ? "undo" : "redo"}.`
          if (result.stranded) {
            // The step can never be applied from the current on-disk
            // state (byte-mismatch, unreadable target) — offer to drop it
            // instead of leaving the user stuck retrying forever. Capture
            // the refusal's stepId in the closure and forward it: without
            // it, a stale click (another tab, or a click that lands after
            // a new step already landed) would discard whatever happens
            // to be on top by then instead of the step this toast is
            // actually about.
            const stepId = result.stepId
            toast.error(reason, {
              action: {
                label: "Discard step",
                onClick: () => {
                  void (async () => {
                    const discardResult = await branches.discardStep(action, stepId)
                    if (!discardResult.ok) {
                      // The step already moved on (someone else discarded
                      // or applied it first) — say so instead of leaving
                      // this click looking like it silently did nothing.
                      toast.error(
                        discardResult.reason ?? `Could not discard the ${action} step.`,
                      )
                    }
                  })()
                },
              },
            })
          } else {
            toast.error(reason)
          }
        }
      } finally {
        setBusy(false)
      }
    },
    [branches],
  )

  const { canUndo, canRedo, undoLabel, redoLabel } = branches.history
  const undoText = undoLabel ? `Undo: ${undoLabel}` : "Undo"
  const redoText = redoLabel ? `Redo: ${redoLabel}` : "Redo"

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* span wrapper so the tooltip still fires while the button is
              disabled (a disabled button swallows pointer events). */}
          <span>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={busy || !canUndo}
              aria-label={undoText}
              data-testid="editor-undo"
              onClick={() => void run("undo")}
            >
              <Undo2 />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{undoText}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* span wrapper so the tooltip still fires while the button is
              disabled (a disabled button swallows pointer events). */}
          <span>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={busy || !canRedo}
              aria-label={redoText}
              data-testid="editor-redo"
              onClick={() => void run("redo")}
            >
              <Redo2 />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{redoText}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
