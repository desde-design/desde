/**
 * The edit that is waiting on an iteration-scope decision, and two pure
 * readers over it. Moved out of `useEditorEditing.ts` so the decision logic
 * around the "this item or all items" prompt can be unit-tested without
 * mounting the hook.
 */
import type {
  IterationContext,
  PendingMutation,
  Selection,
  SourceLocation,
} from "@/editor/core"
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
 * EXACTLY, and got "No v-for element at ..." back.
 *
 * Absent only when the verify never ran, i.e. on an edit that never took the
 * iteration route. A `loop` verdict always carries a position now, so an edit
 * that verified as a loop always has this set.
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
 * A thrown value as a sentence.
 *
 * `(err as Error).message` is a cast, not a check. A rejected fetch, a thrown
 * string, a rejected `null`: none of them has a `.message`, and the iteration
 * lane's two catch blocks rendered "undefined" into the status bar for each of
 * them, which tells the designer nothing about what went wrong.
 *
 * The `message` of a real Error, `String(...)` of anything else, and a named
 * fallback for the values whose string form is empty or absent.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === "string" && err) return err
  try {
    const asString = String(err)
    return asString === "" ? "unknown error" : asString
  } catch {
    // A thrown object with a hostile `toString`. Nothing to report but the
    // fact that something was thrown.
    return "unknown error"
  }
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

/** Options for {@link settleHandOff}. */
export interface SettleHandOffOptions {
  /** Override the {@link HANDOFF_TIMEOUT_MS} deadline (tests, mostly). */
  timeoutMs?: number
  /**
   * The caller's own lifetime, when it has one.
   *
   * The iteration lane's hand-offs belong to one bridge session: the draft
   * being held, the page showing it, and the adapter that would receive the
   * release all go away together. When they do, this signal aborts, the POST
   * is cancelled, and the attempt settles as a refusal without waiting out the
   * deadline. An already-aborted signal means `run` is never called at all, so
   * a torn-down surface cannot start a chat turn on its way out.
   */
  signal?: AbortSignal
}

/**
 * Run a chat hand-off and settle within {@link HANDOFF_TIMEOUT_MS}, whatever
 * the transport does.
 *
 * A throw is a refusal, not a failure of whatever called this: the hand-off
 * POST failing says nothing about the check that preceded it.
 *
 * The race is not enough on its own. Dropping the loser's resolution stops a
 * late `true` from releasing a parked draft, but it does not stop the POST:
 * the request keeps running, the server can answer `accepted` after the
 * timeout, and the agent then edits the same element the designer is at that
 * moment choosing a deterministic scope for. Two writes, from two lanes, for
 * one click.
 *
 * So the timeout ABORTS as well as settling. `run` receives the signal and is
 * expected to pass it to the transport; the client's fetch is aborted, the
 * server sees the stream close, and the turn winds down (`chat-handler.ts`
 * pipes `stream.aborted` into the runtime's abort controller, both before and
 * after it emits `accepted`).
 *
 * `options.signal` is the same argument for a different clock: a hand-off
 * whose bridge session ended must stop for the same reason a slow one must,
 * and a turn accepted after the adapter is gone edits a file for a page that
 * nobody is looking at any more.
 */
export async function settleHandOff(
  run: (signal: AbortSignal) => Promise<boolean>,
  options: SettleHandOffOptions = {},
): Promise<HandOffOutcome> {
  const { timeoutMs = HANDOFF_TIMEOUT_MS, signal } = options
  const controller = new AbortController()
  // Nothing to send: the session this hand-off belongs to is already over, so
  // starting the POST would submit a turn about a page that is gone.
  if (signal?.aborted) return "refused"
  const attempt: Promise<HandOffOutcome> = (async () => {
    try {
      return (await run(controller.signal)) ? "accepted" : "refused"
    } catch {
      return "refused"
    }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<HandOffOutcome>((resolve) => {
    timer = setTimeout(() => {
      // Abort BEFORE resolving, so the caller's park and the transport's
      // cancellation are not separated by a turn of the event loop.
      controller.abort()
      resolve("timed-out")
    }, timeoutMs)
  })
  // A refusal, because nothing was accepted. The caller that was awaiting this
  // is superseded either way and does not act on the value; what matters is
  // that the submission is cancelled rather than left running.
  let onAbort: (() => void) | undefined
  const cancelled: Promise<HandOffOutcome> | null = signal
    ? new Promise<HandOffOutcome>((resolve) => {
        onAbort = () => {
          controller.abort()
          resolve("refused")
        }
        signal.addEventListener("abort", onAbort, { once: true })
      })
    : null
  try {
    return await Promise.race(
      cancelled ? [attempt, timeout, cancelled] : [attempt, timeout],
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener("abort", onAbort)
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
 * The Save lane's version of the same fact.
 *
 * Save has no dialog to park an edit in: the mutations are still in the buffer
 * and the save simply did not happen, so the sentence says that instead of
 * asking a question. It is a constant rather than a literal in the hook so the
 * copy rules (no em dash, no "me"/"my") are testable and so the save dialog's
 * failure test asserts the string the hook actually sets.
 */
export const SAVE_HANDOFF_TIMEOUT_STATUS =
  "Chat did not answer in time. Nothing was discarded; try again when the chat is free."

/**
 * What Save says when the page was replaced while it was running.
 *
 * A save is several requests, and the document can go away between any two of
 * them. Anything after that point would resolve a stylesheet against the new
 * page, write the departed page's mutations, clear the new page's previews, or
 * reload it. So the save stops where it is and says so.
 *
 * "Nothing further" is the honest wording: whatever had already been written
 * before the page changed is written, and the buffer still holds the rest, so
 * a second Save on the page that is there now picks it up.
 */
export const SAVE_PAGE_CHANGED_STATUS =
  "The page changed during the save. Nothing further was applied."

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
 * click landed on the loop element.
 *
 * It is also false when a position is missing, which is NOT a claim that the
 * click was on the loop element. This function only ever answers "yes, it is
 * nested"; a missing position fails closed one layer up, in
 * {@link thisRowOperationAllowed}, which requires both positions to be present
 * before it will let a row operation run.
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
 *
 * It fails CLOSED. "Not nested" has to be POSITIVELY established: both
 * positions present, and equal. Reading a missing position as "not nested" is
 * the same mistake the verify used to make one layer up, and it produces the
 * worst outcome of the three (the whole item removed, or the rows reordered by
 * an index counted among a nested element's siblings) from the least
 * information. A hand-off asks the agent instead, which is answerable.
 */
export function thisRowOperationAllowed(pending: PendingIterationEdit): boolean {
  if (pending.editKind !== "delete" && pending.editKind !== "move") return true
  const loop = pending.loopLocation
  if (!loop) return false
  if (!iterationTemplateLocation(pending)) return false
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
 * The status shown to an edit that arrived while a scope question was already
 * on screen and had nothing to park.
 *
 * It names the thing to do first and the thing to do after, because the edit
 * really is gone: there is no draft anywhere holding it, and a designer who is
 * not told to repeat it will assume it landed.
 */
export const PROMPT_BUSY_STATUS = "Answer the open dialog first, then repeat this edit."

/** What to do when a verified edit arrives and a scope prompt is already open. */
export type PromptCollision =
  /** No prompt open, or the same in-page typing session: today's behaviour. */
  | "open-incoming"
  /** Keep the open one; the newcomer's typed text goes to the mutation dialog. */
  | "keep-open-park-incoming"
  /** Keep the open one; the newcomer has nothing to hold, so say so and drop it. */
  | "keep-open-drop-incoming"

/**
 * Which of the two edits survives when both verify.
 *
 * The prompt is per HOOK; the verify sequence is per TARGET. So two edits on
 * two different elements can both pass their loop check, and the second one
 * used to be written straight over the first: the previous pending's bridge
 * draft was cancelled (an in-page typing session lost its text with nothing
 * written anywhere), and a delete or a move with no draft simply vanished with
 * no status at all.
 *
 * The open prompt therefore always wins. It is the one the designer is looking
 * at and the only one they can answer; replacing it also moves the question
 * under their cursor between the reading and the click.
 *
 * The NEWCOMER is not thrown away either, when there is anything to keep. A
 * bridge draft is parked in the mutation-disambiguation dialog, which asks a
 * blunter question ("this instance" or "all instances") but keeps the text.
 * Everything else has nothing to park, so it is dropped with a status saying
 * to repeat it.
 *
 * The same-draft case is unchanged: an in-page typing session rebuilds its
 * pending object on every keystroke, so "previous" and "incoming" there are
 * two objects describing one edit, and the newer one has the newer text.
 */
export function promptCollision(
  previous: PendingIterationEdit | null | undefined,
  incoming: PendingIterationEdit,
): PromptCollision {
  if (!previous || previous === incoming || sameBridgeDraft(previous, incoming)) {
    return "open-incoming"
  }
  return bridgeDraftIdOf(incoming) ? "keep-open-park-incoming" : "keep-open-drop-incoming"
}

/**
 * A dialog the hook owes the designer, as a value.
 *
 * The Editor has two of them and they ask about the same edit from opposite
 * ends: the SCOPE dialog asks "this item or all items?" for an edit the
 * iteration lane is still holding, and the DISAMBIGUATION dialog asks "this
 * instance or all instances?" for a draft the bridge is holding. Either can be
 * raised while the other is open, from four independent places (a verify
 * completing, a lane failure, a refused hand-off, the bridge delivering a
 * fresh ambiguous mutation), so neither could see the other and the two
 * stacked in whichever order they happened to arrive.
 *
 * Making the request a value is what lets ONE owner exist: an opener no longer
 * opens anything, it hands its request over and is told whether it opened now
 * or is waiting.
 */
export type ModalRequest =
  /** The scope prompt, for an edit the iteration lane verified. */
  | { kind: "scope"; pending: PendingIterationEdit }
  /**
   * The deterministic mutation dialog, for a draft the bridge is holding.
   *
   * `reason` is the status line a park shows when it finally opens. It is
   * absent for the bridge's ordinary route, because that one is not a park:
   * nothing failed and there is nothing to explain.
   */
  | { kind: "disambiguation"; mutation: PendingMutation; reason?: string }

/** Which of the two dialogs a request is for, and which one currently owns. */
export type ModalKind = ModalRequest["kind"]

/**
 * Which bridge draft a request is about, or undefined when it is about none.
 *
 * The two kinds name the same thing two ways: the bridge's `pendingId` IS the
 * iteration edit's `bridgePendingId`. Reducing both to one key is what lets the
 * queue hold one entry per draft no matter which dialog asked for it, so an
 * edit whose scope question is still queued when its lane gives up ends as one
 * request rather than as two dialogs about one draft.
 */
export function modalRequestDraftId(request: ModalRequest): string | undefined {
  return request.kind === "disambiguation"
    ? request.mutation.pendingId
    : bridgeDraftIdOf(request.pending)
}

/**
 * Add a request to the queue, or replace the entry already in it for the same
 * in-page typing session.
 *
 * Replacing matters because the designer can keep typing on the held element:
 * every keystroke round trip rebuilds the pending object and re-collides, and
 * the queue must end up holding the LATEST text rather than the first
 * keystroke's plus a stack of duplicates. `sameBridgeDraft` is the same test
 * that decides it everywhere else.
 *
 * The match is on the DRAFT, not on the kind, so a park and a scope question
 * about one draft collapse to one entry, latest wins.
 */
function queueModalRequest(
  queue: readonly ModalRequest[],
  request: ModalRequest,
): ModalRequest[] {
  const draftId = modalRequestDraftId(request)
  const at = queue.findIndex(
    (existing) =>
      (existing.kind === "scope" &&
        request.kind === "scope" &&
        (existing.pending === request.pending ||
          sameBridgeDraft(existing.pending, request.pending))) ||
      (draftId !== undefined && modalRequestDraftId(existing) === draftId),
  )
  if (at === -1) return [...queue, request]
  const next = queue.slice()
  next[at] = request
  return next
}

/** Open it now, or hold it behind whatever is already on screen. */
export type ModalDecision = { open: ModalRequest } | { deferred: ModalRequest[] }

/**
 * THE rule for raising either dialog. Pure, so the one-modal invariant can be
 * read in six lines instead of inferred from four call sites.
 *
 * Nothing opens while anything is open, in EITHER direction. The exclusion used
 * to be one-way and informal: a park asked whether a scope prompt was open, and
 * a completed verify asked whether another scope prompt was open. Neither asked
 * about the mutation dialog, so a park that had opened that dialog was
 * invisible to the verify which then opened the scope prompt on top of it.
 *
 * A non-empty queue with no owner cannot happen, because the release opens the
 * head. It is treated as owned anyway: opening past a queue would put the
 * newcomer in front of edits that have been waiting longer.
 */
export function enqueueModal(
  queue: readonly ModalRequest[],
  request: ModalRequest,
  currentOwner: ModalKind | null,
): ModalDecision {
  if (currentOwner === null && queue.length === 0) return { open: request }
  return { deferred: queueModalRequest(queue, request) }
}

/**
 * Take the next request off the queue when the open dialog closes. FIFO: the
 * edit that has been waiting longest is asked about first.
 */
export function dequeueModal(queue: readonly ModalRequest[]): {
  next: ModalRequest | null
  queue: ModalRequest[]
} {
  const [next, ...rest] = queue
  if (!next) return { next: null, queue: [] }
  return { next, queue: rest }
}

/**
 * Forget every queued request about a draft that has just been given back to
 * the bridge.
 *
 * A queued request holds a payload, not a promise that the payload still
 * exists: a late completion can cancel the draft while its question waits. The
 * dialog would then open on a draft the bridge no longer holds, and answering
 * it would resolve nothing. So the release drops the request too.
 */
export function dropModalRequestsForDraft(
  queue: readonly ModalRequest[],
  draftId: string | undefined,
): ModalRequest[] {
  if (!draftId) return [...queue]
  return queue.filter((request) => modalRequestDraftId(request) !== draftId)
}

/**
 * The rows on screen in the deterministic dialog whose draft the bridge is
 * still holding, and which therefore have to be handed back when the adapter
 * that would answer them goes away.
 *
 * Every row reaches that dialog from the bridge, so in practice this is all of
 * them. It is a named selector rather than the array itself because the rule is
 * "a row the bridge is holding", not "a row": a row that ever arrives from
 * somewhere else must not be cancelled against an adapter that never saw it.
 */
export function rowsToRelease(
  rows: readonly PendingMutation[],
): PendingMutation[] {
  return rows.filter((row) => Boolean(row.pendingId))
}

/**
 * What Save says when the designer answers a dialog whose adapter has gone.
 *
 * The dialog's answer is a message to the bridge, and there is no bridge to
 * send it to. The row STAYS: removing it would drop the edit on the floor while
 * telling the designer they had chosen something.
 */
export const NOT_CONNECTED_STATUS = "The page is not connected. Reload and try again."

/**
 * What the status bar says when the adapter went away and took held edits with
 * it, or null when it took none.
 *
 * Counted rather than vague, because "some edits" leaves the designer checking
 * the page for something that is not there. Null at zero: a re-attach with
 * nothing held is not an event, and reporting it would put a scary sentence on
 * screen for a page that lost nothing.
 */
export function discardedOnResetStatus(count: number): string | null {
  if (count <= 0) return null
  const edits = count === 1 ? "1 pending edit was" : `${count} pending edits were`
  return `The page connection was reset; ${edits} discarded.`
}

/**
 * Is there work the designer has not dispatched, that reloading the page would
 * throw away without saying so?
 *
 * Three counts, and the third is the one that was missing: a queued modal
 * request is an edit the bridge is still holding while it waits for a dialog to
 * close. It is exactly as unsaved as the other two, and it is INVISIBLE,
 * because nothing has opened a dialog for it yet. A pure function so the unload
 * warning's rule can be read and tested in one place rather than inferred from
 * a boolean expression inside a listener.
 */
export function hasUndispatchedWork(counts: {
  /** Mutations queued for the AI lane, which only Save dispatches. */
  aiQueue: number
  /** Edits parked in the deterministic disambiguation dialog. */
  parked: number
  /** Requests waiting behind the dialog that is open ({@link enqueueModal}). */
  deferred: number
}): boolean {
  return counts.aiQueue > 0 || counts.parked > 0 || counts.deferred > 0
}

/**
 * The status shown to a newcomer whose dialog is waiting behind the open one.
 *
 * Either dialog: a park held back, and a scope question raised while the
 * deterministic dialog is up. It has to say the edit is KEPT, unlike
 * {@link PROMPT_BUSY_STATUS}, which tells the designer to repeat an edit that
 * really is gone. Nothing is lost here: the text is still in the bridge's draft
 * and the question about it opens as soon as the current one is answered.
 */
export const DEFERRED_PARK_STATUS =
  "This edit is held behind the open question. Answer it and this one is next."

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
 * Does this continuation belong to a bridge session that has ended?
 *
 * The sibling of {@link isStaleVerify}, one level up. That one asks whether a
 * NEWER edit replaced this one inside the same session; this one asks whether
 * the session itself is over: the adapter was torn down and re-attached, or
 * the page was reloaded out from under the edit.
 *
 * It matters because the bridge restarts its draft ids from `dom-pending-1` on
 * every reconnect. A continuation that resumes across that boundary is holding
 * an id that now names SOMEONE ELSE'S draft, so applying its edit writes an
 * overwrite computed for a page that is gone, and releasing "its" draft
 * cancels the live one the designer can still see. Teardown has already handed
 * every held draft back, so the right answer at a stale generation is to do
 * nothing at all: no apply, no release, no park, no status.
 */
export function isStaleGeneration(captured: number, current: number): boolean {
  return captured !== current
}

/**
 * May a dispatch that has just finished delete its own in-flight marker?
 *
 * The marker sets (one key per selector+prop identity) are SHARED across bridge
 * sessions, and a dispatch can outlive the session it started in: the page
 * reloads, the adapter re-attaches, a new dispatch for the same key starts and
 * adds the same key. The old dispatch's `finally` then deletes a marker that
 * now belongs to the new one, and a second dispatch for that identity can run
 * concurrently with the first.
 *
 * So a marker may only be cleared by the dispatch that still owns it, i.e. one
 * whose session is the current one. The session end clears the whole set, so a
 * marker left behind here is not stranded.
 *
 * It is the negation of {@link isStaleGeneration} and it is still its own named
 * function: "is this answer stale" and "may I clear this marker" are different
 * questions, and the second one is the whole of the concurrency rule.
 */
export function mayClearInFlightMarker(captured: number, current: number): boolean {
  return !isStaleGeneration(captured, current)
}

/**
 * Does a completed bridge handshake end the session that was running?
 *
 * The document boundary is the HANDSHAKE, not the iframe's `load` event. Those
 * two are not the same moment, and the difference is a real defect: the bridge
 * announces itself as soon as its script runs, so a page whose images or fonts
 * finish afterwards fires `load` on a document the shell is already connected
 * to and has been editing. Ending the session there discarded a draft the live
 * bridge was still holding, with nothing left to cancel it.
 *
 * So `load` only TRIGGERS a handshake now, and this decides what the handshake
 * means:
 *
 * | `previousToken` | `nextToken` | Decision |
 * | --- | --- | --- |
 * | null (first handshake of an attachment) | anything | ends nothing |
 * | a document | the SAME document | ends nothing: the page answered again |
 * | a document | a DIFFERENT document | ends the session: a new page is here |
 *
 * `nextToken` is the bridge's own per-document id. A bridge older than
 * 2026-09-09a reports none and arrives here as `null`, and the shell used to
 * mint a fresh token per handshake for that case — which read EVERY handshake
 * after the first as a new document, so a page that simply answered twice had
 * the designer's pending edits discarded.
 *
 * `loadSinceLast` is the honest answer for a bridge that cannot say who it is:
 * did the iframe fire a `load` event since the previous completed handshake?
 * A document cannot be replaced without one, so no load means the same
 * document, and a load means a new one may be here and the conservative call
 * is to end the session. `previousToken` for such a bridge is
 * {@link UNIDENTIFIED_DOCUMENT}: it is not null, so the shell can still tell
 * "a handshake completed" from "none has yet".
 *
 * | `previousToken` | `nextToken` | `loadSinceLast` | Decision |
 * | --- | --- | --- | --- |
 * | unidentified | null | false | ends nothing: the same page answered again |
 * | unidentified | null | true | ends the session: a page loaded in between |
 */
export function shouldEndSessionOnHandshake(
  previousToken: string | null,
  nextToken: string | null,
  loadSinceLast: boolean,
): boolean {
  // No handshake has completed in this attachment yet, so there is no session
  // about a document for this one to end.
  if (previousToken === null) return false
  // Both sides name their document: the ids decide, and nothing else can.
  if (nextToken !== null) return previousToken !== nextToken
  // A bridge that reports no id. The iframe's `load` event is the only
  // evidence left that the document underneath changed.
  return loadSinceLast
}

/**
 * The token stored for a completed handshake whose bridge reported no document
 * id (a bridge older than 2026-09-09a).
 *
 * It exists so `previousToken` can distinguish "a handshake completed, and the
 * bridge would not say which document" from "no handshake has completed yet",
 * which is the difference between consulting `loadSinceLast` and ending
 * nothing. It never has to be unique per document, because it is never
 * compared for equality against another document's id: the no-id branch of
 * {@link shouldEndSessionOnHandshake} is decided by the load event instead.
 */
export const UNIDENTIFIED_DOCUMENT = "unidentified-document"

/**
 * Did a handshake fail because a newer one replaced it?
 *
 * The adapter rejects the outstanding handshake with "superseded" when the
 * shell starts another one, which is not a failure at all: the newer handshake
 * is still running and will decide the document boundary itself. Every OTHER
 * rejection is a real one. The page never answered (it is off-origin, it 500'd,
 * or the five-second timeout ran out), so there is no document behind the
 * session the shell is still holding, and the session has to end there or the
 * generation never moves and none of the staleness guards engage.
 *
 * A string test, because that is what the adapter gives: the rejection is an
 * `Error` and the reason is in its message.
 */
export function isSupersededHandshake(message: string): boolean {
  return message.includes("superseded")
}

/**
 * Everything a bridge session is holding when it ends, as plain values.
 *
 * The three places a session ends (the adapter effect's cleanup, the iframe's
 * `load` handler, the conflict reload) used to clear different subsets of this
 * in different orders, so they discarded different amounts of the same state.
 */
export interface SessionEndState {
  /** The scope question on screen, if one is open. */
  openPrompt: PendingIterationEdit | null
  /** Questions waiting behind whatever is open ({@link enqueueModal}). */
  queued: readonly ModalRequest[]
  /** Rows in the deterministic disambiguation dialog. */
  rows: readonly PendingMutation[]
  /** Draft ids still recorded in the lane's maps, i.e. work in flight. */
  heldDraftIds: readonly string[]
  /**
   * How many buffered entries the departed document left behind, from
   * {@link retireForeignEntries}: the pending prop edits and the captured
   * mutations that were waiting for their debounce when the page went away.
   *
   * Required, not defaulted. It is a separate count from everything else here
   * and the only caller that can measure it is the one ending the session; a
   * default of zero would let a caller under-report a discard silently, which
   * is the failure this whole function exists to stop.
   *
   * Only counted for a reason that actually retires them
   * ({@link retiresBufferedEntries}). A caller that measures a count on a
   * `teardown` cannot report a discard that did not happen.
   */
  retiredBuffered: number
  /** Why the session is ending. See {@link retiresBufferedEntries}. */
  reason: BridgeSessionEndReason
}

/**
 * Why a bridge session ended.
 *
 * `cancelWithBridge` used to be the only thing the call sites disagreed about,
 * and it was passed as a bare boolean. The reason is what actually happened,
 * and two decisions now read it: whether the status line is worth setting, and
 * whether the edit buffers are retired.
 *
 * The four are not four behaviours. `unmount` is `teardown` with nobody left to
 * read the status bar, and `reload` is `reconnect` seen one step earlier: the
 * shell knows the document is about to be replaced rather than finding out from
 * the `load` event.
 */
export type BridgeSessionEndReason =
  /** The adapter is detaching and the panels stay on screen. */
  | "teardown"
  /** The adapter is detaching because the hook is unmounting. */
  | "unmount"
  /** The shell is about to replace the document (the conflict reload). */
  | "reload"
  /** The iframe has just loaded a different document. */
  | "reconnect"

/**
 * Does ending the session for this reason retire the edit buffers?
 *
 * Retirement is for a DOCUMENT CHANGE, and only two reasons are one: `reload`
 * (the shell is about to replace the document) and `reconnect` (the iframe
 * already did, including the handshake that never answered). An entry captured
 * against the departed page cannot be written into the page that replaced it,
 * so it is discarded and counted.
 *
 * The other two are not document changes:
 *
 * - `teardown` detaches the adapter and leaves the same document on screen with
 *   its previews still showing. An `enabled: true → false → true` flip would
 *   otherwise throw the designer's buffered edits away for a page that never
 *   went anywhere.
 * - `unmount` needs nothing done: React drops the buffers with the hook, and
 *   there is no status bar left to say what was discarded.
 *
 * Everything else a session end clears (the open prompt, the queued questions,
 * the dialog rows, the held drafts, the in-flight markers and the debounce
 * timers) is cleared for EVERY reason, because all of it is bound to the
 * adapter rather than to the document.
 */
export function retiresBufferedEntries(reason: BridgeSessionEndReason): boolean {
  return reason === "reload" || reason === "reconnect"
}

/** What ending a bridge session has to do, decided from {@link SessionEndState}. */
export interface SessionEndPlan {
  /**
   * Every draft this session was holding, once each, in the order the teardown
   * used to hand them back. Handed to the bridge only when the document that
   * issued them is still the one on screen.
   */
  cancelDraftIds: string[]
  /** How many held edits the session end throws away. */
  discarded: number
  /** The line to show for that count, or null when nothing was held. */
  status: string | null
}

/**
 * The ONE decision behind ending a bridge session.
 *
 * Pure, because the count it produces is the only thing the designer sees and
 * it was previously computed by three different code paths: the teardown
 * counted the prompt, the queue, the dialog rows and the maps; the conflict
 * reload counted nothing and said nothing; the `load` handler did not exist.
 *
 * Counting rules, unchanged from the teardown that had them first:
 *
 * - The open prompt counts as one whether or not it holds a bridge draft. An
 *   inspector or Layers edit parked in that dialog is just as lost.
 * - A queued request counts as one, for the same reason.
 * - A dialog row counts only when the bridge is holding its draft
 *   ({@link rowsToRelease}).
 * - A held draft counts only if nothing above already claimed it. The prompt
 *   and the queue own their drafts, and cancelling one twice would both
 *   double-count it and send the bridge a message about an id it has already
 *   dropped.
 * - Every buffered entry the departed document left behind counts, and none of
 *   them holds a bridge draft, so there is nothing to cancel for them. See
 *   {@link retireForeignEntries} for what "left behind" means, and
 *   {@link retiresBufferedEntries} for the reasons that leave them alone
 *   entirely (a `teardown` keeps the document, so it keeps the buffers).
 *
 * Releasing the prompt's draft also drops any queued question about that same
 * draft, which is what {@link dropModalRequestsForDraft} does at the call site
 * that releases it; doing it here keeps the count honest.
 */
export function sessionEndPlan(state: SessionEndState): SessionEndPlan {
  const promptDraftId = state.openPrompt ? bridgeDraftIdOf(state.openPrompt) : undefined
  const queued = promptDraftId
    ? dropModalRequestsForDraft(state.queued, promptDraftId)
    : [...state.queued]
  const rows = rowsToRelease(state.rows)
  const cancelDraftIds: string[] = []
  const claimed = new Set<string>()
  const claim = (draftId: string | undefined): boolean => {
    if (!draftId || claimed.has(draftId)) return false
    claimed.add(draftId)
    cancelDraftIds.push(draftId)
    return true
  }
  claim(promptDraftId)
  for (const request of queued) claim(modalRequestDraftId(request))
  for (const row of rows) claim(row.pendingId)
  // The reason has the last word on the buffered count. The caller only
  // measures one for a reason that retires, and this is the second lock on the
  // same door: a `teardown` cannot report edits as discarded when it left them
  // exactly where they were.
  const retiredBuffered = retiresBufferedEntries(state.reason)
    ? state.retiredBuffered
    : 0
  let discarded =
    (state.openPrompt ? 1 : 0) + queued.length + rows.length + retiredBuffered
  for (const draftId of state.heldDraftIds) {
    if (claim(draftId)) discarded += 1
  }
  return { cancelDraftIds, discarded, status: discardedOnResetStatus(discarded) }
}

/**
 * Split buffered entries into the ones the live session may still act on and
 * the ones the departed document left behind.
 *
 * The shell's two edit buffers (the pending prop edits, the captured DOM
 * mutations) outlive the document that filled them. A prop typed just before a
 * reload is still sitting in its buffer when the new page attaches; so is a
 * text or class capture whose debounce had not fired. Nothing in either entry
 * says which page it came from, so the next Save, the next AI-queue drain, or
 * the next debounce read the whole array and wrote the departed page's source
 * into the page the designer is looking at now, or failed stale-target trying.
 *
 * The rule is exact equality with the live generation, so an entry captured in
 * ANY other session is foreign, older or newer. An entry carrying no
 * generation at all is foreign too: every shell creation site tags its entry,
 * so an untagged one came from somewhere that cannot say which document it
 * describes, and applying it to this one is the hazard this exists to stop.
 *
 * Retiring is a discard, and the caller says so: the count goes to
 * {@link sessionEndPlan}, which puts it in the line the designer reads.
 */
export function retireForeignEntries<T extends { generation?: number }>(
  entries: readonly T[],
  currentGeneration: number,
): { kept: T[]; retired: T[] } {
  const kept: T[] = []
  const retired: T[] = []
  for (const entry of entries) {
    if (entry.generation === currentGeneration) kept.push(entry)
    else retired.push(entry)
  }
  return { kept, retired }
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
   * `loopLocation` is where the verify found the loop. The caller stores it on
   * the pending edit so the "this item" dispatch aims at the loop element
   * rather than at whatever was nested inside the row.
   *
   * REQUIRED on both, because the `loop` verdict it comes from now requires a
   * location. It was optional while a verdict could arrive with the position
   * dropped, and an absent position there was indistinguishable from "the
   * click IS the loop element" - which is the fact that decides whether a
   * remove takes the clicked element or the whole item.
   */
  | { kind: "remembered"; scope: IterationScope; loopLocation: SourceLocation }
  | { kind: "prompt"; loopLocation: SourceLocation }

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
  // The loop's own position. The file is the file that was verified; only line
  // and column move. Unconditional: `error` and `no-loop` have both returned
  // above, so the outcome is a `loop`, and that variant carries a location.
  const loopLocation: SourceLocation = {
    ...location,
    line: outcome.location.line,
    column: outcome.location.column,
  }
  if (remembered) return { kind: "remembered", scope: remembered, loopLocation }
  return { kind: "prompt", loopLocation }
}
