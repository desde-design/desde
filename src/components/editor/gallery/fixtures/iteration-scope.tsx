import {
  IterationScopeDialog,
  type IterationEditKind,
} from "@/components/editor/iteration-scope-dialog"
import type { SurfaceEntry, SurfaceRenderContext } from "../types"

/**
 * `editKind` selects an entire copy set (verb, both tile titles, both hints)
 * from EDIT_LABELS, so every kind is a genuinely distinct rendering — this is
 * the surface most in need of a design pass and it has six of them.
 */
/**
 * The kinds the PRODUCT can open this dialog with, which is not the same as
 * the kinds `IterationEditKind` declares.
 *
 * `PendingIterationEdit` (useEditorEditing.ts) has exactly four variants:
 * delete, prop, move, dom-text. Nothing constructs a pending iteration edit for
 * `duplicate` or `insert`, so the dialog can never render their copy. Their
 * EDIT_LABELS entries stay as spec for when those kinds land, the same way the
 * bridge protocol keeps specified-but-unbuilt messages, but a gallery state for
 * them would be showing a screen the product cannot produce, which is the one
 * thing a fixture must never do.
 */
const EDIT_KINDS: readonly IterationEditKind[] = [
  "delete",
  "prop",
  "move",
  "dom-text",
]

/**
 * Every edit kind offers both scopes as of 2026-08-16. `dom-text` used to be
 * grey-disabled here, mirroring the call site, because no this-row text path
 * existed; the `patch-text` lane closed that and the gate was deleted rather
 * than left permanently true.
 *
 * The fixture still derives nothing of its own — it renders what the call site
 * renders. That is the whole reason an earlier inverted version of this file
 * (a disabled tile on `prop`, which the product never disabled) was a bug.
 */
function dialog(
  kind: IterationEditKind,
  ctx: SurfaceRenderContext,
  { siblingCount = 8, rowIndex = 2 }: { siblingCount?: number; rowIndex?: number } = {},
) {
  return (
    <IterationScopeDialog
      open
      editKind={kind}
      siblingCount={siblingCount}
      rowIndex={rowIndex}
      onConfirm={(scope, remember) => ctx.log("onConfirm", scope, remember)}
      onCancel={() => ctx.log("onCancel")}
    />
  )
}

export const ITERATION_SCOPE_SURFACE: SurfaceEntry = {
  id: "iteration-scope",
  title: "Iteration scope (this row vs. all rows)",
  kind: "modal",
  sourceFile: "src/components/editor/iteration-scope-dialog.tsx",
  states: [
    ...EDIT_KINDS.map((kind) => ({
      id: `iteration-scope/${kind}`,
      label: `Edit kind: ${kind}`,
      render: (ctx: SurfaceRenderContext) => dialog(kind, ctx),
    })),
    {
      id: "iteration-scope/two-rows",
      label: "Smallest ambiguity (2 rows)",
      // Routed through the same helper so the this-row derivation can't drift
      // between this state and the per-kind ones.
      render: (ctx: SurfaceRenderContext) =>
        dialog("delete", ctx, { siblingCount: 2, rowIndex: 0 }),
    },
  ],
}
