/**
 * L3a goal verifier (Tier-2 edit verification P2).
 *
 * For a fuzzy / NL edit goal ("make this fit the content width", "align this
 * with the header"), this composes the three P2 pieces into the SAME
 * `VerificationResult` the L0–L2 oracle produces:
 *
 *   translate (LLM picks predicates) → read measurements (bridge) →
 *   evaluate predicates (deterministic judge) → verdict
 *
 * Load-bearing boundary: the only LLM step is `translate`; the judgment is
 * pure code (`predicates.ts`). All I/O is injected (`translate`,
 * `readMeasurements`), so the whole verifier is unit-testable with fakes —
 * matching `verify-render.ts`'s DI shape.
 *
 * Best-effort: never throws into the edit flow, and reports `skipped` (not a
 * false fail) whenever the goal isn't measurable or the DOM can't be read.
 *
 * Spec: tasks/editor-edit-verification.md (P2).
 */

import type { Measurements } from '@/types/bridge'
import type { VerificationResult } from './types'
import {
  evaluatePredicate,
  needsSecondElement,
  type PredicateOutcome,
} from './predicates'
import type { TranslatedPredicate } from './translate-goal'
import type { ReferenceElement } from './translate-goal-prompt'

/** Result shape the injected translator must return (mirrors translateGoal). */
export type TranslateResult =
  | { ok: true; predicates: TranslatedPredicate[] }
  | { ok: false; reason: string; kind: 'unmeasurable' | 'error' }

export interface GoalVerificationInput {
  /** Id of the edit whose goal we're verifying (mirrors the edit). */
  editId: string
  /** The fuzzy / NL goal, e.g. "make this fit the content width". */
  goal: string
  /** CSS selector of the primary element the goal is about. */
  selector: string
  /** Optional short label for the surface; defaults to the goal text. */
  label?: string
}

export interface VerifyGoalDeps {
  /**
   * Compile the goal → predicates. Inject the bound `translateGoal`
   * (production) or a fake (tests). Keeping this a function — not a provider —
   * keeps the verifier free of registry/provider imports.
   */
  translate: (args: {
    goal: string
    selector: string
    /**
     * Real present elements the translator may ground a two-element `other`
     * in (gathered from the live DOM for relational goals). Forwarded to
     * `translateGoal`.
     */
    referenceElements?: ReferenceElement[]
    signal?: AbortSignal
  }) => Promise<TranslateResult>
  /**
   * Read measurements for a selector via the bridge `READ_MEASUREMENTS` query.
   * Resolves `null` on no-match / timeout / unsupported bridge / abort. The
   * verifier forwards its `signal` so an aborted turn resolves reads as `null`
   * promptly instead of hanging until the bridge timeout (the shell transport
   * `useIframeReadMeasurements` honors the signal).
   */
  readMeasurements: (
    selector: string,
    signal?: AbortSignal,
  ) => Promise<Measurements | null>
  /** Aborts translate + reads when fired (the turn's signal). */
  signal?: AbortSignal
  /** Injectable monotonic clock (default `Date.now`). */
  now?: () => number
}

interface JudgedPredicate {
  predicate: TranslatedPredicate
  outcome: PredicateOutcome
}

/**
 * Verify a fuzzy goal against measurable predicates. Returns a
 * `VerificationResult` — `pass` iff every *measurable* predicate passed (and at
 * least one did); `fail` when a measurable predicate failed; `skipped` when the
 * goal compiled to nothing measurable, the DOM couldn't be read, or every
 * predicate was indeterminate.
 */
export async function verifyGoal(
  input: GoalVerificationInput,
  deps: VerifyGoalDeps,
): Promise<VerificationResult> {
  const now = deps.now ?? Date.now
  const start = now()

  const done = (
    partial: Omit<VerificationResult, 'editId' | 'durationMs' | 'expectedValue'>,
  ): VerificationResult => ({
    editId: input.editId,
    expectedValue: input.goal,
    durationMs: now() - start,
    ...partial,
  })

  const skipped = (
    detail: string,
    skipReason: NonNullable<VerificationResult['skipReason']> = 'unmeasurable',
  ): VerificationResult =>
    done({ status: 'skipped', escalatable: false, detail, skipReason })

  // Read measurements, deduped by selector (the inventory gather, the primary
  // read, and the per-predicate secondary reads all share this cache).
  const cache = new Map<string, Measurements | null>()
  const read = async (selector: string): Promise<Measurements | null> => {
    if (cache.has(selector)) return cache.get(selector) ?? null
    let m: Measurements | null = null
    try {
      m = await deps.readMeasurements(selector, deps.signal)
    } catch {
      m = null
    }
    cache.set(selector, m)
    return m
  }

  // 1a. DOM context for two-element goals. A relational goal ("align with the
  //     header") needs the SECOND element's real selector — the model can't
  //     invent one. Probe the live DOM for present landmark/structural elements
  //     and hand them to the translator as a grounded inventory. Gated on a
  //     relational-goal heuristic so single-element goals pay no extra reads;
  //     the probe seeds the shared cache, so a chosen `other` is a cache hit at
  //     judge time (no double read).
  const referenceElements = isRelationalGoal(input.goal)
    ? await gatherReferenceElements(read, input.selector)
    : undefined

  // 1b. Translate (the one LLM step). A genuine aesthetic goal isn't a failure —
  //    it's "not measurable here" → `unmeasurable` skip (the L3b vision-judge
  //    path is its eventual home). But an LLM/provider error (auth, refusal, bad
  //    output) is an INFRASTRUCTURE failure, not an aesthetic one — tag it
  //    `translate-error` so the caller surfaces it as actionable, not a benign skip.
  let translation: TranslateResult
  try {
    translation = await deps.translate({
      goal: input.goal,
      selector: input.selector,
      ...(referenceElements && referenceElements.length > 0 ? { referenceElements } : {}),
      signal: deps.signal,
    })
  } catch (err) {
    return skipped(
      `Goal translation errored: ${(err as Error)?.message ?? 'unknown'}`,
      'translate-error',
    )
  }
  if (!translation.ok) {
    return translation.kind === 'error'
      ? skipped(`Goal translation failed: ${translation.reason}`, 'translate-error')
      : skipped(`Not measurable: ${translation.reason}`, 'unmeasurable')
  }
  if (translation.predicates.length === 0) {
    return skipped('Goal compiled to no predicates.', 'unmeasurable')
  }

  // 2. Read the primary element.
  const primary = await read(input.selector)
  if (!primary) {
    // Can't read the element (selector gone, HMR not settled, or old bridge) —
    // don't claim a fail we can't substantiate.
    return skipped(`Could not read measurements for ${input.selector}.`, 'unreadable')
  }

  // 3. Judge each predicate deterministically.
  const judged: JudgedPredicate[] = []
  for (const p of translation.predicates) {
    let secondary: Measurements | null | undefined
    if (needsSecondElement(p.predicate) && p.args.other) {
      secondary = await read(p.args.other)
    }
    const outcome = evaluatePredicate(p.predicate, p.args, primary, secondary ?? null)
    judged.push({ predicate: p, outcome })
  }

  // 4. Verdict over the *measurable* predicates. Indeterminate ones (e.g.
  //    contrast on a translucent bg, a missing secondary element) are excluded
  //    from the verdict — we can't confirm or deny them, so they neither pass
  //    nor fail. If NONE were measurable → skip.
  const measurable = judged.filter((j) => !j.outcome.indeterminate)
  if (measurable.length === 0) {
    return skipped(
      `No predicate was measurable: ${summarize(judged)}`,
    )
  }
  const failed = measurable.filter((j) => !j.outcome.pass)
  const detail = summarize(judged)

  if (failed.length > 0) {
    return done({
      status: 'fail',
      failedAt: 'L3',
      // Goal-failure repair is the agent self-correct loop (P3), not the
      // bound-binding one-shot LLM lane — so this is not `escalatable` in the
      // P1 sense.
      escalatable: false,
      observedValue: detail,
      detail: `Goal not met: ${detail}`,
    })
  }
  return done({
    status: 'pass',
    escalatable: false,
    observedValue: detail,
    detail: `Goal verified: ${detail}`,
  })
}

/**
 * Curated set of structural/landmark selectors probed to build the two-element
 * DOM inventory. Covers semantic landmarks, ARIA roles, top headings, and the
 * most common layout class names — the elements a relational goal usually
 * refers to ("the header", "the sidebar", "the nav"). A fixed list keeps the
 * probe bounded; non-landmark secondary elements still require the goal to name
 * the selector verbatim (documented limitation).
 */
const CANDIDATE_SECONDARY_SELECTORS: readonly string[] = [
  'header',
  'nav',
  'main',
  'aside',
  'footer',
  '[role="banner"]',
  '[role="navigation"]',
  '[role="main"]',
  '[role="complementary"]',
  '[role="contentinfo"]',
  '.sidebar',
  '.toolbar',
]

/**
 * Heuristic gate: does the goal reference a SECOND element (alignment / size
 * match)? Only then do we pay the inventory-probe reads. Single-element goals
 * ("fit the content width", "enough contrast") match nothing here.
 */
export function isRelationalGoal(goal: string): boolean {
  // A false positive only costs an unused DOM probe (the translator just gets
  // an unused inventory), so the gate is kept GENEROUSLY broad — a false
  // NEGATIVE silently disables the feature, a false positive is harmless.
  // Covers: alignment ("align", "line up"/"line it up", "flush", "even/level
  // with", "next to", "beside", "against"); size/box match ("same width /
  // height / size / dimensions / box / proportions", "as wide/tall/big as",
  // "equal width", "match the size"); and relational framing ("relative to").
  return /\b(align(?:ed|s)?|line(?:s|d)?\s+(?:\w+\s+){0,2}up|flush|even with|level with|next to|beside|alongside|against\b|same\s+(?:width|height|size|line|dimensions?|box|proportions?)|as\s+(?:wide|tall|big|large|small|high)\s+as|equal\s+(?:width|height|size|dimensions?)|match(?:es|ing)?\b|relative to|compared to)/i.test(
    goal,
  )
}

/**
 * Probe the curated candidate selectors in parallel and return the present ones
 * as a grounded `{selector,label}` inventory (label = trimmed text, capped).
 * Excludes the primary selector (a goal aligns an element with ANOTHER). Seeds
 * the shared read cache so a chosen `other` is a cache hit at judge time.
 */
async function gatherReferenceElements(
  read: (selector: string) => Promise<Measurements | null>,
  primarySelector: string,
): Promise<ReferenceElement[]> {
  const candidates = CANDIDATE_SECONDARY_SELECTORS.filter((s) => s !== primarySelector)
  const measured = await Promise.all(
    candidates.map(async (selector) => ({ selector, m: await read(selector) })),
  )
  const out: ReferenceElement[] = []
  for (const { selector, m } of measured) {
    if (!m) continue
    const text = m.textContent?.trim().replace(/\s+/g, ' ') ?? ''
    const label = text.length > 0 ? text.slice(0, 40) : undefined
    out.push(label ? { selector, label } : { selector })
    if (out.length >= 12) break
  }
  return out
}

/** One-line human summary of every predicate's verdict. */
function summarize(judged: JudgedPredicate[]): string {
  return judged
    .map((j) => {
      const mark = j.outcome.indeterminate ? '?' : j.outcome.pass ? '✓' : '✗'
      return `${mark} ${j.predicate.predicate}: ${j.outcome.detail}`
    })
    .join('; ')
}
