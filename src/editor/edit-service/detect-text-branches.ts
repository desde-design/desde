/**
 * Detects Vue template interpolations that look like
 *
 *     {{ <test> ? <a> : <b> }}
 *
 * and exposes the two branches as separately editable byte ranges. Drives
 * the inspector's "two fields" UX for elements whose visible text is a
 * conditional ternary — designers can rename either branch's literal
 * string (or replace a bound expression with another) without touching
 * the rest of the file.
 *
 * Scope: ternary expressions only. `&&` / `||` / `??` patterns are
 * deliberately out of scope for v1; widen later by adding more cases
 * to `extractBranches`.
 *
 * Pure module — no I/O, no LLM, takes raw SFC text and a target source
 * location and returns the branches (or `null` if no detection). Both
 * the server route and the CLI handler call this; both must dispatch
 * the same branch shape.
 */

import { NodeTypes } from "@vue/compiler-dom"
import { parseExpression } from "@babel/parser"
import { resolveTemplateTarget } from "./resolve-template-target"
import type { Expression, ConditionalExpression } from "@babel/types"

export interface TextBranch {
  /**
   * Which branch this represents — the `consequent` ("when test is truthy")
   * vs the `alternate` ("when test is falsy"). Drives the inspector's
   * "when true / when false" labeling.
   */
  kind: "consequent" | "alternate"
  /**
   * How the branch is represented in source. Drives display + dispatch:
   *  - `"literal"`: source has a quoted string literal. Display value
   *    is the unquoted content; on save we re-wrap in single quotes
   *    and escape inner quotes.
   *  - `"bound"`: source has a non-literal expression (identifier,
   *    member access, function call, etc.). Display value is the raw
   *    JS source text; on save the new value is spliced verbatim.
   */
  valueKind: "literal" | "bound"
  /** Current display value (unquoted for literals; raw JS for bound). */
  value: string
  /**
   * SFC-absolute byte range covering the BRANCH's source bytes:
   *  - `"literal"`: includes the surrounding quotes.
   *  - `"bound"`: covers just the expression text.
   * The caller splices `byteStart..byteEnd` with the rewrapped value.
   */
  byteStart: number
  byteEnd: number
}

export interface DetectTextBranchesResult {
  /** Raw source text of the test expression (e.g. `"enabled"` or `"user.active"`). */
  testExpression: string
  branches: [TextBranch, TextBranch]
}

export interface DetectTextBranchesInput {
  /** Full SFC source. */
  source: string
  /**
   * Where the candidate text element lives in the SFC. Comes from the
   * inspector — same `editTarget` / `authoredAt` shape that drives every
   * other source-aware applicator. Lines/columns are 1-based, SFC-relative
   * (NOT template-content-relative).
   */
  line: number
  column: number
}

/**
 * Returns the two branches if (and only if) the element at
 * `(line, column)` in `source` has exactly one interpolation child whose
 * expression is a conditional ternary. Returns `null` for anything else
 * (literal text node, non-ternary interpolation, mixed text + element
 * children, parse failure).
 */
export function detectTextBranches(
  input: DetectTextBranchesInput,
): DetectTextBranchesResult | null {
  const { source, line, column } = input

  // Resolve the target element via the shared resolver; every failure
  // (parse error, no template, no match) collapses to `null` here — this
  // module signals "no detection" rather than reasons.
  const resolved = resolveTemplateTarget({ source, line, column })
  if (!resolved.ok) return null
  const el = resolved.node as unknown as TemplateNode
  const { templateOffset } = resolved.ctx

  // Only one child, and it must be an INTERPOLATION. Mixed children
  // (text + element, multiple interpolations) aren't this v1's case.
  if (el.children.length !== 1) return null
  const child = el.children[0] as TemplateNode
  if (child.type !== NodeTypes.INTERPOLATION) return null
  const content = (child as InterpolationNode).content
  if (content.type !== NodeTypes.SIMPLE_EXPRESSION) return null

  const exprText = content.content
  const exprStartOffset = content.loc.start.offset

  let expr: Expression
  try {
    expr = parseExpression(exprText, {
      sourceType: "module",
      plugins: ["typescript"],
    })
  } catch {
    return null
  }

  if (expr.type !== "ConditionalExpression") return null
  const cond = expr as ConditionalExpression
  if (cond.test.start == null) return null
  const testText = exprText.slice(cond.test.start, cond.test.end ?? cond.test.start)

  const consequent = branchFor(cond.consequent, exprText, exprStartOffset, templateOffset)
  const alternate = branchFor(cond.alternate, exprText, exprStartOffset, templateOffset)
  if (!consequent || !alternate) return null
  consequent.kind = "consequent"
  alternate.kind = "alternate"

  return {
    testExpression: testText,
    branches: [consequent, alternate],
  }
}

function branchFor(
  node: Expression,
  exprText: string,
  exprStartOffset: number,
  templateOffset: number,
): TextBranch | null {
  if (node.start == null || node.end == null) return null
  // SFC-absolute byte range: the @vue/compiler-dom interpolation's
  // expression start is template-content-relative — shift by the
  // template block's start offset to get SFC bytes.
  const byteStart = templateOffset + exprStartOffset + node.start
  const byteEnd = templateOffset + exprStartOffset + node.end

  if (node.type === "StringLiteral") {
    return {
      kind: "consequent", // overwritten by caller
      valueKind: "literal",
      value: node.value,
      byteStart,
      byteEnd,
    }
  }

  // Treat anything that isn't a string literal as a bound expression —
  // identifier, member expression, call, etc. The branch is editable;
  // we just splice the user's input verbatim.
  const rawText = exprText.slice(node.start, node.end)
  return {
    kind: "consequent", // overwritten by caller
    valueKind: "bound",
    value: rawText,
    byteStart,
    byteEnd,
  }
}

// ── Minimal AST node types we need ─────────────────────────────────
// We type these narrowly so the file isn't coupled to `@vue/compiler-dom`'s
// full public AST shape (which moves around between versions). Only the
// fields touched here matter.
interface TemplateNode {
  type: number
  loc: { start: { line: number; column: number; offset: number }; end: { offset: number } }
  children: TemplateNode[]
  tag?: string
}

interface InterpolationNode extends TemplateNode {
  content: {
    type: number
    content: string
    loc: { start: { offset: number } }
  }
}
