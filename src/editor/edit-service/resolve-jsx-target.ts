/**
 * Shared JSX target resolution for the deterministic edit applicators
 * (WS1 of tasks/edit-pipeline-rearchitecture.md) — the `.tsx`/`.jsx`
 * sibling of [resolve-template-target.ts](./resolve-template-target.ts).
 *
 * Every JSX applicator used to carry its own copy of the same Babel
 * parse + tree walk + exact `(line, column)` match. The audit (2026-07-24)
 * found 7 copies of the JSXElement-matching walk and 2 of the
 * JSXOpeningElement-matching variant. This module is now the single
 * implementation of both, plus the generic `walkJsx` visitor they share.
 *
 * Coordinate convention: Babel 1-based line, 0-based column (matches what
 * the JSX source-tag plugin stamps into `data-desde-src` for React files).
 * Babel offsets are absolute — no template-block shift.
 *
 * Behavioral contract kept identical to the copies it replaces: exact
 * integer equality, first match in walk order, refusal reason strings
 * match the historical per-applicator strings ("JSX parse failed: …",
 * "No JSX element found at line X, column Y").
 */

import { parse } from '@babel/parser'

/** Minimal structural Babel node shape shared by the JSX applicators. */
export interface JsxNode {
  type?: string
  start?: number | null
  end?: number | null
  loc?: {
    start?: { line?: number; column?: number }
    end?: { line?: number; column?: number }
  } | null
  openingElement?: JsxNode
  children?: JsxNode[]
  [key: string]: unknown
}

export type ResolveJsxTargetResult =
  | { ok: true; ast: JsxNode; node: JsxNode }
  | { ok: false; reason: string }

/** Parse a `.tsx`/`.jsx` module with the standard plugin set the JSX
 *  applicators all use (jsx + typescript, errorRecovery on). */
export function parseJsxModule(
  source: string,
): { ok: true; ast: JsxNode } | { ok: false; reason: string } {
  try {
    const ast = parse(source, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      errorRecovery: true,
    }) as unknown as JsxNode
    return { ok: true, ast }
  } catch (err) {
    return { ok: false, reason: `JSX parse failed: ${(err as Error).message}` }
  }
}

/** Parse + find the first JSXElement whose OPENING TAG is at (line, column). */
export function resolveJsxElement(
  source: string,
  line: number,
  column: number,
): ResolveJsxTargetResult {
  const parsed = parseJsxModule(source)
  if (!parsed.ok) return parsed
  const node = findJsxElementAt(parsed.ast, line, column)
  if (!node) {
    return { ok: false, reason: `No JSX element found at line ${line}, column ${column}` }
  }
  return { ok: true, ast: parsed.ast, node }
}

/** Parse + find the first JSXOpeningElement at (line, column). */
export function resolveJsxOpeningElement(
  source: string,
  line: number,
  column: number,
): ResolveJsxTargetResult {
  const parsed = parseJsxModule(source)
  if (!parsed.ok) return parsed
  const node = findJsxOpeningElementAt(parsed.ast, line, column)
  if (!node) {
    return { ok: false, reason: `No JSX element found at line ${line}, column ${column}` }
  }
  return { ok: true, ast: parsed.ast, node }
}

/** First JSXElement whose opening tag is at (line, column). */
export function findJsxElementAt(ast: JsxNode, line: number, column: number): JsxNode | null {
  let found: JsxNode | null = null
  walkJsx(ast, (node) => {
    if (found) return
    if (node.type !== 'JSXElement') return
    const s = node.openingElement?.loc?.start
    if (s?.line === line && s?.column === column) found = node
  })
  return found
}

/** First JSXOpeningElement whose position matches (line, column). */
export function findJsxOpeningElementAt(
  ast: JsxNode,
  line: number,
  column: number,
): JsxNode | null {
  let found: JsxNode | null = null
  walkJsx(ast, (node) => {
    if (found) return
    if (node.type !== 'JSXOpeningElement') return
    const s = node.loc?.start
    if (s?.line === line && s?.column === column) found = node
  })
  return found
}

/** Generic depth-first Babel-node visitor (the `walk` every JSX applicator
 *  private-copied). Skips loc/start/end/type keys, recurses arrays and
 *  typed child objects. */
export function walkJsx(node: JsxNode | null | undefined, visit: (n: JsxNode) => void): void {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') visit(node)
  for (const key in node) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue
    const v = node[key]
    if (Array.isArray(v)) {
      for (const item of v) walkJsx(item as JsxNode, visit)
    } else if (v && typeof v === 'object' && typeof (v as JsxNode).type === 'string') {
      walkJsx(v as JsxNode, visit)
    }
  }
}
