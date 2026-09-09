/**
 * The edit that is waiting on an iteration-scope decision, and two pure
 * readers over it. Moved out of `useEditorEditing.ts` so the decision logic
 * around the "this item or all items" prompt can be unit-tested without
 * mounting the hook.
 */
import type { IterationContext, Selection, SourceLocation } from "@/editor/core"
import type { IterationScope } from "@/components/editor/iteration-scope-dialog"
import type { LayersMovePayload } from "@/components/editor/layers-panel"
import type { PropControlValue } from "@/components/editor/prop-control"
import type { EditableTextField, OutlineNode } from "@/types/bridge"
import type { AmbiguousIterationHandoff } from "@/editor/edit-service/build-edit-escalation-prompt"
import { buildAmbiguousIterationHandoffPrompt } from "@/editor/edit-service/build-edit-escalation-prompt"
import type { IterationVerifyOutcome } from "./iteration-verify"

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
  // `delete` reads the OUTLINE NODE, not the selection. A Layers-panel delete
  // carries whatever the iframe had selected at the time, which is routinely a
  // different element from the row the user deleted. Handing chat the
  // selection's selector pointed the agent at the wrong element.
  if (pending.editKind === "delete") return pending.node.selector
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

/**
 * Do these two pending edits hold the SAME bridge draft? Two verifies can be
 * in flight at once, and the later one replaces the earlier in the dialog
 * state. Whatever it replaces must have its bridge draft released, or Save
 * stays blocked behind an orphaned disambiguation. But when both objects
 * describe the same in-page typing session, releasing "the previous one"
 * cancels the draft the survivor still needs. Object identity is not the
 * test: the pending object is rebuilt on every keystroke round trip.
 */
export function sameBridgeDraft(a: PendingIterationEdit, b: PendingIterationEdit): boolean {
  if (a.editKind !== "dom-text" || b.editKind !== "dom-text") return false
  if (!a.bridgePendingId || !b.bridgePendingId) return false
  return a.bridgePendingId === b.bridgePendingId
}

/**
 * Is this verify's answer stale, i.e. did a newer intercept start while it was
 * in flight?
 *
 * Verify is an HTTP round trip and nothing orders the responses. Draft P1 goes
 * out, the user types again, draft P2 goes out. If B answers first the dialog
 * shows P2, and A's late answer then released P2 (the NEWER keystrokes) and
 * reopened P1. With two `loop` answers it was worse: the second completion
 * silently destroyed the first edit. Sequence numbers make "newer exists" a
 * fact rather than an inference from object identity, which does not hold
 * (the pending object is rebuilt on every keystroke round trip).
 *
 * A stale result may only release ITS OWN draft. It must not touch the prompt
 * or the draft the newer intercept is holding.
 */
export function isStaleVerify(seq: number, latest: number): boolean {
  return seq !== latest
}

/**
 * What the client should do once the server has answered "is there a loop at
 * this position?". Pure, so the four exits are testable without mounting the
 * hook: an error surfaces as a status, a missing loop goes to chat, a
 * remembered scope dispatches straight through, and anything else opens the
 * dialog.
 */
export type AfterVerifyAction =
  | { kind: "release-and-status"; message: string }
  | { kind: "hand-off"; prompt: string }
  | { kind: "remembered"; scope: IterationScope }
  | { kind: "prompt" }

export function decideAfterVerify(args: {
  outcome: IterationVerifyOutcome
  pending: PendingIterationEdit
  location: SourceLocation
  remembered: IterationScope | undefined
}): AfterVerifyAction {
  const { outcome, pending, location, remembered } = args
  if (outcome.kind === "error") {
    return { kind: "release-and-status", message: `Could not check the source for a loop: ${outcome.reason}` }
  }
  if (outcome.kind === "no-loop") {
    return {
      kind: "hand-off",
      prompt: buildAmbiguousIterationHandoffPrompt(describeAmbiguousIteration(pending, location, outcome.reason)),
    }
  }
  if (remembered) return { kind: "remembered", scope: remembered }
  return { kind: "prompt" }
}
