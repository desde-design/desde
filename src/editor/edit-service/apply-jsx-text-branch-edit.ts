/**
 * React/JSX sibling of [apply-text-branch-edit.ts](./apply-text-branch-edit.ts).
 * Edits one branch of a `{<test> ? <a> : <b>}` JSX conditional-text expression.
 * Paired with {@link detectJsxTextBranches} — the detector finds the branch's
 * byte range + value-kind, this applicator byte-splices the new value back.
 *
 * Value-kinds (same contract as the Vue applicator):
 *  - `"literal"`: the branch bytes include surrounding quotes. New value is the
 *    unquoted user input; re-wrap as a JS string (double-quoted via JSON, which
 *    escapes inner quotes/backslashes/newlines so it parses to exactly what was
 *    typed).
 *  - `"bound"`: the branch bytes cover the raw expression. New value is JS
 *    source spliced verbatim — validated as a JS expression up front.
 *
 * Post-splice we re-parse the whole module with `@babel/parser` so a malformed
 * splice surfaces as an upfront refusal instead of a broken dev server.
 */

import { parse, parseExpression } from "@babel/parser"

export interface ApplyJsxTextBranchEditInput {
  source: string
  byteStart: number
  byteEnd: number
  valueKind: "literal" | "bound"
  /** Unquoted string (literal) or raw JS source (bound). */
  newValue: string
}

export type ApplyJsxTextBranchEditResult =
  | { ok: true; source: string }
  | { ok: false; reason: string }

export function applyJsxTextBranchEdit(
  input: ApplyJsxTextBranchEditInput,
): ApplyJsxTextBranchEditResult {
  const { source, byteStart, byteEnd, valueKind, newValue } = input

  if (byteStart < 0 || byteEnd > source.length || byteStart > byteEnd) {
    return { ok: false, reason: "Branch byte range is out of bounds for source" }
  }

  if (valueKind === "bound") {
    try {
      parseExpression(newValue, { sourceType: "module", plugins: ["jsx", "typescript"] })
    } catch (err) {
      return {
        ok: false,
        reason: `Bound expression is not valid JavaScript: ${(err as Error).message}`,
      }
    }
  }

  // JSON.stringify gives a correctly-escaped double-quoted JS string literal.
  const replacement = valueKind === "literal" ? JSON.stringify(newValue) : newValue
  const newSource = source.slice(0, byteStart) + replacement + source.slice(byteEnd)

  if (newSource === source) {
    return { ok: false, reason: "Branch is unchanged. No edit needed." }
  }

  // Post-splice parse — catches a malformed bound splice (e.g. `a, b` swallowing
  // the ternary) before it reaches disk.
  try {
    parse(newSource, { sourceType: "module", plugins: ["jsx", "typescript"] })
  } catch (err) {
    return {
      ok: false,
      reason: `Post-splice JSX parse failed: ${(err as Error).message}`,
    }
  }

  return { ok: true, source: newSource }
}
