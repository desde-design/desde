import type { PendingMutation } from "@/editor/core"
import { MutationDisambiguationDialog } from "@/components/editor/mutation-disambiguation-dialog"
import type { SurfaceEntry } from "../types"

/**
 * The offered choices come from `offeredDisambiguationChoices`
 * (src/hooks/disambiguation-choices.ts), which branches on `draft.scope`:
 * "This item only" is offered ONLY for `callsite`, because that is the only
 * scope whose save path honours it.
 *
 * **Every state here is `callsite`, deliberately** — it is the only scope that
 * still opens this dialog. `definition` and `unknown` collapse to a single
 * honest option, and since 2026-08-17 the shell auto-resolves those instead of
 * prompting (`onMutationAwaitingDisambiguation` in useEditorEditing.ts): a
 * one-radio group above a Save button is not a decision, so it applies and
 * reports the blast radius in a toast, with toolbar Undo as the way back. A
 * single-choice fixture would render a dialog the product can no longer open.
 *
 * This inverts the fixture's previous note, which said `callsite` was the
 * unproducible one. That was true until `classifyMutationScope`
 * (src/bridge/mutation-scope.ts, 2026-08-16) — before it, scope came from
 * `resolutionKind` alone and could never be `callsite`.
 *
 * `callsite` requires 2+ candidates each mapping to its OWN distinct callsite,
 * so the selectors below deliberately come from different authored lines rather
 * than being loop siblings.
 */
function pending(over: { rows?: number } = {}): PendingMutation {
  const rows = over.rows ?? 2
  return {
    pendingId: "pending-1",
    draft: {
      id: "mut-1",
      kind: "text",
      // The shared stamp the candidates collide on — a wrapper component's own
      // `<Comp {...props} />`, not the authored callsites.
      sourceLoc: "src/components/ui/button.tsx:47:6",
      resolutionKind: "direct",
      scope: "callsite",
      // The origin candidate's own authored line — what a this-item save
      // splices instead of `sourceLoc`.
      callsiteLoc: "src/pages/Settings.tsx:118:10",
      selector: "main section > button:nth-of-type(1)",
      before: "Rate limiting",
      after: "Rate limits",
    },
    candidates: Array.from({ length: rows }, (_, index) => ({
      instancePath: `App>Settings>Button[${index}]`,
      selector: `main section > button:nth-of-type(${index + 1})`,
      // Exactly one candidate carries `origin: true` (edit.ts:597-598).
      origin: index === 0,
    })),
  }
}

export const MUTATION_DISAMBIGUATION_SURFACE: SurfaceEntry = {
  id: "mutation-disambiguation",
  title: "Resolve ambiguous edit",
  kind: "modal",
  sourceFile: "src/components/editor/mutation-disambiguation-dialog.tsx",
  states: [
    {
      id: "mutation-disambiguation/callsite-two-items",
      label: "Callsite scope, 2 items (the commonest shape)",
      render: (ctx) => (
        <MutationDisambiguationDialog
          prompt={pending()}
          onConfirm={(choice) => ctx.log("onConfirm", choice)}
          onCancel={() => ctx.log("onCancel")}
        />
      ),
    },
    {
      id: "mutation-disambiguation/callsite-many-items",
      label: "Callsite scope, 8 items",
      render: (ctx) => (
        <MutationDisambiguationDialog
          prompt={pending({ rows: 8 })}
          onConfirm={(choice) => ctx.log("onConfirm", choice)}
          onCancel={() => ctx.log("onCancel")}
        />
      ),
    },
  ],
}
