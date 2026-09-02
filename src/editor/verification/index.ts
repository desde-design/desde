/**
 * Editor Edit Verification (Tier 2) — public surface.
 *
 * Deterministic-first render verification for Editor edits. See
 * tasks/editor-edit-verification.md.
 */

export type {
  RenderAccessor,
  EditExpectation,
  VerificationLevel,
  FailureCause,
  VerificationResult,
} from './types'
export { LLM_FIXABLE_CAUSES, isLlmFixable } from './types'
export { deriveExpectation } from './derive-expectation'
export type { ExpectationInput } from './derive-expectation'
export { classifyFailure } from './classify-failure'
export type { ClassifyInput, ClassifyOutput } from './classify-failure'
export { verifyRender } from './verify-render'
export type { VerifyDeps } from './verify-render'
export { orchestrateVerification } from './orchestrate'
export type { OrchestrateCallbacks, OrchestrateDeps } from './orchestrate'
export type {
  CascadeExpectationSpec,
  CascadeOutcome,
  CascadeOwner,
  CascadePropertyExpectation,
  CascadePropertyOutcome,
  CascadeSinglePropertySpec,
  CascadeVerification,
} from './cascade-outcome'
export {
  declarationIsImportant,
  describeCascadeWinner,
  evaluateCascadeOutcome,
  evaluateCascadeVerification,
  wouldLoseToImportant,
} from './cascade-outcome'
export { EXPANDABLE_SHORTHANDS, expandStyleDeclarations } from './style-shorthands'
export type { ExpandedDeclaration } from './style-shorthands'
// L3a — goal → predicate verification (P2)
export {
  noOverflow,
  fitsViewport,
  aligned,
  bboxMatches,
  contrastRatio,
  contrastRatioValue,
  parseCssColor,
  textEquals,
  evaluatePredicate,
  needsSecondElement,
} from './predicates'
export type {
  Measurements,
  PredicateName,
  PredicateArgs,
  PredicateOutcome,
  AlignAxis,
} from './predicates'
// NOTE: `translateGoal` (the value) is intentionally NOT re-exported here. It
// statically imports the LLM-provider registry (`getProvider`), which pulls in
// the server-only `@anthropic-ai/claude-agent-sdk` — and this barrel is imported
// by the browser Editor UI (for the P1 verification types + the pure
// predicates). Re-exporting it would drag the Node-only SDK (shebang and all)
// into the browser bundle and break `build:ui`. Server-side callers import it
// directly: `import { translateGoal } from '@/editor/verification/translate-goal'`.
// `verifyGoal` is barrel-safe — it type-imports translate-goal and takes the
// `translate` fn as an injected dep, so it never imports the registry.
export type {
  TranslateGoalInput,
  TranslateGoalResult,
  TranslatedPredicate,
} from './translate-goal'
export { buildTranslateGoalPrompt } from './translate-goal-prompt'
export type {
  TranslateGoalPrompt,
  TranslateGoalPromptInput,
} from './translate-goal-prompt'
export { verifyGoal } from './verify-goal'
export type {
  GoalVerificationInput,
  VerifyGoalDeps,
  TranslateResult,
} from './verify-goal'
