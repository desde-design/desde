"use client"

/**
 * Mutation-disambiguation dialog.
 *
 * Fix for "stuck disambiguation blocks Save forever": when the bridge
 * captures a v-for-ambiguous mutation it can't auto-resolve (more than one
 * origin candidate, or `scope === "definition"` — see the honesty-rule
 * comment in `useEditorEditing.ts` above `onMutationAwaitingDisambiguation`),
 * the mutation used to sit in `pendingDisambiguations` with no UI to clear
 * it, so `handleSaveAll`'s gate refused Save forever. This dialog surfaces
 * the oldest pending item and forces an explicit, HONEST choice:
 *
 *   - 'this-instance'  — patch only the call-site that produced this row
 *                         (offered ONLY when `draft.scope === "callsite"` —
 *                         it's the only scope whose save path actually
 *                         honors a this-instance choice).
 *   - 'all-instances'  — rewrite the shared v-for template (always offered).
 *   - cancel           — discard the buffered edit; nothing is written.
 *
 * The offered choice set itself is computed by the pure
 * `offeredDisambiguationChoices` helper (`src/hooks/disambiguation-choices.ts`)
 * so the scope-gating rule is unit-testable independent of this component.
 *
 * **In practice this dialog now only ever opens with TWO choices.** Since
 * 2026-08-17 `onMutationAwaitingDisambiguation` auto-resolves any prompt whose
 * offered set has one entry and reports it in a toast instead
 * (`src/hooks/single-choice-disambiguation-notice.ts`), because a one-radio
 * group above a Save button is not a decision. That is the common shape, not a
 * rare one: `classifyMutationScope` fails safe to `definition` whenever it
 * cannot prove a 1:1 candidate→callsite mapping. The single-choice rendering
 * below is kept because the component stays honest about whatever it is handed,
 * but nothing in the product reaches it. See `docs/design.md` § "A dialog with
 * one option is not a decision".
 *
 * Mirrors `iteration-scope-dialog.tsx` / `delete-scope-dialog.tsx`: shadcn
 * Dialog shell, one `OptionCard` per offered choice, honest Cancel copy.
 */

import type { DisambiguationChoice, PendingMutation } from "@/editor/core/edit"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  BeforeAfter,
  OptionCard,
  OptionCardGroup,
  ValueReadout,
} from "@/components/blocks"
import { useState } from "react"
import { offeredDisambiguationChoices } from "@/hooks/disambiguation-choices"

interface MutationDisambiguationDialogProps {
  /** The oldest unresolved pending mutation; null when none is queued. */
  prompt: PendingMutation | null
  /** Designer picked a scope for `prompt`. */
  onConfirm: (choice: DisambiguationChoice) => void
  /** Designer discarded the buffered edit — nothing is written. */
  onCancel: () => void
}

export function MutationDisambiguationDialog({
  prompt,
  onConfirm,
  onCancel,
}: MutationDisambiguationDialogProps) {
  const offered = prompt ? offeredDisambiguationChoices(prompt) : null
  // Default to the first offered choice. `offeredDisambiguationChoices` puts
  // the narrower option first when there is one, so this follows the product's
  // own ordering rather than picking a favourite here.
  const defaultChoice = offered?.choices[0]?.choice

  // Re-seed per prompt. This dialog is mounted for the whole session
  // (editor-surface passes `prompt`, which is null when closed), so a
  // `useState` initializer runs once with `prompt === null` and never again.
  // That was worse here than a dead default: the module's honesty rule offers
  // `this-instance` ONLY for callsite scope, so a `this-instance` pick left
  // over from a callsite prompt would still be the selected value when a
  // DEFINITION-scoped prompt opened, and confirming it would report "only this
  // row changed" while the save path rewrote the shared template.
  const [picked, setPicked] = useState<DisambiguationChoice | undefined>(defaultChoice)
  const [prevPrompt, setPrevPrompt] = useState(prompt)
  if (prompt !== prevPrompt) {
    setPrevPrompt(prompt)
    setPicked(defaultChoice)
  }

  return (
    <Dialog open={!!prompt} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent size="xl" data-testid="mutation-disambiguation-dialog">
        {offered ? (
          <>
            <DialogHeader>
              {/*
                The same question the iteration-scope dialog asks, worded the
                same way. "Resolve ambiguous edit" named the machine's problem
                rather than the user's choice.
              */}
              <DialogTitle>Change this item or all items?</DialogTitle>
              <DialogDescription>
                This edit landed on one item in a loop that renders{" "}
                {offered.rowCount} item{offered.rowCount === 1 ? "" : "s"}.
                Choose what to change before saving.
              </DialogDescription>
            </DialogHeader>

            <ValueReadout
              label="Change"
              data-testid="mutation-disambiguation-preview"
            >
              <BeforeAfter before={offered.before} after={offered.after} />
            </ValueReadout>

            <OptionCardGroup
              value={picked}
              onValueChange={(v) => setPicked(v as DisambiguationChoice)}
              aria-label="Resolve ambiguous edit"
            >
              {offered.choices.map((option) => (
                <OptionCard
                  key={option.choice}
                  value={option.choice}
                  title={option.title}
                  hint={option.hint}
                  data-testid={`mutation-disambiguation-${option.choice}`}
                />
              ))}
            </OptionCardGroup>
          </>
        ) : null}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={onCancel}
            data-testid="mutation-disambiguation-cancel"
          >
            Discard edit
          </Button>
          <Button
            onClick={() => picked && onConfirm(picked)}
            disabled={!picked}
            data-testid="mutation-disambiguation-confirm"
          >
            Save edit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
