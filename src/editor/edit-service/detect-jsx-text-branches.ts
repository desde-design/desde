/**
 * React/JSX sibling of [detect-text-branches.ts](./detect-text-branches.ts).
 * Detects a JSX element whose single child is a conditional-text expression
 *
 *     {<test> ? <a> : <b>}
 *
 * and exposes the two branches as separately editable byte ranges — the same
 * `TextBranch` shape the Vue detector produces, so the inspector's two-field
 * "when true / when false" UX is framework-neutral.
 *
 * Scope (mirrors the Vue v1): ternary expressions only; `&&` / `||` / `??` are
 * out of scope. The element must have exactly one child — a JSXExpressionContainer
 * wrapping a ConditionalExpression. Mixed children, non-ternary containers, or
 * plain JSX text return `null`.
 *
 * Coordinate convention: Babel 1-based line / 0-based column (the
 * `data-desde-src` stamp + what apply-jsx-* match). Babel offsets are absolute,
 * so branch byte ranges come straight off `node.start`/`node.end` — no
 * template-block shift (unlike the Vue detector).
 *
 * Pure — no I/O. Returns the shared `TextBranch` / `DetectTextBranchesResult`
 * types so callers dispatch one branch shape regardless of framework.
 */

import { parseJsxModule, findJsxElementAt, type JsxNode } from "./resolve-jsx-target"
import type { TextBranch, DetectTextBranchesResult } from "./detect-text-branches"

export type { TextBranch, DetectTextBranchesResult }

export interface DetectJsxTextBranchesInput {
  /** Full `.tsx`/`.jsx` source. */
  source: string
  /** Element opening-tag location — Babel 1-based line / 0-based column. */
  line: number
  column: number
}

/** Local extension of the shared node shape: conditional-expression fields the
 *  branch detection reads as typed nodes (children re-typed so a child's
 *  `.expression` is directly readable). */
interface BabelNode extends JsxNode {
  children?: BabelNode[]
  expression?: BabelNode
  test?: BabelNode
  consequent?: BabelNode
  alternate?: BabelNode
}

export function detectJsxTextBranches(
  input: DetectJsxTextBranchesInput,
): DetectTextBranchesResult | null {
  const { source, line, column } = input

  const parsed = parseJsxModule(source)
  if (!parsed.ok) return null
  const ast = parsed.ast as BabelNode

  const el = findJsxElementAt(ast, line, column) as BabelNode | null
  if (!el) return null

  // Exactly one MEANINGFUL child: a JSXExpressionContainer wrapping a ternary.
  // JSX text whitespace nodes around the container are ignored (the common
  // `<span>\n  {cond ? a : b}\n</span>` formatting).
  const children = (el.children ?? []).filter(
    (c) => !(c.type === "JSXText" && typeof c.value === "string" && c.value.trim() === ""),
  )
  if (children.length !== 1) return null
  const child = children[0]
  if (child.type !== "JSXExpressionContainer") return null
  const expr = child.expression
  if (!expr || expr.type !== "ConditionalExpression") return null
  if (
    typeof expr.test?.start !== "number" ||
    typeof expr.test?.end !== "number"
  ) {
    return null
  }
  const testText = source.slice(expr.test.start, expr.test.end)

  const consequent = branchFor(expr.consequent, source)
  const alternate = branchFor(expr.alternate, source)
  if (!consequent || !alternate) return null
  consequent.kind = "consequent"
  alternate.kind = "alternate"

  return { testExpression: testText, branches: [consequent, alternate] }
}

function branchFor(node: BabelNode | undefined, source: string): TextBranch | null {
  if (!node || typeof node.start !== "number" || typeof node.end !== "number") {
    return null
  }
  if (node.type === "StringLiteral") {
    return {
      kind: "consequent", // overwritten by caller
      valueKind: "literal",
      value: typeof node.value === "string" ? node.value : "",
      byteStart: node.start,
      byteEnd: node.end,
    }
  }
  // Anything else (identifier, member, call, JSX element, …) is a bound branch:
  // splice the user's input verbatim.
  return {
    kind: "consequent", // overwritten by caller
    valueKind: "bound",
    value: source.slice(node.start, node.end),
    byteStart: node.start,
    byteEnd: node.end,
  }
}
