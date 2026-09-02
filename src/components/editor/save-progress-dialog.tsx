"use client"

import { useState } from "react"
import { Loader2, ChevronDown } from "lucide-react"
import type { SaveLLMTrace } from "@/editor/core"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogCopy,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  BeforeAfter,
  Eyebrow,
  OptionCard,
  OptionCardGroup,
} from "@/components/blocks"
import type { ExternalEditConflict } from "@/components/editor/edit-conflict-types"

interface SaveProgressDialogProps {
  /** True while the save is in flight (deterministic try + LLM if needed). */
  saving: boolean
  /** Set as soon as the LLM-eligible bundle dispatches — what the model is about to see. */
  pendingLLMInput: SaveLLMTrace["mutationSummary"] | null
  /** Set when the route returned an llmTrace (LLM actually ran). Null on the fast-path. */
  lastLLMTrace: SaveLLMTrace | null
  /** Accumulated streaming text — live LLM output as tokens arrive. Empty on fast-path. */
  streamingText: string
  /** Latest save status string (errors, "Saved …" text). */
  saveStatus: string | null
  /**
   * Present when the last save returned 409 + external-edit-conflict.
   * When set, the dialog renders recovery actions (Reload prototype /
   * Force overwrite / Dismiss) so the designer can resolve the conflict
   * without leaving the save modal — which is the only surface that
   * announces the failure today.
   */
  conflict?: ExternalEditConflict | null
  onForceOverwrite?: () => void
  onReloadAfterConflict?: () => void
  onDismissConflict?: () => void
}

/**
 * Modal overlay shown while the editor save is in flight. Surfaces:
 *
 *  - The deterministic fast-path (sub-100ms): briefly shows "Saving" and
 *    closes the moment the save lands. Often invisible to the eye, which
 *    is correct UX.
 *  - The LLM fallback (~5–95s): shows "Asking AI to interpret the edits"
 *    with the mutation summary the route is sending so the designer can
 *    SEE what they asked for. When the response returns, swaps to a
 *    completed view showing the model's outcome + per-mutation notes.
 *  - Failures, including the 409 external-edit conflict and its recovery
 *    actions — the only surface that announces those today.
 *
 * The "pending LLM input" snapshot is captured client-side at dispatch
 * time (mirrors the server's truncation cap) so the dialog has something
 * to render IMMEDIATELY, before the route returns. The actual `llmTrace`
 * arrives with the response and overwrites the in-flight view with the
 * authoritative server-side data (model id, latency, notes, per-mutation
 * outcomes).
 *
 * There is deliberately NO success state — see `derivePhase`. A plain
 * deterministic save closes the dialog and is announced by the save-status
 * toast instead. The designer can keep the dialog open after an LLM save to
 * review the trace; it closes only on Close (or on a conflict's Dismiss).
 */
export function SaveProgressDialog({
  saving,
  pendingLLMInput,
  lastLLMTrace,
  streamingText,
  saveStatus,
  conflict,
  onForceOverwrite,
  onReloadAfterConflict,
  onDismissConflict,
}: SaveProgressDialogProps) {
  // Open whenever there's something worth showing AND we haven't been
  // explicitly dismissed since the most recent save started. The state
  // here is intentionally minimal: a "dismissed" flag that flips back
  // to false when a new save begins (via the prop transition tracked
  // below). Avoids the cascading-render pattern of `setState`-in-effect
  // that the React Compiler rejects.
  const [dismissed, setDismissed] = useState(false)
  const [prevSaving, setPrevSaving] = useState(saving)
  // Transition false → true on `saving` re-opens the dialog after the
  // user closed a prior one. Use a setState comparison rather than a
  // ref read during render (which lint forbids).
  if (saving !== prevSaving) {
    setPrevSaving(saving)
    if (saving) setDismissed(false)
  }

  // The phase IS the reason to be open: `null` means there is nothing worth
  // interrupting for. Deriving `open` from anything else is what let the two
  // drift apart before (see `derivePhase`).
  const phase = derivePhase({
    saving,
    pendingLLMInput,
    lastLLMTrace,
    saveStatus,
    conflict,
  })
  const open = phase !== null && !dismissed

  // `phase` going non-null → null while the dialog is open is the COMMON
  // path, not an edge case: every plain deterministic save drops straight out
  // of "saving". Retain the last real phase so whatever renders on that
  // transition shows what it was showing rather than a blank header.
  //
  // Whether anything renders at all depends on the surface. MEASURED under
  // jsdom: Radix unmounts synchronously, so this is inert in tests. In a real
  // browser `DialogContent` carries `duration-100 data-closed:animate-out`
  // (ui/dialog.tsx:64) and Radix's Presence holds the node mounted until the
  // animation ends — so the frame does render there. That second half is
  // inferred from Presence's contract, not instrumented; the guard is kept
  // because it makes a blank header impossible either way for two lines.
  // Same setState-during-render idiom as the `prevSaving` tracker above.
  const [renderedPhase, setRenderedPhase] = useState<Phase>("saving")
  if (phase !== null && phase !== renderedPhase) setRenderedPhase(phase)

  const hasConflict = !!conflict && conflict.files.length > 0
  // Each child of the details region can return null on its own, so the gate
  // has to mirror their real emptiness checks: a bordered container with
  // nothing inside it is worse than no container.
  const showPendingMutations =
    !!pendingLLMInput && pendingLLMInput.length > 0 && !lastLLMTrace
  const showStreaming = streamingText.length > 0 && !lastLLMTrace
  const showDetails = showPendingMutations || showStreaming || !!lastLLMTrace

  // Everything the header has to say, as discrete points. `phaseDescription`
  // returns "" for the phases whose title already says it, so those drop out
  // here instead of rendering an empty line.
  const phaseLine = phaseDescription(renderedPhase)
  // The recovery options, as a selectable set rather than a row of buttons.
  // Two buttons side by side made a destructive action one stray click away and
  // gave neither any room to say what it does; a card carries its consequence
  // and the footer is what commits.
  const recoveryOptions = [
    ...(onReloadAfterConflict
      ? [
          {
            value: "reload",
            title: "Reload prototype",
            hint: "Discards pending edits and re-syncs against the version on disk.",
            run: onReloadAfterConflict,
          },
        ]
      : []),
    ...(onForceOverwrite
      ? [
          {
            value: "force",
            title: "Force overwrite",
            hint: "Re-runs the save against the current on-disk source. These edits win, and the other changes stay recoverable from .desde/backups/.",
            run: onForceOverwrite,
          },
        ]
      : []),
  ]
  // Seeded in the initializer AND re-seeded per conflict, because either alone
  // is wrong here. The options come from the callback props, which exist from
  // first mount, so the initializer gives the first conflict a live default;
  // the prev-tracker then re-seeds for every conflict after it, since this
  // dialog is mounted for the whole session and an initializer runs once.
  // Without the initializer the first conflict opened with nothing selected and
  // a dead Continue button, which is the same defect this branch already fixed
  // twice in the scope dialogs.
  const [recovery, setRecovery] = useState<string | undefined>(
    () => recoveryOptions[0]?.value,
  )
  const [prevConflict, setPrevConflict] = useState(conflict)
  if (conflict !== prevConflict) {
    setPrevConflict(conflict)
    setRecovery(recoveryOptions[0]?.value)
  }
  const chosenRecovery = recoveryOptions.find((o) => o.value === recovery)

  const issues: { key: string; node: React.ReactNode }[] = [
    ...(looksLikeFailure(saveStatus)
      ? [
          {
            key: "error",
            node: (
              <span
                role="status"
                className="text-destructive"
                data-testid="save-dialog-error"
              >
                {saveStatus}
              </span>
            ),
          },
        ]
      : []),
  ]
  // While the save is in flight there is nothing to close: dismissing this
  // dialog never cancelled the write, it only stopped you watching it. The X
  // said "you may leave" and the greyed-out Close button said "you may not",
  // and both were describing an action that does not exist. Show neither until
  // the save reaches a state the user can actually act on.
  const inFlight = renderedPhase === "saving" || renderedPhase === "asking-ai"
  // A failure title goes destructive. The icon that used to sit beside it put
  // the whole weight of "this went wrong" on a 16px glyph while the sentence
  // read as neutral chrome, and the error line underneath was already red, so
  // the heading was the one part of the block not carrying the state. Colouring
  // the heading fixed that and made the glyph the third red thing saying one
  // fact, which is why `PhaseIcon` now returns null for both failure phases.
  const isFailure = renderedPhase === "ai-failed" || renderedPhase === "failed"

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setDismissed(true)
      }}
    >
      <DialogContent size="2xl" showCloseButton={!inFlight}>
        <DialogHeader>
          <DialogTitle
            className={cn(
              "flex items-center gap-2",
              isFailure && "text-destructive",
            )}
          >
            <PhaseIcon phase={renderedPhase} />
            {phaseTitle(renderedPhase)}
          </DialogTitle>
          {/*
            The prose sources as points rather than one run-on sentence: the
            phase line, the failure string, the conflict guidance. They used to
            be a gray caption plus two tinted Callouts stacked before anything
            actionable; then they were a single paragraph, which ran three
            unrelated statements together.

            One point renders as a paragraph and two or more as a list, because
            a lone bullet is a paragraph wearing a dot. `asChild` is what lets
            the list BE the description: DialogDescription renders a <p>, a <ul>
            inside a <p> is invalid, and dropping the wrapper would break the
            dialog's aria-describedby.

            The error keeps the guard it had as a Callout, so it can only appear
            under a failure title; a success string never reaches this dialog.
            Button names stay emphasised because the guidance is telling the
            user which of two footer buttons to press.
          */}
          {/*
            `titleCarriesError` in the failure phases, because this dialog's
            own title becomes the error there ("Save failed", "AI couldn't
            apply some edits") and goes `text-destructive` with it. A tinted
            box under a red title that is already about this failure is a
            banner inside a banner. In the non-failure phases the title is
            "Saving" and any issue WOULD need its own container, so the flag
            follows `isFailure` rather than being hardcoded.
          */}
          <DialogCopy
            description={phaseLine || undefined}
            issues={issues}
            titleCarriesError={isFailure}
          />
        </DialogHeader>

        {/*
          One details region instead of four stacked boxes. TraceMeta, the
          mutation list, the outcomes and the notes are all answers to "what did
          the AI do", so they are rows of a single bordered container rather
          than four siblings competing with the description for attention. Each
          child brings its own padding and no border; the divider comes from the
          parent.

          Which children render:
            - in flight, before a trace: the pending input, then the streaming text
            - after a trace: the trace's own server-authoritative summary
          The gate is computed rather than inlined so the container can't render
          as an empty bordered box when every child would have returned null.
        */}
        {showDetails ? (
          <div className="divide-y rounded-md border bg-muted/30 text-sm">
            {showPendingMutations ? (
              <MutationsBlock
                label="What the AI is being asked to apply"
                mutations={pendingLLMInput!}
                truncated={false}
              />
            ) : null}

            {showStreaming ? <StreamingBlock text={streamingText} /> : null}

            {lastLLMTrace ? (
              <>
                <TraceMeta trace={lastLLMTrace} />
                <MutationsBlock
                  label="What the AI was asked to apply"
                  mutations={lastLLMTrace.mutationSummary}
                  truncated={lastLLMTrace.truncated}
                  totalCount={lastLLMTrace.mutationCount}
                />
                {lastLLMTrace.perMutationOutcomes &&
                lastLLMTrace.perMutationOutcomes.length > 0 ? (
                  <OutcomesBlock outcomes={lastLLMTrace.perMutationOutcomes} />
                ) : null}
                {lastLLMTrace.notes ? (
                  <NotesBlock notes={lastLLMTrace.notes} />
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        {hasConflict ? <ConflictFiles files={conflict!.files} /> : null}

        {hasConflict && recoveryOptions.length > 0 ? (
          <OptionCardGroup
            value={recovery}
            onValueChange={setRecovery}
            aria-label="Recover from the conflict"
          >
            {recoveryOptions.map((option) => (
              <OptionCard
                key={option.value}
                value={option.value}
                title={option.title}
                hint={option.hint}
                data-testid={`save-dialog-conflict-${option.value}`}
              />
            ))}
          </OptionCardGroup>
        ) : null}

        {inFlight ? null : (
        <DialogFooter>
          {hasConflict ? (
            <>
              {onDismissConflict ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onDismissConflict()
                    setDismissed(true)
                  }}
                  data-testid="save-dialog-conflict-dismiss"
                >
                  Dismiss
                </Button>
              ) : null}
              <Button
                size="sm"
                disabled={!chosenRecovery}
                onClick={() => chosenRecovery?.run()}
                data-testid="save-dialog-conflict-confirm"
              >
                Continue
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDismissed(true)}
            >
              Close
            </Button>
          )}
        </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

type Phase =
  | "saving" // deterministic try in flight, no LLM signal yet
  | "asking-ai" // LLM call in flight (pendingLLMInput set, no trace yet)
  | "ai-done" // trace returned; LLM ran successfully
  | "ai-failed" // trace returned with outcome=failed
  | "failed" // status (or a 409 conflict) indicates failure

/**
 * Maps the save state onto the reason this modal is on screen. `null` means
 * there is no such reason and the dialog stays shut.
 *
 * **There is deliberately no success phase.** A plain deterministic save is
 * sub-100ms and already announced by the transient save-status toast in
 * `BannerToasts` (`banner-toasts.tsx`); a backdrop-dimming modal would
 * duplicate that message on a surface far too heavy for it. This dialog is
 * for the two things a toast can't carry: a multi-second wait the designer
 * needs to watch, and a failure they have to act on.
 *
 * A `"done"` phase — full title, description and green tick — did exist here
 * and was unreachable: the separate `hasContent` expression that decided
 * whether to open had no success term, so nothing could ever open the dialog
 * into it. Returning `null` from the same function that names the phase is
 * what keeps the two from drifting apart again: every phase is an
 * open-reason, and every open-reason is a phase.
 *
 * Note also why the failure check reads a prose string: `saveStatus` is the
 * only channel most failures arrive on. That makes it a weak signal — the
 * pre-save gate's "Cannot save: N edits still need a v-for scope choice…"
 * matches none of these words and correctly yields `null` (toast territory),
 * but a future notice could match by accident. Anything that MUST hold the
 * dialog open should arrive as a structured prop, the way `conflict` does.
 */
function derivePhase(args: {
  saving: boolean
  pendingLLMInput: SaveLLMTrace["mutationSummary"] | null
  lastLLMTrace: SaveLLMTrace | null
  saveStatus: string | null
  conflict?: ExternalEditConflict | null
}): Phase | null {
  if (looksLikeFailure(args.saveStatus)) {
    if (args.lastLLMTrace?.outcome === "failed") return "ai-failed"
    return "failed"
  }
  // A 409 renders recovery actions the designer can't reach anywhere else,
  // so it holds the dialog open on the structured prop rather than on the
  // wording of `saveStatus` — which the next notice is free to overwrite.
  if (args.conflict && args.conflict.files.length > 0) return "failed"
  if (args.saving) {
    if (args.pendingLLMInput) return "asking-ai"
    return "saving"
  }
  if (args.lastLLMTrace) {
    return args.lastLLMTrace.outcome === "failed" ? "ai-failed" : "ai-done"
  }
  // Nothing in flight, no trace to read, no failure to acknowledge: the save
  // either succeeded plainly or never started. Both are the toast's job.
  return null
}

function looksLikeFailure(saveStatus: string | null): boolean {
  return saveStatus
    ? /failed|threw|conflict|refused|error/i.test(saveStatus)
    : false
}

function phaseTitle(p: Phase): string {
  switch (p) {
    case "saving":
      return "Saving"
    case "asking-ai":
      return "Asking AI to interpret the edits"
    case "ai-done":
      return "AI applied the edits"
    case "ai-failed":
      return "AI couldn't apply some edits"
    case "failed":
      return "Save failed"
  }
}

function phaseDescription(p: Phase): string {
  switch (p) {
    case "saving":
      return "Writing changes directly to source files."
    case "asking-ai":
      return "Your edits don't map cleanly to a single source location, so the AI is reading the file and figuring out where to write. This usually takes 5 to 90 seconds."
    case "ai-done":
      return "Review the AI's interpretation below. Your changes are already saved."
    // Empty: the title already says it. A description that restates its own
    // heading is a line the user reads twice and learns nothing from.
    case "ai-failed":
      return ""
    case "failed":
      return ""
  }
}

/**
 * The header glyph, and it is null for three of five phases on purpose.
 *
 * House rule: one icon per header, and only where it carries something the
 * words do not (`docs/design.md` § "Glyphs"). Applied to these five titles,
 * only the in-flight phases qualify:
 *
 *  - `saving` / `asking-ai` keep a spinner. Motion is liveness, and liveness is
 *    exactly what a static title cannot say. "Asking AI to interpret your
 *    edits" tells you what is happening, not that it is still happening.
 *  - `asking-ai` used a `Sparkles` instead. It encoded "AI", which is the
 *    second word of its own title, so the one phase where the header had
 *    something to add was the one where it added nothing.
 *  - `ai-done` used a `Sparkles` too, under "AI applied the edits". Same
 *    redundancy, and there is nothing in flight to report.
 *  - `ai-failed` / `failed` used a destructive `AlertCircle` beside a title
 *    that is ALREADY `text-destructive` (see `isFailure` at the call site) and
 *    above an error line that is already red. Three reds for one fact. The
 *    coloured heading is the one that scales, because it carries the state in
 *    the thing the user reads rather than in a 16px glyph beside it.
 */
function PhaseIcon({ phase }: { phase: Phase }) {
  switch (phase) {
    case "saving":
    case "asking-ai":
      return <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
    case "ai-done":
    case "ai-failed":
    case "failed":
      return null
  }
}

/**
 * Disclosure summary: label first, a line chevron last.
 *
 * `list-none` + the webkit marker rule remove the native filled triangle, which
 * sat before the text and is the only disclosure glyph the browser gives you.
 * The affordance belongs after the label, the way it does everywhere else in
 * the editor, and it should match the rest of the icon set: a stroked chevron,
 * not a solid arrowhead.
 */
const disclosureSummary =
  "flex cursor-pointer list-none items-center gap-1.5 font-normal [&::-webkit-details-marker]:hidden"

const disclosureChevron =
  "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"

function TraceMeta({ trace }: { trace: SaveLLMTrace }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2 text-sm">
      <dt className="text-muted-foreground">Model</dt>
      <dd className="font-mono">{trace.model}</dd>
      <dt className="text-muted-foreground">Latency</dt>
      <dd className="font-mono">{(trace.latencyMs / 1000).toFixed(1)}s</dd>
      <dt className="text-muted-foreground">Edits</dt>
      <dd className="font-mono">{trace.mutationCount}</dd>
    </dl>
  )
}

function MutationsBlock({
  label,
  mutations,
  truncated,
  totalCount,
}: {
  label: string
  mutations: SaveLLMTrace["mutationSummary"]
  truncated: boolean
  totalCount?: number
}) {
  if (mutations.length === 0) return null
  return (
    <details className="group px-3 py-2 text-sm" open>
      <summary className={disclosureSummary}>
        {label}
        <ChevronDown className={disclosureChevron} aria-hidden />
      </summary>
      <ul className="mt-2 space-y-2">
        {mutations.map((m) => (
          <li key={m.id} className="rounded border bg-background px-2 py-1.5">
            {/* The kind was a filled pill; it is a word, so it reads as one. */}
            <Eyebrow as="div" size="sm" className="flex items-center gap-2">
              <span>{m.kind}</span>
              {m.target && m.target !== m.kind ? (
                <span className="font-mono">{m.target}</span>
              ) : null}
              {m.sourceLoc ? (
                <span className="ml-auto truncate font-mono text-code">
                  {m.sourceLoc}
                </span>
              ) : null}
            </Eyebrow>
            <BeforeAfter
              className="mt-1 font-mono"
              before={m.before}
              after={m.after}
            />
          </li>
        ))}
      </ul>
      {truncated && totalCount ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Showing first {mutations.length} of {totalCount}.
        </p>
      ) : null}
    </details>
  )
}

function OutcomesBlock({
  outcomes,
}: {
  outcomes: NonNullable<SaveLLMTrace["perMutationOutcomes"]>
}) {
  const refused = outcomes.filter((o) => o.outcome === "refused")
  const skipped = outcomes.filter((o) => o.outcome === "skipped")
  const applied = outcomes.filter((o) => o.outcome === "applied")
  return (
    <div className="space-y-1 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-success/15 px-2 py-0.5 text-success">
          {applied.length} applied
        </span>
        {skipped.length > 0 ? (
          <span className="rounded bg-muted px-2 py-0.5 text-muted-foreground">
            {skipped.length} skipped
          </span>
        ) : null}
        {refused.length > 0 ? (
          <span className="rounded bg-destructive/15 px-2 py-0.5 text-destructive">
            {refused.length} refused
          </span>
        ) : null}
      </div>
      {refused.length > 0 || skipped.length > 0 ? (
        <ul className="mt-1 space-y-1">
          {[...refused, ...skipped].map((o) => (
            <li key={o.mutationId} className="text-xs">
              <span className="font-mono text-muted-foreground">
                {o.mutationId}:
              </span>{" "}
              <span
                className={
                  o.outcome === "refused"
                    ? "text-destructive"
                    : "text-muted-foreground"
                }
              >
                {o.outcome}
              </span>
              {o.reason ? (
                <span className="text-muted-foreground">, {o.reason}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function NotesBlock({ notes }: { notes: string }) {
  return (
    <details className="group px-3 py-2 text-sm">
      <summary className={disclosureSummary}>
        Notes from the AI
        <ChevronDown className={disclosureChevron} aria-hidden />
      </summary>
      <p className="mt-2 whitespace-pre-wrap font-mono text-code">{notes}</p>
    </details>
  )
}

function ConflictFiles({
  files,
}: {
  files: ExternalEditConflict["files"]
}) {
  return (
    <div className="text-sm" data-testid="save-dialog-conflict">
      <div className="font-normal">Files changed on disk since your last save:</div>
      <ul className="mt-1 space-y-0.5">
        {files.slice(0, 5).map((c) => (
          <li
            key={c.file}
            className="truncate font-mono text-code text-muted-foreground"
          >
            {c.file}
          </li>
        ))}
        {files.length > 5 ? (
          <li className="text-xs text-muted-foreground">
            …and {files.length - 5} more
          </li>
        ) : null}
      </ul>
    </div>
  )
}

function StreamingBlock({ text }: { text: string }) {
  return (
    <div className="px-3 py-2 text-sm">
      <div className="mb-1 flex items-center gap-1.5 font-normal">
        AI response (streaming)
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-code text-muted-foreground">
        {text}
      </pre>
    </div>
  )
}
