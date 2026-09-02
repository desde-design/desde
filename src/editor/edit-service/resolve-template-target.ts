/**
 * Shared Vue-template target resolution for the deterministic edit
 * applicators (WS1 of tasks/edit-pipeline-rearchitecture.md).
 *
 * Every applicator used to carry its own copy of the same three-step
 * algorithm — parse the SFC, re-parse the `<template>` content with
 * `@vue/compiler-dom` (whose loc positions are template-content-relative),
 * then shift positions by the template block's start before comparing
 * against the SFC-absolute `(line, column)` that `data-desde-src` carries.
 * The audit (2026-07-24) found ~11 byte-equivalent copies of that logic;
 * a fix applied to one copy silently missed the others. This module is
 * now the single implementation.
 *
 * Behavioral contract (kept identical to the copies it replaces, so
 * migrated applicators pass their existing tests unchanged):
 *  - Exact integer equality on the shifted (line, column) — no fuzzy match.
 *  - The walk descends into every ELEMENT node, including `<template v-if>`
 *    wrappers, and returns the first exact hit in document order.
 *  - Refusal reason strings match the historical per-applicator strings
 *    ("SFC parse failed: …", "SFC has no <template> block",
 *    "Template parse failed: …", "No element found at SFC line X, column Y").
 *
 * What's new relative to the copies:
 *  - `path` — the ancestor element chain (outermost → innermost, excluding
 *    the target itself). WS2's semantic-closure checks (ancestor
 *    `<template v-if>` / `v-for` wrappers) build on this.
 *  - Optional `expectedTag` verification (the identity check `apply-detach-edit`
 *    and `apply-swap-edit` already did ad hoc), tolerant of PascalCase vs
 *    kebab-case the way Vue callsites are.
 */

import { parse as parseSfc } from '@vue/compiler-sfc'
import type { SFCDescriptor } from '@vue/compiler-sfc'
import { parse as parseTemplate, NodeTypes } from '@vue/compiler-dom'
import type { ElementNode, RootNode } from '@vue/compiler-dom'

export interface ResolveTemplateTargetInput {
  /** Full SFC source text. */
  source: string
  /** 1-based SFC-absolute line (the convention `data-desde-src` carries). */
  line: number
  /** 1-based SFC-absolute column. */
  column: number
  /**
   * When set, the resolved node's tag must match (exactly, or as the
   * kebab-case/PascalCase equivalent Vue accepts at callsites). A hit at
   * the right coordinates with the wrong tag refuses as `tag-mismatch`
   * instead of silently editing whatever now occupies that position.
   */
  expectedTag?: string
}

/** Everything an applicator needs to splice against the resolved node. */
export interface TemplateTargetContext {
  descriptor: SFCDescriptor
  /** The `<template>` block's content (the string `templateAst` was parsed from). */
  templateContent: string
  /** Offset of `templateContent` within the full SFC source. */
  templateOffset: number
  templateStartLine: number
  templateStartColumn: number
  templateAst: RootNode
}

export type ResolveTemplateTargetFailure =
  | { kind: 'sfc-parse-error'; reason: string }
  | { kind: 'no-template'; reason: string }
  | { kind: 'template-parse-error'; reason: string }
  /**
   * `not-found` carries the parsed context: the SFC and template parsed
   * fine, only the coordinate lookup missed. Callers that historically ran
   * template-level prechecks BEFORE the element lookup (e.g. delete's
   * "Template has no rendered content") use it to keep their refusal
   * ordering byte-identical without re-parsing.
   */
  | { kind: 'not-found'; reason: string; ctx: TemplateTargetContext }
  | { kind: 'tag-mismatch'; reason: string; expectedTag: string; foundTag: string }

export type ResolveTemplateTargetResult =
  | {
      ok: true
      node: ElementNode
      /** Ancestor elements, outermost → innermost, excluding `node`. */
      path: ElementNode[]
      ctx: TemplateTargetContext
    }
  | { ok: false; failure: ResolveTemplateTargetFailure }

export function resolveTemplateTarget(
  input: ResolveTemplateTargetInput,
): ResolveTemplateTargetResult {
  const { source, line, column, expectedTag } = input

  let descriptor: SFCDescriptor
  try {
    descriptor = parseSfc(source).descriptor
  } catch (err) {
    return {
      ok: false,
      failure: { kind: 'sfc-parse-error', reason: `SFC parse failed: ${(err as Error).message}` },
    }
  }
  if (!descriptor.template) {
    return {
      ok: false,
      failure: { kind: 'no-template', reason: 'SFC has no <template> block' },
    }
  }
  const templateContent = descriptor.template.content
  const templateOffset = descriptor.template.loc.start.offset
  const templateStartLine = descriptor.template.loc.start.line
  const templateStartColumn = descriptor.template.loc.start.column

  let templateAst: RootNode
  try {
    templateAst = parseTemplate(templateContent)
  } catch (err) {
    return {
      ok: false,
      failure: {
        kind: 'template-parse-error',
        reason: `Template parse failed: ${(err as Error).message}`,
      },
    }
  }

  const hit = findElementAt(
    templateAst.children as ElementNode[],
    line,
    column,
    templateStartLine,
    templateStartColumn,
    [],
  )
  const ctx: TemplateTargetContext = {
    descriptor,
    templateContent,
    templateOffset,
    templateStartLine,
    templateStartColumn,
    templateAst,
  }

  if (!hit) {
    return {
      ok: false,
      failure: {
        kind: 'not-found',
        reason: `No element found at SFC line ${line}, column ${column}`,
        ctx,
      },
    }
  }

  if (expectedTag && !tagMatches(hit.node.tag, expectedTag)) {
    return {
      ok: false,
      failure: {
        kind: 'tag-mismatch',
        reason: `Element at SFC line ${line}, column ${column} is <${hit.node.tag}>, expected <${expectedTag}>: the source has changed since this target was captured.`,
        expectedTag,
        foundTag: hit.node.tag,
      },
    }
  }

  return {
    ok: true,
    node: hit.node,
    path: hit.path,
    ctx,
  }
}

/**
 * Shift a template-content-relative loc start to SFC-absolute coordinates.
 * The column offset only applies on the first content line (where content
 * starts right after `>` of `<template>`); subsequent lines start at
 * column 1, so the AST column equals the SFC column directly.
 */
export function toSfcPosition(
  loc: { line: number; column: number },
  templateStartLine: number,
  templateStartColumn: number,
): { line: number; column: number } {
  return {
    line: loc.line + templateStartLine - 1,
    column: loc.line === 1 ? loc.column + templateStartColumn - 1 : loc.column,
  }
}

function findElementAt(
  children: ElementNode[],
  sfcLine: number,
  sfcColumn: number,
  templateStartLine: number,
  templateStartColumn: number,
  path: ElementNode[],
): { node: ElementNode; path: ElementNode[] } | null {
  for (const child of children) {
    if (child.type !== NodeTypes.ELEMENT) continue
    const pos = toSfcPosition(child.loc.start, templateStartLine, templateStartColumn)
    if (pos.line === sfcLine && pos.column === sfcColumn) {
      return { node: child, path }
    }
    const nested = findElementAt(
      child.children as ElementNode[],
      sfcLine,
      sfcColumn,
      templateStartLine,
      templateStartColumn,
      [...path, child],
    )
    if (nested) return nested
  }
  return null
}

/**
 * Vue accepts both PascalCase (`<KButton>`) and kebab-case (`<ui-button>`)
 * at callsites. Treat the two spellings of the same name as a match, same
 * as `apply-detach-edit`'s historical check.
 */
export function tagMatches(actual: string, expected: string): boolean {
  if (actual === expected) return true
  return camelToKebab(actual) === camelToKebab(expected)
}

function camelToKebab(s: string): string {
  return s.replace(/\B([A-Z])/g, '-$1').toLowerCase()
}
