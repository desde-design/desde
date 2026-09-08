/**
 * The edit that is waiting on an iteration-scope decision, and two pure
 * readers over it. Moved out of `useEditorEditing.ts` so the decision logic
 * around the "this item or all items" prompt can be unit-tested without
 * mounting the hook.
 */
import type { IterationContext, Selection, SourceLocation } from "@/editor/core"
import type { LayersMovePayload } from "@/components/editor/layers-panel"
import type { PropControlValue } from "@/components/editor/prop-control"
import type { EditableTextField, OutlineNode } from "@/types/bridge"
import type { AmbiguousIterationHandoff } from "@/editor/edit-service/build-edit-escalation-prompt"

/**
 * Pending iteration edit — held while the IterationScopeDialog asks the
 * user to pick between mutating the data array entry vs. the template.
 * Each variant carries the data the legacy-path handler would need so
 * "all-rows" can re-enter without re-collecting inputs. New iteration-
 * aware edit kinds add a variant here.
 */
export type PendingIterationEdit =
  | {
      editKind: "delete"
      selection: Selection
      node: OutlineNode
      iterationContext: IterationContext
    }
  | {
      editKind: "prop"
      selection: Selection
      propName: string
      value: PropControlValue
      iterationContext: IterationContext
    }
  | {
      editKind: "move"
      payload: LayersMovePayload
      iterationContext: IterationContext
    }
  | {
      editKind: "dom-text"
      selection: Selection
      field: EditableTextField
      value: string
      iterationContext: IterationContext
      /**
       * Set ONLY when the edit reached us as a bridge pending disambiguation —
       * i.e. the designer typed in the page rather than in the inspector. The
       * bridge is holding a draft mutation and a live DOM preview, so every
       * exit from the dialog must resolve or cancel it; leaving it hanging
       * blocks Save behind `handleSaveAll`'s gate.
       */
      bridgePendingId?: string
    }

/**
 * Where the loop would be in source for this pending edit. Same derivation
 * `dispatchIterationEdit`'s "this-row" branch used inline; now shared with
 * the verify step that runs before any prompt opens.
 */
export function iterationTemplateLocation(pending: PendingIterationEdit): SourceLocation | undefined {
  switch (pending.editKind) {
    case "delete":
      return pending.node.editTarget
    case "prop":
    case "dom-text":
      return pending.selection.editTarget
    case "move":
      return pending.payload.source.editTarget
  }
}

function selectorOf(pending: PendingIterationEdit): string {
  return pending.editKind === "move" ? pending.payload.source.selector : pending.selection.selector
}

function namesOf(pending: PendingIterationEdit): { componentName?: string | null; tagName?: string | null } {
  if (pending.editKind === "delete") {
    return pending.node.type === "component"
      ? { componentName: pending.node.name }
      : { tagName: pending.node.name }
  }
  if (pending.editKind === "move") {
    const n = pending.payload.source
    return n.type === "component" ? { componentName: n.name } : { tagName: n.name }
  }
  return { componentName: pending.selection.componentName ?? null, tagName: pending.selection.tagName ?? null }
}

function requestedOf(pending: PendingIterationEdit): string {
  switch (pending.editKind) {
    case "delete":
      return "delete the element"
    case "prop":
      return `set the prop \`${pending.propName}\` to ${JSON.stringify(pending.value)}`
    case "dom-text":
      return `change the text to ${JSON.stringify(pending.value)}`
    case "move":
      return "move the element"
  }
}

/** Everything `buildAmbiguousIterationHandoffPrompt` needs, read off the pending edit. */
export function describeAmbiguousIteration(
  pending: PendingIterationEdit,
  location: SourceLocation,
  noLoopReason: string,
): AmbiguousIterationHandoff {
  return {
    requested: requestedOf(pending),
    ...namesOf(pending),
    selector: selectorOf(pending),
    location: { file: location.file, line: location.line, column: location.column },
    index: pending.iterationContext.index,
    siblingCount: pending.iterationContext.siblingCount,
    noLoopReason,
  }
}
