/**
 * Prompt builder for the goal → predicate translator (Tier-2 verification P2).
 *
 * The model's ONLY job is to compile a fuzzy / NL visual goal into a list of
 * measurable predicates drawn from a FIXED catalog — it picks predicates and
 * their args; it never evaluates whether the goal is met (that's deterministic
 * code, `predicates.ts`). This file owns the catalog text + the hard rules; the
 * translator (`translate-goal.ts`) owns the call + validation.
 *
 * TWO-ELEMENT GOALS (DOM context): for `aligned`/`bboxMatches` ("align with the
 * header") the model needs the SECOND element's selector. It still has no free
 * inventory of the page, but the verifier now probes the live DOM for present
 * landmark/structural elements and passes them as `referenceElements` — a small
 * inventory of REAL `{selector,label}` pairs. The model may use an `other`
 * selector that is EITHER named verbatim in the goal OR drawn from that
 * inventory; anything else is still dropped downstream (→ the verifier skips,
 * never hallucinates a wrong `.header`).
 *
 * Spec: tasks/editor-edit-verification.md (P2 — "LLM translates, code judges").
 */

export interface ReferenceElement {
  /** A real, present CSS selector the model may use as a two-element `other`. */
  selector: string
  /** Short human label (e.g. trimmed text / tag) to help the model pick. */
  label?: string
}

export interface TranslateGoalPromptInput {
  /** The fuzzy / NL edit goal, e.g. "make this fit the content width". */
  goal: string
  /** CSS selector of the element the goal is about (the primary element). */
  selector: string
  /**
   * Inventory of REAL secondary elements the model may reference as `other`
   * (for `aligned`/`bboxMatches`). Gathered by the verifier from the live DOM.
   * Omitted / empty → the model may only use selectors named in the goal text.
   */
  referenceElements?: ReferenceElement[]
}

export interface TranslateGoalPrompt {
  system: string
  user: string
}

/**
 * The predicate catalog, rendered into the system prompt. Kept here (not
 * generated from `predicates.ts`) so the *descriptions* the model reads are
 * hand-tuned for picking accuracy; the names/args MUST stay in sync with
 * `PredicateName` / `PredicateArgs`.
 */
const CATALOG = `
- noOverflow — the element is big enough for its own content (no clipped or
  scrolled content). Use for: "fit the content width", "don't clip", "no
  scrollbar", "size to contents". args: none.
- fitsViewport — the element's box sits fully within the on-screen viewport.
  Use for: "fit on screen", "no off-screen", "stop the page scrolling
  sideways". args: none.
- aligned — the element shares an edge or centerline with ANOTHER element.
  Use for: "line this up with X", "align to the header". args:
  { "other": "<css selector of the other element>", "axis": one of
  "left" | "right" | "top" | "bottom" | "centerX" | "centerY" }.
- bboxMatches — the element's box has the same size as ANOTHER element's.
  Use for: "match the size of X", "same width as the card". args:
  { "other": "<css selector of the other element>", "tol": <optional px
  tolerance, default 4> }.
- contrastRatio — the element's text/background contrast meets a WCAG
  minimum. Use for: "enough contrast", "make it readable", "accessible
  colors". args: { "min": <optional ratio, default 4.5 for AA normal text;
  use 3 for large text / AA UI, 7 for AAA> }.
- textEquals — the element's visible text equals a specific string. Use for:
  "make it say Y", "change the label to Z". args: { "expected": "<the exact
  text>" }.`.trim()

/** Render the reference-element inventory for the prompt (capped + labelled). */
function renderReferenceElements(elements: ReferenceElement[] | undefined): string {
  if (!elements || elements.length === 0) return ''
  const lines = elements
    .slice(0, 12)
    .map((e) => (e.label ? `  - ${e.selector}  (${e.label})` : `  - ${e.selector}`))
    .join('\n')
  return `\n\nAvailable elements on the page you MAY use as "other" (real selectors):\n${lines}`
}

export function buildTranslateGoalPrompt(
  input: TranslateGoalPromptInput,
): TranslateGoalPrompt {
  const hasInventory = !!input.referenceElements && input.referenceElements.length > 0
  const otherRule = hasInventory
    ? `- The PRIMARY element is given to you; every predicate runs against it. For
  the two-element predicates (aligned, bboxMatches) you MUST also supply
  "other": a CSS selector for the second element. Use EITHER a selector the GOAL
  TEXT contains verbatim, OR one of the "Available elements" listed below (match
  the goal's described element — e.g. "the header" → the listed header
  selector). Do NOT invent a selector that is neither in the goal nor the list —
  a wrong guess is worse than no check; omit the predicate instead.`
    : `- The PRIMARY element is given to you; every predicate runs against it. For
  the two-element predicates (aligned, bboxMatches) you MUST also supply
  "other": a CSS selector for the second element. You have NO inventory of the
  page, so only use a selector the GOAL TEXT itself contains verbatim (e.g. the
  user wrote ".sidebar" or "#header"). Do NOT invent a selector from a noun
  ("the header" is not a selector). If the goal names a second element only in
  prose, omit that predicate — a wrong guess is worse than no check.`

  const system = `You compile a visual edit GOAL into a list of measurable predicates.

You pick predicates from the catalog below and fill in their args. You do
NOT evaluate, measure, or decide whether the goal is currently met — that is
done deterministically by separate code. Your only output is which predicates
should be checked and with what arguments.

Predicate catalog (these are the ONLY predicates you may use):
${CATALOG}

Rules:
- Return ONLY predicates from the catalog, by their exact names.
${otherRule}
- Choose the smallest set that captures the goal — usually one predicate,
  occasionally two. Do not pad.
- If the goal is purely aesthetic / subjective ("looks cleaner", "more
  modern", "nicer spacing") and maps to NO catalog predicate, return an empty
  list. Do not force a poor fit. An empty list is the correct answer for
  un-measurable goals.
- Never invent predicate names or args not listed above.`

  const user = `Primary element selector: ${input.selector}
Goal: ${input.goal}${renderReferenceElements(input.referenceElements)}

Return the predicates to check.`

  return { system, user }
}
