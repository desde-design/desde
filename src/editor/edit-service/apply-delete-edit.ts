/**
 * Pure (filesystem-free) DeleteEdit applicator. Given a Vue SFC's
 * source and the build-time `(line, column)` of an element, produces
 * a new SFC source with the element removed.
 *
 * Coordinates follow the same convention as
 * {@link import('./apply-prop-edit').applyPropEdit} and
 * {@link import('./apply-move-edit').applyMoveEdit}: line/column are
 * SFC-absolute (the values the substrate's source-tag plugin writes
 * into `data-desde-src`). Internally we re-parse the template with
 * `@vue/compiler-dom` (template-content-relative loc) and shift by
 * the SFC's template block start when matching.
 *
 * Refusal cases:
 *   - The (line, column) doesn't match any element in the template.
 *   - The match is the SFC's root element (Vue requires a single root,
 *     deleting it would leave an empty template).
 *
 * Whitespace handling (fixed 2026-08-10; was a V1 simplification):
 *   - The element is removed together with its **gutter** — the
 *     horizontal whitespace back to the start of its line plus that
 *     line's leading newline. Snipping the exact byte range instead
 *     left a whitespace-only orphan line at the deleted position,
 *     which accumulates over a session and shows up in the diff the
 *     user reviews before committing. Consuming the gutter also keeps
 *     exactly ONE separator between the siblings that become adjacent.
 *     Shares {@link findGutterStart} with MoveEdit so the two can't
 *     drift apart again.
 *   - No "delete and replace with a slot" or "delete and merge
 *     siblings" features. Simple snip.
 */

import { parse as parseSfc } from '@vue/compiler-sfc'
import {
  parse as parseTemplate,
  compile as compileTemplate,
  NodeTypes,
} from '@vue/compiler-dom'
import { resolveTemplateTarget } from './resolve-template-target'
import type { TemplateTargetContext } from './resolve-template-target'
import { findGutterStart } from './template-whitespace'

export interface ApplyDeleteEditInput {
  /** Full SFC source text. */
  source: string
  /** Element location — 1-based SFC-absolute. */
  line: number
  column: number
}

export type ApplyDeleteEditResult =
  | { ok: true; source: string }
  | { ok: false; reason: string }

interface ElementLike {
  type: number
  tag: string
  loc: {
    start: { line: number; column: number; offset: number }
    end: { offset: number }
  }
  children: ElementLike[]
}

interface TopLevelNode {
  type: number
  /** TEXT nodes carry `content`; ELEMENT/INTERPOLATION/COMMENT use other fields. */
  content?: string
}

/**
 * Is this top-level template node "meaningful" — i.e., would removing
 * the surrounding renderable nodes leave the template effectively
 * empty? Elements, interpolations (`{{ msg }}`), and non-whitespace
 * text count. Comments and pure-whitespace text don't.
 */
function isMeaningfulTopLevelNode(node: TopLevelNode): boolean {
  if (node.type === NodeTypes.ELEMENT) return true
  if (node.type === NodeTypes.INTERPOLATION) return true
  if (node.type === NodeTypes.TEXT) {
    return typeof node.content === 'string' && node.content.trim().length > 0
  }
  return false
}

export function applyDeleteEdit(input: ApplyDeleteEditInput): ApplyDeleteEditResult {
  const { source, line, column } = input

  // Resolve the target element via the shared resolver. The historical
  // "Template has no rendered content" precheck ran BEFORE the element
  // lookup, so an empty template (comments / whitespace only) refused with
  // that reason rather than "No element found" — the `not-found` failure
  // carries the parsed ctx so we can preserve that ordering.
  const resolved = resolveTemplateTarget({ source, line, column })
  if (!resolved.ok) {
    if (
      resolved.failure.kind === 'not-found' &&
      meaningfulRootsOf(resolved.failure.ctx).length === 0
    ) {
      return { ok: false, reason: 'Template has no rendered content' }
    }
    return { ok: false, reason: resolved.failure.reason }
  }
  const target = resolved.node as unknown as ElementLike
  const { templateOffset, templateAst } = resolved.ctx

  const meaningfulRoots = (templateAst.children as TopLevelNode[]).filter(
    isMeaningfulTopLevelNode,
  )

  // Refuse deleting the SFC's only meaningful top-level child. We count
  // ALL renderable roots (elements, interpolations, non-whitespace text)
  // so a template like `<div>foo</div>{{ msg }}` correctly allows
  // deleting the div — the `{{ msg }}` interpolation is still rendered
  // content. Per codex P2: counting only Elements caused false
  // refusals for templates that mix element and interpolation roots.
  if (
    meaningfulRoots.length === 1 &&
    (meaningfulRoots[0] as ElementLike) === target
  ) {
    return {
      ok: false,
      reason:
        "Refusing to delete the template's only rendered content: would leave an empty <template>",
    }
  }

  const start = templateOffset + target.loc.start.offset
  const end = templateOffset + target.loc.end.offset

  // Remove the element together with its gutter, so the deleted position
  // doesn't keep a whitespace-only orphan line. `findGutterStart` can never
  // reach back past the `<template>` open tag: the character preceding the
  // block's content is `>`, which stops the backscan.
  const removeStart = findGutterStart(source, start)
  const newSource = source.slice(0, removeStart) + source.slice(end)

  // Post-splice validation. Parsing alone is NOT enough, and that gap was a
  // live defect: deleting a `v-if` element leaves its `v-else` sibling with
  // no branch to attach to, which PARSES fine but fails the transform with
  // "v-else/v-else-if has no adjacent v-if or v-else-if" — so the applicator
  // returned ok:true and the caller wrote a file Vite then refused to
  // compile. Measured on the dogfood substrate, 71 of 1178 sampled deletes
  // (6%) hit exactly that. MoveEdit already ran the FULL compile for the
  // same reason; delete now matches it.
  //
  // The check is conditional on the ORIGINAL template compiling: if the file
  // was already broken before we touched it, refusing every structural edit
  // would lock the user out of the very edits that might fix it. We only
  // refuse when the delete is what broke it.
  let newDescriptor
  try {
    newDescriptor = parseSfc(newSource).descriptor
    if (!newDescriptor.template) {
      return { ok: false, reason: 'Post-splice SFC lost its <template> block' }
    }
    parseTemplate(newDescriptor.template.content)
  } catch (err) {
    return {
      ok: false,
      reason: `Post-splice template parse failed: ${(err as Error).message}`,
    }
  }
  if (compiles(resolved.ctx.templateContent) && !compiles(newDescriptor.template.content)) {
    return {
      ok: false,
      reason: `Deleting <${target.tag}> would leave the template unable to compile: ${compileError(newDescriptor.template.content)}. It is probably the v-if head of a conditional whose v-else branch would be orphaned. Delete the whole conditional, or restructure via chat.`,
    }
  }

  return { ok: true, source: newSource }
}

function meaningfulRootsOf(ctx: TemplateTargetContext): TopLevelNode[] {
  return (ctx.templateAst.children as TopLevelNode[]).filter(isMeaningfulTopLevelNode)
}

/** Does this template survive the FULL compile (parse + transform + codegen)? */
function compiles(templateContent: string): boolean {
  try {
    compileTemplate(templateContent)
    return true
  } catch {
    return false
  }
}

/** The compile failure's message, for the refusal reason. */
function compileError(templateContent: string): string {
  try {
    compileTemplate(templateContent)
    return 'unknown error'
  } catch (err) {
    return (err as Error).message
  }
}
