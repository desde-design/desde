/**
 * Deterministic slot-text edit. Same shape as `apply-prop-edit.ts`: locate
 * an element at SFC-absolute (line, column), find its single text-node child,
 * verify the content matches `before` (after trimming both), and rewrite
 * just that text-node span to `after`. Returns `{ ok: false }` for any case
 * the LLM patch should handle (mixed slot children, interpolation, multiple
 * text fragments, mismatch).
 *
 * Why this exists: every text edit otherwise round-trips through Claude
 * (`apply-llm-patch.ts`), which is ~95s for a trivial "Default ACL" →
 * "Welcome" change. The deterministic path handles the common slot-text
 * case in sub-100ms; the LLM remains the fallback for shapes this can't
 * statically rewrite.
 */

import { parse as parseSfc } from '@vue/compiler-sfc'
import { compile as compileTemplate, NodeTypes } from '@vue/compiler-dom'
import { resolveTemplateTarget } from './resolve-template-target'

export interface ApplySlotTextEditInput {
  /** Full SFC source text. */
  source: string
  /** 1-based line within the SFC (same coords `data-desde-src` carries). */
  line: number
  /** 1-based column within the SFC. */
  column: number
  /** Current rendered text content (from the bridge's mutation `before`). */
  before: string
  /** New text the designer typed. */
  after: string
}

export type ApplySlotTextEditResult =
  | { ok: true; source: string }
  | { ok: false; reason: string }

interface ElementLike {
  type: number
  tag: string
  loc: {
    start: { line: number; column: number; offset: number }
    end: { offset: number }
  }
  children: Array<ChildLike>
  isSelfClosing: boolean
}

interface TextChildLike {
  type: typeof NodeTypes.TEXT
  content: string
  loc: { start: { offset: number }; end: { offset: number } }
}

interface InterpolationChildLike {
  type: typeof NodeTypes.INTERPOLATION
  loc: { start: { offset: number }; end: { offset: number } }
}

interface ElementChildLike {
  type: typeof NodeTypes.ELEMENT
  loc: { start: { offset: number }; end: { offset: number } }
}

type ChildLike = TextChildLike | InterpolationChildLike | ElementChildLike | {
  type: number
  loc: { start: { offset: number }; end: { offset: number } }
}

export function applySlotTextEdit(
  input: ApplySlotTextEditInput,
): ApplySlotTextEditResult {
  const { source, line, column, before, after } = input

  const trimmedBefore = before.trim()
  const trimmedAfter = after.trim()
  if (trimmedBefore.length === 0) {
    return { ok: false, reason: 'before is empty after trimming' }
  }
  if (trimmedBefore === trimmedAfter) {
    return { ok: false, reason: 'no-op (before equals after after trimming)' }
  }

  // Resolve the target element via the shared resolver (parse the SFC,
  // re-parse the template content, shift loc, exact-match walk).
  const resolved = resolveTemplateTarget({ source, line, column })
  if (!resolved.ok) {
    return { ok: false, reason: resolved.failure.reason }
  }
  const target = resolved.node as unknown as ElementLike
  const { templateOffset } = resolved.ctx

  if (target.isSelfClosing) {
    return { ok: false, reason: 'Element is self-closing; no slot content to edit' }
  }

  // Collect significant children. Whitespace-only TEXT nodes don't count —
  // they're template indentation, not authored content.
  const significantChildren = target.children.filter((c) => {
    if (c.type === NodeTypes.TEXT) {
      return typeof (c as TextChildLike).content === 'string' &&
        (c as TextChildLike).content.trim().length > 0
    }
    // INTERPOLATION, ELEMENT, IF, FOR — anything else is "significant" and
    // means we can't deterministically rewrite a single text span.
    return true
  })

  if (significantChildren.length === 0) {
    return { ok: false, reason: 'Element has no significant slot content' }
  }

  let textNode: TextChildLike
  if (significantChildren.length === 1) {
    const only = significantChildren[0]
    if (only.type !== NodeTypes.TEXT) {
      return {
        ok: false,
        reason: `Slot content is a ${describeNodeType(only.type)}, not a static text node; LLM fallback required`,
      }
    }
    textNode = only as TextChildLike
  } else {
    // Mixed slot content (icon + text, nested component + text, two
    // text fragments separated by an element, etc.). Disambiguate by
    // matching the bridge-captured `before` against each TEXT child's
    // trimmed content — non-text siblings stay untouched. Refuse only
    // when zero or 2+ TEXT children match (then the edit is genuinely
    // ambiguous and the LLM fallback should pick).
    const textMatches: TextChildLike[] = []
    for (const c of significantChildren) {
      if (c.type !== NodeTypes.TEXT) continue
      const t = c as TextChildLike
      if (t.content.trim() === trimmedBefore) textMatches.push(t)
    }
    if (textMatches.length === 0) {
      return {
        ok: false,
        reason: `Element has ${significantChildren.length} significant children; no text child matches before (\`${truncate(trimmedBefore, 60)}\`); LLM fallback required`,
      }
    }
    if (textMatches.length > 1) {
      return {
        ok: false,
        reason: `Element has ${textMatches.length} text children matching before (\`${truncate(trimmedBefore, 60)}\`); ambiguous, LLM fallback required`,
      }
    }
    textNode = textMatches[0]
  }
  // Vue's compiler condenses whitespace inside text content by default
  // (`whitespace: 'condense'`), so `textNode.content` may differ from
  // the raw source bytes — e.g. `<KLabel>  Spaced  </KLabel>` parses to
  // content `" Spaced "` (collapsed). For matching, compare trimmed
  // forms. For rewriting, read the original source span so the
  // surrounding whitespace (indentation, newlines, double-spaces) is
  // preserved exactly.
  const start = templateOffset + textNode.loc.start.offset
  const end = templateOffset + textNode.loc.end.offset
  const originalSpan = source.slice(start, end)
  const originalTrimmed = originalSpan.trim()
  if (originalTrimmed !== trimmedBefore) {
    return {
      ok: false,
      reason: `Slot text content (\`${truncate(originalTrimmed, 60)}\`) does not match before (\`${truncate(trimmedBefore, 60)}\`); LLM fallback required`,
    }
  }

  // Replace the meaningful text portion of the span while preserving
  // leading + trailing whitespace from source verbatim. Source
  // formatting (indentation, surrounding newlines, internal padding)
  // survives the edit.
  const leadingWs = originalSpan.match(/^\s*/)?.[0] ?? ''
  const trailingWs = originalSpan.match(/\s*$/)?.[0] ?? ''
  const newSpan = `${leadingWs}${trimmedAfter}${trailingWs}`

  const newSource = source.slice(0, start) + newSpan + source.slice(end)

  // Post-splice validation (WS2 defense-in-depth, tasks/
  // edit-pipeline-rearchitecture.md) — mirrors `apply-move-edit.ts`'s post-
  // splice check. Unlike apply-prop-edit's attribute values, `after` is
  // spliced into the template as raw text content with no escaping (a
  // literal `<` or an unterminated tag genuinely breaks the template), so
  // this backstop is reachable in practice, not just theoretical.
  try {
    const newDescriptor = parseSfc(newSource).descriptor
    if (!newDescriptor.template) {
      return { ok: false, reason: 'Post-splice SFC lost its <template> block' }
    }
    compileTemplate(newDescriptor.template.content)
  } catch (err) {
    return {
      ok: false,
      reason: `Post-splice template compile failed: ${(err as Error).message}`,
    }
  }

  return { ok: true, source: newSource }
}

function describeNodeType(t: number): string {
  switch (t) {
    case NodeTypes.INTERPOLATION:
      return 'Vue interpolation (`{{ … }}`)'
    case NodeTypes.ELEMENT:
      return 'nested element'
    case NodeTypes.IF:
      return 'v-if conditional'
    case NodeTypes.FOR:
      return 'v-for loop'
    case NodeTypes.COMMENT:
      return 'HTML comment'
    default:
      return `unknown node type ${t}`
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}
