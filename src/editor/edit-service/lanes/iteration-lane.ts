/**
 * The iteration lane, as two functions over one bridge session.
 *
 * This was four hundred lines inside `useEditorEditing.ts`, and every await in
 * it was followed by a hand-written `gone()` built out of three refs: the
 * generation, the dispose flag, and the abort signal. The closure was rebuilt
 * at four call sites and the rule it encoded was re-derived at each one.
 *
 * It is `session.run` now. `ctx.step` will not hand back a value once the page
 * the work was for has gone, so the check is the only way to read an answer
 * rather than a line somebody has to remember to add. `ctx.signal` is the
 * session's own lifetime, so the verify, the hand-off and the proposal are all
 * cancelled by the same teardown that ends the session.
 *
 * The lane raises no dialog of its own. It asks the session, which owns the
 * one-modal rule, and everything else it needs from the shell arrives in
 * {@link IterationLaneDeps}.
 */
import type {
  ApplyEditOpts,
  DisambiguationChoice,
  EditResult,
  StructuralEdit,
} from "@/editor/core"
import type { LaneSession } from "@/editor/session/lane-session"
import type { ModalRequest } from "@/editor/session/modal-queue"
import type { IterationScope } from "@/components/editor/iteration-scope-dialog"
import type { IterationEditKind } from "@/editor/edit-service/iteration-fallback"
import type { verifyIterationLoop } from "@/editor/edit-service/iteration-verify"
import {
  logIterationScopeChoice,
  requestIterationProposal,
} from "@/editor/edit-service/iteration-fallback"
import {
  bridgeDraftIdOf,
  decideAfterVerify,
  DEFERRED_PARK_STATUS,
  describeRowScopedEdit,
  errorMessage,
  handOffFailureStatus,
  iterationTemplateLocation,
  parkedReason,
  promptCollision,
  PROMPT_BUSY_STATUS,
  settleHandOff,
  thisRowOperationAllowed,
  thisRowTemplateLocation,
  verifyKeyFor,
  type PendingIterationEdit,
} from "@/editor/edit-service/pending-iteration-edit"
import { isStaleVerify } from "@/editor/session/session-state"
import { buildRowScopedEditHandoffPrompt } from "@/editor/edit-service/build-edit-escalation-prompt"
import { makeEditId } from "@/editor/edit-service/make-edit-id"

/** The status this lane shows when the click carried no source position. */
const NO_SOURCE_LOCATION_STATUS =
  "This edit has no source location, so it cannot be applied."

/** The refusal both "no position" exits in the row lane show. */
const ROW_NO_SOURCE_LOCATION_STATUS =
  "Iteration edit refused: no source location on the selection."

/** A chat submission, as the shell offers it. */
type IterationHandOff = (
  prompt: string,
  options?: { signal?: AbortSignal },
) => Promise<boolean>

/**
 * What this lane is allowed to see of the bridge session.
 *
 * `LaneSession` plus the scope prompt's own surface: the per-target verify
 * sequence, the draft claims, and the one way a dialog is raised. Not the
 * class, so the lane cannot reach the buffers or end the session.
 */
type IterationLaneSession = LaneSession & {
  nextVerifySeq(key: string): number
  latestVerifySeq(key: string, fallback: number): number
  claimPending(draftId: string, pending: PendingIterationEdit): void
  latestPendingFor(draftId: string): PendingIterationEdit | undefined
  getSnapshot(): { scopePrompt: PendingIterationEdit | null }
  readonly modalOwner: "scope" | "disambiguation" | null
  requestModal(request: ModalRequest<PendingIterationEdit>): boolean
  setScopePrompt(prompt: PendingIterationEdit | null): void
}

export interface IterationLaneDeps {
  session: IterationLaneSession
  verify: typeof verifyIterationLoop
  /** Absent when the shell has no chat to hand an ambiguous edit to. */
  handOff?: IterationHandOff
  rememberedScope: (kind: IterationEditKind) => IterationScope | undefined
  releaseDraft: (pending: PendingIterationEdit) => void
  releaseDraftUnlessShared: (pending: PendingIterationEdit) => void
  parkOrDefer: (pending: PendingIterationEdit, reason: string) => boolean
  releaseOrPark: (pending: PendingIterationEdit, message: string) => void
  releaseOrParkUnlessShared: (pending: PendingIterationEdit, message: string) => void
  dispatch: (pending: PendingIterationEdit, scope: IterationScope) => Promise<void>
  setStatus: (message: string | null) => void
  logScopeChoice: typeof logIterationScopeChoice
}

/**
 * The adapter surface the dispatch reaches for.
 *
 * Spelled out rather than taken from `FrameworkAdapter`, because
 * `setElementText` is a member of the bridge adapter and not of the interface.
 * Structural, so the lane names no bridge class.
 */
interface IterationLaneAdapter {
  applyEdit(edit: StructuralEdit, opts?: ApplyEditOpts): Promise<EditResult>
  resolveMutationDisambiguation(
    pendingId: string,
    choice: DisambiguationChoice | "cancel",
  ): void
  setElementText(selector: string, value: string, textNodeIndex?: number): void
}

/** One member of the pending union, by its `editKind`. */
type PendingOfKind<K extends PendingIterationEdit["editKind"]> = Extract<
  PendingIterationEdit,
  { editKind: K }
>

/**
 * Coerce a prop-control value (string, number or boolean) into the JSON payload
 * value the iteration-data prompt expects. Identity for the three primitive
 * types; a future widening of that union lands here.
 */
function serializePropValue(
  value: PendingOfKind<"prop">["value"],
): string | number | boolean {
  return value
}

export interface IterationDispatchDeps {
  session: LaneSession & { releaseDraft(pendingId: string): void }
  /** Absent when the shell has no chat to hand a nested row edit to. */
  handOff?: IterationHandOff
  /**
   * The adapter INSTANCE, read once by the caller before the first await, so
   * it cannot change under the lane. Null when nothing is attached, which the
   * row lane reports at the point the old code did: after the proposal, not
   * before it.
   */
  adapter: IterationLaneAdapter | null
  parkOrDefer: (pending: PendingIterationEdit, reason: string) => boolean
  releaseDraft: (pending: PendingIterationEdit) => void
  setStatus: (message: string | null) => void
  requestProposal: typeof requestIterationProposal
  /** The page-level source file, when the current-page store knows one. */
  pageSourceFile: () => string | null
  /** The three "all rows" re-entries, which are the shell's own handlers. */
  applyAllRowsDelete: (pending: PendingOfKind<"delete">) => void
  applyAllRowsProp: (pending: PendingOfKind<"prop">) => void
  applyAllRowsMove: (pending: PendingOfKind<"move">) => void
}

/**
 * Funnel a pending iteration edit through: verify the loop in source, then
 * remembered-scope, then the dialog.
 *
 * The caller answers its own caller synchronously (the legacy path must not
 * run) and lets this promise settle on its own; the decision lands
 * asynchronously.
 *
 * The verify step exists because the bridge's classification comes from DOM
 * stamps, and N usages of one component look exactly like N loop rows. The
 * 2026-09-08 incident: four hand-written cards, "all items" chosen, the
 * component's root deleted by an AI rewrite of the wrong function. When source
 * has no loop at the position, the question "this item or all items" has no
 * right answer, so the edit goes to chat with the evidence and the agent asks a
 * better one.
 */
export async function interceptIteration(
  pending: PendingIterationEdit,
  deps: IterationLaneDeps,
): Promise<void> {
  const { session } = deps
  const location = iterationTemplateLocation(pending)
  if (!location) {
    deps.releaseDraft(pending)
    deps.setStatus(NO_SOURCE_LOCATION_STATUS)
    return
  }
  // Claim the latest slot FOR THIS TARGET. Responses are not ordered, so this
  // is what tells a late answer that newer keystrokes on the same element have
  // replaced it. Scoped by key so an edit somewhere else on the page cannot
  // make this one stale.
  const verifyKey = verifyKeyFor(pending)
  const seq = session.nextVerifySeq(verifyKey)
  const latestSeqForKey = (): number => session.latestVerifySeq(verifyKey, seq)
  // Claim the DRAFT too. A newer intercept for the same in-page typing session
  // shares the draft id and differs only by object identity, so this is what
  // lets an older completion tell that the draft it is about to release is no
  // longer its own to release.
  const claimedDraftId = bridgeDraftIdOf(pending)
  if (claimedDraftId) session.claimPending(claimedDraftId, pending)
  await session.run(async (ctx) => {
    try {
      // THE PAGE THIS ANSWER IS ABOUT MAY BE GONE. `ctx.step` refuses the value
      // then, and NOTHING below runs: not even a release, because the teardown
      // that ended this session handed every held draft back already and the
      // next adapter starts its draft ids at `dom-pending-1` again, so
      // cancelling "this" draft id now would cancel the new session's first
      // edit. No status either, since the panel that would show it is gone too.
      const settled = await ctx.step(
        deps.verify({
          file: location.file,
          line: location.line,
          column: location.column,
          // The session's own signal, captured with the generation: a teardown
          // cancels the check rather than leaving it to answer for a page
          // nobody is looking at.
          signal: ctx.signal,
        }),
      )
      if (settled.stale) return
      if (isStaleVerify(seq, latestSeqForKey())) {
        // Release THIS draft only, and only when nothing live is still using
        // it: neither a newer intercept nor the prompt currently open. A stale
        // result and the survivor can describe one in-page typing session,
        // because the pending object is rebuilt on every keystroke round trip,
        // so they are different objects sharing a `bridgePendingId`. Cancelling
        // here cancels theirs.
        deps.releaseDraftUnlessShared(pending)
        deps.setStatus("A newer edit replaced this one.")
        return
      }
      const action = decideAfterVerify({
        outcome: settled.value,
        pending,
        location,
        remembered: deps.rememberedScope(pending.editKind),
      })
      if (action.kind === "release-and-status") {
        // Park, do not cancel. The loop check failing says nothing about what
        // the designer typed, and cancelling a dom-text draft loses it with no
        // record anywhere. See `releaseOrPark`.
        deps.releaseOrPark(pending, action.message)
        return
      }
      if (action.kind === "hand-off") {
        // AWAIT the hand-off before letting the draft go. The transport can
        // refuse after the client-side guard accepted (an HTTP error, a dropped
        // fetch), and releasing first meant the bridge had already dropped the
        // live preview by the time we learned nothing was sent.
        //
        // BOUNDED, because the draft is held for the whole await: the page is
        // showing a change that has reached no file and the designer cannot
        // resolve it meanwhile. A late answer after the timeout resolves into a
        // promise nobody holds, so it cannot release a draft this branch has
        // already parked. The deadline also ABORTS the submission, so a turn
        // accepted after the park cannot edit the same element behind the
        // deterministic dialog.
        //
        // `ctx.signal` goes in as well, so a teardown cancels the submission
        // rather than leaving a turn to be accepted for a page that is gone.
        // See `settleHandOff`.
        const attempt = await ctx.step(
          settleHandOff(
            (signal) =>
              deps.handOff
                ? deps.handOff(action.prompt, { signal })
                : Promise.resolve(false),
            { signal: ctx.signal },
          ),
        )
        // The session ending outranks everything: no release, for the reason
        // the verify's own arm gives.
        if (attempt.stale) return
        // Staleness next, and it decides the release. While this POST was in
        // flight a newer intercept can have taken over the same draft (the user
        // kept typing); releasing here would cancel THEIR draft, and the newer
        // one is the one the user can still see.
        if (isStaleVerify(seq, latestSeqForKey())) {
          deps.releaseDraftUnlessShared(pending)
          return
        }
        if (attempt.value === "accepted") {
          // Chat owns the edit from here, so the shared-template draft goes.
          deps.releaseDraft(pending)
          return
        }
        // Refused or unanswered, and NOTHING was sent. Cancelling the draft
        // here would throw away what the designer typed with no record of it in
        // any file and no way to retry, so park it in the deterministic dialog
        // instead: "this instance" or "all instances" is a worse question than
        // the agent would have asked, but it is answerable.
        const failure = handOffFailureStatus(attempt.value)
        if (!deps.parkOrDefer(pending, failure.parked)) {
          deps.releaseDraft(pending)
          deps.setStatus(failure.released)
        }
        return
      }
      // Carry the verified loop's position onto the pending edit. Both
      // remaining exits dispatch or open a dialog that dispatches, and "this
      // item" aims at the loop element, which is not necessarily the element
      // that was clicked. Unconditional: both remaining actions carry a
      // position, because a `loop` verdict requires one.
      const verified: PendingIterationEdit = {
        ...pending,
        loopLocation: action.loopLocation,
      }
      if (action.kind === "remembered") {
        deps.logScopeChoice({
          editKind: pending.editKind,
          scope: action.scope,
          iterationContext: pending.iterationContext,
          remembered: true,
        })
        void deps.dispatch(verified, action.scope)
        return
      }
      // An open prompt is never REPLACED. Two verifies can be in flight at once
      // (verify is an HTTP round trip) and the sequence that decides staleness
      // is per target, so two edits on two different elements both arrive here
      // legitimately. Overwriting cancelled the first one's bridge draft, or
      // made a delete or a move disappear with nothing said. See
      // `promptCollision`.
      //
      // The SNAPSHOT, not a rendered value: two completions can land in the
      // same tick, before React re-renders, and the second has to see the
      // first one's prompt.
      const collision = promptCollision(session.getSnapshot().scopePrompt, verified)
      if (collision === "open-incoming") {
        if (session.modalOwner === "scope") {
          // The scope dialog is open AND `promptCollision` said to open the
          // incoming one, so by construction it is the same in-page typing
          // session with newer text. Replace the question in place: it is the
          // same question, and going through `requestModal` would queue an edit
          // behind its own dialog.
          session.setScopePrompt(verified)
          return
        }
        // Nothing open, or the MUTATION dialog is. That second case is the
        // round-10 defect: this arm used to open the scope prompt on top of it,
        // because it only ever asked about another scope prompt.
        if (!session.requestModal({ kind: "scope", pending: verified })) {
          deps.setStatus(DEFERRED_PARK_STATUS)
        }
        return
      }
      if (collision === "keep-open-park-incoming") {
        // Typed in the page: the text survives in the mutation disambiguation
        // dialog, which asks a blunter question than this one but is answerable
        // and holds the same draft.
        //
        // DEFERRED, not asked now. Opening the mutation dialog would land on
        // top of the scope dialog the designer is being asked to answer. This
        // arm is only ever reached with that prompt open, so `parkOrDefer`
        // always queues here, and the release of the open modal opens it. It
        // goes through the choke point rather than queueing directly so this
        // arm and the failure exits cannot drift apart.
        if (
          !deps.parkOrDefer(
            verified,
            parkedReason("Another edit is waiting for a scope choice"),
          )
        ) {
          // `promptCollision` only returns this arm for an edit with a draft
          // id, but the bridge's payload for it can have gone (released by a
          // stale completion) between then and here. Then there is nothing to
          // hold, which is the same situation the drop-incoming arm below
          // reports.
          deps.setStatus(PROMPT_BUSY_STATUS)
        }
        return
      }
      deps.setStatus(PROMPT_BUSY_STATUS)
    } catch (err) {
      // A throw inside the body above (not an `outcome.kind === "error"`
      // result, an actual exception) must still release the draft and surface a
      // status, or it leaves the bridge blocked with nothing shown.
      // `UnlessShared`, because this is a late completion like any other: a
      // newer intercept may already own the draft.
      //
      // The hand-off's own failures never arrive here; `settleHandOff` reports
      // a throw as a refusal, so this message is only ever about the loop
      // check.
      //
      // `ctx.current` rather than a rethrow: `ctx.step` converts a throw from a
      // page that has gone into a stale result, so a throw reaching here is
      // usually current, and the one path that is not (a throw from the
      // synchronous code after a step) has nothing to park it in and no status
      // to show. See the verify's own arm.
      if (!ctx.current) return
      deps.releaseOrParkUnlessShared(
        pending,
        `Could not check the source for a loop: ${errorMessage(err)}`,
      )
    }
  })
}

/**
 * Drive a pending iteration edit through the chosen scope. Used by both the
 * dialog confirm path AND the remembered-scope fast path (when the user already
 * picked "this row" or "all rows" for this edit kind earlier in the session).
 *
 * On "all-rows" we run today's applicator; on "this-row" we POST for a
 * deterministic proposal and write the resulting full-file rewrite.
 *
 * The row lane holds a bridge draft across a hand-off POST, a proposal POST and
 * a file write, and a teardown anywhere in there ends the session the draft
 * belonged to. Every one of those awaits goes through `ctx.step`.
 */
export async function dispatchIteration(
  pending: PendingIterationEdit,
  scope: IterationScope,
  deps: IterationDispatchDeps,
): Promise<void> {
  const { session, adapter } = deps
  if (scope === "all-rows") {
    // Today's behavior: route back to the shell's own handler with the same
    // arguments. Nothing here awaits, so there is no session boundary to cross.
    if (pending.editKind === "delete") {
      deps.applyAllRowsDelete(pending)
    } else if (pending.editKind === "prop") {
      // The shell's prop handler reads the live editor selection, which may
      // have drifted between dialog-open and dialog-confirm. The re-entry
      // buffers against the selection CAPTURED on this pending instead.
      deps.applyAllRowsProp(pending)
    } else if (pending.editKind === "move") {
      deps.applyAllRowsMove(pending)
    } else if (pending.editKind === "dom-text") {
      // The intercept short-circuited the text-field handler before
      // `setElementText` was called, so the bridge has not mutated yet.
      // Re-enter the dom-text dispatch now that the user confirmed "all rows":
      // the bridge mutates one DOM element for preview and emits the capture.
      // At save time the applicator rewrites the template literal, which the
      // framework re-renders to every row.
      if (adapter) {
        if (pending.bridgePendingId) {
          // The bridge already captured this edit and is holding it. Let it
          // through as the shared-template rewrite. Re-typing via
          // `setElementText` here would emit a SECOND mutation for the same
          // keystroke and leave the first pending forever.
          adapter.resolveMutationDisambiguation(
            pending.bridgePendingId,
            "all-instances",
          )
          // Resolved, so nothing may park or re-release it later.
          session.releaseDraft(pending.bridgePendingId)
        } else {
          const targetSelector = pending.field.selector ?? pending.selection.selector
          adapter.setElementText(
            targetSelector,
            pending.value,
            pending.field.textNodeIndex,
          )
        }
      }
    }
    return
  }

  // The designer picked the narrower scope, so the bridge's draft, which is the
  // SHARED-template edit, must never reach the edit route. It is released once
  // this lane has actually WRITTEN the row edit, and parked in the
  // deterministic dialog if it cannot (see `parkOrDefer`).
  //
  // It used to be cancelled here, before the request ran. Cancelling does not
  // restore the typed text: the in-page contentEditable path supplies no
  // preview ops, because the designer typed into the DOM directly. So a failed
  // proposal or a failed write left neither a source edit nor anything to
  // retry, with the page still showing text that reached no file.
  await session.run(async (ctx) => {
    // Reached from four places, three of them after an await. A park takes the
    // draft out of the maps and puts a row in the deterministic dialog, so
    // doing it for an ended session strands the NEW session's draft behind a
    // question about an edit that no longer exists.
    const failThisRow = (message: string): void => {
      if (!ctx.current) return
      // `parkedReason` rather than a literal: it is the same status three exits
      // now show, and it ends the refusal with a full stop first because these
      // reasons come from three places (our own literals, an applicator's
      // refusal text, a server's 400 body) and not all of them end in
      // punctuation.
      if (!deps.parkOrDefer(pending, parkedReason(message))) deps.setStatus(message)
    }

    // The VERIFIED loop's position when there is one, not the click's. See
    // `thisRowTemplateLocation`.
    const templateLocation = thisRowTemplateLocation(pending)
    if (!templateLocation) {
      failThisRow(ROW_NO_SOURCE_LOCATION_STATUS)
      return
    }
    // Where the CLICK landed, which is the loop root only when the element the
    // designer touched is itself the loop element.
    const fieldLocation = iterationTemplateLocation(pending)
    // A `remove` or a `reorder` dispatched for an element NESTED inside the row
    // is not the edit the designer asked for. The row lane speaks in whole data
    // entries, so it would delete the entire item they clicked inside, or
    // reorder the rows using a `destIndex` counted among that element's own
    // siblings. `patch` and `patch-text` name a field and are unaffected; see
    // `thisRowOperationAllowed`.
    if (!thisRowOperationAllowed(pending)) {
      const loopLocation = pending.loopLocation
      // `thisRowOperationAllowed` fails closed, so it also returns false when a
      // position is MISSING, and the row-scoped hand-off needs both to say
      // which element inside which loop. In practice a verified pending always
      // carries one (a `loop` verdict without a position is an error now), so
      // this is the defensive arm: park the edit and say so rather than
      // dispatch a row operation on half the information.
      if (!loopLocation || !fieldLocation) {
        failThisRow(ROW_NO_SOURCE_LOCATION_STATUS)
        return
      }
      const prompt = buildRowScopedEditHandoffPrompt(
        describeRowScopedEdit(pending, loopLocation, fieldLocation),
      )
      // Bounded for the reason the other hand-off is: a thrown or unanswered
      // POST is a refusal, and the park below keeps the edit answerable. The
      // signal handed to `run` is the deadline's: an unanswered submission is
      // cancelled, not merely stopped being waited for. The session's own
      // signal goes in alongside it, so a teardown cancels the submission too.
      const attempt = await ctx.step(
        settleHandOff(
          (signal) =>
            deps.handOff ? deps.handOff(prompt, { signal }) : Promise.resolve(false),
          { signal: ctx.signal },
        ),
      )
      // The session ended while the POST was in flight: the teardown gave the
      // draft back and the id names the next session's draft now, so neither
      // the release below nor the park may run.
      if (attempt.stale) return
      if (attempt.value === "accepted") {
        // Chat owns the edit from here, so a held draft (in-page typing) goes.
        deps.releaseDraft(pending)
        return
      }
      const failure = handOffFailureStatus(attempt.value)
      if (!deps.parkOrDefer(pending, failure.parked)) {
        deps.setStatus(failure.released)
      }
      return
    }
    const pageSourceFile = deps.pageSourceFile()
    let payload
    let description: string
    if (pending.editKind === "delete") {
      payload = { operation: "remove" as const }
      description = `Remove row ${JSON.stringify(pending.iterationContext.key)} from the iteration data`
    } else if (pending.editKind === "prop") {
      payload = {
        operation: "patch" as const,
        updates: { [pending.propName]: serializePropValue(pending.value) },
      }
      description = `Patch row ${JSON.stringify(pending.iterationContext.key)}: set ${pending.propName}`
    } else if (pending.editKind === "move") {
      payload = {
        operation: "reorder" as const,
        toIndex: pending.payload.destIndex,
      }
      description = `Reorder row ${JSON.stringify(pending.iterationContext.key)} to index ${pending.payload.destIndex}`
    } else if (pending.editKind === "dom-text") {
      // The client deliberately does NOT name the property here. It knows the
      // new string; it does not know which field of the row rendered it,
      // because that answer lives in the source file. `patch-text` carries the
      // value alone and the SERVER derives the key with the interpolation
      // extractor (Vue or JSX, one shared refusal set).
      //
      // The predecessor to this line refused outright, on the correct reasoning
      // that guessing a key would let the static endpoint write a literal
      // `"Text (2)": "new"` into the data array. That reasoning stands; the fix
      // was to stop guessing, not to keep refusing.
      payload = { operation: "patch-text" as const, value: pending.value }
      description = `Set the text of row ${JSON.stringify(pending.iterationContext.key)}`
    } else {
      return
    }

    deps.setStatus(null)
    try {
      // The whole rest of this lane belongs to a session that has ended if
      // `ctx.step` says so: the proposal was computed for source the page no
      // longer shows, and the draft went back to the bridge at teardown.
      // Applying here writes the old overwrite into the new session.
      const proposed = await ctx.step(
        deps.requestProposal({
          editKind: pending.editKind,
          templateLocation,
          // The session's signal: a teardown cancels the proposal rather than
          // leaving the server to compute a rewrite for a page that is gone.
          signal: ctx.signal,
          // The clicked element's OWN position, when the verify moved
          // `templateLocation` up to the loop root. The data resolver needs the
          // loop; the text-field extractor needs the field. Sending only one
          // made a nested `<span>{item.email}</span>` patch `name`.
          ...(fieldLocation && fieldLocation !== templateLocation
            ? { fieldLocation }
            : {}),
          iterationContext: pending.iterationContext,
          pageSourceFile,
          payload,
          description,
        }),
      )
      if (proposed.stale) return
      const result = proposed.value
      if (!result.ok) {
        failThisRow(`Iteration edit refused: ${result.reason}`)
        return
      }
      const overwrite: StructuralEdit = {
        kind: "overwrite",
        id: makeEditId(),
        target: {
          targetId: result.proposal.file,
          selector: result.proposal.file,
        },
        file: result.proposal.file,
        newSource: result.proposal.newSource,
        baseHash: result.proposal.baseHash,
      }
      // Immediate dispatch: the proposal is a deterministic full-file rewrite;
      // write it to the working tree so the dev server reflects it.
      if (!adapter) {
        failThisRow("Editor adapter not ready. Try again in a moment.")
        return
      }
      // The write itself spans a teardown window, and `releaseDraft` below
      // would then be about a draft the NEXT adapter issued to the designer's
      // current edit. Cancelling it would take their live preview away and
      // blame this row's write for it.
      const written = await ctx.step(
        adapter.applyEdit(overwrite, { signal: ctx.signal }),
      )
      if (written.stale) return
      if (written.value.kind === "failed") {
        failThisRow(
          `Iteration edit failed for ${result.proposal.file}: ${written.value.reason}`,
        )
        return
      }
      // WRITTEN. Only now is the bridge's shared-template draft safe to drop:
      // the row edit is on disk and the dev server will render it.
      deps.releaseDraft(pending)
      deps.setStatus(
        `Iteration applied to ${result.proposal.file}: ${
          result.proposal.explanation ?? description
        }`,
      )
    } catch (err) {
      failThisRow(`Iteration edit threw: ${errorMessage(err)}`)
    }
  })
}
