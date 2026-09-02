/**
 * React/JSX sibling of [apply-flatten-conditional-edit.ts](./apply-flatten-conditional-edit.ts).
 * Collapses a JSX conditional render down to one branch:
 *
 *   `{cond ? <A/> : <B/>}`  → `<A/>`  (or `<B/>`)
 *   `{cond && <A/>}`        → `<A/>`  (or removed entirely)
 *
 * Coordinate convention: Babel 1-based line / 0-based column. `(line, column)`
 * points at a JSX element that is currently rendered — i.e. one BRANCH of an
 * enclosing conditional (the bridge stamps the active branch). The applicator
 * walks up to the nearest enclosing `{conditional}` JSXExpressionContainer that
 * holds the clicked element in a branch.
 *
 * `branchToKeep` is **clicked-relative** (matches the layers menu's "Keep this
 * branch" / "Keep else branch" labels, where the user right-clicked the active
 * element — unlike the Vue chain-index semantics, since a JSX ternary has just
 * two sides and the click identifies one of them):
 *   - `0`      → keep the CLICKED branch.
 *   - `"else"` → keep the OTHER branch (ternary) / remove the render (`&&`).
 *
 * Refusal cases:
 *   - No element at (line, column).
 *   - The element isn't inside a `{ternary}` / `{cond && …}` JSXExpressionContainer.
 *   - `||` / `??` conditionals (out of scope for v1 — ambiguous "keep" semantics).
 *   - The kept branch would be empty when removal isn't intended.
 *   - Post-splice parse fails (e.g. the result is an adjacent-root JSX).
 */

import { parse } from "@babel/parser"

import {
  parseJsxModule,
  findJsxElementAt,
  walkJsx,
  type JsxNode,
} from "./resolve-jsx-target"

export interface ApplyJsxFlattenConditionalEditInput {
  source: string
  /** A rendered branch element — Babel 1-based line / 0-based column. */
  line: number
  column: number
  /** `0` keeps the clicked branch; `"else"` keeps the other branch / removes. */
  branchToKeep: number | "else"
}

export type ApplyJsxFlattenConditionalEditResult =
  | { ok: true; source: string }
  | { ok: false; reason: string }

/** Local extension of the shared node shape: conditional/logical-expression
 *  fields the flatten walk reads as typed nodes. */
interface BabelNode extends JsxNode {
  expression?: BabelNode
  test?: BabelNode
  consequent?: BabelNode
  alternate?: BabelNode
  left?: BabelNode
  right?: BabelNode
  operator?: string
}

export function applyJsxFlattenConditionalEdit(
  input: ApplyJsxFlattenConditionalEditInput,
): ApplyJsxFlattenConditionalEditResult {
  const { source, line, column, branchToKeep } = input

  const parsed = parseJsxModule(source)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const ast = parsed.ast as BabelNode

  const clicked = findJsxElementAt(ast, line, column) as BabelNode | null
  if (!clicked || typeof clicked.start !== "number" || typeof clicked.end !== "number") {
    return { ok: false, reason: `No JSX element found at ${line}:${column}` }
  }

  // Only `0` ("keep this branch") and `"else"` are meaningful for a JSX
  // conditional (two sides, identified by the clicked element). The shared
  // validator permits any non-negative number (Vue else-if chains), so reject
  // other indexes here rather than silently treating them like `0`.
  if (typeof branchToKeep === "number" && branchToKeep !== 0) {
    return {
      ok: false,
      reason: `branchToKeep ${branchToKeep} is invalid for a JSX conditional: use 0 (keep clicked branch) or "else".`,
    }
  }

  // Find the SMALLEST enclosing conditional/logical expression that holds the
  // clicked element in a branch — not just the smallest container — so nested
  // conditionals inside one `{…}` (e.g. `{a ? (b ? <X/> : <Y/>) : <Z/>}`)
  // target the inner conditional the user clicked into.
  const expr = findEnclosingConditional(ast, clicked)
  if (!expr) {
    return {
      ok: false,
      reason:
        "This element isn't rendered by a JSX conditional ({cond ? … : …} or {cond && …}). Nothing to flatten.",
    }
  }

  // Determine the kept branch node.
  let keptNode: BabelNode | null
  let removeEntirely = false
  if (expr.type === "ConditionalExpression") {
    const inConsequent = within(clicked, expr.consequent)
    const clickedNode = inConsequent ? expr.consequent! : expr.alternate!
    const otherNode = inConsequent ? expr.alternate! : expr.consequent!
    keptNode = branchToKeep === "else" ? otherNode : clickedNode
  } else {
    // LogicalExpression && — the renderable side is `right`.
    if (branchToKeep === "else") {
      keptNode = null
      removeEntirely = true
    } else {
      keptNode = expr.right ?? null
    }
  }

  // Replacement target: when the conditional is the direct top-level expression
  // of a `{…}` container, replace the whole container (so `{cond ? <A/> : <B/>}`
  // collapses to a bare `<A/>`). For a NESTED conditional, replace just the
  // expression in place (it stays in JS-expression position).
  const container = findContainerOf(ast, expr)
  const isContainerLevel = container !== null
  const target = container ?? expr
  if (typeof target.start !== "number" || typeof target.end !== "number") {
    return { ok: false, reason: "could not locate the conditional's byte range" }
  }

  let replacement: string
  if (removeEntirely) {
    // `&&` false-case renders nothing. At container level that's an empty
    // child; in expression position it must be a valid expression (`null`).
    replacement = isContainerLevel ? "" : "null"
  } else {
    if (!keptNode || typeof keptNode.start !== "number" || typeof keptNode.end !== "number") {
      return { ok: false, reason: "Kept branch has no source range. Nothing to keep." }
    }
    const kedesdeSrc = source.slice(keptNode.start, keptNode.end)
    const isElement = keptNode.type === "JSXElement" || keptNode.type === "JSXFragment"
    // At container level: a JSX element splices bare (`<A/>`); a non-element
    // stays wrapped to remain a valid JSX child (`{null}`, `{label}`). In
    // expression position: splice the raw expression (already valid there).
    replacement = isContainerLevel && !isElement ? `{${kedesdeSrc}}` : kedesdeSrc
  }

  const newSource =
    source.slice(0, target.start) + replacement + source.slice(target.end)

  if (newSource === source) {
    return { ok: false, reason: "Flatten produced no change. No edit needed." }
  }

  try {
    parse(newSource, { sourceType: "module", plugins: ["jsx", "typescript"] })
  } catch (err) {
    return {
      ok: false,
      reason: `Flattening here produces invalid JSX (${(err as Error).message}).`,
    }
  }

  return { ok: true, source: newSource }
}

/** Whether `node`'s byte range sits inside `branch`'s byte range. */
function within(node: BabelNode, branch: BabelNode | undefined): boolean {
  if (
    !branch ||
    typeof branch.start !== "number" ||
    typeof branch.end !== "number" ||
    typeof node.start !== "number" ||
    typeof node.end !== "number"
  ) {
    return false
  }
  return node.start >= branch.start && node.end <= branch.end
}

/** Smallest ConditionalExpression / LogicalExpression(&&) that holds `clicked`
 *  in a branch (consequent/alternate for ternary, right for &&). "Smallest" =
 *  least byte span, so a nested conditional inside one `{…}` is picked over its
 *  outer conditional when the click is inside the inner one. */
function findEnclosingConditional(ast: BabelNode, clicked: BabelNode): BabelNode | null {
  let best: BabelNode | null = null
  let bestSpan = Infinity
  walkJsx(ast, (raw) => {
    const node = raw as BabelNode
    let holds = false
    if (node.type === "ConditionalExpression") {
      holds = within(clicked, node.consequent) || within(clicked, node.alternate)
    } else if (node.type === "LogicalExpression" && node.operator === "&&") {
      holds = within(clicked, node.right)
    }
    if (!holds) return
    if (typeof node.start !== "number" || typeof node.end !== "number") return
    const span = node.end - node.start
    if (span < bestSpan) {
      bestSpan = span
      best = node
    }
  })
  return best
}

/** The JSXExpressionContainer whose top-level `.expression` IS `expr`, or null
 *  when `expr` is nested inside another expression (not a direct container child). */
function findContainerOf(ast: BabelNode, expr: BabelNode): BabelNode | null {
  let found: BabelNode | null = null
  walkJsx(ast, (raw) => {
    const node = raw as BabelNode
    if (found) return
    if (node.type === "JSXExpressionContainer" && node.expression === expr) {
      found = node
    }
  })
  return found
}
