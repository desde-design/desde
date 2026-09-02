/**
 * Deterministic applicator for "edit one branch of a `{{ test ? a : b }}`
 * ternary interpolation." Paired with {@link detectTextBranches} — the
 * detector finds the branch's byte range and value-kind; this applicator
 * byte-splices the new value back into source.
 *
 * The two value-kinds dispatch differently:
 *  - `"literal"`: the branch's bytes include the surrounding quotes
 *    (e.g. `'This policy is enabled'`). The new value is the
 *    unquoted user input; we re-wrap in single quotes and escape any
 *    inner single quotes / backslashes so the resulting JS string
 *    parses back to exactly what the user typed.
 *  - `"bound"`: the branch's bytes cover just the raw expression
 *    (e.g. `title` or `user.name`). The new value is JS source text;
 *    we splice it verbatim with no escaping. Caller is responsible
 *    for handing us a valid JS expression — we don't parse it here
 *    because the LLM lane would just refuse on garbage and the
 *    inspector's "Save" button can do a lightweight validity check.
 *
 * Post-splice we re-parse the SFC + recompile its template to verify
 * the edit didn't break the file. Same backstop as `applyMoveEdit` —
 * a malformed expression (`enabled ? 'foo` for instance) would parse
 * fine as text but blow up at Vue compile, and refusing here turns a
 * silently-broken save into an upfront refusal the caller can show.
 */

import { parse as parseSfc } from "@vue/compiler-sfc"
import { parse as parseTemplate, compile as compileTemplate, NodeTypes } from "@vue/compiler-dom"
import { parseExpression } from "@babel/parser"

export interface ApplyTextBranchEditInput {
  source: string
  byteStart: number
  byteEnd: number
  valueKind: "literal" | "bound"
  /**
   * The new content. For `"literal"`, this is the unquoted string the
   * user typed in the inspector field (we add quotes). For `"bound"`,
   * this is raw JS source spliced as-is.
   */
  newValue: string
}

export type ApplyTextBranchEditResult =
  | { ok: true; source: string }
  | { ok: false; reason: string }

export function applyTextBranchEdit(
  input: ApplyTextBranchEditInput,
): ApplyTextBranchEditResult {
  const { source, byteStart, byteEnd, valueKind, newValue } = input

  if (byteStart < 0 || byteEnd > source.length || byteStart > byteEnd) {
    return { ok: false, reason: "Branch byte range is out of bounds for source" }
  }

  // For bound branches, validate the user's input as a JS expression up
  // front. Vue's template compile doesn't catch malformed JS inside
  // `{{ ... }}` — those errors only surface at runtime — so without
  // this we'd silently write `foo(` to disk and break the dev server.
  if (valueKind === "bound") {
    try {
      parseExpression(newValue, {
        sourceType: "module",
        plugins: ["typescript"],
      })
    } catch (err) {
      return {
        ok: false,
        reason: `Bound expression is not valid JavaScript: ${(err as Error).message}`,
      }
    }
  }

  const replacement =
    valueKind === "literal" ? formatLiteralReplacement(newValue) : newValue

  const newSource =
    source.slice(0, byteStart) + replacement + source.slice(byteEnd)

  // Post-splice validation.
  //
  // Vue's template compiler embeds interpolation expressions in the
  // generated render function but doesn't fully parse them up front —
  // some malformed bound-branch splices slip through `compileTemplate`.
  // Concrete example: `parseExpression("a, b")` succeeds standalone, so
  // the pre-splice JS check passes; but the spliced template ends up
  // with `{{ flag ? a, b : 'Default' }}` — the comma swallows the
  // ternary and the runtime evaluates as `(flag ? a), b` instead of
  // `flag ? a : b`. To catch this, we also re-parse EVERY interpolation
  // expression in the post-splice template through @babel/parser. Any
  // change that produced an invalid JS expression (or one that, when
  // spliced, parses to a different shape than the user intended)
  // surfaces here.
  let descriptor
  try {
    descriptor = parseSfc(newSource).descriptor
    if (!descriptor.template) {
      return { ok: false, reason: "Post-splice SFC lost its <template> block" }
    }
    compileTemplate(descriptor.template.content)
  } catch (err) {
    return {
      ok: false,
      reason: `Post-splice template compile failed: ${(err as Error).message}`,
    }
  }
  try {
    const ast = parseTemplate(descriptor.template.content)
    const failure = findInvalidInterpolation(ast.children as TemplateNode[])
    if (failure) {
      return {
        ok: false,
        reason: `Post-splice interpolation invalid: ${failure}`,
      }
    }
  } catch (err) {
    return {
      ok: false,
      reason: `Post-splice template re-parse failed: ${(err as Error).message}`,
    }
  }

  return { ok: true, source: newSource }
}

interface TemplateNode {
  type: number
  children?: TemplateNode[]
  content?: { type: number; content?: string }
}

function findInvalidInterpolation(nodes: TemplateNode[]): string | null {
  for (const node of nodes) {
    if (node.type === NodeTypes.INTERPOLATION) {
      const expr = node.content?.content
      if (typeof expr === "string") {
        try {
          parseExpression(expr, {
            sourceType: "module",
            plugins: ["typescript"],
          })
        } catch (err) {
          return `\`{{ ${expr} }}\`: ${(err as Error).message}`
        }
      }
    }
    if (node.children) {
      const nested = findInvalidInterpolation(node.children)
      if (nested) return nested
    }
  }
  return null
}

/**
 * Wrap a user-typed string in single quotes for splicing back into a JS
 * source position. Escapes the two characters that would otherwise break
 * the quoted form: backslashes (to avoid them escaping the next char)
 * and single quotes (to avoid terminating the string early). Newlines
 * are encoded as `\n` so the resulting string still fits on one line —
 * matters because the detected branch lived on one line in source and we
 * don't want to introduce a runtime difference.
 */
function formatLiteralReplacement(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
  return `'${escaped}'`
}
