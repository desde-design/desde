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
import { findImportBinding, type IterateeImportCandidate } from './import-binding'
import type { LocateLoopResult, LoopPosition } from './locate-loop'

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
  | {
      ok: false
      reason: string
      /**
       * Set when the loop was found and its iteratee is a bare identifier
       * bound by a relative import rather than a local array literal. The
       * handler follows the import (one hop) before giving up on the
       * deterministic path. See `import-binding.ts`.
       */
      importCandidate?: IterateeImportCandidate
      /**
       * The list's name, when the loop was found but its data was not. The
       * AI lane builds its file bundle from THIS, never from the client's
       * `iterationContext.expression`. See the JSX sibling.
       */
      iterateeRoot?: string
    }

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
): {
  element: ElementNode
  vForExpression: string
  keyExpression: string | null
  /** Loop variables of every ENCLOSING v-for, outermost first. */
  enclosingAliases: string[]
} | null {
  const stack: Array<{ node: ElementNode; aliases: string[] }> = [
    { node: templateAst, aliases: [] },
  ]
  while (stack.length > 0) {
    const { node, aliases } = stack.pop()!
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
            enclosingAliases: aliases,
          }
        }
      }
    }
    // Names introduced by a v-for on THIS element are in scope for its
    // children. Collected so the resolver can tell `item in rows` under
    // `rows in groups` apart from a module-level `rows` (codex round 4).
    const ownVFor = node.props?.find(
      (p): p is DirectiveNode =>
        p.type === NodeTypes.DIRECTIVE && (p as DirectiveNode).name === 'for',
    )
    const ownContent = (ownVFor?.exp as SimpleExpressionNode | undefined)?.content
    const ownAliases = ownContent ? vForAliases(ownContent) : []
    // `v-slot="{ rows }"` / `#default="{ rows }"` binds names for the
    // children just like an outer v-for does (Fable review: a slot named
    // like an imported list rewrote the wrong row of the imported file).
    for (const p of node.props ?? []) {
      if (p.type !== NodeTypes.DIRECTIVE || (p as DirectiveNode).name !== 'slot') continue
      const content = ((p as DirectiveNode).exp as SimpleExpressionNode | undefined)?.content
      if (content) {
        ownAliases.push(...Array.from(content.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g), (x) => x[0]))
      }
    }
    const childAliases = ownAliases.length > 0 ? [...aliases, ...ownAliases] : aliases
    for (const child of node.children ?? []) {
      if (child.type === NodeTypes.ELEMENT) {
        stack.push({ node: child as ElementNode, aliases: childAliases })
      }
    }
  }
  return null
}

/**
 * The result of asking "is the element at this position inside a v-for?".
 * Three answers, not two: "nothing is at that position" and "something is
 * there but no loop encloses it" are different facts, and the hand-off
 * message quotes the reason verbatim.
 */
type EnclosingVForResult =
  | {
      kind: 'found'
      vForExpression: string
      /**
       * Where the element CARRYING the `v-for` is, SFC-absolute, 1-based
       * column, same convention as the target position. The clicked element
       * can be nested inside the row, and the "this item" lane dispatches
       * against the loop element itself, not the nested one.
       */
      location: { line: number; column: number }
      /**
       * The v-for element's own span, as absolute offsets into the SFC.
       * Callers confine a second position (the retyped field) to this loop.
       */
      range: { startOffset: number; endOffset: number }
    }
  | { kind: 'no-element' }
  | { kind: 'no-loop' }

/** The nearest ancestor-or-self `v-for`, with the position of the element carrying it. */
type EnclosingVFor = {
  expression: string
  line: number
  column: number
  startOffset: number
  endOffset: number
}

/**
 * Nearest ANCESTOR-OR-SELF element carrying `v-for`, for the element at the
 * given SFC-absolute position.
 *
 * Deliberately NOT `findVForAt`. That one matches only when the node AT the
 * position carries the directive, which the data resolver needs (it rewrites
 * the loop's own iteratee). The loop CHECK is a different question: a
 * `<span>` inside `<li v-for>` is a loop row, and answering "no loop" for it
 * both sent a false premise to chat and made the deterministic "all rows"
 * path unreachable for every nested Vue element. The JSX sibling
 * (`locateJsxLoopAt`) has always walked up to the enclosing `.map()`; this
 * brings Vue to the same rule.
 *
 * Same coordinate convention as `findVForAt`: template-relative lines are
 * shifted by `templateStartLine`, columns are Vue's 1-based ones.
 */
function findEnclosingVForAt(
  templateAst: ElementNode,
  templateStartLine: number,
  templateStartOffset: number,
  targetLine: number,
  targetColumn: number,
): EnclosingVForResult {
  const stack: Array<{ node: ElementNode; enclosing: EnclosingVFor | null }> = [
    { node: templateAst, enclosing: null },
  ]
  while (stack.length > 0) {
    const { node, enclosing } = stack.pop()!
    const ownVFor = node.props?.find(
      (p): p is DirectiveNode =>
        p.type === NodeTypes.DIRECTIVE && (p as DirectiveNode).name === 'for',
    )
    // An EMPTY expression is absent, not present. `v-for=""` parses to a
    // directive whose content is `""`, and a nullish check kept it: the empty
    // string then shadowed the real enclosing loop, and the check answered
    // "found" with no expression for an element that is genuinely a row of
    // the loop above it.
    const rawExpression = (ownVFor?.exp as SimpleExpressionNode | undefined)?.content ?? null
    const ownExpression = rawExpression && rawExpression.trim().length > 0 ? rawExpression : null
    const loc = node.loc?.start
    const sfcLine = loc ? loc.line + templateStartLine - 1 : null
    // Self counts: the clicked element may BE the `v-for` element. The
    // position travels with the expression, so a nested match can report
    // where the loop actually is rather than where the click landed.
    // Template-node offsets are relative to the <template> BLOCK's content;
    // `templateStartOffset` lifts them to SFC-absolute, the same frame the
    // caller's `source` is in.
    const nearest: EnclosingVFor | null =
      ownExpression !== null && loc && sfcLine !== null
        ? {
            expression: ownExpression,
            line: sfcLine,
            column: loc.column,
            startOffset: templateStartOffset + (node.loc?.start?.offset ?? 0),
            endOffset: templateStartOffset + (node.loc?.end?.offset ?? 0),
          }
        : enclosing
    if (loc && sfcLine !== null) {
      if (sfcLine === targetLine && loc.column === targetColumn) {
        return nearest
          ? {
              kind: 'found',
              vForExpression: nearest.expression,
              location: { line: nearest.line, column: nearest.column },
              range: { startOffset: nearest.startOffset, endOffset: nearest.endOffset },
            }
          : { kind: 'no-loop' }
      }
    }
    for (const child of node.children ?? []) {
      if (child.type === NodeTypes.ELEMENT) {
        stack.push({ node: child as ElementNode, enclosing: nearest })
      }
    }
  }
  return { kind: 'no-element' }
}

/** Every name a v-for expression binds: `(item, i) in rows` → `["item", "i"]`,
 *  `{ rows } in groups` → `["rows"]`. Destructuring is read as "every
 *  identifier in the alias part", which over-includes the KEY of
 *  `{ rows: r }` — over-inclusion only ever costs a refusal (codex round 5). */
function vForAliases(expr: string): string[] {
  const m = expr.match(/^\s*(.+?)\s+(?:in|of)\s+/)
  if (!m) return []
  return Array.from(m[1].matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g), (x) => x[0])
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

/** The identifier a v-for's iteratee EXPRESSION starts with, for any
 *  expression shape: `r in rows.filter(Boolean)` → `rows`. A hint for the AI
 *  bundle only; `parseVForIteratee` decides what the deterministic lane edits. */
function leadingIterateeIdentifier(expr: string): string | null {
  const m = expr.match(
    /^\s*(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s+(?:in|of)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  )
  return m ? m[1] : null
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
export function findArrayDeclaration(
  ast: File,
  name: string,
): { line: number; column: number; count: number } | null {
  let found: { line: number; column: number; count: number } | null = null
  // What the template can see: top-level `<script setup>` bindings, and the
  // locals of an Options API `setup()` (which returns them). A declaration
  // inside any other function is a helper's local, whatever its name (codex
  // round 5: a helper's `const rows = [...]` was picked over the import).
  // `setup()` only counts on the COMPONENT DEFINITION: the object literal of
  // `export default { … }` or the first argument of `defineComponent({ … })`.
  // Any other object with a method called `setup` is somebody's helper
  // (codex round 6: `const unrelated = { setup() { const rows = … } }`).
  function visit(node: unknown, inHelper: boolean, inComponentObject: boolean): void {
    if (found || !node || typeof node !== 'object') return
    const n = node as { type?: string; key?: { type?: string; name?: string } }
    let nextInHelper = inHelper
    let nextInComponentObject = false
    if (n.type === 'ExportDefaultDeclaration') {
      const decl = (node as { declaration?: { type?: string } }).declaration
      if (decl?.type === 'ObjectExpression') {
        visit(decl, inHelper, true)
        return
      }
    }
    if (n.type === 'CallExpression') {
      const call = node as { callee?: { type?: string; name?: string }; arguments?: unknown[] }
      if (call.callee?.type === 'Identifier' && call.callee.name === 'defineComponent') {
        const first = call.arguments?.[0] as { type?: string } | undefined
        if (first?.type === 'ObjectExpression') {
          visit(first, inHelper, true)
          return
        }
      }
    }
    if (n.type === 'ObjectExpression') nextInComponentObject = inComponentObject
    if (
      n.type === 'FunctionDeclaration' ||
      n.type === 'FunctionExpression' ||
      n.type === 'ArrowFunctionExpression' ||
      n.type === 'ObjectMethod' ||
      n.type === 'ClassMethod'
    ) {
      const isSetup =
        inComponentObject &&
        n.type === 'ObjectMethod' &&
        n.key?.type === 'Identifier' &&
        n.key.name === 'setup'
      nextInHelper = inHelper || !isSetup
    }
    if (
      inComponentObject &&
      n.type === 'ObjectProperty' &&
      n.key?.type === 'Identifier' &&
      n.key.name === 'setup'
    ) {
      // `setup: () => { … }` — the arrow below it is the setup body.
      const value = (node as { value?: { type?: string } }).value
      if (value?.type === 'ArrowFunctionExpression' || value?.type === 'FunctionExpression') {
        visit((value as { body?: unknown }).body, inHelper, false)
        return
      }
    }
    if (n.type === 'VariableDeclarator' && !inHelper) {
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
      if (Array.isArray(v)) for (const item of v) visit(item, nextInHelper, nextInComponentObject)
      else if (v && typeof v === 'object') visit(v, nextInHelper, nextInComponentObject)
    }
  }
  visit(ast, false, false)
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
    // `v-for="r in rows.filter(Boolean)"`: not a shape the deterministic
    // lane edits, but the list is still `rows`, and the AI lane's bundle
    // needs that name to follow the import (codex round 2). Report it.
    const leading = leadingIterateeIdentifier(match.vForExpression)
    const hint = leading && !match.enclosingAliases.includes(leading) ? leading : null
    return {
      ok: false,
      reason: `Could not parse v-for iteratee expression: "${match.vForExpression}"`,
      ...(hint ? { iterateeRoot: hint } : {}),
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
        `only a plain list name can be traced here`,
      iterateeRoot: iteratee.root,
    }
  }
  const keyProperty = extractKeyProperty(match.keyExpression, iteratee.itemVar)

  // The iteratee is a loop variable of an enclosing v-for, not a script
  // binding: nothing in the script (or any import) is the array it reads.
  if (match.enclosingAliases.includes(iteratee.root)) {
    return {
      ok: false,
      reason: `"${iteratee.root}" is the loop variable of an outer v-for, so its data is one entry of that outer list`,
    }
  }

  // 2. Parse the script block + find the iteratee root's declaration.
  const scriptInfo = getScriptBlock(input.source)
  if (!scriptInfo) {
    return {
      ok: false,
      reason: 'SFC has no <script> block: iteratee is not local',
      iterateeRoot: iteratee.root,
    }
  }
  let ast: File
  try {
    ast = babelParse(scriptInfo.content, {
      sourceType: 'module',
      plugins: ['typescript'],
      allowReturnOutsideFunction: true,
    }) as unknown as File
  } catch (err) {
    return {
      ok: false,
      reason: `Script parse failed: ${(err as Error).message}`,
      iterateeRoot: iteratee.root,
    }
  }

  const arrayPos = findArrayDeclaration(ast, iteratee.root)
  if (!arrayPos) {
    // Not a local literal. Before declaring this a cross-component case,
    // check whether the name is simply imported from another module — the
    // handler can follow one hop deterministically.
    const binding = findImportBinding(scriptInfo.content, iteratee.root)
    if (binding) {
      return {
        ok: false,
        reason: `"${iteratee.root}" is imported from ${binding.specifier}: the list's data lives in another file`,
        iterateeRoot: iteratee.root,
        importCandidate: {
          iterateeRoot: iteratee.root,
          itemVar: iteratee.itemVar,
          keyProperty,
          binding,
        },
      }
    }
    return {
      ok: false,
      reason: `Could not find an array literal for "${iteratee.root}" in this file: its data may come from a parent component`,
      iterateeRoot: iteratee.root,
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

/**
 * Loop check only: is the template element at `templateLocation` (SFC-absolute
 * line, 1-based column) inside a `v-for`? Walks ancestor-or-self via
 * `findEnclosingVForAt`, so a nested element inside a loop row answers "yes",
 * matching the JSX side. Does not touch the script block.
 */
export function locateVueLoopAt(source: string, templateLocation: LoopPosition): LocateLoopResult {
  let descriptor
  try {
    descriptor = parseSfc(source).descriptor
  } catch (err) {
    return { found: false, reason: `SFC parse failed: ${(err as Error).message}` }
  }
  if (!descriptor.template) {
    return { found: false, reason: 'SFC has no <template> block' }
  }
  let templateAst
  try {
    templateAst = parseTemplate(descriptor.template.content, { comments: false })
  } catch (err) {
    return { found: false, reason: `Template parse failed: ${(err as Error).message}` }
  }
  const root = templateAst as unknown as ElementNode
  const match = findEnclosingVForAt(
    root,
    descriptor.template.loc.start.line,
    descriptor.template.loc.start.offset,
    templateLocation.line,
    templateLocation.column,
  )
  if (match.kind === 'no-element') {
    return { found: false, reason: `No element at ${templateLocation.line}:${templateLocation.column}` }
  }
  if (match.kind === 'no-loop') {
    return { found: false, reason: 'This element is not inside a `v-for`' }
  }
  return {
    found: true,
    kind: 'v-for',
    expression: match.vForExpression,
    location: match.location,
    range: match.range,
  }
}
