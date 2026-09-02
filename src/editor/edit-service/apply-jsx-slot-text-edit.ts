/**
 * Deterministic text-edit applicator for React/JSX — the `.tsx`/`.jsx` sibling
 * of [apply-slot-text-edit.ts](./apply-slot-text-edit.ts). Locate the JSX
 * element at the `(line, column)` Babel coordinate the source-tag plugin
 * stamped, find its single JSXText child, verify it matches `before` (trimmed),
 * and rewrite just that text span to `after` (preserving the node's leading/
 * trailing whitespace so indentation survives).
 *
 * Refuses — deferring to the LLM patch lane — for any shape it can't safely
 * rewrite: no text child, multiple text fragments, a `{expression}` child
 * (the JSX analog of a Vue interpolation), nested element children mixed with
 * text, or a `before` mismatch.
 *
 * Coordinate convention: Babel 1-based line, 0-based column (see
 * apply-jsx-prop-edit.ts). Internally consistent with the JSX source-tag plugin.
 */

import { parse } from "@babel/parser"

import { parseJsxModule, findJsxElementAt, type JsxNode } from "./resolve-jsx-target"

export interface ApplyJsxSlotTextEditInput {
  /** Full `.tsx`/`.jsx` source text. */
  source: string
  /** 1-based line of the element's opening tag (Babel `loc.start.line`). */
  line: number
  /** 0-based column of the element's opening tag (Babel `loc.start.column`). */
  column: number
  /** Current rendered text (from the bridge mutation's `before`). */
  before: string
  /** New text the designer typed. */
  after: string
}

export type ApplyJsxSlotTextEditResult =
  | { ok: true; source: string }
  | { ok: false; reason: string }

export function applyJsxSlotTextEdit(
  input: ApplyJsxSlotTextEditInput,
): ApplyJsxSlotTextEditResult {
  const { source, line, column, before, after } = input

  const parsed = parseJsxModule(source)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const ast: JsxNode = parsed.ast

  const element = findJsxElementAt(ast, line, column)
  if (!element) {
    return { ok: false, reason: `No JSX element found at ${line}:${column}` }
  }

  const children = element.children ?? []
  // Meaningful children = anything that isn't pure-whitespace JSXText.
  const meaningful = children.filter((c) => {
    if (c.type === "JSXText") return typeof c.value === "string" && c.value.trim().length > 0
    return true // JSXExpressionContainer, JSXElement, JSXFragment, …
  })

  if (meaningful.length !== 1) {
    return {
      ok: false,
      reason:
        meaningful.length === 0
          ? "element has no text child to edit"
          : "element has mixed/multiple children (text + expression/element); deferring to the LLM lane",
    }
  }
  const only = meaningful[0]
  if (only.type !== "JSXText") {
    return {
      ok: false,
      reason: `single child is a ${only.type}, not static text; deferring to the LLM lane`,
    }
  }
  if (typeof only.start !== "number" || typeof only.end !== "number") {
    return { ok: false, reason: "could not locate the text node range" }
  }

  const raw = source.slice(only.start, only.end)
  const leading = raw.match(/^\s*/)?.[0] ?? ""
  const trailing = raw.match(/\s*$/)?.[0] ?? ""
  const core = raw.trim()
  if (core !== before.trim()) {
    return {
      ok: false,
      reason: `text mismatch: source has "${core}", expected "${before.trim()}"`,
    }
  }

  // Escape JSX-special characters before splicing — `<` and `{` would start a
  // child element / expression container and break the JSX (the deterministic
  // lane skips parse validation, so unescaped `2 < 3` would corrupt the file).
  const next =
    source.slice(0, only.start) + leading + escapeJsxText(after) + trailing + source.slice(only.end)
  if (next === source) {
    return { ok: false, reason: "text is unchanged. No edit needed" }
  }

  // Post-splice validation (WS2 defense-in-depth, tasks/
  // edit-pipeline-rearchitecture.md) — mirrors `apply-jsx-delete-edit.ts`'s
  // post-splice check: a strict Babel re-parse (errorRecovery OFF) so a
  // corrupting splice refuses instead of silently writing broken JSX.
  try {
    parse(next, { sourceType: "module", plugins: ["jsx", "typescript"] })
  } catch (err) {
    return { ok: false, reason: `Post-splice JSX parse failed: ${(err as Error).message}` }
  }

  return { ok: true, source: next }
}

/** Escape text for a JSXText node. `<`/`{` are structural in JSX; `&` must be
 *  escaped so it isn't read as an entity. The browser decodes these back to the
 *  literal characters at render time. */
function escapeJsxText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;")
}
