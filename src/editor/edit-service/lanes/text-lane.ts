/**
 * The buffered dom-mutation lane, as a function of one bridge session.
 *
 * TWO dispatches live here, and they are one lane. `dispatchTextMutation`
 * bundles a `text` / `attr` / `style` capture as a single-mutation llm-patch;
 * `dispatchClassMutation` sends a `class` capture through the style builders
 * instead, because a class change is written as a CSS rule rather than as a
 * rewrite of the source line. They share ONE in-flight marker set and ONE timer
 * map, keyed by an identity that carries the mutation's kind so the two can
 * never collide on the same element. That sharing used to be a fact you could
 * only learn from a comment naming a variable; it is now the `"text"` lane id
 * both functions pass to the session.
 *
 * The rule for both: every await goes through `ctx.step`, which will not give
 * up a value once the page the write was for has been replaced. The class lane
 * has the one asymmetry, and it is the reason it is in this file rather than
 * its own: it awaits BEFORE it takes its marker.
 */
import type { FrameworkAdapter, Mutation, Selection } from "@/editor/core"
import type { LaneSession } from "@/editor/session/lane-session"
import type { VerificationOutcome, VerifyEditInput } from "@/hooks/useEditVerification"
import {
  buildStyleEdit,
  isUnsupportedStyleBuild,
  type StyleEditDestinationOptions as StyleEditOpts,
} from "@/editor/edit-service/style-edit-builders"
import { cascadeTargetForStyleEdit } from "@/hooks/cascade-target-for-style-edit"
import { reconcileDispatchedValue } from "@/hooks/dispatch-reconcile"
import { makeEditId } from "@/hooks/make-edit-id"

/**
 * The bundle target when nothing is selected. The llm-patch carries its
 * mutations; the target is only what the request is addressed to, and a
 * dispatch fired from a debounce can outlive the selection that started it.
 */
const BUNDLE_TARGET: Selection = {
  targetId: "llm-patch-bundle",
  selector: "llm-patch-bundle",
  ancestry: [],
}

export interface TextLaneDeps {
  session: LaneSession & {
    getSnapshot(): { mutations: readonly Mutation[] }
    updateMutations(update: (prev: readonly Mutation[]) => readonly Mutation[]): void
  }
  /** The adapter instance, passed in so it cannot change between two awaits. */
  adapter: Pick<FrameworkAdapter, "applyEdit" | "resolveOverride">
  /** The buffer identity for one mutation. `mutationIdentity` in the hook. */
  mutationKey: (mutation: Mutation) => string
  setStatus: (message: string) => void
  recordHashes: (hashes: Record<string, string>) => void
  /** The hashes to send as `baseHashes`, read at dispatch time. */
  baseHashes: () => Record<string, string>
  resolveOverride: (
    id: string,
    outcome: "confirmed" | "failed" | "ineffective",
    reason?: string,
  ) => void
  verifyEdit: (
    input: VerifyEditInput,
    onOutcome?: (outcome: VerificationOutcome) => void,
  ) => void
  refreshSelectionStamps: (files: string[]) => void
  /** Park this identity for the save-time AI lane. A `needsChat` refusal. */
  queueForAi: (identityKey: string) => void
  forgetEditId: (id: string) => void
  /**
   * The class lane's ONE pre-marker await: where a style rule may be written.
   * Stays in the hook because answering it asks the document.
   */
  resolveStyleDestination: () => Promise<
    { ok: true; opts: StyleEditOpts } | { ok: false; reason: string }
  >
  /**
   * What the request is addressed to, read at dispatch time. Optional because
   * the mutations are what the server acts on: with no selection the bundle
   * addresses itself, exactly as the hook did.
   */
  selection?: () => Selection | null
  /**
   * The edit id is being written right now, or is not any more. The shell uses
   * it to suppress the "not yet confirmed" notice while the request is out.
   */
  setOverrideInFlight?: (id: string, inFlight: boolean) => void
  debounceMs: number
}

/**
 * The file part of a `file:line:column` source location, or null.
 *
 * Local rather than shared with `style-edit-builders.ts`: this lane only needs
 * the file, to look this write's fresh hash up by it.
 */
function fileOfSourceLoc(sourceLoc: string | null): string | null {
  if (!sourceLoc) return null
  const lastColon = sourceLoc.lastIndexOf(":")
  if (lastColon < 0) return null
  const secondLast = sourceLoc.lastIndexOf(":", lastColon - 1)
  if (secondLast < 0) return null
  return sourceLoc.slice(0, secondLast)
}

/**
 * Branch-mode dispatch for a buffered `text` / `attr` / `style` capture.
 *
 * The write is a single-mutation llm-patch, the same shape the save-time flush
 * ships, with `llmFallback: "chat"`: at typing time the deterministic lane is
 * PROBED only. An edit it refuses comes back `needsChat` and is parked for the
 * save-time AI lane rather than running a model in the middle of a keystroke.
 *
 * `generation` is the bridge session the caller decided to write in, which for
 * a debounced call is the session that was live when the designer stopped
 * typing, half a second before this runs.
 */
export async function dispatchTextMutation(
  identityKey: string,
  generation: number,
  deps: TextLaneDeps,
): Promise<void> {
  const { session, adapter } = deps
  // The page this write was for is gone. Write nothing: the capture stays in
  // the buffer, and the designer's next keystroke re-arms the debounce under
  // the session that is actually on screen.
  if (!session.isCurrent(generation)) return
  await session.run(async (ctx) => {
    // Per-identity serialization. A second dispatch for the same identity
    // while one is in flight risks the older response landing last and
    // overwriting the newer value. The in-flight one re-reads the buffer when
    // it returns and re-fires if keystrokes arrived, so this just stops here.
    if (session.isInFlight("text", identityKey)) return
    const current = session
      .getSnapshot()
      .mutations.find((m) => deps.mutationKey(m) === identityKey)
    if (!current) return
    // The `after` we are about to write. Compared against the buffer's `after`
    // once the round trip returns, to see whether more was typed meanwhile.
    const dispatchedAfter = current.after
    // Match the save-time flush's normalization: a callsite-scope capture the
    // designer never explicitly routed defaults to "this instance", so the
    // prompt has a rule instead of an undefined choice falling through.
    const normalized: Mutation =
      current.disambiguationChoice === undefined &&
      current.scope === "callsite" &&
      current.callsiteLoc !== null &&
      current.kind !== "class"
        ? { ...current, disambiguationChoice: "this-instance" }
        : current
    const baseHashes = deps.baseHashes()
    const edit = {
      kind: "llm-patch" as const,
      id: makeEditId(),
      target: deps.selection?.() ?? BUNDLE_TARGET,
      mutations: [normalized],
      llmFallback: "chat" as const,
      ...(Object.keys(baseHashes).length > 0 ? { baseHashes } : {}),
    }
    session.markInFlight("text", identityKey)
    deps.setOverrideInFlight?.(normalized.id, true)
    try {
      // The hashes are recorded off the promise itself, BEFORE staleness is
      // decided. They are disk truth, not session state: the files are what
      // they are whoever is looking at them, and skipping them would leave the
      // external-edit guard comparing against a hash this very write
      // invalidated.
      const write = adapter.applyEdit(edit, { signal: ctx.signal }).then((result) => {
        if (result.kind === "applied" && result.newHashes) {
          deps.recordHashes({ ...result.newHashes })
        }
        return result
      })
      // THE PAGE THIS ANSWER IS ABOUT MAY BE GONE. `ctx.step` will not give up
      // the value if it is, and then nothing below runs: no status, no
      // verification, no buffer filter, no timer. The override id names a
      // document that has been replaced, and the bridge restarts its mutation
      // ids on the new one, so resolving "this" override would retire an
      // override the designer can still see. The `finally` leaves the marker
      // alone for the same reason.
      const written = await ctx.step(write)
      if (written.stale) return
      const result = written.value
      if (result.kind === "failed") {
        // The deterministic lane could not apply this edit. Do not interrupt
        // the designer mid-type: PARK it. The capture stays in the buffer, its
        // identity is recorded so the capture scheduler stops re-dispatching on
        // every keystroke, and the save-time AI lane applies it.
        if (result.needsChat) {
          deps.queueForAi(identityKey)
          return
        }
        // The write genuinely failed. Leave the capture in the buffer so the
        // save-time flush can still retry it, and revert the optimistic
        // preview: nothing landed. (The `needsChat` branch above deliberately
        // does not resolve, because the preview legitimately rides until the
        // AI lane applies the edit.)
        deps.setStatus(`Inline text edit failed: ${result.reason}`)
        deps.resolveOverride(normalized.id, "failed", result.reason)
        return
      }
      // Tier-2 verification: the source write landed and HMR will re-render.
      // Confirm the edited text actually shows up in the live DOM, which
      // catches a value overridden by a binding or gated by a v-if.
      // Diagnostic and fire-and-forget; it never blocks the edit flow.
      deps.verifyEdit(
        {
          editId: edit.id,
          selector: current.selector,
          expectedValue: dispatchedAfter,
          editKind: "dom-text",
          // The join key for the Activity row's badge, when an adapter sets
          // one. Branch mode never auto-commits, so none does today.
          commitSha: result.kind === "applied" ? result.commitSha : undefined,
          // Verification settles 0.85-3s later, by which time a newer
          // keystroke has usually re-dispatched and this snapshot's
          // `dispatchedAfter` is stale. Read the LIVE buffer then rather than
          // snapshotting now: a failure against a value nobody is typing any
          // more is not worth a toast.
          isSuperseded: () => {
            const m = session
              .getSnapshot()
              .mutations.find((x) => deps.mutationKey(x) === identityKey)
            return !!m && !Object.is(m.after, dispatchedAfter)
          },
        },
        // The release gate. "verified": the post-HMR DOM renders the value
        // from source, so release. "didnt-take": the write landed but the
        // rendering does not show it (bound or shadowed), so release WITHOUT
        // reverting, because the post-HMR DOM is the truth and the
        // verification hook's own warning explains it. "skipped" (an older
        // bridge with no read support): the write landed, so release rather
        // than leave the override fighting HMR.
        (outcome) => {
          deps.resolveOverride(
            normalized.id,
            outcome === "didnt-take" ? "ineffective" : "confirmed",
          )
        },
      )
      // Refresh the (still-open) selection's stamps so the next edit from it
      // does not false-409 against its own predecessor's write.
      if (result.kind === "applied" && result.newHashes) {
        deps.refreshSelectionStamps(Object.keys(result.newHashes))
      }
      // Reconcile the buffer with what was dispatched (see
      // dispatch-reconcile.ts for the shared decision). "settled": nothing was
      // typed during the round trip, so drop the entry; the next keystroke
      // makes a fresh one against the now-on-disk source. "advanced": the
      // designer typed more, so keep the entry and rebase its `before` to the
      // dispatched `after`, because that is what source holds now. Without the
      // rebase the next dispatch sends the ORIGINAL `before` and the applicator
      // cannot find it.
      let needsRefire = false
      session.updateMutations((prev) => {
        const idx = prev.findIndex((m) => deps.mutationKey(m) === identityKey)
        const entry = idx === -1 ? undefined : prev[idx]
        const decision = reconcileDispatchedValue(idx !== -1, dispatchedAfter, entry?.after)
        if (decision === "no-entry" || !entry) return prev
        if (decision === "settled") {
          // The buffered entry is gone, so the side tables keyed by its id go
          // with it. An id left behind in them is a wrong answer later, not
          // just waste.
          deps.forgetEditId(entry.id)
          return prev.filter((m) => deps.mutationKey(m) !== identityKey)
        }
        needsRefire = true
        const updated = [...prev]
        // The stale-target stamp is rebased to THIS write's hash for the same
        // reason: the re-fire must not 409 against our own write. The full
        // hash is fine, because the guard compares by prefix.
        const file = fileOfSourceLoc(entry.sourceLoc)
        const freshHash =
          result.kind === "applied" && result.newHashes && file
            ? result.newHashes[file]
            : undefined
        updated[idx] = {
          ...entry,
          before: dispatchedAfter,
          ...(freshHash ? { sourceVersion: freshHash } : {}),
        }
        return updated
      })
      if (needsRefire) {
        // In THIS dispatch's session: the re-fire is the rest of the text the
        // designer was typing on the page this dispatch wrote for.
        // `session.schedule` refuses to run a callback whose generation has
        // moved, and the generation it is given is this run's.
        session.schedule(
          "text",
          identityKey,
          ctx.generation,
          () => {
            void dispatchTextMutation(identityKey, ctx.generation, deps)
          },
          deps.debounceMs,
        )
      }
    } catch (err) {
      deps.setStatus(`Inline text edit threw: ${(err as Error).message}`)
      deps.resolveOverride(normalized.id, "failed", (err as Error).message)
    } finally {
      deps.setOverrideInFlight?.(normalized.id, false)
      // Only while this dispatch still owns the marker. Once the session has
      // ended, the session emptied the set and any key in it was put there by a
      // dispatch that started afterwards; deleting it would let a second write
      // for that identity run alongside the first.
      session.clearInFlight("text", identityKey, ctx.generation)
    }
  })
}

/**
 * Branch-mode dispatch for a buffered `class` capture.
 *
 * Not an llm-patch: a class change is written by the style builders, as a CSS
 * rule (Vue) or as a className/style splice (React). It shares the text lane's
 * markers and timers, because the identity carries the mutation's kind and a
 * `class` and a `text` edit on one element are two separate writes to
 * serialize independently.
 */
export async function dispatchClassMutation(
  identityKey: string,
  generation: number,
  deps: TextLaneDeps,
): Promise<void> {
  const { session, adapter } = deps
  if (!session.isCurrent(generation)) return
  await session.run(async (ctx) => {
    if (session.isInFlight("text", identityKey)) return
    const current = session
      .getSnapshot()
      .mutations.find((m) => deps.mutationKey(m) === identityKey)
    if (!current) return
    const dispatchedAfter = current.after
    // THE ONE PRE-MARKER AWAIT, and the reason this lane is not the text lane:
    // resolving where a style rule may be written can ask the DOCUMENT. A page
    // replaced in that window makes both the answer and the override id below
    // name a document that is gone, so this is a `ctx.step` like every other
    // await rather than a hand-placed check after it.
    const resolved = await ctx.step(deps.resolveStyleDestination())
    if (resolved.stale) return
    const destination = resolved.value
    if (!destination.ok) {
      deps.setStatus(`Inline style edit failed: ${destination.reason}`)
      deps.resolveOverride(current.id, "failed", destination.reason)
      return
    }
    const edit = buildStyleEdit(current, destination.opts)
    if (!edit) return
    if (isUnsupportedStyleBuild(edit)) {
      deps.setStatus(`Inline style edit failed: ${edit.unsupported}`)
      // The applicator cannot express this edit at all, so the write never
      // landed. Revert the live class preview the bridge is holding under
      // `current.id`, which is the id the override store registered when the
      // classes were set.
      deps.resolveOverride(current.id, "failed", edit.unsupported)
      return
    }
    session.markInFlight("text", identityKey)
    deps.setOverrideInFlight?.(current.id, true)
    try {
      // Disk truth first, then staleness, for the same reason as the text lane.
      const write = adapter.applyEdit(edit, { signal: ctx.signal }).then((result) => {
        if (result.kind === "applied" && result.newHashes) {
          deps.recordHashes({ ...result.newHashes })
        }
        return result
      })
      const written = await ctx.step(write)
      if (written.stale) return
      const result = written.value
      if (result.kind === "failed") {
        deps.setStatus(`Inline class edit failed: ${result.reason}`)
        // Resolve by `current.id`, the captured mutation's id and the override
        // store's registration key, NOT by `edit.id`, which is this dispatch's
        // own id and unrelated to the bridge-side override entry. Same
        // distinction the text lane draws between `normalized.id` and its
        // llm-patch `edit.id`.
        deps.resolveOverride(current.id, "failed", result.reason)
        return
      }
      // RELEASE-THEN-VERIFY. The write landed, so release the preview override
      // NOW and run verification purely diagnostically afterwards.
      //
      // The two goals cannot be combined. The live class preview stamps its
      // declarations inline with `!important`, and inline `!important` outranks
      // everything, so holding the preview until the cascade is verified means
      // the cascade walk is measuring OUR OWN shim: it would report the inline
      // style as the winner on 100% of successful edits, and the failure the
      // walk exists to detect could never be observed. Measuring cascade
      // ownership requires that our preview is already gone.
      //
      // What is kept is the DIAGNOSIS: a lost cascade still names the rule that
      // actually won. Exactly ONE resolve per override id on every path, which
      // is why every failure branch above returns.
      deps.resolveOverride(current.id, "confirmed")
      const cascadeTarget = cascadeTargetForStyleEdit(edit)
      if (cascadeTarget) {
        deps.verifyEdit({
          // `edit.id`, not `current.id`. It is the id `applyEdit` dispatches,
          // and the id the ledger row carries as its `correlationId`, which is
          // what the Activity panel's verification pill joins on. `current.id`
          // is the right id for the resolve above and the wrong one here.
          editId: edit.id,
          selector: current.selector,
          // The RESOLVED CSS value for the representative property, not the
          // raw className string.
          expectedValue: cascadeTarget.value,
          // EVERY property this edit sets, shorthands expanded, each with its
          // own expected value. Ownership alone false-passes a repeat edit of a
          // property our own declaration already owns.
          styleProperties: cascadeTarget.properties,
          editKind: "style",
          styleProperty: cascadeTarget.property,
          cascadeOwner: cascadeTarget.owner,
          isSuperseded: () => {
            const m = session
              .getSnapshot()
              .mutations.find((x) => deps.mutationKey(x) === identityKey)
            return !!m && !Object.is(m.after, dispatchedAfter)
          },
        })
      }
      // Reconcile: "settled" drops the entry, "advanced" keeps it and re-fires.
      // No rebase here, unlike text and prop: this lane has no stale-target
      // stamp to refresh.
      let needsRefire = false
      session.updateMutations((prev) => {
        const idx = prev.findIndex((m) => deps.mutationKey(m) === identityKey)
        const decision = reconcileDispatchedValue(
          idx !== -1,
          dispatchedAfter,
          idx === -1 ? undefined : prev[idx].after,
        )
        if (decision === "no-entry") return prev
        if (decision === "settled") {
          deps.forgetEditId(current.id)
          return prev.filter((m) => deps.mutationKey(m) !== identityKey)
        }
        needsRefire = true
        return prev
      })
      if (needsRefire) {
        session.schedule(
          "text",
          identityKey,
          ctx.generation,
          () => {
            void dispatchClassMutation(identityKey, ctx.generation, deps)
          },
          deps.debounceMs,
        )
      }
    } catch (err) {
      deps.setStatus(`Inline class edit threw: ${(err as Error).message}`)
      deps.resolveOverride(current.id, "failed", (err as Error).message)
    } finally {
      deps.setOverrideInFlight?.(current.id, false)
      session.clearInFlight("text", identityKey, ctx.generation)
    }
  })
}
