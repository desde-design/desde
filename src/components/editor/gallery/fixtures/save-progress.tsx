import type { SaveLLMTrace } from "@/editor/core"
import type { ExternalEditConflict } from "@/components/editor/edit-conflict-types"
import { SaveProgressDialog } from "@/components/editor/save-progress-dialog"
import type { SurfaceEntry } from "../types"

/**
 * The dialog derives its phase (saving / asking-ai / ai-done / ai-failed /
 * failed) from `saving`, `pendingLLMInput`, `lastLLMTrace`, `saveStatus` and
 * `conflict`. Each fixture below pins one phase by supplying exactly that
 * combination.
 *
 * There is deliberately no success state here, because the dialog has no
 * success phase: a plain deterministic save closes it, and the save-status
 * toast in `BannerToasts` announces the result instead. A dead `done` phase
 * did exist in the product — unreachable, because the open condition had no
 * success term — and was deleted in `ed38e83c`. The gallery fixture that had
 * tried to pin it was removed separately, in this branch's own `a223913d`.
 * Don't re-add either.
 */
const SUMMARY: SaveLLMTrace["mutationSummary"] = [
  {
    id: "mut-1",
    kind: "class",
    sourceLoc: "src/pages/Settings.vue:118:10",
    target: "class",
    before: "btn btn-secondary",
    after: "btn btn-primary",
  },
  {
    id: "mut-2",
    kind: "text",
    sourceLoc: "src/pages/Settings.vue:124:14",
    before: "Rate limiting",
    after: "Rate limits",
  },
]

const TRACE: SaveLLMTrace = {
  outcome: "applied",
  model: "claude-opus-5",
  latencyMs: 8420,
  mutationCount: 2,
  mutationSummary: SUMMARY,
  truncated: false,
  perMutationOutcomes: [
    { mutationId: "mut-1", outcome: "applied" },
    { mutationId: "mut-2", outcome: "refused", reason: "The text is bound to a computed property." },
  ],
  notes: "Applied the class change directly. The label is computed, so it was left alone.",
}

const CONFLICT: ExternalEditConflict = {
  files: [
    {
      file: "src/pages/Settings.vue",
      expected: "a1b2c3d4",
      actual: "9f8e7d6c",
    },
  ],
  pendingMutations: [],
}

export const SAVE_PROGRESS_SURFACE: SurfaceEntry = {
  id: "save-progress",
  title: "Save progress",
  kind: "modal",
  sourceFile: "src/components/editor/save-progress-dialog.tsx",
  states: [
    {
      id: "save-progress/saving",
      label: "Deterministic fast-path in flight",
      render: () => (
        <SaveProgressDialog
          saving
          pendingLLMInput={null}
          lastLLMTrace={null}
          streamingText=""
          saveStatus={null}
        />
      ),
    },
    {
      id: "save-progress/asking-ai",
      label: "LLM fallback streaming",
      render: () => (
        <SaveProgressDialog
          saving
          pendingLLMInput={SUMMARY}
          lastLLMTrace={null}
          streamingText={
            "Reading src/pages/Settings.vue…\nThe Save button's class list is authored inline, so"
          }
          saveStatus={null}
        />
      ),
    },
    {
      id: "save-progress/ai-done",
      label: "LLM finished with a mixed trace",
      render: () => (
        <SaveProgressDialog
          saving={false}
          pendingLLMInput={SUMMARY}
          lastLLMTrace={TRACE}
          streamingText=""
          // Real copy: any successful save — deterministic-only or via the
          // LLM fallback — falls through to the same `setSaveStatus(`Saved
          // ${summary}.`)` call (useEditorEditing.ts:4149-4150). "2 DOM
          // mutation(s)" (the literal template output, singular/plural
          // un-normalized) is the actual string a designer would see here,
          // not a paraphrase of it.
          saveStatus="Saved 2 DOM mutation(s)."
        />
      ),
    },
    {
      id: "save-progress/ai-failed",
      label: "LLM returned outcome: failed",
      render: () => (
        <SaveProgressDialog
          saving={false}
          pendingLLMInput={SUMMARY}
          lastLLMTrace={{
            ...TRACE,
            outcome: "failed",
            perMutationOutcomes: [
              { mutationId: "mut-1", outcome: "refused", reason: "Could not locate the class attribute." },
              { mutationId: "mut-2", outcome: "refused", reason: "The text is bound to a computed property." },
            ],
            notes: "Neither mutation could be applied safely. Nothing was written.",
          }}
          streamingText=""
          // Real copy, `Save failed at DOM mutations: ${reason}`
          // (useEditorEditing.ts:4029) — the reason text mirrors the trace's
          // own per-mutation reason above for a coherent story.
          saveStatus="Save failed at DOM mutations: Could not locate the class attribute."
        />
      ),
    },
    {
      id: "save-progress/external-conflict",
      label: "409 external-edit conflict with recovery actions",
      render: (ctx) => (
        <SaveProgressDialog
          saving={false}
          pendingLLMInput={null}
          lastLLMTrace={null}
          streamingText=""
          // Real copy, `External-edit conflict on ${n} file(s): choose a
          // recovery option.` (useEditorEditing.ts:4025) — including its
          // "1 file(s)" plural-handling flaw, which is exactly the kind of
          // thing this gallery exists to surface rather than paper over.
          saveStatus="External-edit conflict on 1 file(s): choose a recovery option."
          conflict={CONFLICT}
          onForceOverwrite={() => ctx.log("onForceOverwrite")}
          onReloadAfterConflict={() => ctx.log("onReloadAfterConflict")}
          onDismissConflict={() => ctx.log("onDismissConflict")}
        />
      ),
    },
  ],
}
