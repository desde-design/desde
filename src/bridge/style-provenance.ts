/**
 * Style provenance — Layer 0 of the inspector style-provenance feature
 * (tasks/inspector-style-provenance.md, Phase 1).
 *
 * A pure, read-only cascade walker that answers "where did this rendered
 * style actually come from?" for one or more CSS properties on an element.
 * It reverse-resolves each property to the *winning* CSS rule (by real
 * specificity + source order) and, when that rule's value is a
 * `var(--token)`, walks the custom-property chain back to its definition.
 *
 * The question it answers is about the element **at rest**: rules that match
 * only because of a transient interaction state (`:hover`, `:focus`, `:active`)
 * are excluded, because the cursor is by construction on the element the user
 * just clicked to inspect. See `dependsOnTransientState`.
 *
 * This is the honest replacement for the inspector's current
 * reverse-inference (guessing a Tailwind shade from `getComputedStyle`).
 * It runs inside the prototype iframe (the bridge), where it has access to
 * `document.styleSheets`, and is driven on-demand by the
 * `GET_STYLE_PROVENANCE` message (Layer 1).
 *
 * Specificity is delegated to `@bramus/specificity` (Selectors Level 4 —
 * correct for `:is()` / `:where()` / `:not()` / `:has()` / `:nth-child()`),
 * NOT hand-rolled — those are exactly the cases a naive counter gets wrong.
 *
 * Graceful degradation is load-bearing: a cross-origin stylesheet, an
 * unparseable selector, or a computed-only value never throws — the
 * property just reports `winningRule: null` and the inspector falls back to
 * today's class-edit behavior. Never regresses; only gets better as
 * coverage widens.
 *
 * Pure function over a passed `element` (+ its `ownerDocument`): no DOM
 * mutation, no message I/O, no bridge-runtime deps — so it is unit-testable
 * in jsdom against fixture `<style>` sheets without a browser.
 */

import Specificity from '@bramus/specificity'
// Wire types live in the shared bridge-contract file so the shell + editor-cli
// don't transitively typecheck this browser-only module (+ @bramus/specificity).
import type {
  StyleStylesheetRef,
  StyleWinningRule,
  StyleVarChainEntry,
  StyleOrigin,
} from '../types/bridge'

export type { StyleStylesheetRef, StyleWinningRule, StyleVarChainEntry, StyleOrigin }

/** A flattened, source-ordered view of one declaring CSS rule. */
interface CollectedRule {
  selectorText: string
  style: CSSStyleDeclaration
  ref: StyleStylesheetRef
  media?: string
  /** Document source order — later index wins ties. */
  order: number
  /** False when an enclosing `@media` condition doesn't currently apply. */
  mediaApplies: boolean
  /**
   * Cascade-layer rank. Unlayered rules use {@link UNLAYERED}; rules inside an
   * `@layer` block get an ascending rank by encounter order.
   *
   * The rank is a plain ORDERING, not a strength: {@link cascadeBeats} reads it
   * in the direction the declaration's origin calls for — higher wins for
   * normal declarations (unlayered strongest, later layer beats earlier), lower
   * wins for `!important` ones (earlier layer strongest, unlayered weakest,
   * which {@link UNLAYERED} being the maximum gives for free).
   *
   * Approximation for v1: `@layer a,b,c;` statement ordering and nested-layer
   * precedence aren't modeled — encounter order stands in.
   */
  layerRank: number
}

/**
 * Rank for rules outside any `@layer`. Deliberately the MAXIMUM, which makes
 * both halves of the layer cascade fall out of one comparison: unlayered
 * outranks every layered rule for normal declarations, and — since
 * {@link cascadeBeats} reverses the comparison for `!important` — ranks below
 * every layered rule for important ones. No special-casing either way.
 */
const UNLAYERED = Number.MAX_SAFE_INTEGER

/** One cascade candidate (a declaration of the queried property/var). */
interface Candidate {
  rule: CollectedRule
  selector: string
  spec: [number, number, number]
  important: boolean
}

/**
 * Outcome of one element's cascade walk for a property.
 *
 * `transient` is the load-bearing addition: the resting-state rule (see
 * {@link dependsOnTransientState}) is the honest answer to "which rule can the
 * user act on", but it is NOT necessarily the rule painting the pixels right
 * now — clicking an element to inspect it puts the cursor on it, so a `:hover`
 * rule can be live while the reported winner is the resting one. The walk
 * records the strongest transient candidate it DROPPED when that candidate
 * would otherwise have won, so the payload can explain the discrepancy instead
 * of presenting a contradiction (a resting declaration beside a hovered
 * `computedValue`, or `winningRule: null` beside a real opaque colour).
 */
interface WinnerLookup {
  winner: Candidate | null
  /**
   * The transient-state candidate that currently applies AND would have beaten
   * `winner`, or null when no dropped candidate outranks the resting answer
   * (in which case the transient rule changes nothing the user sees).
   */
  transient: Candidate | null
}

/**
 * Injected, read-only capabilities the walker consults but does not own. Each is
 * OPTIONAL — omitting one degrades to the walker's stand-alone behavior, which
 * is what keeps this module unit-testable in jsdom with no bridge wiring.
 */
export interface StyleProvenanceDeps {
  /**
   * Was `element`'s CURRENT inline declaration for `property` stamped by
   * editor's live-preview shim rather than authored by the prototype?
   *
   * Supplied by `comment-bridge.ts` as `overridePreview.isPreviewStampedProperty`
   * (`src/bridge/override-preview.ts`, which records exactly what it stamped).
   * Injected rather than imported so this module keeps no dependency on the
   * preview layer and reaches into no shared mutable state; when it is absent,
   * `inline.fromPreview` is simply never set.
   */
  isPreviewStampedProperty?: (element: Element, property: string) => boolean
}

/**
 * Resolve provenance for `properties` on `element`. Returns one
 * {@link StyleOrigin} per requested property (keyed by property name).
 */
export function getStyleProvenance(
  element: Element,
  properties: readonly string[],
  deps: StyleProvenanceDeps = {},
): Record<string, StyleOrigin> {
  const doc = element.ownerDocument
  const rules = collectRules(doc)
  const out: Record<string, StyleOrigin> = {}
  // Per-call cache: several properties on one element often resolve to the
  // same root token (e.g. spacing props all → `--acme-space-*`), so count each
  // token's usages once.
  const usageCache = new Map<string, number>()
  for (const property of properties) {
    const origin = resolveProperty(element, property, rules, deps)
    const root = origin.varChain[origin.varChain.length - 1]
    if (root) {
      let count = usageCache.get(root.name)
      if (count === undefined) {
        count = countTokenUsages(root.name, rules)
        usageCache.set(root.name, count)
      }
      origin.tokenUsageCount = count
    }
    out[property] = origin
  }
  return out
}

/**
 * Blast radius of patching `name`: the number of declaration sites (a property
 * in a rule) whose value references `var(--name)` across all collected rules.
 * The token's own DEFINITION (`--name: …`) isn't a reference, so it's excluded;
 * an alias (`--other: var(--name)`) IS a reference, so it counts (patching
 * `--name` flows through it). Uses the precise `extractVarNames` parse rather
 * than a substring test, so `--acme-color` doesn't match `--acme-color-bg`.
 *
 * v1 approximation: counts by token NAME across the whole document, so when a
 * token is redefined per theme/container (`:root { --brand } .dark { --brand }`)
 * this counts every `var(--brand)` use, including ones that resolve to a
 * different definition than the one being patched. Computing the exact set that
 * resolves to a SPECIFIC definition needs a per-consumer cascade walk — out of
 * proportion for a heads-up count. The dialog frames this as a usage count
 * ("used in N places"), not a reachability guarantee, to stay honest.
 */
function countTokenUsages(name: string, rules: readonly CollectedRule[]): number {
  let count = 0
  for (const rule of rules) {
    const style = rule.style
    for (let i = 0; i < style.length; i++) {
      const value = style.getPropertyValue(style[i])
      if (value && extractVarNames(value).includes(name)) count++
    }
  }
  return count
}

function resolveProperty(
  element: Element,
  property: string,
  rules: readonly CollectedRule[],
  deps: StyleProvenanceDeps,
): StyleOrigin {
  const computedValue = safeComputed(element, property)
  const inline = readInline(element, property, deps)

  // The element's own winning rule — but a rule whose value is `inherit`
  // (any property) or `unset` (inherited property) FORWARDS to the parent
  // rather than authoring a value, so it isn't a real source.
  const forwards = (c: Candidate): boolean =>
    isForwardingValue(c.rule.style.getPropertyValue(property), property)
  const elementLookup = findWinningRuleAt(element, property, rules)
  const elementWinner = elementLookup.winner
  let winnerNode: Element = element
  let winner: Candidate | null =
    elementWinner && !forwards(elementWinner) ? elementWinner : null
  let inherited = false
  // Resolve from an ancestor when the property INHERITS and nothing authored
  // it on the element, OR the element's own rule explicitly forwards. Walk
  // nearest-first (mirrors findVarDefinition), SKIPPING ancestors that also
  // just forward (`.parent { color: inherit }`), to the first ancestor that
  // authors a real value — flagged `inherited`. Without this a `<span>` in a
  // styled button shows a computed value but a blank "From:".
  const elementForwards = elementWinner != null && forwards(elementWinner)
  if (!winner && (INHERITED_PROPERTIES.has(property) || elementForwards)) {
    for (let node = element.parentElement; node; node = node.parentElement) {
      const w = findWinningRuleAt(node, property, rules).winner
      if (!w || forwards(w)) continue
      winner = w
      winnerNode = node
      inherited = true
      break
    }
  }
  // Documented boundary: the ancestor walk resolves STYLESHEET-rule sources
  // only — an ancestor's INLINE style (`<div style="color:red"><span> …`) and
  // an inline `inherit`/`unset` that forwards to one are not traced (no clean
  // slot in StyleOrigin for an ancestor-inline source, and the pattern is
  // rare). Degrades to a blank "From:", never a wrong source. Revisit if a
  // real prototype leans on ancestor inline styles.

  // A transient-state rule ON THE ELEMENT ITSELF that outranks the resting
  // answer: the reason `computedValue` (always a LIVE sample) can disagree with
  // the resting `winningRule`. Only the element's own walk is consulted — the
  // element is what the user clicked and hovered; an ancestor's `:hover` rule is
  // not what puts the cursor's value on this element.
  const transientPseudo = elementLookup.transient
    ? transientStatePseudoClass(elementLookup.transient.selector)
    : null
  const transientRuleApplies = transientPseudo ? { pseudoClass: `:${transientPseudo}` } : undefined

  if (!winner) {
    return {
      property,
      computedValue,
      winningRule: null,
      varChain: [],
      ...(inline ? { inline } : {}),
      ...(transientRuleApplies ? { transientRuleApplies } : {}),
    }
  }

  const value = winner.rule.style.getPropertyValue(property)
  const priority = winner.rule.style.getPropertyPriority(property)
  const declaration = `${property}: ${value}${priority ? ' !' + priority : ''}`
  const winningRule: StyleWinningRule = {
    selector: winner.selector,
    stylesheet: winner.rule.ref,
    declaration,
    specificity: winner.spec,
    ...(winner.rule.media ? { media: winner.rule.media } : {}),
    ...(pseudoClassOf(winner.selector) ? { pseudoClass: pseudoClassOf(winner.selector)! } : {}),
  }

  // Resolve the var chain in the WINNER's context (the ancestor for inherited
  // values), so a token defined/overridden between element and ancestor is
  // followed by proximity correctly.
  const varChain = resolveVarChain(value, winnerNode, rules)
  return {
    property,
    computedValue,
    winningRule,
    varChain,
    ...(inherited ? { inherited: true } : {}),
    ...(inline ? { inline } : {}),
    ...(transientRuleApplies ? { transientRuleApplies } : {}),
  }
}

/**
 * The cascade winner among rules that currently match `node` for `property`,
 * resolved for the element AT REST — plus the strongest transient-state rule
 * that was dropped and would have won (see {@link WinnerLookup}).
 */
function findWinningRuleAt(
  node: Element,
  property: string,
  rules: readonly CollectedRule[],
): WinnerLookup {
  // `matchingSelectors` gates on `node.matches`, so only currently-matching
  // rules are candidates; `dependsOnTransientState` then drops the ones whose
  // match depends on a TRANSIENT interaction state, so the answer is always
  // about the element at rest. See that function for why matching alone isn't
  // enough.
  let winner: Candidate | null = null
  let transient: Candidate | null = null
  for (const rule of rules) {
    if (!rule.mediaApplies) continue
    if (!rule.style.getPropertyValue(property)) continue
    const important = rule.style.getPropertyPriority(property) === 'important'
    for (const sel of matchingSelectors(node, rule.selectorText)) {
      const cand: Candidate = { rule, selector: sel, spec: specificityTuple(sel), important }
      if (dependsOnTransientState(sel)) {
        // Dropped from the resting answer, but remembered: it currently matches,
        // so it is part of what the user is looking at.
        if (transient === null || cascadeBeats(cand, transient)) transient = cand
        continue
      }
      if (winner === null || cascadeBeats(cand, winner)) winner = cand
    }
  }
  // Only report a transient rule that actually changes the rendered value —
  // one that loses to the resting winner anyway explains nothing.
  const decisive = transient && (winner === null || cascadeBeats(transient, winner))
  return { winner, transient: decisive ? transient : null }
}

/**
 * CSS properties that inherit (the inspector-relevant subset). Used to decide
 * whether a property with no element-level rule should resolve up the ancestor
 * chain. Notably excludes `background-color` / `border-*` (non-inherited).
 */
const INHERITED_PROPERTIES = new Set<string>([
  'color',
  'font',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'word-break',
  'text-align',
  'text-transform',
  'text-indent',
  'white-space',
  'visibility',
])

/**
 * Whether a declaration's value FORWARDS to the parent rather than authoring
 * one: `inherit` always does; `unset` does only for inherited properties (for
 * non-inherited ones it means `initial`). Such a rule isn't a real source, so
 * provenance resolution skips past it up the ancestor chain.
 */
function isForwardingValue(value: string, property: string): boolean {
  const v = value.trim().toLowerCase()
  if (v === 'inherit') return true
  if (v === 'unset') return INHERITED_PROPERTIES.has(property)
  return false
}

/**
 * Walk the `var(--…)` chain starting from a property value. Each hop finds
 * the highest-specificity matching rule that *defines* the custom property
 * and records it; recurses when the definition is itself a `var(...)`.
 * Cycle-guarded.
 */
function resolveVarChain(
  value: string,
  element: Element,
  rules: readonly CollectedRule[],
): StyleVarChainEntry[] {
  const chain: StyleVarChainEntry[] = []
  const seen = new Set<string>()
  let names = extractVarNames(value)
  while (names.length > 0) {
    // Resolve the first unseen var; a single value rarely chains through
    // more than one token, and following the head keeps the chain linear
    // and legible (the common --token → value case).
    const name = names.find((n) => !seen.has(n))
    if (!name) break
    seen.add(name)
    const def = findVarDefinition(name, element, rules)
    if (!def) break
    chain.push(def)
    names = extractVarNames(def.value)
  }
  return chain
}

/**
 * The definition of `--name` that the element actually inherits. Custom
 * properties inherit by **ancestor proximity**, NOT by global specificity:
 * each element computes its own `--name` from rules matching IT, and a
 * descendant inherits the NEAREST ancestor's computed value. So we walk the
 * ancestor chain nearest-first and return the first level that defines it,
 * resolving the cascade (important > layer > specificity > order) *among
 * that level's own competing rules*. (`:root`/`html`/`body` are reached
 * naturally at the documentElement/body nodes — no special-casing.)
 */
function findVarDefinition(
  name: string,
  element: Element,
  rules: readonly CollectedRule[],
): StyleVarChainEntry | null {
  for (let node: Element | null = element; node; node = node.parentElement) {
    let best: Candidate | null = null
    for (const rule of rules) {
      if (!rule.mediaApplies) continue
      if (!rule.style.getPropertyValue(name)) continue
      const important = rule.style.getPropertyPriority(name) === 'important'
      for (const sel of matchingSelectors(node, rule.selectorText)) {
        // Same resting-state rule as the property walk: a token redefined under
        // `:hover` is not where the resting value comes from.
        if (dependsOnTransientState(sel)) continue
        const cand: Candidate = { rule, selector: sel, spec: specificityTuple(sel), important }
        if (best === null || cascadeBeats(cand, best)) best = cand
      }
    }
    if (best) {
      return {
        name,
        value: best.rule.style.getPropertyValue(name).trim(),
        definedAt: { selector: best.selector, stylesheet: best.rule.ref },
      }
    }
  }
  return null
}

// ── stylesheet collection ────────────────────────────────────────────────

function collectRules(doc: Document): CollectedRule[] {
  const out: CollectedRule[] = []
  let sheets: StyleSheetList
  try {
    sheets = doc.styleSheets
  } catch {
    return out
  }
  // Shared counters across the whole document so source order and layer
  // ranks are globally comparable across stylesheets. `layerRanks` maps a
  // named layer to the rank fixed at its FIRST appearance, so a reopened
  // `@layer name { … }` block keeps its original position (CSS keeps a layer
  // at the spot where it was first declared).
  const ctr = { order: 0, layer: 0, anon: 0, layerRanks: new Map<string, number>() }
  for (const sheet of Array.from(sheets)) {
    const ref = stylesheetRef(sheet as CSSStyleSheet)
    let cssRules: CSSRuleList
    try {
      cssRules = (sheet as CSSStyleSheet).cssRules
    } catch {
      // Cross-origin stylesheet — inaccessible by design. Skip.
      continue
    }
    walkRuleList(cssRules, ref, undefined, true, UNLAYERED, '', out, ctr)
  }
  return out
}

/** Recurse a rule list, descending into `@media`/`@layer`/`@supports` groups. */
function walkRuleList(
  list: CSSRuleList,
  ref: StyleStylesheetRef,
  media: string | undefined,
  mediaApplies: boolean,
  layerRank: number,
  /** Dotted path of the enclosing named layer(s), '' at the top level. */
  layerPath: string,
  out: CollectedRule[],
  ctr: { order: number; layer: number; anon: number; layerRanks: Map<string, number> },
): void {
  for (const rule of Array.from(list)) {
    if (isStyleRule(rule)) {
      out.push({
        selectorText: rule.selectorText,
        style: rule.style,
        ref,
        order: ctr.order++,
        ...(media ? { media } : {}),
        mediaApplies,
        layerRank,
      })
    } else if (isMediaRule(rule)) {
      const condition = rule.media.mediaText
      const applies = mediaApplies && mediaMatches(condition)
      walkRuleList(rule.cssRules, ref, condition, applies, layerRank, layerPath, out, ctr)
    } else if (isLayerBlockRule(rule)) {
      // A named layer's rank is fixed at its FIRST appearance; reopening it
      // reuses that rank (so `@layer a{} @layer b{} @layer a{}` keeps the 2nd
      // `a` losing to `b`). The dedup key is the FULL layer path — `foo.bar`
      // and `baz.bar` share a local CSSOM name (`bar`) but are distinct layers.
      // Anonymous `@layer { … }` blocks (empty name) are each distinct → always
      // a fresh rank, never stored. Later-declared layers outrank earlier ones.
      const local = rule.name
      const fullPath = local
        ? layerPath
          ? `${layerPath}.${local}`
          : local
        : `${layerPath}.#anon${++ctr.anon}` // dedicated counter → always-unique anon path
      let rank: number
      if (local && ctr.layerRanks.has(fullPath)) {
        rank = ctr.layerRanks.get(fullPath)!
      } else {
        rank = ++ctr.layer
        if (local) ctr.layerRanks.set(fullPath, rank)
      }
      walkRuleList(rule.cssRules, ref, media, mediaApplies, rank, fullPath, out, ctr)
    } else if (isGroupingRule(rule)) {
      // @supports etc. — keep current media + layer context, descend.
      walkRuleList(rule.cssRules, ref, media, mediaApplies, layerRank, layerPath, out, ctr)
    }
  }
}

// ── selector matching ────────────────────────────────────────────────────

/** Comma-parts of `selectorText` that currently match `element`. */
function matchingSelectors(element: Element, selectorText: string): string[] {
  const out: string[] = []
  for (const part of splitSelectorList(selectorText)) {
    try {
      if (element.matches(part)) out.push(part)
    } catch {
      // Unsupported/invalid selector (e.g. a pseudo-element, `::before`) —
      // can't match an element; ignore.
    }
  }
  return out
}

/**
 * Pseudo-classes describing a TRANSIENT interaction state — true only while the
 * pointer is over the element, or while it holds focus. Deliberately excludes
 * every DURABLE state (`:checked`, `:disabled`, `:required`, `:first-child`,
 * `:nth-child`, `:empty`, …): those describe the element the user is looking at,
 * so a rule matching one of them IS the style they see and must stay a candidate.
 */
const TRANSIENT_STATE_PSEUDO_CLASSES = new Set([
  'hover',
  'active',
  'focus',
  'focus-visible',
  'focus-within',
  'target',
  'target-within',
])

/**
 * Does this selector match only because of a transient interaction state?
 *
 * WHY THIS EXISTS ON TOP OF `element.matches()` (Phase 3 live finding 4). The
 * candidate walk already gates on `matches`, so a `:hover` rule is only ever a
 * candidate while the element really is hovered — and that is precisely the
 * problem: when the user clicks an element to inspect it, the cursor is BY
 * CONSTRUCTION sitting on that element, so `:hover` rules match for the whole
 * inspection. Live, the walker named
 * `.ui-button.primary[data-v-…]:hover:not(:disabled)…` as the source of the
 * button's `background-color` while `computedValue` reported the resting colour
 * — self-contradictory, and it would send the user to edit a rule that is not
 * what they are looking at. Worse for the cascade verifier: a `:hover` rule
 * outranking editor's override would report `css-overridden` on an edit that
 * visibly works at rest — a false alarm on a correct edit.
 *
 * So provenance answers about the element AT REST, always: a transient-state
 * selector is not a candidate even when it currently matches.
 *
 * Scope rules, which is where the subtlety is:
 *  - Only a POSITIVE dependency counts. `:not(:hover)` matches at rest and is
 *    kept; `.a:hover` and `.a:has(:hover)` are dropped. Nesting is tracked, so
 *    `:not(:is(:hover))` is kept too.
 *  - `::before` and friends are pseudo-ELEMENTS, never states — skipped (they
 *    also never match an element, so `matches` already excludes them).
 *  - Attribute-selector values are skipped wholesale, so a literal colon inside
 *    one (`[data-desde-src="src/App.vue:12:4"]`, `[data-x=":hover"]`) can never be
 *    misread as a pseudo-class.
 *
 * Exported for unit testing.
 */
export function dependsOnTransientState(selector: string): boolean {
  return transientStatePseudoClass(selector) !== null
}

/**
 * The FIRST transient-state pseudo-class `selector` positively depends on
 * (`'hover'`, `'focus-visible'`, …, lower-cased and without the leading colon),
 * or null when it depends on none. Same scope rules as
 * {@link dependsOnTransientState}, of which this is the implementation — the
 * name is what lets a consumer EXPLAIN the exclusion ("`:hover` currently
 * applies") rather than silently dropping the rule.
 *
 * Exported for unit testing.
 */
export function transientStatePseudoClass(selector: string): string | null {
  // Names of the functional pseudo-classes we are currently INSIDE, innermost
  // last — so an enclosing `:not(` can veto a positive match.
  const enclosing: string[] = []
  let i = 0
  while (i < selector.length) {
    const ch = selector[i]
    if (ch === '\\') {
      i += 2 // escaped character — never structural
      continue
    }
    if (ch === '[') {
      // Skip the whole attribute selector, quotes and all.
      i++
      let quote: string | null = null
      while (i < selector.length) {
        const c = selector[i]
        if (quote) {
          if (c === '\\') i++
          else if (c === quote) quote = null
        } else if (c === '"' || c === "'") {
          quote = c
        } else if (c === ']') {
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === ')') {
      enclosing.pop()
      i++
      continue
    }
    if (ch !== ':') {
      i++
      continue
    }
    if (selector[i + 1] === ':') {
      i += 2 // pseudo-ELEMENT
      continue
    }
    const match = /^:([-\w]+)/.exec(selector.slice(i))
    if (!match) {
      i++
      continue
    }
    const name = match[1].toLowerCase()
    i += match[0].length
    const functional = selector[i] === '('
    if (functional) {
      enclosing.push(name)
      i++
    }
    if (TRANSIENT_STATE_PSEUDO_CLASSES.has(name)) {
      // Negation flips the sense, and nests: an EVEN number of enclosing
      // `:not()`s leaves a positive dependency (`:not(:not(:hover))` ≡ `:hover`).
      const context = functional ? enclosing.slice(0, -1) : enclosing
      const negations = context.filter((n) => n === 'not').length
      if (negations % 2 === 0) return name
    }
  }
  return null
}

/**
 * Split a selector list on TOP-LEVEL commas (not inside `()` or `[]`).
 * Exported for unit testing — selector-list splitting is easy to get
 * subtly wrong around `:is(.a, .b)`.
 */
export function splitSelectorList(selectorText: string): string[] {
  const parts: string[] = []
  let depthParen = 0
  let depthBracket = 0
  let current = ''
  for (const ch of selectorText) {
    if (ch === '(') depthParen++
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1)
    else if (ch === '[') depthBracket++
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1)
    if (ch === ',' && depthParen === 0 && depthBracket === 0) {
      parts.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

// ── value parsing ──────────────────────────────────────────────────────────

/** Extract `--name` references from a CSS value (`var(--a, var(--b))` → [--a,--b]). */
function extractVarNames(value: string): string[] {
  const names: string[] = []
  const re = /var\(\s*(--[A-Za-z0-9_-]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(value)) !== null) names.push(m[1])
  return names
}

/** First pseudo-class in a selector (`:hover`, `:focus-within`), or null. */
function pseudoClassOf(selector: string): string | null {
  const m = selector.match(/(?<!:):([a-z-]+(?:\([^)]*\))?)/)
  return m ? ':' + m[1] : null
}

// ── specificity ──────────────────────────────────────────────────────────

function specificityTuple(selector: string): [number, number, number] {
  try {
    const results = Specificity.calculate(selector)
    const arr = results[0]?.toArray?.()
    if (Array.isArray(arr) && arr.length === 3) {
      return [arr[0], arr[1], arr[2]]
    }
  } catch {
    /* fall through */
  }
  return [0, 0, 0]
}

/**
 * Cascade winner comparison — returns true when candidate `a` beats `b`,
 * applying the cascade in priority order:
 *   1. `!important` declarations beat normal ones (regardless of layer).
 *   2. Cascade-layer rank, in the direction the origin calls for:
 *      - normal: HIGHER {@link CollectedRule.layerRank} wins — unlayered
 *        ({@link UNLAYERED}) outranks every layered rule, and a later-declared
 *        layer outranks an earlier one.
 *      - `!important`: **the comparison reverses** — LOWER rank wins, so an
 *        earlier-declared layer outranks a later one and unlayered-important
 *        (rank {@link UNLAYERED}, the maximum) is the weakest of all.
 *   3. Higher specificity.
 *   4. Later source order.
 *
 * The important-layer reversal in (2) is real CSS (Cascade 5 § "Cascade
 * Sorting Order"), not a nicety, and it MEASURES that way in Chromium — see
 * `tasks/scripts/important-layer-measure.mts`, which constructs each competing
 * shape in a real page and reads back `getComputedStyle`. Every branch above is
 * covered there, including that layer rank dominates specificity on BOTH sides
 * of the reversal and that specificity still decides *within* one layer.
 *
 * Why it matters beyond the inspector's display: a design system shipping
 * `@layer components { .btn { background-color: #111 !important } }` genuinely
 * beats editor's unlayered `[data-desde-src=…] { background-color: …
 * !important }`. Before this was modeled, the cascade verifier (which reads this
 * walker) could name editor's losing rule the winner and report a **false
 * pass**.
 *
 * Layering alone is NOT sufficient for the reversal to bite — the competing
 * declaration must ALSO be `!important`. Tailwind's utilities are layered but
 * normal-weight by default, where step (1) already puts editor's `!important`
 * override above them. So the exposure is a substrate that emits layered
 * utilities `!important`: the `!` modifier (`!bg-black`) or v4's global
 * important mode (`@import "tailwindcss" important;`).
 *
 * Remaining approximation (unchanged, and orthogonal to `!important`): layer
 * RANKS come from block encounter order, so a `@layer a, b, c;` statement that
 * pre-declares an order different from the blocks' appearance order isn't
 * modeled — see {@link CollectedRule.layerRank}. Both comparison directions
 * read the same ranks, so that approximation is neither widened nor narrowed
 * here.
 */
function cascadeBeats(a: Candidate, b: Candidate): boolean {
  if (a.important !== b.important) return a.important
  // Past this point both candidates share an importance, so one flag decides
  // which direction the layer comparison runs.
  if (a.rule.layerRank !== b.rule.layerRank) {
    return a.important
      ? a.rule.layerRank < b.rule.layerRank
      : a.rule.layerRank > b.rule.layerRank
  }
  for (let i = 0; i < 3; i++) {
    if (a.spec[i] !== b.spec[i]) return a.spec[i] > b.spec[i]
  }
  return a.rule.order > b.rule.order
}

// ── misc helpers ───────────────────────────────────────────────────────────

/**
 * The element's OWN inline declaration for `property`, or undefined when it has
 * none.
 *
 * `fromPreview` is set only when {@link StyleProvenanceDeps.isPreviewStampedProperty}
 * is both supplied and affirmative, so it is a positive claim ("this exact
 * declaration is editor's preview shim") and never a guess. It is reported
 * independently of `important` — the preview layer's own record is what
 * establishes ownership, not the priority the shim happens to use — and the key
 * is omitted entirely when false, keeping the wire payload byte-identical for
 * every declaration editor did not stamp.
 */
function readInline(
  element: Element,
  property: string,
  deps: StyleProvenanceDeps,
): { value: string; important: boolean; fromPreview?: boolean } | undefined {
  const style = (element as HTMLElement).style
  if (!style) return undefined
  const value = style.getPropertyValue(property)
  if (!value) return undefined
  let fromPreview = false
  try {
    fromPreview = deps.isPreviewStampedProperty?.(element, property) === true
  } catch {
    // The query is injected from another bridge module; a throw there must
    // degrade to "unknown" (absent), never break the provenance read.
  }
  return {
    value,
    important: style.getPropertyPriority(property) === 'important',
    ...(fromPreview ? { fromPreview: true } : {}),
  }
}

function safeComputed(element: Element, property: string): string {
  try {
    return element.ownerDocument.defaultView!
      .getComputedStyle(element)
      .getPropertyValue(property)
      .trim()
  } catch {
    return ''
  }
}

function mediaMatches(condition: string): boolean {
  try {
    return window.matchMedia(condition).matches
  } catch {
    // jsdom / no matchMedia — assume the rule applies rather than drop it.
    return true
  }
}

/**
 * Attributes a bundler stamps on an injected `<style>` naming the real source
 * file it compiled that CSS from. Consulted ONLY when the sheet has no `href`
 * (see {@link stylesheetSourceHint}) — a real href is always the better answer.
 *
 * Vite is the one entry today because it is the dev server Editor supervises;
 * another bundler's equivalent is one more string in this list, not a change
 * anywhere else.
 */
const SOURCE_HINT_ATTRIBUTES = ['data-vite-dev-id'] as const

/**
 * The owner node's source-file hint, or undefined when it declares none. Kept
 * separate from {@link stylesheetRef} so the bundler-specific knowledge is one
 * lookup table rather than a branch in the walk.
 */
export function stylesheetSourceHint(owner: Node | null | undefined): string | undefined {
  if (!owner) return undefined
  // `CSSStyleSheet.ownerNode` is `Element | ProcessingInstruction`; only the
  // former has getAttribute. Duck-type rather than `instanceof` (cross-realm).
  const el = owner as Partial<Element>
  if (typeof el.getAttribute !== 'function') return undefined
  for (const name of SOURCE_HINT_ATTRIBUTES) {
    const value = el.getAttribute(name)
    if (value && value.trim()) return value.trim()
  }
  return undefined
}

/**
 * Every stylesheet the document has loaded, as `StyleStylesheetRef`s, **in
 * document order**.
 *
 * This is an exposure of a computation `collectRules` already performs, not
 * new DOM knowledge — and it exists because a CSS override written into a
 * `.css` file the app never imports is inert. Walking the filesystem for
 * `.css` files (`walkAppCssFiles`, `buildDesignTokenSources`) finds files on
 * DISK; only `document.styleSheets` proves REACHABILITY. See
 * `tasks/dev-server-hosts.md` § 9g.1.
 *
 * Document order is load-bearing for the caller's last-rung tie-break: later
 * source order wins at equal importance and specificity.
 *
 * Cross-origin sheets are kept, not skipped: their `href` is readable even
 * when their `cssRules` are not, and the caller refuses them anyway (they
 * cannot map to a first-party writable path).
 */
export function collectStylesheetRefs(doc: Document): StyleStylesheetRef[] {
  let sheets: StyleSheetList
  try {
    sheets = doc.styleSheets
  } catch {
    return []
  }
  const out: StyleStylesheetRef[] = []
  for (const sheet of Array.from(sheets)) {
    try {
      out.push(stylesheetRef(sheet as CSSStyleSheet))
    } catch {
      // A sheet whose owner node is gone mid-walk; skip it rather than
      // failing the whole enumeration.
    }
  }
  return out
}

function stylesheetRef(sheet: CSSStyleSheet): StyleStylesheetRef {
  const owner = sheet.ownerNode
  const href = sheet.href ?? (owner?.nodeName === 'STYLE' ? '<style>' : '<inline>')
  // `href` stays primary; the hint only answers for sheets that have none.
  const sourceHint = sheet.href ? undefined : stylesheetSourceHint(owner)
  const pkg = parsePackage(href) ?? (sourceHint ? parsePackage(sourceHint) : undefined)
  return {
    href,
    ...(pkg ? { package: pkg } : {}),
    ...(sourceHint ? { sourceHint } : {}),
  }
}

/**
 * Parse the npm package name from a `node_modules/<pkg>` href or source-hint
 * path. Exported for unit testing — jsdom `<style>` sheets carry no href, so
 * this path can't be exercised through `getStyleProvenance` in jsdom.
 */
export function parsePackage(href: string): string | undefined {
  const m = href.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)
  return m ? m[1] : undefined
}

// ── narrow CSSOM type guards (avoid `instanceof` across realms) ─────────────

function isStyleRule(rule: CSSRule): rule is CSSStyleRule {
  return rule.type === 1 /* STYLE_RULE */ && 'selectorText' in rule
}
function isMediaRule(rule: CSSRule): rule is CSSMediaRule {
  return rule.type === 4 /* MEDIA_RULE */ && 'media' in rule
}
/**
 * `@layer name { … }` block. CSSLayerBlockRule has no stable numeric type, so
 * match structurally: it groups rules (`cssRules`) and carries a layer `name`,
 * but isn't a media/supports/style rule. (`@layer a,b,c;` *statement* rules
 * have no `cssRules` and are intentionally not matched — see the layerRank
 * approximation note.)
 */
function isLayerBlockRule(rule: CSSRule): rule is CSSGroupingRule & { name: string } {
  return (
    'cssRules' in rule &&
    'name' in rule &&
    !('media' in rule) &&
    !('selectorText' in rule) &&
    !('conditionText' in rule)
  )
}
function isGroupingRule(rule: CSSRule): rule is CSSGroupingRule {
  // @supports and other grouping rules expose `cssRules`. Match structurally
  // so cross-realm + newer grouping rule types still descend. (Layer blocks
  // are handled earlier by isLayerBlockRule.)
  return 'cssRules' in rule
}
