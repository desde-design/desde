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
import type {
  AmbiguousIterationHandoff,
  RowScopedEditHandoff,
} from "@/editor/edit-service/build-edit-escalation-prompt"
import {
  buildAmbiguousIterationHandoffPrompt,
  describeMoveDestination,
  safeCount,
} from "@/editor/edit-service/build-edit-escalation-prompt"
import type { IterationVerifyOutcome } from "./iteration-verify"

/**
 * Pending iteration edit — held while the IterationScopeDialog asks the
 * user to pick between mutating the data array entry vs. the template.
 * Each variant carries the data the legacy-path handler would need so
 * "all-rows" can re-enter without re-collecting inputs. New iteration-
 * aware edit kinds add a variant here.
 */
/**
 * Where the LOOP is, as the verify step found it. Carried on every variant.
 *
 * The click's own position is not the loop's: both locators walk up from the
 * clicked element to the enclosing `v-for` / `.map()`, so a `<span>` inside an
 * `<li v-for>` verifies as a loop. Dispatching "this item" against the SPAN's
 * position then reached the data resolver, which matches the loop element
 * EXACTLY, and got "No v-for element at ..." back. Absent when the verify
 * never ran or an older CLI answered without a position; the click's position
 * is the fallback, which is the behaviour before this field existed.
 */
type WithLoopLocation = { loopLocation?: SourceLocation }

export type PendingIterationEdit =
  | ({
      editKind: "delete"
      selection: Selection
      node: OutlineNode
      iterationContext: IterationContext
    } & WithLoopLocation)
  | ({
      editKind: "prop"
      selection: Selection
      propName: string
      value: PropControlValue
      iterationContext: IterationContext
    } & WithLoopLocation)
  | ({
      editKind: "move"
      payload: LayersMovePayload
      iterationContext: IterationContext
    } & WithLoopLocation)
  | ({
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
    } & WithLoopLocation)

/**
 * The status every refusing entry point sets when the page's loop information
 * did not survive the wire boundary. One string, in one place, because five
 * call sites say it and they must not drift apart.
 *
 * It says what happened and what to do, and it does NOT say "malformed" or
 * name a field: the designer did not write the message that failed.
 */
export const MALFORMED_ITERATION_STATUS =
  "The page reported loop information it could not describe, so this edit was not applied. Reload and try again."

/**
 * `message` with a full stop, unless it already ends in one.
 *
 * The status bar builds a two-sentence line by appending "Choose how to apply
 * it." to a refusal reason, and those reasons come from several places: our
 * own literals, an applicator's refusal text, a server's 400 body. Not all of
 * them end in punctuation, so the two sentences ran together. Trailing
 * whitespace is trimmed first, so a reason ending in a space does not get a
 * stop hung off the end of it.
 *
 * `!` and `?` count as ended too. Nothing we write ends that way, but a
 * refusal reason we did not write might, and appending a stop to one would
 * read as a typo.
 */
export function endSentence(message: string): string {
  const trimmed = message.trim()
  if (trimmed === "") return trimmed
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/**
 * The status line for an edit that has been PARKED: why the deterministic
 * lane could not apply it, then the question the dialog it landed in asks.
 *
 * One function because three exits now park — a refused proposal, a failed
 * loop check, and a throw inside the verify completion — and a designer who
 * sees the same situation described two ways has to work out whether they are
 * the same situation.
 */
export function parkedReason(message: string): string {
  return `${endSentence(message)} Choose how to apply it.`
}

/**
 * How long the client waits for the chat hand-off to answer before treating
 * it as unanswered.
 *
 * The await holds the bridge's draft: the page is showing a change that has
 * reached no file, and the designer cannot resolve it while it is held. The
 * loop check that runs just before this has a 15 s bound for exactly that
 * reason. 30 s because a hand-off POST is a chat submission and the chat's own
 * first response can be slower than a source lookup.
 */
export const HANDOFF_TIMEOUT_MS = 30_000

/** What a hand-off attempt settled as. */
export type HandOffOutcome = "accepted" | "refused" | "timed-out"

/**
 * Run a chat hand-off and settle within {@link HANDOFF_TIMEOUT_MS}, whatever
 * the transport does.
 *
 * A throw is a refusal, not a failure of whatever called this: the hand-off
 * POST failing says nothing about the check that preceded it.
 *
 * The race IS the guard the caller needs against a late answer. Once this
 * returns "timed-out" the caller parks the draft, and the attempt's eventual
 * `true` resolves into a promise nobody is holding, so no code path can
 * release a draft that has already been parked.
 */
export async function settleHandOff(
  run: () => Promise<boolean>,
  timeoutMs: number = HANDOFF_TIMEOUT_MS,
): Promise<HandOffOutcome> {
  const attempt: Promise<HandOffOutcome> = (async () => {
    try {
      return (await run()) ? "accepted" : "refused"
    } catch {
      return "refused"
    }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<HandOffOutcome>((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), timeoutMs)
  })
  try {
    return await Promise.race([attempt, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The two statuses a hand-off that did not land shows: one for the edit parked
 * in the deterministic dialog, one for the case where there was nothing to
 * park.
 *
 * A timeout and a refusal are different facts and a designer can act on the
 * difference, so they do not share a sentence: a refused hand-off will refuse
 * again, an unanswered one may just be slow.
 */
export function handOffFailureStatus(
  outcome: "refused" | "timed-out",
): { parked: string; released: string } {
  if (outcome === "timed-out") {
    return {
      parked: "Chat did not answer in time. Choose how to apply the pending edit.",
      released: "Chat did not answer in time, and this edit needs a decision.",
    }
  }
  return {
    parked: parkedReason("This edit could not be sent to chat"),
    released: "This edit needs a decision and could not be sent to chat.",
  }
}

/**
 * Which of the three routes an edit on this element takes.
 *
 * - `refuse`: the page sent loop information that failed the boundary check.
 *   Nothing is dispatched. The alternative, treating it as "not a loop",
 *   rewrites the SHARED template, and for a delete that removes every row.
 * - `iteration`: a valid loop context, so the "this item or all items"
 *   question applies.
 * - `plain`: no loop context at all, i.e. the ordinary edit path.
 *
 * Pure and tiny on purpose. The five entry points that consult it live inside
 * a 4700-line hook with no test harness, so the decision they share is tested
 * here instead.
 */
export type IterationRouteTarget = {
  iterationContext?: IterationContext
  iterationContextMalformed?: boolean
}

export function iterationRouteFor(
  target: IterationRouteTarget | null | undefined,
): "refuse" | "iteration" | "plain" {
  if (!target) return "plain"
  if (target.iterationContextMalformed) return "refuse"
  return target.iterationContext ? "iteration" : "plain"
}

/**
 * The same route for an edit that has a DESTINATION as well as a target: a
 * Layers move (source + destination parent) or a Layers insert (destination
 * parent only).
 *
 * Two rules, and only two:
 *
 * - Malformed loop information on EITHER end refuses. It used to be checked on
 *   the source only, so a move INTO a destination the page could not describe
 *   went through, and an insert checked nothing at all. Dropping a row into a
 *   loop we cannot read writes the shared template, which is every row.
 * - A destination with a VALID loop context changes nothing. Inserting into a
 *   `v-for` element adds to the shared template on purpose, and that is
 *   today's behaviour; the "this item or all items" question belongs to the
 *   element being edited, not to where it lands.
 *
 * So the returned route is the NODE's, and the destination can only veto it.
 * An insert (no node) is therefore `plain` or `refuse`, never `iteration`.
 */
export function structuralRouteFor(args: {
  node?: IterationRouteTarget | null
  destParent?: IterationRouteTarget | null
}): "refuse" | "iteration" | "plain" {
  if (args.destParent?.iterationContextMalformed) return "refuse"
  return iterationRouteFor(args.node)
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

/**
 * The position the "this item" lane dispatches against: the verified loop's
 * own, when the verify found one, and otherwise the clicked element's.
 *
 * A one-line decision, but it is the whole of H4 and the failure it fixes is
 * silent (a refusal from the data resolver, then an LLM fallback with no
 * iteratee root), so it is a named function with a test rather than an
 * expression inside a 100-line callback.
 */
export function thisRowTemplateLocation(pending: PendingIterationEdit): SourceLocation | undefined {
  return pending.loopLocation ?? iterationTemplateLocation(pending)
}

/**
 * Did the designer click something INSIDE a loop row rather than the row
 * itself?
 *
 * True only when the verify found a loop AND that loop is somewhere other than
 * the clicked element: a `<span>` inside an `<li v-for>`, say. False when the
 * click landed on the loop element, and false when no verify position is
 * carried at all, which is the pre-`loopLocation` behaviour.
 */
export function clickedInsideRow(pending: PendingIterationEdit): boolean {
  const loop = pending.loopLocation
  if (!loop) return false
  const element = iterationTemplateLocation(pending)
  if (!element) return false
  return (
    loop.file !== element.file || loop.line !== element.line || loop.column !== element.column
  )
}

/**
 * May the "this item" lane run its DETERMINISTIC row operation for this
 * pending edit, or does the edit have to go to chat instead?
 *
 * The row lane speaks in whole entries of the data array. `patch` and
 * `patch-text` name a field of the entry, so redirecting them to the loop root
 * is exactly right: the field is found from the clicked element's own position
 * and the entry from the loop's.
 *
 * `remove` and `reorder` name no field. They remove the entry, or move the
 * entry to an index. Dispatched from an element nested inside the row, the
 * first deletes the whole item the designer clicked INSIDE, and the second
 * applies a `destIndex` counted among the element's own siblings as an index
 * into the rows array. Both are silent, and both are a different edit from the
 * one that was asked for, so this returns false and the caller hands off.
 *
 * A click on the loop element itself is unaffected: there, removing the entry
 * IS deleting what was clicked.
 */
export function thisRowOperationAllowed(pending: PendingIterationEdit): boolean {
  if (pending.editKind !== "delete" && pending.editKind !== "move") return true
  return !clickedInsideRow(pending)
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

/**
 * The half of the request the element cannot express. Only `move` has one:
 * "move the element" alone leaves the agent unable to reconstruct the drop,
 * because the destination parent and the child index live on the payload.
 * The other kinds put everything into `requestedOf`.
 */
function detailOf(pending: PendingIterationEdit): string | undefined {
  if (pending.editKind !== "move") return undefined
  return describeMoveDestination(pending.payload.destParent.editTarget, pending.payload.destIndex)
}

/** Everything `buildAmbiguousIterationHandoffPrompt` needs, read off the pending edit. */
export function describeAmbiguousIteration(
  pending: PendingIterationEdit,
  location: SourceLocation,
  noLoopReason: string,
): AmbiguousIterationHandoff {
  const detail = detailOf(pending)
  return {
    requested: requestedOf(pending),
    ...(detail ? { detail } : {}),
    ...namesOf(pending),
    selector: selectorOf(pending),
    location: { file: location.file, line: location.line, column: location.column },
    // Coerced here as well as at the wire boundary and in the builder. This
    // is the point where two page-supplied numbers become part of a message
    // to an agent, and each of the three gates is cheap.
    index: safeCount(pending.iterationContext.index),
    siblingCount: safeCount(pending.iterationContext.siblingCount),
    noLoopReason,
  }
}

/**
 * The verb phrase for an edit the "this item" lane refused because the click
 * landed inside the row rather than on it. Only the two kinds
 * {@link thisRowOperationAllowed} can refuse have one.
 *
 * It says "this element" AND "this item" on purpose: the whole reason the edit
 * is here is that those are two different things, and a request that named
 * only one of them would read as the edit the row lane would have made.
 */
function requestedRowScopedOf(pending: PendingIterationEdit): string {
  return pending.editKind === "move"
    ? "move this element within this item only"
    : "delete this element in this item only"
}

/** Everything {@link buildRowScopedEditHandoffPrompt} needs, read off the pending edit. */
export function describeRowScopedEdit(
  pending: PendingIterationEdit,
  loopLocation: SourceLocation,
  elementLocation: SourceLocation,
): RowScopedEditHandoff {
  const detail = detailOf(pending)
  return {
    requested: requestedRowScopedOf(pending),
    ...(detail ? { detail } : {}),
    ...namesOf(pending),
    selector: selectorOf(pending),
    loopLocation: {
      file: loopLocation.file,
      line: loopLocation.line,
      column: loopLocation.column,
    },
    elementLocation: {
      file: elementLocation.file,
      line: elementLocation.line,
      column: elementLocation.column,
    },
    // Coerced here as well as at the wire boundary and in the builder, for the
    // reason `describeAmbiguousIteration` gives.
    index: safeCount(pending.iterationContext.index),
    siblingCount: safeCount(pending.iterationContext.siblingCount),
  }
}

/**
 * The bridge draft this pending edit is holding, when it is holding one.
 *
 * Only an in-page typing session has one: the designer typed into the DOM, the
 * bridge captured a draft mutation and is waiting to be told what to do with
 * it. Every other pending edit came from the inspector or the Layers panel and
 * the bridge holds nothing.
 */
export function bridgeDraftIdOf(pending: PendingIterationEdit): string | undefined {
  return pending.editKind === "dom-text" ? pending.bridgePendingId : undefined
}

/**
 * The TARGET a verify belongs to. Staleness is decided within one of these,
 * never across them.
 *
 * The sequence used to be one counter for the whole hook, so any second edit
 * made the first one's answer "stale" — and a stale answer releases its own
 * bridge draft and says "A newer edit replaced this one." Nothing had replaced
 * it. Two different elements can be edited in either order, and the loop check
 * for one says nothing about the other.
 *
 * The bridge draft id is the key when there is one: an in-page typing session
 * rebuilds the pending object on every keystroke and keeps that id, which is
 * exactly the run of verifies that DO supersede each other. Everything else
 * keys on the element's selector, which is what identifies the target for an
 * inspector or Layers edit.
 */
export function verifyKeyFor(pending: PendingIterationEdit): string {
  return bridgeDraftIdOf(pending) ?? selectorOf(pending)
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
  /**
   * `loopLocation` is where the verify found the loop, when that is not the
   * clicked position. The caller stores it on the pending edit so the "this
   * item" dispatch aims at the loop element rather than at whatever was
   * nested inside the row.
   */
  | { kind: "remembered"; scope: IterationScope; loopLocation?: SourceLocation }
  | { kind: "prompt"; loopLocation?: SourceLocation }

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
  // The loop's own position, when the server reported one that differs from
  // the click. The file is the file that was verified; only line and column
  // move.
  const found = outcome.kind === "loop" ? outcome.location : undefined
  const loopLocation: SourceLocation | undefined = found
    ? { ...location, line: found.line, column: found.column }
    : undefined
  if (remembered) {
    return { kind: "remembered", scope: remembered, ...(loopLocation ? { loopLocation } : {}) }
  }
  return { kind: "prompt", ...(loopLocation ? { loopLocation } : {}) }
}
