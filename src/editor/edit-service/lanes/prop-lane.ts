/**
 * The buffered prop/attr edit lane, as a function of one bridge session.
 *
 * This was three hundred lines inside `useEditorEditing.ts` that read four
 * refs and re-derived the same staleness rule at every await. It is a plain
 * async function now, and the only thing it knows about the shell is what
 * `PropLaneDeps` hands it.
 */
import type { FrameworkAdapter, PropEdit } from "@/editor/core"
import type { ManifestValue } from "@/editor/core/manifest"
import type { LaneSession } from "@/editor/session/lane-session"
import type { RenderSite } from "@/editor/attribution/types"
import type { VerificationOutcome, VerifyEditInput } from "@/hooks/useEditVerification"
import {
  afterEscalation,
  buildPropEditEscalationPrompt,
} from "@/editor/edit-service/build-edit-escalation-prompt"
import { reconcileDispatchedValue } from "@/editor/edit-service/dispatch-reconcile"

/**
 * Buffer key for one element's one prop. Module scope, so every closure that
 * builds a key gets the SAME function identity.
 *
 * The NUL separator is deliberate: a selector can contain anything a CSS
 * selector can, and a printable separator could be part of one.
 */
export const propEditKey = (selector: string, propName: string): string =>
  `${selector}\u0000${propName}`

/**
 * Narrow a {@link PropEdit}'s value to the string|number|boolean shape the
 * escalation prompt expects. The wire protocol's PropEdit body only accepts
 * these three primitive kinds - arrays / objects / null get rejected at the
 * server boundary. So in practice this is just a type-narrowing assertion; the
 * fallback stringifies defensively in case a future PropEdit variant slips
 * through.
 */
function normalizeManifestValueForEscalation(
  value: ManifestValue,
): string | number | boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  // ManifestValue widens to null / array / object for non-prop edits.
  // PropEdits don't carry these - fall back to a labeled string so the
  // prompt is still readable if the validator drifts.
  return String(value)
}

/**
 * How long a prop write may run before the wait is explained. The prop request
 * is a plain synchronous POST: when the deterministic lane refuses, the server
 * runs the AI mini-turn INSIDE the request (up to ~90s) with no streaming
 * signal. The client cannot know the fallback engaged, but a dispatch outlasting
 * a couple of seconds is a reliable tell.
 */
const ASKING_AI_NOTICE_MS = 2_000

export interface PropLaneDeps {
  session: LaneSession & {
    getSnapshot(): { propEdits: readonly PropEdit[] }
    updatePropEdits(update: (prev: readonly PropEdit[]) => readonly PropEdit[]): void
  }
  /**
   * The adapter INSTANCE, passed in rather than read from a ref, so it cannot
   * change under the lane between two awaits. `FrameworkAdapter` and not the
   * bridge class, so the lane has no bridge-specific surface to reach for.
   */
  adapter: Pick<FrameworkAdapter, "applyEdit" | "selectBySelector">
  escalateToChat?: (prompt: string, options?: { signal?: AbortSignal }) => Promise<boolean>
  setStatus: (message: string) => void
  recordHashes: (hashes: Record<string, string>) => void
  resolveOverride: (id: string, outcome: "confirmed" | "failed" | "ineffective", reason?: string) => void
  /**
   * `useEditVerification`'s `verifyEdit`, exactly as it is declared in
   * `src/hooks/useEditVerification.ts`. There is no `VerifyEditRequest` type
   * anywhere in this repo; the input type is `VerifyEditInput`.
   */
  verifyEdit: (
    input: VerifyEditInput,
    onOutcome?: (outcome: VerificationOutcome) => void,
  ) => void
  refreshSelectionStamps: (files: string[]) => void
  /**
   * Drop every side table keyed by this edit id. The buffered entry is gone,
   * and an id left behind in those tables is a wrong answer later, not just
   * waste.
   */
  forgetEditId: (id: string) => void
  /**
   * The edit id is being written right now, or is not any more. The shell uses
   * it to suppress the "not yet confirmed" notice while the request is out:
   * in-flight is the expected state, and the AI fallback can hold it for ~90s.
   */
  setOverrideInFlight?: (id: string, inFlight: boolean) => void
  /** The manifest dom-hint captured when the edit was buffered, if there was one. */
  renderSiteFor?: (id: string) => RenderSite | undefined
  /**
   * One-shot stale-target recovery guard, keyed like the in-flight markers.
   * Owned by the caller so the one-shot rule stays observable from the hook,
   * which also has to forget a key when the entry it belongs to is retired.
   * Omit it and the stale-target retry is skipped entirely, which is the safe
   * direction: a retry with nowhere to record that it happened is a loop.
   */
  staleRetried?: Set<string>
  debounceMs: number
}

/**
 * The buffered prop dispatch, as a function of the session.
 *
 * Every await goes through `ctx.step`, which will not give up a value once the
 * session has moved. That is the whole shape of the fix: the four hand-placed
 * `isStaleGeneration` checks this lane had (and the fifth it was missing at the
 * stale-target retry, finding V2) are one rule the compiler enforces.
 *
 * `generation` is the bridge session the caller decided to write in, which for
 * a debounced call is the session that was live when the designer typed, half a
 * second before this runs.
 */
export async function dispatchPropEdit(
  key: string,
  generation: number,
  deps: PropLaneDeps,
): Promise<void> {
  const { session, adapter } = deps
  // The page this write was for is gone. Write nothing: the buffered entry
  // stays, and the designer's next keystroke re-arms the debounce under the
  // session that is actually on screen.
  if (!session.isCurrent(generation)) return
  await session.run(async (ctx) => {
    if (session.isInFlight("prop", key)) return
    const current = session
      .getSnapshot()
      .propEdits.find((e) => propEditKey(e.target.selector, e.propName) === key)
    if (!current) return
    const dispatchedValue = current.value
    session.markInFlight("prop", key)
    deps.setOverrideInFlight?.(current.id, true)
    const askingAiTimer = setTimeout(() => {
      // Both checks, and they answer different questions. `isInFlight` says a
      // write for this identity is still out; `ctx.current` says the page it
      // was written for is still on screen. The marker set is keyed on the
      // element and the prop, not on the session, so the NEXT session's
      // dispatch can take the same key and this timer would then write its
      // status line for someone else's write.
      if (ctx.current && session.isInFlight("prop", key)) {
        deps.setStatus(`Asking AI to apply "${current.propName}"…`)
      }
    }, ASKING_AI_NOTICE_MS)
    try {
      // The hashes are recorded off the promise itself, BEFORE staleness is
      // decided. They are disk truth, not session state, so they are recorded
      // whoever is looking at the files. Skipping them would leave the
      // external-edit guard comparing against a hash this very write
      // invalidated.
      const write = adapter
        .applyEdit(current, { signal: ctx.signal })
        .then((result) => {
          if (result.kind === "applied" && result.newHashes) {
            deps.recordHashes({ ...result.newHashes })
          }
          return result
        })
      // THE PAGE THIS ANSWER IS ABOUT MAY BE GONE. `ctx.step` will not give up
      // the value if it is, and then nothing below runs at all: no buffer
      // filter, no timer replaced, no status. The request can be out for ~90
      // seconds, and a document replaced inside that window took this
      // dispatch's entry with it. A SUCCESS is the case that used to slip
      // through here: the reconcile below would clear the live debounce and
      // re-arm it under this dispatch's dead session, so the replacement
      // document's edit on the same prop stayed buffered and was never
      // written. The `finally` leaves the marker alone for the same reason.
      const written = await ctx.step(write)
      if (written.stale) return
      const result = written.value
      if (result.kind === "failed") {
        // `'chat'` fallback mode: the deterministic applicator refused
        // (bound-binding / v-model / dynamic-vbind) AND the source-aware
        // LLM lane refused too, so the server returned `needsChat`. Route
        // the edit to the chat agent (which has multi-file tool access)
        // instead of leaving it stuck in the buffer, and drop the entry.
        if (result.needsChat && deps.escalateToChat) {
          const editTarget = current.target.editTarget
          const editTargetLocation = editTarget
            ? `${editTarget.file}:${editTarget.line}`
            : null
          // The hand-off can be REFUSED, either by the client guard (a chat
          // is already streaming) or by the server answering the POST with an
          // error. Awaited, so the second kind is known here too. Clearing the
          // buffer on a refusal loses the value: nothing was submitted,
          // nothing is on disk, and the optimistic override reverts later with
          // no explanation.
          const handoff = await ctx.step(
            deps.escalateToChat(
              buildPropEditEscalationPrompt({
                propName: current.propName,
                // Pass the raw value (string | number | boolean) so the
                // prompt renders unquoted for non-string literals - the
                // agent must not write `:max="42"` with the number quoted.
                newValue: normalizeManifestValueForEscalation(current.value),
                componentName: current.target.componentName,
                editTargetLocation,
                selector: current.target.selector,
              }),
              // The submission races the session: a reload cancels it rather
              // than leaving a turn on its way to a page nobody is looking at.
              { signal: ctx.signal },
            ),
          )
          // The session ended while the submission was out. Touch nothing: the
          // entry this would keep or drop was retired with the page it was
          // typed on, and the status bar is describing a different page now.
          if (handoff.stale) return
          const aftermath = afterEscalation(
            handoff.value,
            `The "${current.propName}" edit`,
          )
          if (aftermath.buffer === "keep") {
            deps.setStatus(aftermath.status)
            return
          }
          session.updatePropEdits((prev) => prev.filter((e) => e.id !== current.id))
          deps.forgetEditId(current.id)
          return
        }
        // The source write genuinely failed (not a needsChat refusal). Keep
        // the entry buffered so it stays consistent with the live preview
        // override (still showing the attempted value) and `hasUnsavedChanges`
        // stays true - the value is NOT on disk. There is no save-time flush to
        // retry it (branch mode has no buffer flush; git Commit records the
        // working tree, it doesn't re-run dispatch); editing the field again
        // re-arms the debounced dispatch, which is the retry path.
        //
        // Stale-target auto-recovery: a 409 means the file moved under the
        // buffered entry's captured stamps - usually our own just-landed
        // write. Re-capture coordinates+hash from the post-HMR DOM once,
        // rebase the entry, and re-fire before surfacing failure. One shot per
        // key: a second 409 surfaces.
        //
        // No guard set, no auto-recovery: without somewhere to record that the
        // one shot was used, a 409 that keeps 409ing would re-fire forever.
        // Refusing the retry degrades to "the failure is surfaced", which is
        // where this lane was before the recovery existed.
        if (
          /stale target/i.test(result.reason) &&
          deps.staleRetried &&
          !deps.staleRetried.has(key)
        ) {
          deps.staleRetried.add(key)
          // The session can end while the re-select is out. `ctx.step` refuses
          // the answer then: it would describe a document this dispatch never
          // wrote against, and the re-entry below would run under a marker this
          // dispatch no longer owns. Report nothing, and the buffered entry
          // stays for the next keystroke to re-arm.
          const reselect = await ctx.step(
            adapter.selectBySelector(current.target.selector).catch(() => null),
          )
          if (reselect.stale) return
          const refreshed = reselect.value
          // A NULL ANSWER FALLS THROUGH TO THE SURFACED FAILURE, on purpose.
          // The adapter refuses a selection reply the designer has already
          // clicked past (its selection epoch), so `selectBySelector` answers
          // null here whenever the page moved on under the retry. There is no
          // fresh stamp to rebase onto in that case, and the edit did NOT
          // land, so "Inline prop edit failed" below is the honest report.
          // Degrading to it is the same choice the one-shot guard makes:
          // where the recovery cannot be trusted, the lane says the write
          // failed rather than retrying blind.
          if (refreshed?.editTarget) {
            session.updatePropEdits((prev) => {
              const idx = prev.findIndex(
                (e) => propEditKey(e.target.selector, e.propName) === key,
              )
              if (idx === -1) return prev
              const updated = [...prev]
              updated[idx] = { ...updated[idx], target: refreshed }
              return updated
            })
            // Re-entered in THIS dispatch's session, not in whichever one is
            // live when the timer fires: `session.schedule` refuses a stale
            // generation, and the generation it is given is this run's.
            session.schedule(
              "prop",
              key,
              ctx.generation,
              () => {
                void dispatchPropEdit(key, ctx.generation, deps)
              },
              deps.debounceMs,
            )
            return
          }
        }
        deps.setStatus(`Inline prop edit failed: ${result.reason}`)
        // The write never landed - revert the preview poke. (The needsChat
        // escalation above does NOT resolve: chat will land the edit; the
        // preview rides until then or until the store times out.)
        deps.resolveOverride(current.id, "failed", result.reason)
        return
      }
      if (result.kind === "applied" && result.fallbackUsed) {
        const notes = result.notes
        const truncatedNotes =
          notes && notes.length > 140 ? notes.slice(0, 140) + "…" : notes
        deps.setStatus(
          `Edited via AI fallback${truncatedNotes ? `: ${truncatedNotes}` : ""}`,
        )
      }
      deps.staleRetried?.delete(key)
      // RELEASE-THEN-VERIFY. The write landed - release the preview override
      // immediately, then verify diagnostically. Holding the preview until the
      // read-back confirms means the read-back is partly measuring our own
      // optimistic override, which is what the confirm window has to fight;
      // releasing first lets the post-HMR DOM be the only thing under the
      // microscope. Exactly ONE resolve per override id: every failure branch
      // above returns.
      deps.resolveOverride(current.id, "confirmed")
      // Verify the prop's value actually rendered (diagnostic only - the
      // override is already released). The oracle needs a manifest dom-hint
      // (captured at buffer time from `attribute()`'s `renders`) to know WHERE
      // the value surfaces; without one `deriveExpectation` declines and
      // nothing is reported.
      const renderSite = deps.renderSiteFor?.(current.id)
      // Boolean-attribute exclusion: Vue's `patchAttr` renders a *special*
      // boolean HTML attribute (disabled/checked/readonly/selected) as
      // `attr=""` when true and removes it entirely when false. The bridge's
      // READ_RENDERED_VALUE only special-cases `checked`/`value`; every other
      // attribute name falls through to plain `getAttribute`, so reading it
      // back would compare the empty string against `"true"` and never match -
      // a CORRECT edit would be reported as "didn't take effect." A false
      // failure is worse than no signal, so decline the oracle for this exact
      // combination (same as no hint at all) rather than try to model
      // boolean-attribute semantics with a "matches any of" expectation.
      // Numbers are unaffected - Vue stringifies `4` to `"4"`, which matches -
      // so gate specifically on `typeof === 'boolean'`, not "non-string".
      const isBooleanAttributeHint =
        typeof dispatchedValue === "boolean" && renderSite?.field === "attribute"
      deps.verifyEdit({
        editId: current.id,
        selector: current.target.selector,
        expectedValue: String(dispatchedValue ?? ""),
        editKind: "prop",
        propName: current.propName,
        domField: isBooleanAttributeHint ? undefined : renderSite?.field,
        attribute: isBooleanAttributeHint ? undefined : renderSite?.attribute,
        // Verification settles 0.85-3s later; by then a newer keystroke or
        // drag has typically re-dispatched (or is in flight) and this
        // snapshot's `dispatchedValue` is stale. Read the LIVE buffer lazily
        // at verification-complete time - mirrors the dom-text lane's
        // `isSuperseded` against its own mutations buffer.
        isSuperseded: () => {
          const stillBuffered = session
            .getSnapshot()
            .propEdits.find((e) => propEditKey(e.target.selector, e.propName) === key)
          return !!stillBuffered && !Object.is(stillBuffered.value, dispatchedValue)
        },
        // THE SESSION, read at verification-complete time. Verification reads
        // the DOM seconds after the write, and a page replaced in that window
        // makes the read a measurement of another document. `current` reports
        // the live session then, so the hook can decline to warn about it.
        current: () => ctx.current,
      })
      // Refresh the (still-open) selection's stamps so the next edit from it
      // doesn't false-409 against its own predecessor's write.
      deps.refreshSelectionStamps(
        result.kind === "applied" && result.newHashes
          ? Object.keys(result.newHashes)
          : [current.target.editTarget?.file].filter((f): f is string => !!f),
      )
      // Reconcile (see dispatch-reconcile.ts for the shared decision):
      // "settled" - the buffered value still matches what we dispatched, the
      // worktree now holds it - drop the entry. "advanced" - it moved (the
      // designer kept dragging), keep it and re-fire. Prop applicators
      // re-parse source each call, so no `before`-rebase is needed (unlike the
      // text path) - only the stale-target stamp.
      let needsRefire = false
      session.updatePropEdits((prev) => {
        const idx = prev.findIndex(
          (e) => propEditKey(e.target.selector, e.propName) === key,
        )
        const decision = reconcileDispatchedValue(
          idx !== -1,
          dispatchedValue,
          idx === -1 ? undefined : prev[idx].value,
        )
        if (decision === "no-entry") return prev
        if (decision === "settled") {
          deps.forgetEditId(prev[idx].id)
          return prev.filter((_, i) => i !== idx)
        }
        needsRefire = true
        // Rebase the kept entry's stale-target stamp to THIS write's hash: the
        // re-fire dispatches this entry, and without the rebase its pre-write
        // fileHash 409s against our own write. Coordinates stay valid - the
        // prop splice never moves the element's start tag.
        const freshHash =
          result.kind === "applied" && result.newHashes
            ? result.newHashes[prev[idx].target.editTarget?.file ?? ""]
            : undefined
        const editTarget = prev[idx].target.editTarget
        if (!freshHash || !editTarget) return prev
        const updated = [...prev]
        updated[idx] = {
          ...updated[idx],
          target: {
            ...updated[idx].target,
            editTarget: { ...editTarget, fileHash: freshHash },
          },
        }
        return updated
      })
      if (needsRefire) {
        // In THIS dispatch's session: the re-fire is the rest of the edit the
        // designer was making on the page this dispatch wrote for.
        session.schedule(
          "prop",
          key,
          ctx.generation,
          () => {
            void dispatchPropEdit(key, ctx.generation, deps)
          },
          deps.debounceMs,
        )
      }
    } catch (err) {
      deps.setStatus(`Inline prop edit threw: ${(err as Error).message}`)
      deps.resolveOverride(current.id, "failed", (err as Error).message)
    } finally {
      clearTimeout(askingAiTimer)
      deps.setOverrideInFlight?.(current.id, false)
      // Only while this dispatch still owns the marker. Once the session has
      // ended, the session emptied the set and any key in it was put there by a
      // dispatch that started afterwards; deleting it would let a second write
      // for that identity run alongside the first.
      session.clearInFlight("prop", key, ctx.generation)
    }
  })
}
