/**
 * Slot-interpolation property-key extractor.
 *
 * For dom-text edits inside a v-for, the deterministic "this row" lane
 * needs to know which property of the iterated entry to patch. Given
 * a Vue SFC template position pointing at the slot's enclosing
 * element and the v-for's iteratee root, this returns the property
 * key authored in a `{{ <root>.<key> }}` interpolation child — or
 * refuses with a reason the caller can surface.
 *
 * Examples (root = `step`):
 *   <KStep>{{ step.label }}</KStep>          → "label"
 *   <KStep><span>{{ step.title }}</span></KStep>  → refuses (text is in a wrapper)
 *   <KStep>Logging</KStep>                    → refuses (literal, not interpolation)
 *   <KStep>{{ step.label.toUpperCase() }}</KStep> → refuses (computed expression)
 *   <KStep>{{ step }}</KStep>                 → refuses (entry itself, no key)
 *
 * Scope today: single-key member access only. Chained access
 * (`step.title.text`) and computed expressions refuse and route to
 * the LLM lane. The applicator that consumes this only knows how to
 * patch a single top-level property anyway, so refusing keeps the
 * deterministic path honest.
 */

import { parse as parseSfc } from "@vue/compiler-sfc"
import { parse as parseTemplate, NodeTypes } from "@vue/compiler-dom"

export interface ExtractSlotInterpolationKeyInput {
  /** Full SFC source text. */
  source: string
  /** SFC-absolute 1-based line of the slot's enclosing element. */
  line: number
  /** SFC-absolute 1-based column. */
  column: number
  /**
   * The v-for iteratee's root identifier — `step` in
   * `v-for="step in steps"`. The extractor refuses when the
   * interpolation accesses a different root, so a stray
   * `{{ otherVar.label }}` inside the same element doesn't get
   * mistaken for the iteration field.
   */
  itemVar: string
}

export type ExtractSlotInterpolationKeyResult =
  | { ok: true; propertyKey: string }
  | { ok: false; reason: string }

interface ElementLike {
  type: number
  tag: string
  loc: { start: { line: number; column: number; offset: number }; end: { offset: number } }
  children: Array<ChildLike>
  isSelfClosing: boolean
}

interface InterpolationLike {
  type: typeof NodeTypes.INTERPOLATION
  content: { type: number; content: string }
  loc: { start: { offset: number }; end: { offset: number } }
}

interface TextLike {
  type: typeof NodeTypes.TEXT
  content: string
  loc: { start: { offset: number }; end: { offset: number } }
}

type ChildLike = ElementLike | InterpolationLike | TextLike | {
  type: number
  loc: { start: { offset: number }; end: { offset: number } }
}

function findElementAt(
  children: ChildLike[],
  targetLine: number,
  targetColumn: number,
  templateStartLine: number,
  templateStartColumn: number,
): ElementLike | null {
  for (const c of children) {
    if (c.type !== NodeTypes.ELEMENT) continue
    const el = c as ElementLike
    // compiler-dom emits template-content-relative line numbers, so
    // shift by the template block's start position to get SFC-absolute.
    const sfcLine = el.loc.start.line + templateStartLine - 1
    const sfcColumn = el.loc.start.line === 1
      ? el.loc.start.column + templateStartColumn - 1
      : el.loc.start.column
    if (sfcLine === targetLine && sfcColumn === targetColumn) {
      return el
    }
    const inner = findElementAt(
      el.children,
      targetLine,
      targetColumn,
      templateStartLine,
      templateStartColumn,
    )
    if (inner) return inner
  }
  return null
}

/**
 * Parse `<root>.<key>` from an interpolation's content. Refuse for
 * any shape that isn't a single-level member access on the iteratee.
 *
 * Accepted:
 *   "step.label"  → "label"
 *   "  step.label  "  → "label"  (Vue trims for us, but be defensive)
 *
 * Refused:
 *   "step"                  → entry itself, no field
 *   "step.label.toUpperCase" → chained access / method call
 *   "step.label.text"       → nested property — applicator can't patch
 *   "step['label']"         → bracket access (would need to parse + handle quotes)
 *   "otherVar.label"        → not the iteratee
 *   "step.label + ' (X)'"   → expression
 */
function parseInterpolationContent(
  raw: string,
  itemVar: string,
): ExtractSlotInterpolationKeyResult {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return { ok: false, reason: "Empty interpolation" }
  }
  // Reject anything that doesn't look like a bare identifier sequence.
  // The Vue compiler will have allowed arbitrary JS, but the
  // deterministic lane only handles simple member access.
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(trimmed)) {
    return {
      ok: false,
      reason: `Interpolation \`{{ ${trimmed} }}\` is not a simple member access: LLM fallback required`,
    }
  }
  const parts = trimmed.split(".")
  if (parts[0] !== itemVar) {
    return {
      ok: false,
      reason: `Interpolation root \`${parts[0]}\` does not match the v-for iteratee \`${itemVar}\``,
    }
  }
  if (parts.length === 1) {
    return {
      ok: false,
      reason: `Interpolation \`{{ ${trimmed} }}\` reads the entry itself; no single property to patch`,
    }
  }
  if (parts.length > 2) {
    return {
      ok: false,
      reason: `Interpolation \`{{ ${trimmed} }}\` accesses a nested property; deterministic lane only patches top-level fields`,
    }
  }
  return { ok: true, propertyKey: parts[1] }
}

export function extractSlotInterpolationKey(
  input: ExtractSlotInterpolationKeyInput,
): ExtractSlotInterpolationKeyResult {
  const { source, line, column, itemVar } = input

  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(itemVar)) {
    return {
      ok: false,
      reason: `Iteratee root \`${itemVar}\` is not a bare identifier`,
    }
  }

  let descriptor
  try {
    descriptor = parseSfc(source).descriptor
  } catch (err) {
    return { ok: false, reason: `SFC parse failed: ${(err as Error).message}` }
  }
  if (!descriptor.template) {
    return { ok: false, reason: "SFC has no <template> block" }
  }
  const templateContent = descriptor.template.content
  const templateStartLine = descriptor.template.loc.start.line
  const templateStartColumn = descriptor.template.loc.start.column

  let templateAst
  try {
    templateAst = parseTemplate(templateContent)
  } catch (err) {
    return { ok: false, reason: `Template parse failed: ${(err as Error).message}` }
  }

  const target = findElementAt(
    templateAst.children as ChildLike[],
    line,
    column,
    templateStartLine,
    templateStartColumn,
  )
  if (!target) {
    return {
      ok: false,
      reason: `No element found at SFC line ${line}, column ${column}`,
    }
  }

  // Filter to "significant" children — whitespace-only TEXT counts as
  // template indentation, not content. INTERPOLATION, real text, or
  // any other element all count.
  const significantChildren = target.children.filter((c) => {
    if (c.type === NodeTypes.TEXT) {
      const text = (c as TextLike).content
      return typeof text === "string" && text.trim().length > 0
    }
    return c.type === NodeTypes.INTERPOLATION || c.type === NodeTypes.ELEMENT
  })

  if (significantChildren.length === 0) {
    return { ok: false, reason: "Element has no significant slot content" }
  }
  if (significantChildren.length > 1) {
    return {
      ok: false,
      reason: `Element has ${significantChildren.length} significant children; ambiguous which one carries the iteration field`,
    }
  }
  const only = significantChildren[0]
  if (only.type !== NodeTypes.INTERPOLATION) {
    return {
      ok: false,
      reason: `Slot content is a ${describeNodeType(only.type)}, not an interpolation; "this row" needs a v-for-bound text expression`,
    }
  }
  const interp = only as InterpolationLike
  const rawContent = typeof interp.content?.content === "string"
    ? interp.content.content
    : ""
  return parseInterpolationContent(rawContent, itemVar)
}

function describeNodeType(type: number): string {
  switch (type) {
    case NodeTypes.TEXT:
      return "static text"
    case NodeTypes.INTERPOLATION:
      return "interpolation"
    case NodeTypes.ELEMENT:
      return "child element"
    case NodeTypes.IF:
      return "v-if block"
    case NodeTypes.FOR:
      return "v-for block"
    default:
      return `node type ${type}`
  }
}
