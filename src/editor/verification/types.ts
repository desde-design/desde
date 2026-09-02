/**
 * Editor Edit Verification — Tier 2 types (P1).
 *
 * "Did the edit produce the expected outcome?" — a per-edit verification
 * that runs *after* a deterministic edit applies and HMR settles. The
 * oracle is the manifest forward-hint run in reverse: attribution maps
 * DOM → prop; the same hint gives prop → DOM, so we know exactly where
 * in the live DOM to confirm the value rendered.
 *
 * These types are framework- and design-system-neutral: they import only
 * core types and contain no I/O. The bridge/source readers are injected
 * (see `verify-render.ts`), so the whole oracle is unit-testable.
 *
 * Spec: tasks/editor-edit-verification.md (P1 — deterministic L1 + L2).
 */

import type { SourceLocation } from '../core'
import type { CascadeExpectationSpec } from './cascade-outcome'

/** Where on the matched DOM element the rendered value lives. */
export interface RenderAccessor {
  kind: 'text' | 'attr' | 'style'
  /** Required for `attr` (e.g. `'placeholder'`) and `style` (e.g. `'color'`). */
  name?: string
}

/**
 * Captured at edit-dispatch time: what should be true once a deterministic
 * literal edit (prop / slot text) has applied. Derived for free from the
 * edit intent + the manifest forward-hint that `attribute()` already computed.
 */
export interface EditExpectation {
  /** Mirrors the id of the edit that produced this expectation. */
  editId: string
  /** Short human label for the surface, e.g. `label = "Submit"`. */
  label: string
  /** DOM selector for the element the value renders *into*. */
  selector: string
  /** How to read the value back off that element. */
  accessor: RenderAccessor
  /** The literal we expect to observe in the live DOM. */
  expectedValue: string
  /** Source position the literal was spliced into (L1 + classification). */
  sourceLoc?: SourceLocation
  /** File the edit rewrote, relative to the Vite root (L1 + classification). */
  targetFile?: string
  /**
   * SHA of the worktree auto-commit this edit produced, when the dispatch
   * response surfaced one. Carried through to the store record so the
   * Activity-row badge can join verification → commit. Absent for no-op
   * writes or when no auto-commit ran.
   */
  commitSha?: string
  /**
   * Cascade oracle for style/token edits. When present, L2 verifies *ownership*
   * of every property in `cascade.properties` (did the rule this edit wrote
   * win?) instead of comparing a computed value against an authored literal —
   * the latter is unreliable because computed values are normalized (`red` →
   * `rgb(255,0,0)`). Absent for prop/slot/dom-text edits, which keep the value
   * comparison.
   *
   * All of it collapses into ONE `VerificationResult` (one Checks-strip record,
   * at most one toast); a single unowned property fails the whole edit and the
   * detail names which property lost and to whom.
   */
  cascade?: CascadeExpectationSpec
  /**
   * Edit provenance. P1 only verifies `deterministic` edits; the fuzzy /
   * LLM provenance (goal → predicate) is P2.
   */
  provenance: 'deterministic'
}

export type VerificationLevel = 'L1' | 'L2' | 'L3'

/**
 * Why an L2 (DOM render) check failed. Mirrors the existing
 * `PropEditFallbackHint` taxonomy so an L2 failure can re-trigger the same
 * LLM escalation the pre-check might have missed.
 */
export type FailureCause =
  /** `:foo="expr"` — the rendered value comes from a non-literal binding. */
  | 'bound-binding'
  /** Two-way `v-model` binding shadows the literal. */
  | 'v-model'
  /** `v-bind="…"` spread or `:[name]="…"` dynamic bind. */
  | 'dynamic-vbind'
  /** Element gated by `v-if` / `v-show` / `hidden` — not in the DOM. */
  | 'conditional'
  /** Present in the DOM but not visible (display/visibility/clip). */
  | 'css-hidden'
  /**
   * The edit's own CSS rule lost the cascade: it is in source and parses, but
   * another rule (usually design-system CSS shipping its own `!important`)
   * owns the property. Escalating the edit's SCOPE fixes this, not an LLM
   * rewrite — so it is deliberately absent from `LLM_FIXABLE_CAUSES`.
   */
  | 'css-overridden'
  /** Timed out with the element present but value unchanged — HMR didn't apply. */
  | 'hmr-stale'
  /** The read-back element could not be found at all. */
  | 'selector-missing'
  /** No structural cause could be determined. */
  | 'unknown'

/**
 * Failure causes the existing one-shot LLM fallback lane
 * (`source-aware-text-edit-prompt.ts`) can plausibly repair. An L2 failure
 * with one of these is *escalatable* — i.e. worth surfacing as "ask chat to
 * fix it" — but nothing auto-escalates for direct-manip edits (see
 * `tasks/editor-edit-verification.md`).
 */
export const LLM_FIXABLE_CAUSES: readonly FailureCause[] = [
  'bound-binding',
  'v-model',
  'dynamic-vbind',
]

export function isLlmFixable(cause: FailureCause): boolean {
  return LLM_FIXABLE_CAUSES.includes(cause)
}

export interface VerificationResult {
  editId: string
  /** `skipped` = no oracle could be derived (we don't claim what we can't check). */
  status: 'pass' | 'fail' | 'skipped'
  /** Which ladder level failed (only set when `status === 'fail'`). */
  failedAt?: VerificationLevel
  expectedValue: string
  /** What the DOM actually showed at L2 (when it was read). */
  observedValue?: string | null
  /** Classified cause of an L2 failure. */
  cause?: FailureCause
  /**
   * True when `cause` is one chat's LLM lane could plausibly fix (decision
   * 1's classification). Informational only — nothing auto-escalates for
   * direct-manip edits; see `tasks/editor-edit-verification.md`.
   */
  escalatable: boolean
  /**
   * Why a `skipped` result was skipped (L3 goal path only; unset for L1/L2):
   *   - `unmeasurable` — the goal maps to no measurable predicate, or nothing
   *     could be measured (aesthetic → fall back to the vision judge).
   *   - `unreadable`   — the element couldn't be read off the live DOM.
   *   - `translate-error` — the LLM translate step failed for an infrastructure
   *     reason (auth / refusal / bad output). Callers should surface this as an
   *     actionable error, NOT a benign "use a screenshot" skip.
   */
  skipReason?: 'unmeasurable' | 'unreadable' | 'translate-error'
  /** Human-readable summary for the Checks tab / inline cue. */
  detail: string
  /** Wall-clock the verification took, ms. */
  durationMs: number
}
