/**
 * Stage A of the Phase 3 attribution cutover (see
 * `tasks/attribution-rewrite.md`): map an {@link AttributionResult} to a
 * shell dispatch decision.
 *
 * Scope is deliberately conservative. Only `direct` + `editKind: 'prop'`
 * is routed through `attribute()`'s manifest-resolved source location —
 * that is the case where manifest-first attribution is strictly better
 * than the legacy heuristic walk (it pins the consumer call site
 * deterministically). Every other result kind returns `fallback`, which
 * tells the caller to run today's legacy walk-derived dispatch:
 *
 *   - `direct`/`slot`  → legacy `setElementText` → `applySlotTextEdit`
 *     already handles same-component slot text correctly; re-routing it
 *     through the result loc would bypass the bridge mutation buffer for
 *     no behavioral gain.
 *   - `cross-file`     → the legacy prop path already reaches the LLM
 *     lane for bound expressions (`applyPropEdit` bound-binding hint →
 *     `tryPropEditLLMFallback`). Targeted cross-file dispatch (aiming the
 *     LLM at the binding's definition site) is a deferred refinement.
 *   - `llm`            → legacy reaches the same LLM lane.
 *   - `refuse`         → legacy walk dispatch — the load-bearing fallback
 *     for plain template content (interpolation, v-for rows, plain
 *     literal text) that manifest-first attribution correctly declines.
 *
 * Pure: no I/O, no DOM. One decision per {@link AttributionResult} kind.
 */

import type { EditableTextField } from '@/types/bridge'
import type { AttributionResult, RenderSite } from './types'

/**
 * Which editable-text fields Stage A routes through manifest-first
 * `attribute()` vs. leaves on the legacy walk dispatch.
 *
 * Override candidates are the element's own top-level text (`dom-text`)
 * and the fields synthesized by the legacy *upward* prop-emission walk
 * (`prop:*` / `ancestor-prop:*`) — the walk Stage B deletes. The
 * deterministic same-component fields that walk also emits — `slot-text:*`
 * (slot leaves) and `child-prop:*` (library-component prop attribution) —
 * already carry their own resolved `editTarget`, so they are NOT
 * re-routed and Stage A cannot regress paths Stage B keeps.
 *
 * Field-id prefixes match `findEditableTextFields` in
 * `src/bridge/comment-bridge.ts`; this predicate is the one place that
 * knows that taxonomy, kept beside the routing decision it gates.
 */
export function isAttributionOverrideCandidate(
  field: EditableTextField,
): boolean {
  return (
    field.id === 'dom-text' ||
    field.id.startsWith('prop:') ||
    field.id.startsWith('ancestor-prop:')
  )
}

export type AttributionRouteDecision =
  | {
      kind: 'prop-edit'
      /** File whose `<Tag propName=…>` will be rewritten. */
      targetFile: string
      line: number
      column: number
      propName: string
      /** Current value, for display / coercion reference. */
      currentValue: string
      valueType: 'string' | 'number' | 'boolean'
      /** Where the prop renders in the DOM — Tier-2 verification read-back. */
      renders?: RenderSite
    }
  /** Run the caller's existing (legacy) dispatch for this field. */
  | { kind: 'fallback'; reason: string }

export function routeAttributionResult(
  result: AttributionResult,
): AttributionRouteDecision {
  if (
    result.kind === 'direct' &&
    result.editKind === 'prop' &&
    result.propName
  ) {
    return {
      kind: 'prop-edit',
      targetFile: result.targetFile,
      line: result.sourceLoc.line,
      column: result.sourceLoc.column,
      propName: result.propName,
      currentValue: result.currentValue,
      valueType: result.valueType,
      ...(result.renders ? { renders: result.renders } : {}),
    }
  }

  let reason: string
  switch (result.kind) {
    case 'direct':
      // editKind === 'slot' (or a prop result missing propName).
      reason = `direct ${result.editKind} edit handled by the legacy dispatch path`
      break
    case 'cross-file':
      reason = `cross-file:${result.pattern} deferred to the legacy LLM lane (targeted dispatch not wired)`
      break
    case 'llm':
      reason = result.reason
      break
    case 'refuse':
      reason = result.reason
      break
  }
  return { kind: 'fallback', reason }
}
