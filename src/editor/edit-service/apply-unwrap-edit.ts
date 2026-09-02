/**
 * Pure (filesystem-free) UnwrapEdit applicator. Given a Vue SFC's source
 * and the build-time `(line, column)` of a wrapper element, produces a
 * new SFC source with the wrapper element's tags removed and its
 * children hoisted to the wrapper's former position in the parent.
 *
 * `<div><span/><p/></div>` becomes `<span/><p/>`.
 *
 * Coordinates follow the same convention as the other applicators:
 * line/column are SFC-absolute (the values the substrate's source-tag
 * plugin writes into `data-desde-src`). Internally we re-parse the template
 * with `@vue/compiler-dom` (template-content-relative loc) and shift by
 * the SFC's template block start when matching.
 *
 * Refusal cases:
 *   - The (line, column) doesn't match any element in the template.
 *   - The target is self-closing — there are no children to hoist; the
 *     user wants Delete, not Unwrap.
 *   - The target is empty (no element children, no non-whitespace text,
 *     no interpolations). Same reason: use Delete.
 *   - The target IS the SFC's only meaningful root AND has multiple
 *     element children. Vue requires a single template root, so
 *     unwrapping here would produce an invalid template. The post-
 *     splice compile() guard would catch this too, but we surface a
 *     clearer reason up front.
 *
 * Structural traps the post-splice compile() guard catches (not refused
 * up front because the wrapper-relationship is encoded in the AST, not
 * just the element identity):
 *   - Unwrapping a `<template v-if="…">` while a `<template v-else>`
 *     sibling exists — Vue codegen explodes with "v-else has no adjacent
 *     v-if." User should Flatten Conditional instead.
 *   - Unwrapping a `<template v-for>` — the iteration semantics are
 *     destroyed, but the markup may still parse.
 *
 * V1 simplifications:
 *   - Snip the wrapper's open and close tag exact byte ranges without
 *     re-indenting the now-promoted children. Result may have minor
 *     formatting drift (one extra indent level on the children's text
 *     leading whitespace); HMR re-render or a save-time prettier run
 *     will normalize. Same trade-off as MoveEdit / DeleteEdit.
 */

import { parse as parseSfc } from '@vue/compiler-sfc'
import { compile as compileTemplate, NodeTypes } from '@vue/compiler-dom'
import { resolveTemplateTarget } from './resolve-template-target'

export interface ApplyUnwrapEditInput {
  /** Full SFC source text. */
  source: string
  /** Wrapper element location — 1-based SFC-absolute. */
  line: number
  column: number
}

export type ApplyUnwrapEditResult =
  | { ok: true; source: string }
  | { ok: false; reason: string }

interface ElementLike {
  type: number
  tag: string
  isSelfClosing: boolean
  loc: {
    start: { line: number; column: number; offset: number }
    end: { offset: number }
  }
  props: Array<{
    type?: number
    name?: string
    loc?: { end?: { offset?: number } }
  }>
  children: ChildNode[]
}

/** Vue template directives whose semantics live on the WRAPPER element,
 *  not its children. Unwrapping such an element would silently strip
 *  the directive — the children would render but the iteration / branch
 *  / slot semantics would be gone. We refuse rather than silently
 *  produce surprising output; the user should use `flatten-conditional`
 *  for v-if-family wrappers, or `delete` for the whole v-for region. */
const REFUSED_DIRECTIVES = new Set([
  'for',
  'if',
  'else-if',
  'else',
  'slot',
  'show', // v-show toggles display; unwrap would lose it
])

interface ChildNode {
  type: number
  content?: string
  loc: {
    start: { offset: number }
    end: { offset: number }
  }
}

function hasRenderedContent(children: ChildNode[]): boolean {
  for (const c of children) {
    if (c.type === NodeTypes.ELEMENT) return true
    if (c.type === NodeTypes.INTERPOLATION) return true
    if (c.type === NodeTypes.TEXT && typeof c.content === 'string' && c.content.trim().length > 0) {
      return true
    }
  }
  return false
}

function countElementChildren(children: ChildNode[]): number {
  let n = 0
  for (const c of children) if (c.type === NodeTypes.ELEMENT) n++
  return n
}

export function applyUnwrapEdit(input: ApplyUnwrapEditInput): ApplyUnwrapEditResult {
  const { source, line, column } = input

  // Resolve the wrapper element via the shared resolver (parse the SFC,
  // re-parse the template content, shift loc, exact-match walk).
  const resolved = resolveTemplateTarget({ source, line, column })
  if (!resolved.ok) {
    return { ok: false, reason: resolved.failure.reason }
  }
  const target = resolved.node as unknown as ElementLike
  const { templateContent, templateOffset, templateAst } = resolved.ctx

  if (target.isSelfClosing) {
    return {
      ok: false,
      reason: `<${target.tag}> is self-closing and has no children to unwrap. Use Delete instead.`,
    }
  }
  if (!hasRenderedContent(target.children)) {
    return {
      ok: false,
      reason: `<${target.tag}> has no rendered children to hoist. Use Delete instead.`,
    }
  }
  // Refuse wrappers whose directives semantically belong on the
  // wrapper, not its children. Codex review found that without this
  // guard, unwrapping `<div v-for>` or `<template v-if>` silently
  // dropped the iteration / branch semantics; the post-splice compile
  // catches some shapes but not all, and the error there is opaque.
  // Surface a clear refusal here so the user knows to use Flatten
  // Conditional or Delete instead.
  const offending = directiveOn(target)
  if (offending) {
    return {
      ok: false,
      reason: `<${target.tag} v-${offending}> carries a directive that belongs on the wrapper, not its children. Unwrap would silently drop the directive's semantics. Use Flatten Conditional (for v-if-family) or Delete instead.`,
    }
  }

  // Vue's "single root" rule: if the wrapper is itself the only rendered
  // top-level node and unwrapping it would yield multiple element
  // children, the resulting template has >1 root and Vue refuses to
  // compile it. We could let the post-splice compile() catch this, but
  // surfacing it explicitly gives a more actionable error.
  const meaningfulRoots = (templateAst.children as ChildNode[]).filter((c) => {
    if (c.type === NodeTypes.ELEMENT) return true
    if (c.type === NodeTypes.INTERPOLATION) return true
    if (c.type === NodeTypes.TEXT && typeof c.content === 'string' && c.content.trim().length > 0) return true
    return false
  })
  const targetIsOnlyRoot =
    meaningfulRoots.length === 1 && (meaningfulRoots[0] as ElementLike) === target
  if (targetIsOnlyRoot && countElementChildren(target.children) > 1) {
    return {
      ok: false,
      reason:
        "Refusing to unwrap the template's only root when it has multiple element children: Vue requires a single root.",
    }
  }

  // Compute the inner-content byte range: from the offset right after
  // the open tag's `>` to the offset right before the close tag's `</`.
  // The close tag is always `</${tag}>`, length = tag.length + 3.
  const openTagClose = findOpenTagClose(templateContent, target)
  if (openTagClose < 0) {
    return { ok: false, reason: `Could not locate open-tag close for <${target.tag}>` }
  }
  const innerStart = templateOffset + openTagClose + 1
  const innerEnd = templateOffset + target.loc.end.offset - (target.tag.length + 3)
  const wrapperStart = templateOffset + target.loc.start.offset
  const wrapperEnd = templateOffset + target.loc.end.offset

  if (innerStart < wrapperStart || innerEnd > wrapperEnd || innerStart > innerEnd) {
    return {
      ok: false,
      reason: 'Computed inner-content range is inconsistent with wrapper bounds',
    }
  }

  const innerText = source.slice(innerStart, innerEnd)
  const newSource = source.slice(0, wrapperStart) + innerText + source.slice(wrapperEnd)

  // Post-splice compile check (not just parse) — catches structural
  // problems like orphaning a sibling v-else when unwrapping a
  // <template v-if>. Same hygiene as apply-move-edit.ts.
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

/** Return the refused-directive name (without `v-`) carried by `el`, or
 *  null when the wrapper has no refused directive. We check by props
 *  walk because `@vue/compiler-dom` represents directives as a separate
 *  prop subtype (NodeTypes.DIRECTIVE === 7) with the directive name
 *  stripped of the `v-` prefix. */
function directiveOn(el: ElementLike): string | null {
  for (const p of el.props) {
    if (p.type === NodeTypes.DIRECTIVE && typeof p.name === 'string') {
      if (REFUSED_DIRECTIVES.has(p.name)) return p.name
    }
  }
  return null
}

/** Find the byte offset of the open tag's closing `>` in templateContent.
 *  Mirrors the helper in apply-move-edit.ts. */
function findOpenTagClose(templateContent: string, target: ElementLike): number {
  const startOffset = target.loc.start.offset
  const props = target.props
  let scanFrom: number
  if (props.length > 0) {
    const lastProp = props[props.length - 1]
    scanFrom = lastProp.loc?.end?.offset ?? startOffset + 1 + target.tag.length
  } else {
    scanFrom = startOffset + 1 + target.tag.length
  }
  for (let i = scanFrom; i < templateContent.length; i++) {
    const ch = templateContent[i]
    if (ch === '>') return i
    if (ch === '/' && templateContent[i + 1] === '>') return i
  }
  return -1
}
