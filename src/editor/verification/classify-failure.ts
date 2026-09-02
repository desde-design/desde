/**
 * L2 failure classifier (pure).
 *
 * Given the source line the literal was written to and what the DOM
 * actually showed, label *why* a render verification failed. The taxonomy
 * matches the existing `PropEditFallbackHint` kinds so a post-hoc L2 failure
 * can re-trigger the same LLM escalation a pre-check might have missed.
 *
 * No I/O — the source line is read by the caller and passed in.
 */

import type { FailureCause } from './types'
import { isLlmFixable } from './types'
import type { CascadeOutcome } from './cascade-outcome'

export interface ClassifyInput {
  /** The source line at the edit's `sourceLoc` (1 line is enough for the binding forms). May be absent. */
  sourceLine?: string | null
  /** The prop name the edit targeted (sharpens `:propName=` vs unrelated binds). */
  propName?: string
  /** What the DOM showed at L2 — `null` means the element/value wasn't found. */
  observedValue: string | null
  expectedValue: string
  /**
   * Cascade evaluation for a style edit, when the cascade lane ran. A lost
   * cascade is a definitive answer and takes priority over every DOM-state
   * heuristic below — it is the one case where we know exactly what happened.
   */
  cascadeOutcome?: CascadeOutcome
  /** Element is present but not rendered visibly (display/visibility). */
  hidden?: boolean
}

export interface ClassifyOutput {
  cause: FailureCause
  escalatable: boolean
}

/** Escape a prop name for use inside a RegExp. */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Does the source line carry a binding form (v-model, dynamic/spread v-bind,
 * or a `:prop` bound binding) that could shadow a literal? Used by L1 to tell
 * "the value is bound" (escalatable) apart from "the write mis-targeted"
 * (hard fail) when the literal is absent from source.
 */
export function hasBindingForm(line: string, propName?: string): boolean {
  if (/\bv-model(:[\w-]+)?\s*=/.test(line)) return true
  if (/\bv-bind\s*=/.test(line) || /:\[[^\]]+\]\s*=/.test(line)) return true
  if (propName) {
    if (new RegExp(`(?::|v-bind:)${esc(propName)}\\s*=`).test(line)) return true
  }
  return /(?::|v-bind:)[\w-]+\s*=/.test(line)
}

/**
 * Classify an L2 verification failure. Binding-form detection on the source
 * line takes priority over DOM-state heuristics: a `:bound` value can still
 * render *something* in the DOM (just not our literal), so the source line is
 * the more reliable signal for the LLM-fixable cases.
 */
export function classifyFailure(input: ClassifyInput): ClassifyOutput {
  const line = input.sourceLine ?? ''
  const prop = input.propName ? esc(input.propName) : null

  // — Cascade verdict (definitive; only set by the style lane) —
  // Deliberately ahead of the binding-form heuristics: for a style edit there
  // is no "bound literal" to shadow, and a named winner beats a guess.
  if (input.cascadeOutcome && !input.cascadeOutcome.won) {
    const { reason } = input.cascadeOutcome
    if (reason === 'no-rule') return finalize('selector-missing')
    // `stale-value`: OUR rule owns the property but still declares the old
    // value — nobody outranked us, so `css-overridden` (whose remedy is "widen
    // the scope") would be wrong advice. The honest cause is an un-applied HMR.
    if (reason === 'stale-value') return finalize('hmr-stale')
    // `preview-shim`: editor's own live preview still occupies the property,
    // so nothing was measured. `verifyCascade` short-circuits this to `skipped`
    // before classification, so this branch is a belt-and-braces guard for any
    // other caller — the one thing it must never do is fall through to
    // `css-overridden`, which would advise escalating scope on no evidence.
    if (reason === 'preview-shim') return finalize('hmr-stale')
    return finalize('css-overridden')
  }
  if (input.hidden) return finalize('css-hidden')

  // — Source-line binding forms (LLM-fixable) —
  // v-model (optionally v-model:prop) shadows literal prop/text edits.
  if (/\bv-model(:[\w-]+)?\s*=/.test(line)) {
    return finalize('v-model')
  }
  // Dynamic v-bind: spread (`v-bind="obj"`) or dynamic arg (`:[name]="…"`).
  if (/\bv-bind\s*=/.test(line) || /:\[[^\]]+\]\s*=/.test(line)) {
    return finalize('dynamic-vbind')
  }
  // Bound binding for this specific prop: `:prop="expr"` or `v-bind:prop="expr"`.
  if (prop) {
    const bound = new RegExp(`(?::|v-bind:)${prop}\\s*=`)
    if (bound.test(line)) return finalize('bound-binding')
  }
  // Any bound attribute on the line, when we don't have a prop name to anchor.
  if (!prop && /(?::|v-bind:)[\w-]+\s*=/.test(line)) {
    return finalize('bound-binding')
  }

  // — DOM-state heuristics —
  if (input.observedValue === null) {
    // Element/value absent. A conditional render is the common structural cause;
    // we can't distinguish `v-if` from a wrong selector from the line alone, so
    // prefer `conditional` when the source shows a gate, else `selector-missing`.
    if (/\bv-(if|else-if|show)\b/.test(line) || /\bhidden\b/.test(line)) {
      return finalize('conditional')
    }
    return finalize('selector-missing')
  }

  // Element present, value differs but no binding form on the line: the splice
  // landed but the DOM didn't pick it up — almost always a stale/un-applied HMR.
  return finalize('hmr-stale')
}

function finalize(cause: FailureCause): ClassifyOutput {
  return { cause, escalatable: isLlmFixable(cause) }
}
