/**
 * Single-file Vue SFC iteration-data resolver. Phase 3 of
 * `tasks/_archive/one-shot-tasks/iteration-aware-edits.md`. Given the SFC source and the
 * template position of a `v-for`, traces the iteratee expression back
 * to an array LITERAL in the same `<script setup>` (or `<script>`)
 * block. Returns `IterationDataLocation` when the trace succeeds;
 * `UnresolvedIteration`-shape `{ ok: false, reason }` otherwise.
 *
 * Cross-component traces (iteratee comes through a prop) are out of
 * scope here — that's Phase 4. The single-file case alone covers the
 * common pattern of "page declares the array inline, component
 * iterates it" when the v-for happens IN the page file.
 */

import { parse as parseSfc, babelParse } from '@vue/compiler-sfc'
import {
  parse as parseTemplate,
  NodeTypes,
  type DirectiveNode,
  type ElementNode,
  type SimpleExpressionNode,
} from '@vue/compiler-dom'
import type { File } from '@babel/types'

export interface ResolveInput {
  source: string
  /** SFC-absolute 1-based line/column of the v-for template element. */
  templateLocation: { line: number; column: number }
}

export type ResolveResult =
  | {
      ok: true
      file: string | null // null = "same file as the SFC" (caller already knows the path)
      arrayLocation: { line: number; column: number }
      /** Iteratee root identifier (`items` from `v-for="x in items"`). */
      iterateeRoot: string
      /** Entry count of the resolved array literal. */
      entryCount?: number
      /** Loop variable — `x` in `v-for="x in items"`. See the return site. */
      itemVar?: string
      /** Member access chain after the root, e.g. `["filtered"]` for `items.filtered`. */
      iterateeChain: string[]
      /**
       * Property name the v-for's `:key` directive reads off each entry —
       * e.g. `'id'` when `:key="item.id"`. Used by the applicator to build
       * an `object-property` matcher. Null when the `:key` is the entry
       * itself, an index variable, or an expression we can't decompose;
       * the applicator falls back to positional indexing in that case.
       */
      keyProperty: string | null
    }
  | { ok: false; reason: string }

/**
 * Recursively walk the template AST looking for the v-for element at
 * the requested position. SFC-absolute coordinates: the `<template>`
 * block in @vue/compiler-sfc has loc-content-relative line numbers, so
 * we add the template block's start line.
 */
function findVForAt(
  templateAst: ElementNode,
  templateStartLine: number,
  targetLine: number,
  targetColumn: number,
): { element: ElementNode; vForExpression: string; keyExpression: string | null } | null {
  const stack: ElementNode[] = [templateAst]
  while (stack.length > 0) {
    const node = stack.pop()!
    const loc = node.loc?.start
    if (loc) {
      const sfcLine = loc.line + templateStartLine - 1
      const sfcColumn = loc.column
      if (sfcLine === targetLine && sfcColumn === targetColumn) {
        const vFor = node.props?.find(
          (p): p is DirectiveNode =>
            p.type === NodeTypes.DIRECTIVE && (p as DirectiveNode).name === 'for',
        )
        if (vFor && vFor.exp && (vFor.exp as SimpleExpressionNode).content) {
          // Also read the `:key` directive when present, so the
          // applicator can match against the property the user
          // actually keyed by rather than guessing `'key'`.
          const vBind = node.props?.find((p): p is DirectiveNode => {
            if (p.type !== NodeTypes.DIRECTIVE) return false
            const d = p as DirectiveNode
            if (d.name !== 'bind') return false
            const arg = d.arg as SimpleExpressionNode | undefined
            return arg?.content === 'key'
          })
          const keyExp = vBind?.exp as SimpleExpressionNode | undefined
          return {
            element: node,
            vForExpression: (vFor.exp as SimpleExpressionNode).content,
            keyExpression: keyExp?.content ?? null,
          }
        }
      }
    }
    for (const child of node.children ?? []) {
      if (child.type === NodeTypes.ELEMENT) {
        stack.push(child as ElementNode)
      }
    }
  }
  return null
}

/**
 * Decompose a v-for's `:key` expression to extract the property name the
 * Vue key reads off each entry. Returns null for shapes we can't match
 * against an object literal (`:key="item"` itself, function calls,
 * arithmetic, etc.) — the applicator falls back to positional matching.
 *
 * Supported forms:
 *   :key="item.id"           → 'id'
 *   :key="item['id']"        → 'id'   (string-subscript)
 * Unsupported in v1:
 *   :key="i"  (the v-for index)
 *   :key="item.foo.bar"
 *   :key="getKey(item)"
 */
function extractKeyProperty(
  keyExpression: string | null,
  iterationVar: string,
): string | null {
  if (!keyExpression) return null
  const trimmed = keyExpression.trim()
  const dotMatch = trimmed.match(
    new RegExp(`^${iterationVar}\\.([A-Za-z_$][A-Za-z0-9_$]*)$`),
  )
  if (dotMatch) return dotMatch[1]
  const bracketMatch = trimmed.match(
    new RegExp(`^${iterationVar}\\[(?:'([^']+)'|"([^"]+)")\\]$`),
  )
  if (bracketMatch) return bracketMatch[1] ?? bracketMatch[2] ?? null
  return null
}

/**
 * Parse `v-for="<x> in <iteratee>"` (or `(x, i) in items`) — extract the
 * iteration variable, the iteratee root identifier, and any member
 * chain. Returns null on malformed v-for expressions or unsupported
 * shapes (function calls, arithmetic, etc.).
 *
 * Member chains (`v-for="item in group.items"`) are reported so the
 * caller can decide whether to support them. The same-file resolver
 * REFUSES chains for v1 (Codex P1 #2) — picking the wrong array on a
 * `group.items` vs. `group.other` ambiguity is worse than falling
 * through to LLM, which has the full context.
 */
function parseVForIteratee(
  expr: string,
): { itemVar: string; root: string; chain: string[] } | null {
  // Strip the iteration-var preamble. Accepts `(x, i)`, `(x, i, k)`,
  // `(x)`, or bare `x`.
  const inMatch = expr.match(/^\s*(?:\(\s*([A-Za-z_$][A-Za-z0-9_$]*)[^)]*\)|([A-Za-z_$][A-Za-z0-9_$]*))\s+(?:in|of)\s+(.+?)\s*$/)
  if (!inMatch) return null
  const itemVar = inMatch[1] ?? inMatch[2]
  const iteratee = inMatch[3].trim()
  const chainMatch = iteratee.match(/^([A-Za-z_$][A-Za-z0-9_$]*)((?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)$/)
  if (!chainMatch) return null
  const root = chainMatch[1]
  const chain = chainMatch[2]
    .split('.')
    .filter((s) => s.length > 0)
  return { itemVar, root, chain }
}

interface ScriptInfo {
  content: string
  startLine: number
  lang: 'ts' | 'js' | 'tsx' | 'jsx'
}

function getScriptBlock(source: string): ScriptInfo | null {
  let descriptor
  try {
    descriptor = parseSfc(source).descriptor
  } catch {
    return null
  }
  const block = descriptor.scriptSetup ?? descriptor.script
  if (!block) return null
  const lang = block.lang === 'ts' || block.lang === 'tsx'
    ? block.lang
    : block.lang === 'jsx'
    ? 'jsx'
    : 'ts'
  return {
    content: block.content,
    startLine: block.loc.start.line,
    lang,
  }
}

/**
 * Search the script AST for a declaration whose `id.name` equals
 * `name` and whose initializer is one of the trusted shapes below.
 * Returns the script-local position of the `[` token.
 *
 * Codex round-2 P2 fix: the previous version did a free `findFirstArrayLiteral`
 * walk into the initializer, which picked the wrong branch on shapes
 * like `const items = useAlt ? [...] : [...]`. We now whitelist:
 *
 *   const items = [...]                              // direct
 *   const items = ref([...])                         // ref wrap
 *   const items = reactive([...])                    // reactive wrap
 *   const items = computed(() => [...])              // computed, expr body
 *   const items = computed(() => { return [...] })   // computed, single-return block
 *
 * Anything else (ternary, logical-or, conditional, function call result)
 * returns null and the caller falls through to LLM.
 */
function findArrayDeclaration(
  ast: File,
  name: string,
): { line: number; column: number; count: number } | null {
  let found: { line: number; column: number; count: number } | null = null
  function visit(node: unknown): void {
    if (found || !node || typeof node !== 'object') return
    const n = node as { type?: string }
    if (n.type === 'VariableDeclarator') {
      const v = node as Record<string, unknown>
      const id = v.id as { type?: string; name?: string } | undefined
      const init = v.init
      if (id?.type === 'Identifier' && id.name === name && init) {
        found = extractTrustedArrayLiteral(init)
        if (found) return
      }
    }
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue
      const v = (n as Record<string, unknown>)[key]
      if (Array.isArray(v)) for (const item of v) visit(item)
      else if (v && typeof v === 'object') visit(v)
    }
  }
  visit(ast)
  return found
}

/**
 * Return the `[` position if `node` is one of our trusted initializer
 * shapes. Returns null for anything ambiguous (ternaries, conditional
 * expressions, function calls other than the small whitelist below).
 */
/** `{ line, column, count }` for an ArrayExpression node, or null. */
function arrayLiteralPos(
  node: unknown,
): { line: number; column: number; count: number } | null {
  const n = node as
    | { type?: string; loc?: { start: { line: number; column: number } }; elements?: unknown[] }
    | undefined
  if (n?.type !== 'ArrayExpression' || !n.loc) return null
  return { ...n.loc.start, count: (n.elements ?? []).length }
}

function extractTrustedArrayLiteral(
  node: unknown,
): { line: number; column: number; count: number } | null {
  if (!node || typeof node !== 'object') return null
  const n = node as {
    type?: string
    loc?: { start: { line: number; column: number } }
  }
  // Direct array literal
  if (n.type === 'ArrayExpression' && n.loc) return arrayLiteralPos(node)
  // `wrapper(...)` — accept ref / reactive / computed only
  if (n.type === 'CallExpression') {
    const call = node as {
      callee: { type?: string; name?: string }
      arguments: unknown[]
    }
    if (call.callee.type !== 'Identifier') return null
    const callee = call.callee.name
    if (callee === 'ref' || callee === 'reactive') {
      // Direct `ref([...])` — first arg must be a literal array.
      const first = call.arguments[0] as
        | { type?: string; loc?: { start: { line: number; column: number } } }
        | undefined
      if (first?.type === 'ArrayExpression' && first.loc) return arrayLiteralPos(first)
      return null
    }
    if (callee === 'computed') {
      const fn = call.arguments[0] as { type?: string } | undefined
      if (!fn) return null
      if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') {
        return null
      }
      const arrow = fn as {
        body:
          | { type: 'ArrayExpression'; loc: { start: { line: number; column: number } } }
          | { type: 'BlockStatement'; body: unknown[] }
      }
      // Arrow with expression body: `() => [...]`
      if (arrow.body.type === 'ArrayExpression' && arrow.body.loc) {
        return arrayLiteralPos(arrow.body)
      }
      // Block body — accept only a SINGLE `return [...]` statement so
      // we don't walk into `const items = useAlt ? [...] : [...]` shapes.
      if (arrow.body.type === 'BlockStatement') {
        const stmts = arrow.body.body
        if (stmts.length !== 1) return null
        const ret = stmts[0] as {
          type?: string
          argument?: { type?: string; loc?: { start: { line: number; column: number } } }
        }
        if (ret.type !== 'ReturnStatement') return null
        if (ret.argument?.type === 'ArrayExpression' && ret.argument.loc) {
          return arrayLiteralPos(ret.argument)
        }
        return null
      }
      return null
    }
  }
  // Anything else (ternary, logical, member access, other call) — refuse.
  return null
}

/**
 * Locate the `v-for`'s data array in the same SFC's script block.
 * Returns SFC-absolute coordinates so the applicator can apply
 * mutations directly.
 */
export function resolveIterationDataVueSameFile(
  input: ResolveInput,
): ResolveResult {
  // 1. Parse the SFC to get the template block.
  let descriptor
  try {
    descriptor = parseSfc(input.source).descriptor
  } catch (err) {
    return { ok: false, reason: `SFC parse failed: ${(err as Error).message}` }
  }
  if (!descriptor.template) {
    return { ok: false, reason: 'SFC has no <template> block' }
  }
  let templateAst
  try {
    templateAst = parseTemplate(descriptor.template.content, {
      comments: false,
    })
  } catch (err) {
    return { ok: false, reason: `Template parse failed: ${(err as Error).message}` }
  }

  const templateStartLine = descriptor.template.loc.start.line
  // The compiler-dom `parse` result is a Root node whose children are the
  // top-level template content. Treat it as a synthetic ElementNode-like
  // root for the walker.
  const root = templateAst as unknown as ElementNode

  const match = findVForAt(
    root,
    templateStartLine,
    input.templateLocation.line,
    input.templateLocation.column,
  )
  if (!match) {
    return {
      ok: false,
      reason: `No v-for element at ${input.templateLocation.line}:${input.templateLocation.column}`,
    }
  }

  const iteratee = parseVForIteratee(match.vForExpression)
  if (!iteratee) {
    return {
      ok: false,
      reason: `Could not parse v-for iteratee expression: "${match.vForExpression}"`,
    }
  }
  // Codex P1 #2: refuse member-access iteratees (e.g. `group.items`).
  // Walking into the root declaration and picking the first array
  // would pick the wrong one when the object holds multiple arrays
  // (`{ items: [...], other: [...] }`). The LLM lane handles this
  // shape correctly with the full source context.
  if (iteratee.chain.length > 0) {
    return {
      ok: false,
      reason:
        `v-for iteratee "${iteratee.root}.${iteratee.chain.join('.')}" uses property access; ` +
        `same-file resolver requires a bare identifier: falling through to LLM`,
    }
  }
  const keyProperty = extractKeyProperty(match.keyExpression, iteratee.itemVar)

  // 2. Parse the script block + find the iteratee root's declaration.
  const scriptInfo = getScriptBlock(input.source)
  if (!scriptInfo) {
    return { ok: false, reason: 'SFC has no <script> block: iteratee is not local' }
  }
  let ast: File
  try {
    ast = babelParse(scriptInfo.content, {
      sourceType: 'module',
      plugins: ['typescript'],
      allowReturnOutsideFunction: true,
    }) as unknown as File
  } catch (err) {
    return { ok: false, reason: `Script parse failed: ${(err as Error).message}` }
  }

  const arrayPos = findArrayDeclaration(ast, iteratee.root)
  if (!arrayPos) {
    return {
      ok: false,
      reason: `Could not locate array literal for "${iteratee.root}" in same-file script: likely a cross-component case (Phase 4)`,
    }
  }

  // 3. Translate script-local position to SFC-absolute. Babel reports
  // 1-based line, 0-based column; the applicator expects 1-based both.
  const sfcLine = arrayPos.line + scriptInfo.startLine - 1
  const sfcColumn = arrayPos.column + 1

  return {
    ok: true,
    file: null, // same file
    arrayLocation: { line: sfcLine, column: sfcColumn },
    iterateeRoot: iteratee.root,
    // How many entries the source array literal holds. The handler compares it
    // against the number of RENDERED siblings to tell an unfiltered loop (where
    // render position == array position) from a filtered one (where it does
    // not). See `edit-iteration-handler.ts`'s matcher note.
    entryCount: arrayPos.count,
    // The LOOP VARIABLE (`r` in `v-for="r in rows"`), as distinct from
    // `iterateeRoot` above, which is the ARRAY (`rows`). Both are needed and
    // they are easy to confuse: the interpolation extractor matches
    // `{{ r.label }}` against the loop variable, and handing it the array name
    // makes every extraction refuse with a message that reads like a user
    // error rather than a wiring bug. Measured 2026-08-16.
    itemVar: iteratee.itemVar,
    iterateeChain: iteratee.chain,
    keyProperty,
  }
}
