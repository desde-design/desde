/**
 * React/JSX companion to {@link inferAttrFromTextEdit} (the Vue version). When
 * the bridge captures a designer text edit on rendered DOM text that's actually
 * produced by a component *prop* (e.g. `<Button label="Save" />`, where "Save"
 * is rendered inside Button from the `label` prop, not as a JSX text child), the
 * JSX slot-text applicator refuses — there's no matching JSXText child on the
 * host element. The mutation would then drag the whole batch into the LLM lane.
 *
 * This recovers the common case: locate the JSX element at `(line, column)`,
 * scan its **static string** attributes, and if exactly one attribute's trimmed
 * value equals `before.trim()`, return that attribute's name. The caller then
 * re-runs the mutation through `applyJsxPropEdit` with the inferred propName.
 *
 * Coordinate convention: **Babel coords — 1-based line, 0-based column** (what
 * `jsx-source-tag-plugin.ts` stamps and `apply-jsx-prop-edit.ts` matches).
 *
 * Safety (mirrors the Vue version):
 *  - **No `{...spread}` on the element.** A spread may supply the prop that
 *    renders the text, so a static-attr match could rewrite the wrong thing.
 *  - **No bound (expression-container) attributes anywhere on the element.**
 *    `label={x}` could be the real text source at runtime; the inferrer only
 *    sees static string literals, so any `{…}` attr → refuse and defer to LLM.
 *  - **No children that could render the text.** The recovery is for the
 *    *prop-rendered* case (`<Button label="Save" />` — no children, the text
 *    comes from a prop). If the element has any child that could be the text
 *    source — an expression container (`{label}`), a nested JSX element, or
 *    non-whitespace text — a coincidentally-matching static attr (e.g. an
 *    `aria-label`) must NOT be rewritten; refuse and defer to the LLM.
 *  - **Static string attributes only.** Only `StringLiteral`-valued
 *    JSXAttributes are scanned.
 *  - **Single-match requirement.** Zero or 2+ matches refuse (ambiguous).
 *  - **Pure — no I/O.**
 */

import { parseJsxModule, findJsxElementAt, type JsxNode } from "./resolve-jsx-target"

export interface InferAttrFromJsxTextEditInput {
  /** Full `.tsx`/`.jsx` source text. */
  source: string
  /** 1-based line of the element's opening tag (Babel `loc.start.line`). */
  line: number
  /** 0-based column of the element's opening tag (Babel `loc.start.column`). */
  column: number
  /** The rendered text the bridge captured before the designer's edit. */
  before: string
}

export type InferAttrFromJsxTextEditResult =
  | { ok: true; propName: string }
  | { ok: false; reason: string }

/** Local extension of the shared node shape: attribute-name / attribute-list
 *  fields the attr scan reads as typed nodes. */
interface BabelNode extends JsxNode {
  name?: BabelNode | string
  attributes?: BabelNode[]
  openingElement?: BabelNode
}

export function inferAttrFromJsxTextEdit(
  input: InferAttrFromJsxTextEditInput,
): InferAttrFromJsxTextEditResult {
  const { source, line, column, before } = input

  const trimmedBefore = before.trim()
  if (trimmedBefore.length === 0) {
    return { ok: false, reason: "before is empty after trimming" }
  }

  const parsed = parseJsxModule(source)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const ast = parsed.ast as BabelNode

  const target = findJsxElementAt(ast, line, column) as BabelNode | null
  if (!target) {
    return { ok: false, reason: `No JSX element found at ${line}:${column}` }
  }

  const opening = target.openingElement ?? target
  const attrs = opening.attributes ?? []
  const tag = openingTagName(opening)

  // Refuse if the element has any child that could be the rendered-text source —
  // an expression container (`{label}`), a nested element, or non-whitespace
  // text. Recovery is only safe for the prop-rendered case (no such children),
  // else a coincidentally-matching static attr (e.g. aria-label) would be
  // rewritten while the real text comes from children.
  const children = target.children ?? []
  const hasTextSourceChild = children.some((c) => {
    if (c.type === "JSXExpressionContainer") {
      // `{/* comment */}` / `{}` are JSXEmptyExpression — they render nothing,
      // so they don't compete with the static prop. Any other expression could.
      const expr = (c as { expression?: BabelNode }).expression
      return expr?.type !== "JSXEmptyExpression"
    }
    if (c.type === "JSXElement" || c.type === "JSXFragment") return true
    if (c.type === "JSXText") {
      return typeof c.value === "string" && c.value.trim().length > 0
    }
    return false
  })
  if (hasTextSourceChild) {
    return {
      ok: false,
      reason: `Refusing: <${tag}> has children that could render the text. Deferring to LLM lane`,
    }
  }

  // Refuse if a spread is present — it may supply the text-rendering prop.
  if (attrs.some((a) => a.type === "JSXSpreadAttribute")) {
    return {
      ok: false,
      reason: `Refusing: <${tag}> has a {...spread}. Rendered text source is ambiguous; deferring to LLM lane`,
    }
  }
  // Refuse if any attribute is bound to an expression (`prop={x}`) — the real
  // text source could be that binding at runtime.
  for (const a of attrs) {
    if (a.type !== "JSXAttribute") continue
    const valNode = a.value as BabelNode | null | undefined
    if (valNode?.type === "JSXExpressionContainer") {
      return {
        ok: false,
        reason: `Refusing: <${tag}> has a bound attribute ({…}). Rendered text source is ambiguous when bindings are present; deferring to LLM lane`,
      }
    }
  }

  const matches: string[] = []
  for (const a of attrs) {
    if (a.type !== "JSXAttribute") continue
    const valNode = a.value as BabelNode | null | undefined
    if (valNode?.type !== "StringLiteral") continue
    const v = (valNode as { value?: unknown }).value
    if (typeof v !== "string") continue
    if (v.trim() === trimmedBefore) {
      const name = attrName(a)
      if (name) matches.push(name)
    }
  }

  if (matches.length === 0) {
    return {
      ok: false,
      reason: `No static attribute on <${tag}> matches before (\`${truncate(trimmedBefore, 60)}\`)`,
    }
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `Ambiguous: ${matches.length} static attributes on <${tag}> match before (\`${truncate(trimmedBefore, 60)}\`): ${matches.join(", ")}`,
    }
  }
  return { ok: true, propName: matches[0] }
}

function openingTagName(el: BabelNode): string {
  const n = el.name
  if (typeof n === "string") return n
  const inner = (n as BabelNode | undefined)?.name
  return typeof inner === "string" ? inner : "element"
}

function attrName(attr: BabelNode): string | null {
  const n = attr.name
  if (!n || typeof n === "string") return typeof n === "string" ? n : null
  const inner = (n as BabelNode).name
  return typeof inner === "string" ? inner : null
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…"
}
