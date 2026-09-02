/**
 * Pure (filesystem-free) prop-edit applicator for React/JSX — the `.tsx`/`.jsx`
 * sibling of [apply-prop-edit.ts](./apply-prop-edit.ts). Given a JSX module's
 * source and the `(line, column)` of an element's opening tag, produce a new
 * source with one attribute set to a new literal value.
 *
 * Coordinate convention: **Babel coords — 1-based line, 0-based column** (what
 * `jsx-source-tag-plugin.ts` stamps into `data-desde-src` and the bridge surfaces
 * as `editTarget`). The React lane is internally consistent: the stamp is
 * written by Babel and matched here by re-parsing with Babel, so `(line,
 * column)` lines up against `JSXOpeningElement.loc.start` directly (no template-
 * block shift like the Vue lane needs).
 *
 * Scope (M2, first cut): string / number / boolean values on a single element.
 * - existing literal attribute (`variant="primary"` or `count={3}`) → replace.
 * - absent attribute → insert after the tag name.
 * - attribute bound to a non-literal expression (`variant={kind}`) → refuse
 *   with `bound-binding` so the route falls back to the source-aware LLM lane
 *   (same `PropEditFallbackHint` contract the Vue applicator emits).
 * - element carrying a `{...spread}` and missing the named attr → refuse with
 *   `dynamic-vbind` (the spread may supply the prop; a static insert could be
 *   silently overridden at runtime).
 */

import { parse } from "@babel/parser"

import {
  parseJsxModule,
  findJsxOpeningElementAt,
  type JsxNode,
} from "./resolve-jsx-target"

// Type-only imports — erased at runtime, so the Vue compiler never enters this
// module's dependency graph. The shared result/fallback shapes keep the
// edit-handler's LLM-fallback dispatch framework-agnostic.
import type {
  PropEditValue,
  PropEditFallbackHint,
} from "./apply-prop-edit"

export type { PropEditValue, PropEditFallbackHint }

export interface ApplyJsxPropEditInput {
  /** Full `.tsx`/`.jsx` source text. */
  source: string
  /** 1-based line of the element's opening tag (Babel `loc.start.line`). */
  line: number
  /** 0-based column of the element's opening tag (Babel `loc.start.column`). */
  column: number
  /** Name of the attribute to set. */
  propName: string
  /** New value. String → quoted attr. Number / boolean → JSX expression `{…}`. */
  value: PropEditValue
}

export type ApplyJsxPropEditResult =
  | { ok: true; source: string }
  | { ok: false; reason: string; fallback?: PropEditFallbackHint }

/** Attribute names: identifier-style + optional dashes (covers `className`,
 *  `aria-label`, `data-foo`). Defense-in-depth against a malformed payload
 *  splicing arbitrary characters into source. */
const SAFE_PROP_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/

/** Refuse a true no-op (patched === source) so the handler never writes an
 *  unchanged file and reports "committed". Deterministic applicators refuse
 *  no-ops upstream of the handler's batch-level no-op guard.
 *
 *  Also runs the post-splice validation (WS2 defense-in-depth, tasks/
 *  edit-pipeline-rearchitecture.md) on every genuinely-changed result —
 *  ordered AFTER the no-op check. Mirrors `apply-jsx-delete-edit.ts`'s
 *  post-splice check: a strict Babel re-parse (errorRecovery OFF, unlike
 *  `parseJsxModule`'s permissive initial parse) so a corrupting splice
 *  refuses instead of silently writing broken JSX. */
function okOrNoop(source: string, next: string): ApplyJsxPropEditResult {
  if (next === source) {
    return { ok: false, reason: "Attribute value is unchanged. No edit needed." }
  }
  try {
    parse(next, { sourceType: "module", plugins: ["jsx", "typescript"] })
  } catch (err) {
    return { ok: false, reason: `Post-splice JSX parse failed: ${(err as Error).message}` }
  }
  return { ok: true, source: next }
}

/** Local extension of the shared node shape: attribute-level fields the prop
 *  splice reads as typed nodes. */
interface BabelNode extends JsxNode {
  name?: BabelNode | string
  /** TSX generic type args (`<Foo<T> />`) — ends past the tag name. */
  typeParameters?: BabelNode
  attributes?: BabelNode[]
  value?: BabelNode | null
  expression?: BabelNode
}

export function applyJsxPropEdit(input: ApplyJsxPropEditInput): ApplyJsxPropEditResult {
  const { source, line, column, propName, value } = input

  if (!SAFE_PROP_NAME_RE.test(propName)) {
    return { ok: false, reason: `Unsafe prop name "${propName}"` }
  }

  const parsed = parseJsxModule(source)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const ast = parsed.ast as BabelNode

  const target = findJsxOpeningElementAt(ast, line, column) as BabelNode | null
  if (!target) {
    return { ok: false, reason: `No JSX element found at ${line}:${column}` }
  }

  const attrs = target.attributes ?? []
  const existing = attrs.find(
    (a) => a.type === "JSXAttribute" && attrName(a) === propName,
  )
  const hasSpread = attrs.some((a) => a.type === "JSXSpreadAttribute")

  if (existing) {
    const valNode = existing.value ?? null
    // Boolean-shorthand attr (`<input disabled />`) → append `={value}` /
    // `="value"` after the name.
    if (valNode == null) {
      const nameEnd = (existing.name as BabelNode)?.end
      if (typeof nameEnd !== "number") {
        return { ok: false, reason: "could not locate attribute name end" }
      }
      return okOrNoop(source, splice(source, nameEnd, nameEnd, `=${renderValue(value)}`))
    }
    if (typeof valNode.start !== "number" || typeof valNode.end !== "number") {
      return { ok: false, reason: "could not locate attribute value range" }
    }
    if (valNode.type === "StringLiteral") {
      return okOrNoop(source, splice(source, valNode.start, valNode.end, renderValue(value)))
    }
    if (valNode.type === "JSXExpressionContainer") {
      const expr = valNode.expression
      if (expr && isLiteralExpression(expr)) {
        return okOrNoop(source, splice(source, valNode.start, valNode.end, renderValue(value)))
      }
      // Non-literal binding: editing the literal here would clobber the
      // expression. Hand off to the source-aware LLM lane.
      const expression =
        expr && typeof expr.start === "number" && typeof expr.end === "number"
          ? source.slice(expr.start, expr.end)
          : ""
      return {
        ok: false,
        reason: `Attribute "${propName}" is bound to an expression ({${expression}}); deterministic edit would clobber the binding.`,
        fallback: { kind: "bound-binding", expression },
      }
    }
    return { ok: false, reason: `Unsupported attribute value node: ${valNode.type}` }
  }

  // Attribute absent.
  if (hasSpread) {
    return {
      ok: false,
      reason: `Element has a {...spread}; can't statically set "${propName}" (the spread may supply it).`,
      fallback: { kind: "dynamic-vbind" },
    }
  }
  // Insert after the tag name — but past any TSX type arguments
  // (`<Table<Row> …>`: Babel's `typeParameters` ends beyond `name.end`;
  // inserting at `name.end` would corrupt to `<Table value=…<Row>`).
  const tagNameEnd = (target.name as BabelNode)?.end
  const typeParamsEnd = (target.typeParameters as BabelNode | undefined)?.end
  const insertAt = typeof typeParamsEnd === "number" ? typeParamsEnd : tagNameEnd
  if (typeof insertAt !== "number") {
    return { ok: false, reason: "could not locate opening-tag name end" }
  }
  return okOrNoop(source, splice(source, insertAt, insertAt, ` ${propName}=${renderValue(value)}`))
}

/** The value fragment: `"str"` for strings, `{n}`/`{true}` for number/boolean. */
function renderValue(value: PropEditValue): string {
  if (typeof value === "string") return `"${escapeAttr(value)}"`
  if (typeof value === "number" && Number.isFinite(value)) return `{${value}}`
  if (typeof value === "boolean") return `{${value}}`
  // Non-finite number (NaN/Infinity) — render as a string so we never emit
  // invalid JSX. (Validation upstream should prevent this.)
  return `"${escapeAttr(String(value))}"`
}

/** JSX string-attribute escaping: `&` and `"` only (the chars that break a
 *  double-quoted attribute). */
function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
}

/** A JSX expression is a literal we can safely overwrite when it's a bare
 *  string/number/boolean literal (incl. a negative numeric like `-1`). */
function isLiteralExpression(node: BabelNode): boolean {
  if (node.type === "StringLiteral") return true
  if (node.type === "NumericLiteral") return true
  if (node.type === "BooleanLiteral") return true
  if (
    node.type === "UnaryExpression" &&
    (node.operator === "-" || node.operator === "+") &&
    (node.argument as BabelNode | undefined)?.type === "NumericLiteral"
  ) {
    return true
  }
  return false
}

/** JSXAttribute name (a JSXIdentifier or JSXNamespacedName → its string). */
function attrName(attr: BabelNode): string | null {
  const n = attr.name
  if (!n || typeof n === "string") return typeof n === "string" ? n : null
  // JSXIdentifier.name is a string; JSXNamespacedName has name.name nested.
  const inner = (n as BabelNode).name
  return typeof inner === "string" ? inner : null
}

function splice(source: string, start: number, end: number, text: string): string {
  return source.slice(0, start) + text + source.slice(end)
}
