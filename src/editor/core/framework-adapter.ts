/**
 * Framework-side abstraction. One implementation per supported frontend
 * framework (Vue 3, React, Angular, Svelte, ...). The adapter wraps the
 * postMessage protocol against the prototype iframe and exposes a
 * normalized API the inspector consumes.
 *
 * Adapter responsibilities are intentionally limited: selection state
 * (read + write), edit dispatch, and lifecycle. Component metadata
 * (props, variants, slots) is the job of the
 * {@link ComponentManifestSource} paired with this adapter for a given
 * (framework, design-system) combination.
 *
 * **Edit history is editor-shell-owned, not adapter-owned.** Adapters
 * are stateless with respect to undo/redo. Editor maintains the edit
 * stack itself, dispatching `applyEdit(structuralEdit)` for both
 * forward edits and inverse (undo) edits. Adapters help by returning
 * an `inverse` in {@link EditResult} when one can be computed at apply
 * time (e.g., a `DeleteEdit` returns the inverse "insert this snapshot
 * back at this index"). When `inverse` is absent the editor marks
 * that step as not undoable.
 *
 * **Agent orchestration is editor-shell-owned, not adapter-owned.**
 * Adapters do not accept {@link AgentRequest}. The orchestrator
 * interprets the prompt and produces structural edits that flow
 * through `applyEdit` like any other.
 */

import type { FrameworkId } from './manifest'
import type { AdapterTarget, Selection } from './selection'
import type {
  DisambiguationChoice,
  Mutation,
  PendingMutation,
  StructuralEdit,
} from './edit'
import type {
  Measurements,
  OutlineNode,
  PreviewFailureKind,
  StyleOrigin,
} from '@/types/bridge'

/**
 * Per-call options passed to `applyEdit`. Optional and additive —
 * callers that don't need progress callbacks omit it and the adapter
 * behaves as before.
 *
 * When the `llm-patch` lane runs on the server, the adapter requests
 * SSE and pipes the streaming events through these callbacks so the
 * save dialog can render live LLM output instead of blanking for 5–95s.
 */
export interface ApplyEditOpts {
  /**
   * Fired once with server-authoritative info when the LLM actually
   * starts (after the deterministic fast-path is bypassed). Includes
   * the model id and mutation count.
   */
  onLLMStreamStart?: (info: {
    model: string
    mutationCount: number
  }) => void
  /**
   * Fired for each text-delta the LLM produces. Concatenate to display
   * the response as it's generated.
   */
  onLLMStreamDelta?: (delta: string) => void
}

/**
 * Trace info surfaced when the LLM ran on the server. The save dialog
 * (`save-progress-dialog.tsx`) renders this verbatim. Defined here rather
 * than in the CLI's edit handler so adapters and consumers (tests, other
 * non-CLI callers) can reference the shape without importing server-only
 * code — there is no web Next.js route anymore for this to be "the route's"
 * type (removed 2026-06-04, see tasks/web-editor-removal.md); the CLI's
 * `editor-cli/src/server/edit-handler.ts` is the single dispatcher today.
 */
export interface SaveLLMTrace {
  outcome: 'applied' | 'failed'
  model: string
  latencyMs: number
  mutationCount: number
  mutationSummary: Array<{
    id: string
    kind: string
    sourceLoc: string | null
    target?: string
    before: string
    after: string
  }>
  truncated: boolean
  perMutationOutcomes?: Array<{
    mutationId: string
    outcome: 'applied' | 'skipped' | 'refused'
    reason?: string
  }>
  notes?: string
}

/**
 * Result of applying a {@link StructuralEdit}. The adapter populates
 * `appliedEditId`, `affectedTargetIds`, and (when computable) `inverse`
 * so the editor-shell history stack can support undo/redo without
 * the adapter holding state.
 */
export type EditResult =
  | {
      kind: 'applied'
      /** Mirrors the input edit's id. */
      appliedEditId: string
      /**
       * Targets affected by this edit. Editor uses this to invalidate
       * derived state (selection, manifest cache) for the right scope.
       */
      affectedTargetIds: string[]
      /**
       * Inverse edit, when the adapter can compute one. Editor pushes
       * this onto its history stack and dispatches it via `applyEdit`
       * to undo. Absent when the edit is non-invertible (e.g.,
       * `IntentEdit` overwrites prior intent — to undo, editor would
       * need a snapshot of the prior value, which the adapter may not
       * have captured).
       */
      inverse?: StructuralEdit
      /**
       * Per-file SHA-256 hashes (relative path → hex digest) of every
       * source file the edit touched, post-write. Returned by the
       * `llm-patch` route so the shell can carry the value forward as
       * `baseHashes` on the next save (Phase E external-edit guard).
       * Absent for edit kinds that don't compute hashes.
       */
      newHashes?: Readonly<Record<string, string>>
      /**
       * Trace info surfaced when the LLM ran (omitted for the
       * deterministic fast-path). The save dialog renders this verbatim
       * so the designer can see what the model was asked to do and what
       * it produced. Shape mirrors the server's `LLMTrace`.
       */
      llmTrace?: SaveLLMTrace
      /**
       * SHA of a commit this edit produced. Branch mode (the only
       * substrate) never auto-commits — every edit lands as an ordinary
       * uncommitted working-tree change, and the user commits everything
       * at once via the top-bar Commit — so no adapter sets this today; it
       * is always absent. Kept optional (not deleted) rather than treated
       * as dead: dropping it would be a type-shape change for the sake of
       * a currently-unused value, and it's where a future substrate that
       * DOES commit per-edit would put the sha. See the 2026-08-08 audit
       * and `adapters/bridge/index.ts`'s matching note on why this
       * adapter never sets it.
       */
      commitSha?: string
      /**
       * Set when a deterministic applicator refused and the server's
       * source-aware LLM fallback lane applied the edit instead (currently
       * only the `prop` edit kind wires this through). The save/inline-edit
       * UI surfaces this so the designer knows the value on disk came from
       * the AI fallback, not a straight deterministic splice.
       */
      fallbackUsed?: 'source-aware-llm' | 'agent-mini-turn'
      /**
       * Notes from the source-aware LLM fallback (present alongside
       * `fallbackUsed`). Mirrors the CLI edit-handler's `notes` field.
       */
      notes?: string
    }
  | { kind: 'cancelled' }
  | {
      kind: 'failed'
      reason: string
      /**
       * Populated when the route returned 409 `external-edit-conflict`.
       * Each entry names a file whose pre-write hash didn't match the
       * client's `baseHashes` value. The shell surfaces this in the
       * panel with reload / force-overwrite recovery actions.
       */
      conflicts?: ReadonlyArray<{
        file: string
        expected: string
        actual: string
      }>
      /**
       * Set when the server stopped at the deterministic boundary in
       * `'chat'` fallback mode (per-edit `llmFallback: 'chat'`): the edit
       * couldn't be applied deterministically and should be handed to
       * the chat agent rather than the in-modal LLM patch lane. The
       * caller routes it via `escalateToChat` instead of surfacing
       * `reason` as a save error.
       */
      needsChat?: boolean
    }

/** Subscription handle returned by adapter event subscribers. Call to unsubscribe. */
export type AdapterSubscription = () => void

/**
 * A live-preview poke the substrate could not apply. See
 * {@link FrameworkAdapter.onOverridePreviewFailed}.
 *
 * `kind` distinguishes the two poke lanes (typed prop vs fallthrough
 * attribute) because they fail for different substrate reasons and the two
 * are separately addressable by the designer. `reason` is the bridge's own
 * wording; it is optional only so a bridge older than the one that started
 * sending it degrades to a generic notice rather than an empty one.
 *
 * `cause` is WHY it failed, and it is what decides whether the failure is worth
 * telling the user about at all: a `'unsupported-substrate'` cause is a
 * capability gap that fires on every single poke (see {@link PreviewFailureKind}),
 * so surfacing it would be a false alarm on edits that worked. Optional for the
 * same reason as `reason` — a pre-2026-08-06i bridge sends none, and an absent
 * cause is treated as a genuine failure, which is the fail-safe direction.
 */
export interface OverridePreviewFailure {
  kind: 'prop' | 'attr'
  selector: string
  /** The prop or attribute name the poke targeted. */
  name: string
  reason?: string
  cause?: PreviewFailureKind
}

/** A `data-desde-src` source location (`file:line:column`). */
export interface SourceLoc {
  file: string
  line: number
  column: number
}

/**
 * A direct-manipulation drag-to-move drop (Phase 2). Carries the dragged
 * element's + destination container's source locations and the 0-based
 * insertion index. The shell builds a `move` StructuralEdit from this.
 */
export interface DragMoveRequest {
  sourceSelector: string
  sourceEditTarget: SourceLoc
  destParentSelector: string
  destParentEditTarget: SourceLoc
  destIndex: number
  /** True when the dragged element is v-for/map-rendered (shell refuses). */
  sourceIsIterated: boolean
  /** True when the destination container is v-for/map-rendered (shell refuses). */
  destIsIterated: boolean
}

/**
 * A direct-manipulation insert-at-point placement (Phase 3). The shell inserts
 * its pending palette snippet into `parentEditTarget` at `destIndex`.
 */
export interface InsertAtPointRequest {
  parentSelector: string
  parentEditTarget: SourceLoc
  destIndex: number
  /** True when the resolved container is v-for/map-rendered (shell refuses). */
  parentIsIterated: boolean
}

/**
 * A direct-manipulation drag-to-resize release (Phase 4). The shell applies the
 * quantized `widthClass` to the element at `editTarget` via the class-edit path.
 */
export interface ResizeRequest {
  selector: string
  editTarget: SourceLoc
  widthClass: string
}

export interface FrameworkAdapter {
  /** Identifies which framework this adapter handles. */
  readonly framework: FrameworkId

  // ---------- Lifecycle ----------

  /** Connect to a prototype iframe. Idempotent; subsequent calls without dispose are no-ops. */
  init(target: AdapterTarget): Promise<void>

  /** Disconnect from the iframe. Removes listeners, clears caches. */
  dispose(): Promise<void>

  /**
   * Toggle whether the editor is actively intercepting pointer events
   * in the iframe. Used by Preview mode: with `active === false`, clicks
   * and hovers pass through to the prototype so the designer can drive
   * the prototype's own state (navigate, open menus, change variants).
   * Selection state, listeners, and the bridge connection are preserved
   * — only the bridge's interception flags are flipped.
   */
  setActive(active: boolean): Promise<void>

  // ---------- Selection ops (write) ----------

  /**
   * Resolve and select the element matching the given selector. Used by the
   * layers panel to drive selection from a tree click; the selector is the
   * `OutlineNode.selector` returned by {@link getStructure}.
   */
  selectBySelector(selector: string): Promise<Selection | null>

  /**
   * Phase 6 — resolve and select multiple elements by selector. Returns
   * one `Selection` per resolved selector (in input order). The bridge
   * adapter is expected to update its own `selectedElement` to the
   * FIRST entry so the existing single-selection inspector path stays
   * coherent; the full list is returned so the shell can populate
   * `editorSelectionMany`.
   *
   * Adapters that don't support multi-select may throw — callers must
   * handle (the chat surface that uses this is feature-gated on
   * adapter capability).
   */
  selectMany(selectors: readonly string[]): Promise<Selection[]>

  /** Ascend to the parent of the current selection. */
  selectParent(): Promise<Selection | null>

  /** Clear the current selection. */
  clearSelection(): Promise<void>

  /**
   * Non-committal hover preview. Asks the bridge to draw a transient
   * highlight on the matching element without dispatching a selection
   * change. `selector: null` clears any active preview. Used by the
   * layers panel to mirror tree-row hover into the iframe.
   */
  previewHighlight(selector: string | null): void

  // ---------- Tree introspection ----------

  /**
   * Snapshot the prototype's component / element outline for the layers
   * panel. Each node carries `selector`, which editor dispatches via
   * `INSPECT_SELECTOR` to drive selection from the panel. Re-call after
   * `onTreeUpdate` fires.
   */
  getStructure(): Promise<OutlineNode[]>

  /**
   * Tier-2 edit verification (optional): read the current rendered value at a
   * selector off the live DOM, so the shell can confirm a deterministic edit
   * actually took effect. `accessor.kind` selects `textContent` / an attribute
   * / a computed-style property. Resolves `null` when the selector matches
   * nothing or the accessor has no value. Adapters that don't implement it
   * simply opt out of render verification (the shell reports `skipped`).
   *
   * See tasks/editor-edit-verification.md (P1).
   */
  readRenderedValue?(
    selector: string,
    accessor: { kind: 'text' | 'attr' | 'style'; name?: string },
  ): Promise<string | null>

  /**
   * Whether the connected runtime/bridge actually supports
   * {@link readRenderedValue}. Callers MUST gate on this before treating a
   * read result as meaningful — an unsupported bridge would otherwise return
   * `null` and produce a false verification failure. Absent ⇒ assume the
   * capability tracks `readRenderedValue`'s presence.
   */
  supportsRenderedValueRead?(): boolean

  /**
   * Style-cascade verification (optional): resolve which CSS rule owns each of
   * `properties` on the element at `selector`, including the `var(--…)` chain
   * and any inline declaration. Backed by the bridge's cascade walk
   * (`GET_STYLE_PROVENANCE`).
   *
   * Contract: must not throw. Resolve `{}` (or a partial map) for a SUCCESSFUL
   * read that simply found no origin — e.g. the selector matched nothing —
   * and `null` when the read itself FAILED (timeout, disposal, unsupported
   * bridge) and the answer is unknown. Callers must report an unknown answer as
   * `skipped`, never as a verification failure. Adapters that don't implement
   * this method at all opt out of cascade verification entirely.
   */
  getStyleProvenance?(
    selector: string,
    properties: readonly string[],
  ): Promise<Record<string, StyleOrigin> | null>

  /**
   * Whether the connected bridge implements {@link getStyleProvenance}.
   * Callers MUST gate on this: an older bridge silently drops the request, and
   * a timed-out read would otherwise look like "nobody owns this property" —
   * a false verification failure on a successful edit.
   */
  supportsStyleProvenance?(): boolean

  /**
   * Tier-2 verification P2: read live geometry + a small computed-style subset
   * at a selector so the shell can judge a fuzzy goal against a measurable
   * predicate. Resolves `null` on no-match / timeout / unsupported bridge.
   * Optional — adapters without it opt out of goal verification.
   *
   * See tasks/editor-edit-verification.md (P2). `Measurements` is the wire
   * shape in `src/types/bridge.ts`; the predicates consume it
   * (`src/editor/verification/predicates.ts`).
   */
  readMeasurements?(selector: string): Promise<Measurements | null>

  /**
   * Whether the connected runtime/bridge actually supports
   * {@link readMeasurements}. Gate on this before relying on a read. Absent ⇒
   * assume the capability tracks `readMeasurements`'s presence.
   */
  supportsMeasurementsRead?(): boolean

  // ---------- Edit dispatch ----------

  /**
   * Apply a structural edit to the prototype source. Accepts only
   * {@link StructuralEdit} — agent prompts go through the editor's
   * agent orchestrator, not this method.
   */
  applyEdit(edit: StructuralEdit, opts?: ApplyEditOpts): Promise<EditResult>

  // ---------- DOM-edit mode (Phase A0+) ----------
  //
  // Adapter is a thin bridge proxy here: it forwards messages to/from
  // the iframe-side capture machinery and emits {@link Mutation}s via
  // subscriptions. The MutationLog itself lives in the editor shell —
  // it accumulates by subscribing to {@link onMutationCaptured} and
  // owns drop / dispatch / verification. This split keeps the log alive
  // across adapter dispose+reinit cycles (e.g., during HMR or iframe
  // navigation), which is the whole point of "shell accumulates."

  /**
   * Exit DOM-edit mode. Bridge tears down `contentEditable` and the
   * `MutationObserver`. Pending mutations awaiting disambiguation are
   * dropped. The shell-owned MutationLog is unaffected — call
   * `exitDomEditMode` when the designer wants to leave capture mode
   * without losing what they've already captured.
   */
  exitDomEditMode(): Promise<void>

  /**
   * Subscribe to fully-resolved captured mutations. The shell composes
   * its MutationLog by appending each emitted mutation; it never reads
   * back through the adapter.
   */
  onMutationCaptured(listener: (mutation: Mutation) => void): AdapterSubscription

  /**
   * Subscribe to v-for ambiguity prompts. The shell shows a blocking
   * inline prompt (or modal) and resolves via
   * {@link resolveMutationDisambiguation}. Until then, the bridge holds
   * the underlying change without emitting a {@link Mutation}.
   */
  onMutationAwaitingDisambiguation(
    listener: (pending: PendingMutation) => void,
  ): AdapterSubscription

  /**
   * Resolve an awaiting-disambiguation mutation. `'this-instance'` and
   * `'all-instances'` promote it to a {@link Mutation} and emit via
   * {@link onMutationCaptured}; `'cancel'` drops it.
   */
  resolveMutationDisambiguation(
    pendingId: string,
    choice: DisambiguationChoice | 'cancel',
  ): void

  /**
   * Subscribe to capture failures (e.g., `resolutionKind === 'none'`,
   * or unsupported mutation kind). Surfaced to the designer as a
   * non-blocking notice; never silently retargeted.
   */
  onResolutionFailed(
    listener: (failure: { id: string; reason: string; selector: string }) => void,
  ): AdapterSubscription

  /**
   * Subscribe to live-preview pokes that did NOT land — the substrate had no
   * component instance for the selector, exposed no props, or refused the
   * assignment (see {@link applyPropOverride} / {@link applyAttrOverride}).
   *
   * Distinct from {@link onOverrideReverted}: nothing was ever applied, so
   * there is no shim to take back. The buffered edit still dispatches to
   * source; what's missing is the designer's instant feedback. Without a
   * subscriber the poke's `ok: false` was discarded and a control that
   * visibly did nothing looked broken — the same silent-failure shape as an
   * unsubscribed {@link onResolutionFailed}.
   *
   * Fires only on failure. Successful pokes need no consumer.
   */
  onOverridePreviewFailed(
    listener: (failure: OverridePreviewFailure) => void,
  ): AdapterSubscription

  /**
   * WS3 closed-loop transactions (tasks/edit-pipeline-rearchitecture.md).
   * Tell the bridge how a dispatched edit resolved so it can release the
   * live-preview override it's holding for `id` — `'confirmed'` (the write
   * landed and, when checked, rendered from source), `'failed'` (the
   * dispatch was refused/threw; the bridge should already have reverted
   * the DOM to `before`), or `'ineffective'` (the write landed on disk but
   * the rendered DOM never picked it up — e.g. shadowed by a binding; the
   * bridge releases the override without reverting since the source edit
   * is real, just not the thing the designer saw).
   *
   * `id` matches a {@link Mutation}'s own `id` (the bridge auto-registers
   * an override per captured text/attr/class mutation) or an `overrideId`
   * the caller passed when it applied a prop-preview override. Calling
   * this with an id the bridge never registered (older bridge, or a
   * preview that opted out of tracking) is a no-op — always safe to call
   * unconditionally after every dispatch outcome.
   */
  resolveOverride(
    id: string,
    outcome: 'confirmed' | 'failed' | 'ineffective',
    reason?: string,
  ): void

  /**
   * Subscribe to bridge-initiated override reverts (WS3). Fires when a
   * dispatch the shell hasn't resolved yet gets superseded by the bridge's
   * own revert (e.g. the override's target re-rendered from source while
   * still pending) or, more commonly, mirrors a `'failed'` resolution back
   * with the restored `before` value already applied. The shell surfaces
   * this as a per-edit inline failure instead of the legacy shared-ID
   * status toast.
   */
  onOverrideReverted(
    listener: (event: {
      id: string
      kind: string
      selector: string
      reason: string
    }) => void,
  ): AdapterSubscription

  /**
   * Subscribe to override-confirmation timeouts (WS3): the bridge kept an
   * override live (didn't revert it) but couldn't confirm — within its own
   * budget — that the DOM is now rendering the value from source. Not a
   * failure; HMR can legitimately be slow. The shell surfaces a subtle,
   * non-blocking indicator.
   */
  onOverrideUnverified(
    listener: (event: { id: string; kind: string; selector: string }) => void,
  ): AdapterSubscription

  /**
   * Subscribe to a direct-manipulation drag-to-move drop (Phase 2 of
   * tasks/editor-direct-manipulation.md). The shell turns the request into
   * the same `move` StructuralEdit the Layers-panel drag produces. Source
   * locations are framework-neutral `data-desde-src` coordinates.
   */
  onDragMoveCommitted(
    listener: (move: DragMoveRequest) => void,
  ): AdapterSubscription

  /**
   * Enter / exit direct-manipulation insert-at-point placement mode (Phase 3).
   * `enterInsertPlacement(label)` puts the bridge in click-to-place mode for a
   * pending palette snippet; the placement click emits via
   * {@link onInsertAtPoint}. `exitInsertPlacement()` cancels.
   */
  enterInsertPlacement(label: string): void
  exitInsertPlacement(): void

  /** Subscribe to insert-at-point placement clicks. */
  onInsertAtPoint(
    listener: (req: InsertAtPointRequest) => void,
  ): AdapterSubscription

  /** Subscribe to drag-to-resize releases (Phase 4). The shell applies the
   *  quantized width class via the class-edit path. */
  onResizeCommitted(
    listener: (req: ResizeRequest) => void,
  ): AdapterSubscription

  // ---------- Subscriptions ----------

  /** Subscribe to selection changes. */
  onSelectionChange(listener: (selection: Selection | null) => void): AdapterSubscription

  /** Subscribe to component-tree updates (e.g., when the prototype re-renders). */
  onTreeUpdate(listener: () => void): AdapterSubscription
}
