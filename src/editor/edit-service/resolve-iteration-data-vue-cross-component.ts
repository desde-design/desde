/**
 * Cross-component Vue SFC iteration-data resolver. Phase 4 of
 * `tasks/_archive/one-shot-tasks/iteration-aware-edits.md`.
 *
 * When the v-for iteratee in component A doesn't resolve to an array
 * literal in A's own script (Phase 3 returned Unresolved), the data
 * usually lives in A's caller — the page that renders A and passes
 * the array via a prop. This resolver tries to trace the chain:
 *
 *   templateLocation in A → v-for iteratee `propName` →
 *   A's script declares `defineProps<{ propName: T[] }>()` →
 *   page SFC (pageSourceFile) has `<A :prop-name="X" />` →
 *   page's `<script setup>` has `const X = [...]` (or ref / computed
 *   wrapping an array literal) →
 *   return that literal's location, relative to pageSourceFile.
 *
 * Scope of v1:
 *   - Single-level v-for only. Nested v-fors (where the iteratee comes
 *     from an outer iteration variable) fall through to LLM.
 *   - Prop must be a plain identifier in the caller's binding, not a
 *     computed/store getter expression.
 *   - The defining declaration must be `const X = [...]`, `ref([...])`,
 *     or `computed(() => [...])` with a literal array inside.
 *
 * Anything more complex returns `{ ok: false, reason }` and the caller
 * falls back to the LLM lane.
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

export interface CrossComponentResolveInput {
  /** Source of the SFC that contains the v-for. */
  componentSource: string
  /** SFC-absolute v-for position in `componentSource`. */
  templateLocation: { line: number; column: number }
  /** Source of the page that renders the component (passes the prop). */
  pageSource: string
  /** Repo-relative path of the page — included in the returned location. */
  pageSourceFile: string
  /**
   * PascalCase name of the component the v-for lives in. Used to
   * constrain the page-tag search so the resolver only follows props
   * bound to THIS component, not an unrelated tag that happens to
   * accept a similarly named prop. Defaults to deriving the name from
   * the SFC's filename when the caller omits it (route does this).
   */
  componentName: string
}

export type CrossComponentResolveResult =
  | {
      ok: true
      file: string
      /** Page-SFC-absolute (1-based) line/column of the `[`. */
      arrayLocation: { line: number; column: number }
      /**
       * Property name the v-for's `:key` reads off each entry, or null.
       * Mirrors the same-file resolver's contract — see that file.
       */
      keyProperty: string | null
    }
  | { ok: false; reason: string }

// ── Shared helpers (subset of resolve-iteration-data-vue.ts) ────────

function findVForAt(
  root: ElementNode,
  templateStartLine: number,
  targetLine: number,
  targetColumn: number,
): {
  element: ElementNode
  expression: string
  keyExpression: string | null
} | null {
  const stack: ElementNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    const loc = node.loc?.start
    if (loc) {
      const sfcLine = loc.line + templateStartLine - 1
      if (sfcLine === targetLine && loc.column === targetColumn) {
        const vFor = node.props?.find(
          (p): p is DirectiveNode =>
            p.type === NodeTypes.DIRECTIVE && (p as DirectiveNode).name === 'for',
        )
        if (vFor?.exp) {
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
            expression: (vFor.exp as SimpleExpressionNode).content,
            keyExpression: keyExp?.content ?? null,
          }
        }
      }
    }
    for (const child of node.children ?? []) {
      if (child.type === NodeTypes.ELEMENT) stack.push(child as ElementNode)
    }
  }
  return null
}

function parseIteratee(
  expr: string,
): { itemVar: string; root: string } | null {
  const m = expr.match(
    /^\s*(?:\(\s*([A-Za-z_$][A-Za-z0-9_$]*)[^)]*\)|([A-Za-z_$][A-Za-z0-9_$]*))\s+(?:in|of)\s+(.+?)\s*$/,
  )
  if (!m) return null
  const itemVar = m[1] ?? m[2]
  const iteratee = m[3].trim()
  const ident = iteratee.match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/)
  if (!ident) return null // v1: only bare identifiers, no member access
  return { itemVar, root: ident[1] }
}

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

interface ScriptInfo {
  content: string
  startLine: number
}

function getScript(source: string): ScriptInfo | null {
  let descriptor
  try {
    descriptor = parseSfc(source).descriptor
  } catch {
    return null
  }
  const block = descriptor.scriptSetup ?? descriptor.script
  if (!block) return null
  return { content: block.content, startLine: block.loc.start.line }
}

/**
 * Find the component's defineProps declaration and confirm that
 * `propName` exists in its type literal. We don't fully type-check —
 * just verify the prop is declared at all.
 */
function componentHasProp(scriptContent: string, propName: string): boolean {
  // Simple regex match for the common patterns:
  //   defineProps<{ propName: ... }>()
  //   defineProps({ propName: ... })
  //   const props = defineProps<{ propName: ... }>()
  const escaped = propName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const typed = new RegExp(`defineProps\\s*<[^>]*${escaped}\\s*[:?]`).test(scriptContent)
  const runtime = new RegExp(`defineProps\\s*\\(\\s*\\{[\\s\\S]*?${escaped}\\s*[:?]`).test(
    scriptContent,
  )
  return typed || runtime
}

/**
 * Scan the page template for `<ComponentName :prop-name="value" />`
 * where ComponentName matches `expectedComponentName` (PascalCase or
 * kebab-cased form). Returns the binding identifier.
 *
 * Codex round-1 P1 #3: was matching prop binding by name only, picking
 * up sibling components' same-named props. Fixed by constraining to
 * the expected component tag.
 *
 * Codex round-2 P1 (aliased imports): if the page imports the SFC under
 * a different local name (`import Foo from './ConfigCardDisplay.vue'`),
 * the tag in the template is `<Foo>`, not `<ConfigCardDisplay>`. The
 * resolver can't see the imports here, so to stay safe we look for ALL
 * candidate tags that bind `propName` to an identifier. If exactly one
 * such tag whose name matches `expectedComponentName` exists, we use
 * it. If zero match the expected name (alias case) OR more than one
 * matches with conflicting bindings, we return null — caller falls
 * back to LLM. This trades static-resolution coverage for safety on
 * ambiguous pages.
 */
function findPropBindingInTemplate(
  pageSource: string,
  templateAst: ElementNode,
  templateStartLine: number,
  propName: string,
  expectedComponentName: string,
): string | null {
  // Vue accepts kebab-cased and camelCased forms in the template; check both.
  const propKebab = propName.replace(/([A-Z])/g, '-$1').toLowerCase()
  const propCamel = propName.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
  const propCandidates = new Set([propName, propKebab, propCamel])

  // Vue resolves `<MyTag>` and `<my-tag>` to the same component, so allow
  // both forms on the tag side.
  const tagKebab = expectedComponentName
    .replace(/([A-Z])/g, '-$1')
    .replace(/^-/, '')
    .toLowerCase()
  const tagCandidates = new Set([expectedComponentName, tagKebab])

  // Two passes:
  //   1. Collect every tag that binds `propName` to a bare identifier.
  //   2. Filter to tags whose name matches `expectedComponentName`.
  //   3. Refuse when filtering yields zero (alias case) or >1 distinct
  //      bindings (multiple call-sites with conflicting data) — both
  //      are ambiguous shapes that need the LLM's broader context.
  type Binding = { tag: string; identifier: string }
  const matches: Binding[] = []
  const stack: ElementNode[] = [templateAst]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.type === NodeTypes.ELEMENT && node.props) {
      for (const prop of node.props) {
        if (prop.type !== NodeTypes.DIRECTIVE) continue
        const dir = prop as DirectiveNode
        if (dir.name !== 'bind') continue
        const arg = dir.arg as SimpleExpressionNode | undefined
        const name = arg?.content
        if (!name || !propCandidates.has(name)) continue
        const exp = dir.exp as SimpleExpressionNode | undefined
        if (!exp?.content) continue
        const ident = exp.content.trim().match(/^[A-Za-z_$][A-Za-z0-9_$]*$/)
        if (!ident) continue
        matches.push({ tag: node.tag, identifier: ident[0] })
      }
    }
    for (const child of node.children ?? []) {
      if (child.type === NodeTypes.ELEMENT) stack.push(child as ElementNode)
    }
  }

  const constrained = matches.filter((m) => tagCandidates.has(m.tag))
  if (constrained.length === 0) {
    // No tag matched the expected component name. Could be an aliased
    // import OR no rendering at all. Either way, safer to bail.
    return null
  }
  // If multiple matches with different identifiers, ambiguous — refuse.
  const uniqueIds = new Set(constrained.map((m) => m.identifier))
  if (uniqueIds.size > 1) return null
  return constrained[0].identifier
}

/**
 * Walk the page's script AST looking for a top-level declaration whose
 * identifier matches `name` and whose initializer is one of the
 * trusted array-bearing shapes (direct literal, ref/reactive wrap,
 * computed with literal body). Anything ambiguous (ternaries, function
 * calls outside the whitelist) returns null — caller falls through to LLM.
 *
 * Same trust whitelist as `resolve-iteration-data-vue.ts`. Duplicated
 * here rather than extracted to keep this file self-contained.
 */
function findArrayDecl(
  ast: File,
  name: string,
): { line: number; column: number } | null {
  let result: { line: number; column: number } | null = null
  function extractTrustedArrayLiteral(
    init: unknown,
  ): { line: number; column: number } | null {
    if (!init || typeof init !== 'object') return null
    const n = init as { type?: string; loc?: { start: { line: number; column: number } } }
    if (n.type === 'ArrayExpression' && n.loc) return n.loc.start
    if (n.type === 'CallExpression') {
      const call = init as {
        callee: { type?: string; name?: string }
        arguments: unknown[]
      }
      if (call.callee.type !== 'Identifier') return null
      const callee = call.callee.name
      if (callee === 'ref' || callee === 'reactive') {
        const first = call.arguments[0] as
          | { type?: string; loc?: { start: { line: number; column: number } } }
          | undefined
        if (first?.type === 'ArrayExpression' && first.loc) return first.loc.start
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
        if (arrow.body.type === 'ArrayExpression' && arrow.body.loc) {
          return arrow.body.loc.start
        }
        if (arrow.body.type === 'BlockStatement') {
          const stmts = arrow.body.body
          if (stmts.length !== 1) return null
          const ret = stmts[0] as {
            type?: string
            argument?: { type?: string; loc?: { start: { line: number; column: number } } }
          }
          if (ret.type !== 'ReturnStatement') return null
          if (ret.argument?.type === 'ArrayExpression' && ret.argument.loc) {
            return ret.argument.loc.start
          }
          return null
        }
        return null
      }
    }
    return null
  }
  function visit(node: unknown): void {
    if (result || !node || typeof node !== 'object') return
    const n = node as { type?: string }
    if (n.type === 'VariableDeclarator') {
      const v = node as { id?: { type?: string; name?: string }; init?: unknown }
      if (v.id?.type === 'Identifier' && v.id.name === name && v.init) {
        result = extractTrustedArrayLiteral(v.init)
        if (result) return
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
  return result
}

export function resolveIterationDataVueCrossComponent(
  input: CrossComponentResolveInput,
): CrossComponentResolveResult {
  // 1. Parse the component's template, find the v-for, extract iteratee.
  let componentDesc
  try {
    componentDesc = parseSfc(input.componentSource).descriptor
  } catch (err) {
    return { ok: false, reason: `Component SFC parse failed: ${(err as Error).message}` }
  }
  if (!componentDesc.template) {
    return { ok: false, reason: 'Component has no <template>' }
  }
  let templateAst
  try {
    templateAst = parseTemplate(componentDesc.template.content, { comments: false })
  } catch (err) {
    return { ok: false, reason: `Component template parse failed: ${(err as Error).message}` }
  }
  const componentTemplateStart = componentDesc.template.loc.start.line
  const match = findVForAt(
    templateAst as unknown as ElementNode,
    componentTemplateStart,
    input.templateLocation.line,
    input.templateLocation.column,
  )
  if (!match) {
    return {
      ok: false,
      reason: `No v-for at ${input.templateLocation.line}:${input.templateLocation.column}`,
    }
  }
  const iteratee = parseIteratee(match.expression)
  if (!iteratee) {
    return {
      ok: false,
      reason: `Cross-component resolver only handles bare-identifier iteratees (got "${match.expression}")`,
    }
  }
  const keyProperty = extractKeyProperty(match.keyExpression, iteratee.itemVar)

  // 2. Verify the iteratee is a prop of the component.
  const componentScript = getScript(input.componentSource)
  if (!componentScript) {
    return { ok: false, reason: 'Component has no <script> block' }
  }
  if (!componentHasProp(componentScript.content, iteratee.root)) {
    return {
      ok: false,
      reason: `"${iteratee.root}" is not declared as a component prop: not a cross-component case`,
    }
  }

  // 3. Parse the page template, find a tag that binds `iteratee.root` to a value.
  let pageDesc
  try {
    pageDesc = parseSfc(input.pageSource).descriptor
  } catch (err) {
    return { ok: false, reason: `Page SFC parse failed: ${(err as Error).message}` }
  }
  if (!pageDesc.template) {
    return { ok: false, reason: 'Page has no <template> block' }
  }
  let pageTemplateAst
  try {
    pageTemplateAst = parseTemplate(pageDesc.template.content, { comments: false })
  } catch (err) {
    return { ok: false, reason: `Page template parse failed: ${(err as Error).message}` }
  }
  const pageTemplateStart = pageDesc.template.loc.start.line
  const bindingName = findPropBindingInTemplate(
    input.pageSource,
    pageTemplateAst as unknown as ElementNode,
    pageTemplateStart,
    iteratee.root,
    input.componentName,
  )
  if (!bindingName) {
    return {
      ok: false,
      reason: `Could not find <${input.componentName}> in the page binding ":${iteratee.root}" to an identifier`,
    }
  }

  // 4. Parse the page's script, find the binding's array literal.
  const pageScript = getScript(input.pageSource)
  if (!pageScript) {
    return { ok: false, reason: 'Page has no <script> block' }
  }
  let pageAst: File
  try {
    pageAst = babelParse(pageScript.content, {
      sourceType: 'module',
      plugins: ['typescript'],
      allowReturnOutsideFunction: true,
    }) as unknown as File
  } catch (err) {
    return { ok: false, reason: `Page script parse failed: ${(err as Error).message}` }
  }
  const arrayPos = findArrayDecl(pageAst, bindingName)
  if (!arrayPos) {
    return {
      ok: false,
      reason: `Could not locate array literal for "${bindingName}" in page script: data may be store-backed or dynamically built`,
    }
  }

  // 5. Convert page-script-local position to page-SFC-absolute.
  const sfcLine = arrayPos.line + pageScript.startLine - 1
  const sfcColumn = arrayPos.column + 1

  return {
    ok: true,
    file: input.pageSourceFile,
    arrayLocation: { line: sfcLine, column: sfcColumn },
    keyProperty,
  }
}
