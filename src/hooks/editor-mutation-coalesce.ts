/**
 * Pure helpers for the direct-manipulation edit buffer in
 * `useEditorEditing`. Extracted from the hook so the coalescing +
 * capture-scheduler-suppression logic is unit-testable without mounting
 * the whole hook (which depends on the bridge adapter, several Zustand
 * stores, and refs). The hook imports these; behavior is identical.
 *
 * See tasks/editor-edit-queue-and-fanout.md.
 */

import type { Mutation } from "@/editor/core/edit"

/**
 * Stable coalescing key for a captured mutation. Two captures with the
 * same key are the SAME on-screen field being edited and collapse into a
 * single buffer entry (and a single "pending · needs AI" row when queued).
 *
 * `instancePath` disambiguates v-for / repeated-source-loc siblings so two
 * distinct on-screen instances that share a `sourceLoc` stay distinct.
 */
export function mutationIdentity(m: Mutation): string {
  return [m.sourceLoc ?? "", m.instancePath, m.kind, m.target ?? ""].join("|")
}

/**
 * Reducer for `adapter.onMutationCaptured`: merge an incoming capture into
 * the buffer by identity. A new identity appends; a repeat updates the
 * existing entry in place — taking the incoming mutation's fields BUT
 * preserving the FIRST `before` ever captured for that identity.
 *
 * Why preserve the original `before`: every keystroke in the inspector
 * input fires a fresh capture whose `before` is read from the live DOM,
 * which the previous keystroke already mutated. Replacing wholesale would
 * make the saved `before` reflect the penultimate keystroke instead of the
 * user's true pre-edit value — and the deterministic fast-path's
 * source-match (and the LLM patcher) would then fail to locate it.
 *
 * Pure: returns a new array, never mutates `prev`.
 */
export function coalesceCapturedMutation(
  prev: readonly Mutation[],
  incoming: Mutation,
): Mutation[] {
  const incomingKey = mutationIdentity(incoming)
  const existingIdx = prev.findIndex(
    (existing) => mutationIdentity(existing) === incomingKey,
  )
  if (existingIdx === -1) return [...prev, incoming]
  const next = prev.slice()
  next[existingIdx] = { ...incoming, before: prev[existingIdx].before }
  return next
}

/**
 * Whether a captured mutation should kick off a debounced branch-mode
 * dispatch (the per-keystroke immediate-write lane). Returns false — i.e.
 * the capture scheduler is SUPPRESSED — when:
 *
 *  - the kind isn't one the text/attr/style llm-patch lane handles, OR
 *  - a dispatch for this identity is already in flight (don't start a
 *    second parallel one — the buffer dedup already merged the new `after`
 *    and the in-flight dispatch reconciles post-completion), OR
 *  - the identity is already QUEUED for the AI (known-fuzzy): re-probing on
 *    every keystroke is wasted work — it stays queued and applies at commit
 *    via the LLM lane. The buffer keeps its `after` current regardless.
 *
 * Callers dispatch immediately (branch mode is the only editor edit
 * substrate); this helper owns the per-mutation suppression decision so
 * the rules are testable independent of the dispatch wiring.
 */
export function shouldProbeTextMutation(
  m: Mutation,
  refs: { inFlight: ReadonlySet<string>; queued: ReadonlySet<string> },
): boolean {
  if (m.kind !== "text" && m.kind !== "attr" && m.kind !== "style") {
    return false
  }
  const key = mutationIdentity(m)
  return !refs.inFlight.has(key) && !refs.queued.has(key)
}
