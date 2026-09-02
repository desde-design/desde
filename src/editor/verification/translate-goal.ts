/**
 * Goal → predicate translator (Tier-2 verification P2).
 *
 * The ONE LLM touch in the L3a ladder. It compiles a fuzzy / NL visual goal
 * into a list of `{ predicate, args }` drawn from the fixed catalog
 * (`translate-goal-prompt.ts`). It NEVER judges the result — deterministic code
 * (`predicates.ts`) does that. Keeping the translate step LLM-only and the
 * judge step code-only is the load-bearing boundary of this whole feature.
 *
 * Pure of side effects beyond the injected provider call. Tests pass a mock
 * `CompletionProvider`; production uses the registry default. Mirrors
 * `repair-edit.ts` (provider DI, json_schema, parsed-undefined guard).
 *
 * Spec: tasks/editor-edit-verification.md (P2, decision 2).
 */

import { getProvider } from '../llm-providers/registry'
import type { CompletionProvider } from '../llm-providers/types'
import type { AlignAxis, PredicateArgs, PredicateName } from './predicates'
import {
  buildTranslateGoalPrompt,
  type TranslateGoalPromptInput,
} from './translate-goal-prompt'

/** A predicate the translator chose, ready for `evaluatePredicate`. */
export interface TranslatedPredicate {
  predicate: PredicateName
  args: PredicateArgs
}

export interface TranslateGoalInput extends TranslateGoalPromptInput {
  /** Optional LLM provider injection (tests pass a fake). */
  provider?: CompletionProvider
  /**
   * Model id. When omitted, the PROVIDER's own `defaultModel` is used (Anthropic
   * / claude_code → sonnet, OpenAI → its default) — NOT a hardcoded Claude model,
   * which a non-Anthropic provider would reject. Pass one only to override.
   */
  model?: string
  /** Max output tokens. Default 1000 — the output is a tiny predicate list. */
  maxTokens?: number
  /** Forwarded to the provider so a cancelled turn aborts the call. */
  signal?: AbortSignal
}

export type TranslateGoalResult =
  | { ok: true; predicates: TranslatedPredicate[] }
  | {
      ok: false
      reason: string
      /**
       * Why translation failed — so callers don't conflate a genuine
       * non-measurable goal with an infrastructure failure:
       *   - `unmeasurable` — the goal is valid but maps to no predicate (purely
       *     aesthetic) → the caller should fall back to the vision judge.
       *   - `error` — an LLM/provider/parse failure (auth, refusal, bad JSON,
       *     empty input). Surfaces as an actionable error, NOT a benign skip.
       */
      kind: 'unmeasurable' | 'error'
    }

const PREDICATE_NAMES: readonly PredicateName[] = [
  'noOverflow',
  'fitsViewport',
  'aligned',
  'bboxMatches',
  'contrastRatio',
  'textEquals',
]
const ALIGN_AXES: readonly AlignAxis[] = [
  'left',
  'right',
  'top',
  'bottom',
  'centerX',
  'centerY',
]

const TRANSLATE_RESPONSE_SCHEMA = {
  type: 'object' as const,
  required: ['predicates'] as const,
  additionalProperties: false,
  properties: {
    predicates: {
      type: 'array' as const,
      description:
        'The measurable predicates to check for this goal. Empty when the goal maps to none (purely aesthetic).',
      items: {
        type: 'object' as const,
        required: ['predicate'] as const,
        additionalProperties: false,
        properties: {
          predicate: { type: 'string' as const, enum: [...PREDICATE_NAMES] },
          args: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              other: {
                type: 'string' as const,
                description: 'CSS selector of the second element (aligned / bboxMatches).',
              },
              axis: { type: 'string' as const, enum: [...ALIGN_AXES] },
              tol: { type: 'number' as const },
              min: { type: 'number' as const },
              expected: { type: 'string' as const },
            },
          },
        },
      },
    },
  },
}

interface RawPredicate {
  predicate?: unknown
  args?: unknown
}

/**
 * Keep only the args keys we recognize, with correct types AND sane ranges.
 * A nonsensical numeric (negative `tol` → guaranteed false-fail; `min <= 0` →
 * always-pass contrast) is dropped, not accepted — the predicate then falls
 * back to its safe default rather than inheriting a poisoned threshold. This
 * is the LLM trust boundary; the providers don't enforce schemas strictly.
 */
function sanitizeArgs(raw: unknown): PredicateArgs {
  const out: PredicateArgs = {}
  if (!raw || typeof raw !== 'object') return out
  const a = raw as Record<string, unknown>
  if (typeof a.other === 'string') out.other = a.other
  if (typeof a.axis === 'string' && (ALIGN_AXES as readonly string[]).includes(a.axis)) {
    out.axis = a.axis as AlignAxis
  }
  // Tolerance is a non-negative pixel distance.
  if (typeof a.tol === 'number' && Number.isFinite(a.tol) && a.tol >= 0) out.tol = a.tol
  // WCAG contrast ratios live in [1, 21]; a min below 1 would false-pass any
  // text and above 21 would false-fail everything, so reject out-of-range
  // values → the predicate falls back to its safe 4.5 default.
  if (typeof a.min === 'number' && Number.isFinite(a.min) && a.min >= 1 && a.min <= 21) out.min = a.min
  if (typeof a.expected === 'string') out.expected = a.expected
  return out
}

/**
 * Whether a translated predicate has the args it can't be judged without. A
 * predicate that would only ever degrade to `indeterminate` downstream is
 * dropped here so a malformed translation falls to the vision-judge path
 * instead of masquerading as a measurable goal.
 */
function hasRequiredArgs(name: PredicateName, args: PredicateArgs): boolean {
  switch (name) {
    case 'aligned':
      return !!args.other && !!args.axis
    case 'bboxMatches':
      return !!args.other
    case 'textEquals':
      return args.expected != null
    default:
      return true
  }
}

/**
 * Whether the goal text names `selector` as a WHOLE token (not a substring) —
 * so `align with .header` grounds `.header` but not `.head`. Tokens are split on
 * whitespace and stripped of surrounding quotes/punctuation, then compared
 * exactly. A multi-part selector (e.g. `.card .title`) won't match a single
 * token and is conservatively dropped (→ skip), which is the safe direction.
 */
function goalNamesSelector(goal: string, selector: string): boolean {
  // Strip surrounding quotes/parens + trailing sentence punctuation. A trailing
  // `.` is safe to strip because no valid selector ENDS in a dot (a class needs
  // a name after it), so it can only be a sentence period — fixes "...with
  // .header." Leading `.`/`#`/`[` are preserved (they're part of the selector).
  const strip = (t: string): string => t.replace(/^["'`(]+|["'`),.;:!?]+$/g, '')
  return goal.split(/\s+/).some((tok) => strip(tok) === selector)
}

export async function translateGoal(
  input: TranslateGoalInput,
): Promise<TranslateGoalResult> {
  const {
    goal,
    selector,
    provider = getProvider(),
    // No hardcoded default — undefined lets each provider's complete() fall back
    // to its OWN defaultModel (`opts.model ?? this.defaultModel`), so an
    // OpenAI-configured session doesn't get a Claude model id it would reject.
    model,
    maxTokens = 1000,
    signal,
  } = input

  if (!goal || goal.trim().length === 0) {
    return { ok: false, reason: 'Goal is empty: nothing to translate', kind: 'error' }
  }

  const prompt = buildTranslateGoalPrompt({
    goal,
    selector,
    referenceElements: input.referenceElements,
  })
  // Real selectors the verifier vouched for (gathered from the live DOM). An
  // `other` drawn from here is grounded, even if the goal text doesn't name it.
  const inventorySelectors = new Set(
    (input.referenceElements ?? []).map((e) => e.selector),
  )

  let result
  try {
    result = await provider.complete({
      model,
      maxTokens,
      system: prompt.system,
      user: prompt.user,
      responseFormat: { kind: 'json_schema', schema: { ...TRANSLATE_RESPONSE_SCHEMA } },
      signal,
    })
  } catch (err) {
    return { ok: false, reason: `LLM call failed: ${(err as Error).message}`, kind: 'error' }
  }

  // An explicit refusal is a distinct, non-retryable outcome — don't
  // misreport it as a JSON parse failure. Both providers surface a declined
  // structured-output request as stopReason 'refusal' with parsed undefined.
  if (result.stopReason === 'refusal') {
    return { ok: false, reason: 'Model declined to translate the goal.', kind: 'error' }
  }

  if (result.parsed === undefined) {
    return {
      ok: false,
      reason: `LLM response was not valid JSON: ${result.text.slice(0, 120)}`,
      kind: 'error',
    }
  }

  const parsed = result.parsed as { predicates?: unknown }
  if (!Array.isArray(parsed.predicates)) {
    return { ok: false, reason: 'LLM response missing a predicates array', kind: 'error' }
  }

  const predicates: TranslatedPredicate[] = []
  for (const raw of parsed.predicates as RawPredicate[]) {
    const name = raw?.predicate
    if (typeof name !== 'string' || !(PREDICATE_NAMES as readonly string[]).includes(name)) {
      // Skip an unknown predicate name rather than failing the whole goal.
      continue
    }
    const args = sanitizeArgs(raw.args)
    // Ground a secondary selector. An `other` the model invents from a noun
    // ("the header" → `.header`) could match the WRONG element, yielding a
    // real-but-bogus pass/fail. Trust an `other` only when it is EITHER named
    // verbatim in the goal text OR present in the verifier-supplied DOM
    // inventory (`referenceElements`). Otherwise drop it → the predicate fails
    // `hasRequiredArgs` and the verifier safely skips instead of guessing.
    if (
      args.other &&
      !goalNamesSelector(goal, args.other) &&
      !inventorySelectors.has(args.other)
    ) {
      delete args.other
    }
    // Drop any predicate lacking the args it can't be judged without (e.g.
    // `aligned` with no axis/other, `textEquals` with no expected text) so the
    // verifier never wastes a measurement read on an unjudgeable predicate.
    if (!hasRequiredArgs(name as PredicateName, args)) continue
    predicates.push({ predicate: name as PredicateName, args })
  }

  if (predicates.length === 0) {
    // Either the model returned an empty list (purely aesthetic goal) or every
    // entry was malformed. Both mean "nothing measurable here" — a clean
    // refusal that signals the caller to fall to the advisory vision judge
    // (L3b) instead of reporting a bogus pass/fail.
    return {
      ok: false,
      reason: 'Goal did not map to any measurable predicate (likely purely aesthetic: use the vision judge).',
      kind: 'unmeasurable',
    }
  }

  return { ok: true, predicates }
}
