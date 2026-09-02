/**
 * React/JSX sibling of
 * [extract-slot-interpolation-key.ts](./extract-slot-interpolation-key.ts).
 *
 * For a dom-text edit inside a `.map()` row, the deterministic "this row" lane
 * needs to know WHICH property of the iterated entry to patch. Given the source
 * position of the element holding the text and the map callback's iteratee
 * root, this returns the property key authored in a `{expr}` child — or refuses
 * with a reason the caller surfaces.
 *
 *   {items.map((item) => <Row>{item.label}</Row>)}   → "label"
 *
 * ── Why this is SHORTER than the Vue one, not longer ──
 *
 * The Vue extractor spends most of its 255 lines on two things JSX does not
 * have. It re-implements element lookup with a template-block offset shift,
 * because `@vue/compiler-dom` reports lines relative to the `<template>` block;
 * Babel reports absolute positions, and `findJsxElementAt`
 * ([resolve-jsx-target.ts](./resolve-jsx-target.ts)) is already the shared
 * lookup every JSX applicator uses. And it string-parses `"item.label"` out of
 * an interpolation's raw text, because Vue hands interpolations over as
 * strings; JSX hands over a parsed `MemberExpression`, so the same refusals are
 * decided on real AST nodes rather than on a regex over source text.
 *
 * The refusal set is deliberately IDENTICAL to the Vue extractor's — the two
 * feed one server route and one dialog, and a designer should not discover that
 * "this row" means something different depending on which framework they are
 * in. Every case below has a Vue counterpart in that file's doc comment.
 *
 * Accepted:
 *   `<Row>{item.label}</Row>`                → "label"
 *
 * Refused:
 *   `<Row><span>{item.title}</span></Row>`   text sits in a wrapper element
 *   `<Row>Logging</Row>`                     static text, nothing row-bound
 *   `<Row>{item}</Row>`                      the entry itself; no field to patch
 *   `<Row>{item.title.text}</Row>`           nested; the applicator patches top-level only
 *   `<Row>{item.label.toUpperCase()}</Row>`  computed expression
 *   `<Row>{item["label"]}</Row>`             computed member access
 *   `<Row>{other.label}</Row>`               not the iteratee root
 *   `<Row>{a}{b}</Row>`                      ambiguous which child carries the field
 */

import { parseJsxModule, findJsxElementAt, type JsxNode } from "./resolve-jsx-target"

export interface ExtractJsxInterpolationKeyInput {
  /** Full `.tsx`/`.jsx` source text. */
  source: string
  /** 1-based line of the element's opening tag (Babel `loc.start.line`). */
  line: number
  /** 0-based column of the element's opening tag (Babel `loc.start.column`). */
  column: number
  /**
   * The map callback's iteratee root — `item` in `items.map((item) => …)`.
   * Refusing when the expression reads a different root is what stops a stray
   * `{someOtherVar.label}` inside the same element being mistaken for the
   * iteration field.
   */
  itemVar: string
}

export type ExtractJsxInterpolationKeyResult =
  | { ok: true; propertyKey: string }
  | { ok: false; reason: string }

/** Babel node fields this module reads. `JsxNode` is the shared loose shape. */
interface BabelNode extends JsxNode {
  expression?: BabelNode
  object?: BabelNode
  property?: BabelNode
  name?: string
  computed?: boolean
  value?: unknown
}

/** Human name for a refused child, mirroring the Vue extractor's messages. */
function describeChild(node: BabelNode): string {
  switch (node.type) {
    case "JSXText":
      return "static text"
    case "JSXElement":
      return "child element"
    case "JSXFragment":
      return "fragment"
    case "JSXExpressionContainer":
      return "expression"
    case "JSXSpreadChild":
      return "spread child"
    default:
      return node.type ?? "unknown node"
  }
}

/**
 * `item.label` → "label". Everything else refuses, on the AST rather than on a
 * regex — `computed` alone rules out `item["label"]`, and anything that is not
 * a plain `Identifier.Identifier` pair is rejected by its node type.
 */
function readMemberKey(
  expr: BabelNode | undefined,
  itemVar: string,
): ExtractJsxInterpolationKeyResult {
  if (!expr) return { ok: false, reason: "Empty expression container" }
  if (expr.type === "JSXEmptyExpression") {
    return { ok: false, reason: "Empty expression container" }
  }
  if (expr.type === "Identifier") {
    if (expr.name === itemVar) {
      return {
        ok: false,
        reason: `Expression \`{${expr.name}}\` reads the entry itself; no single property to patch`,
      }
    }
    return {
      ok: false,
      reason: `Expression root \`${expr.name}\` does not match the map iteratee \`${itemVar}\``,
    }
  }
  if (expr.type !== "MemberExpression") {
    return {
      ok: false,
      reason: `Expression is a ${expr.type}, not a simple member access: LLM fallback required`,
    }
  }
  if (expr.computed === true) {
    return {
      ok: false,
      reason: "Computed member access (`item[…]`) is not supported by the deterministic lane",
    }
  }
  const object = expr.object
  const property = expr.property
  if (!object || !property || property.type !== "Identifier") {
    return { ok: false, reason: "Member access is not a plain `<root>.<key>` pair" }
  }
  if (object.type !== "Identifier") {
    // `item.title.text` — the object is itself a MemberExpression. The
    // applicator only patches a top-level property, so nesting refuses rather
    // than silently patching the wrong depth.
    return {
      ok: false,
      reason:
        "Expression accesses a nested property; deterministic lane only patches top-level fields",
    }
  }
  if (object.name !== itemVar) {
    return {
      ok: false,
      reason: `Expression root \`${object.name}\` does not match the map iteratee \`${itemVar}\``,
    }
  }
  return { ok: true, propertyKey: property.name as string }
}

export function extractJsxInterpolationKey(
  input: ExtractJsxInterpolationKeyInput,
): ExtractJsxInterpolationKeyResult {
  const { source, line, column, itemVar } = input

  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(itemVar)) {
    return {
      ok: false,
      reason: `Iteratee root \`${itemVar}\` is not a bare identifier`,
    }
  }

  const parsed = parseJsxModule(source)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }

  const target = findJsxElementAt(parsed.ast, line, column) as BabelNode | null
  if (!target) {
    return { ok: false, reason: `No JSX element found at ${line}:${column}` }
  }

  // "Significant" children, same rule as the Vue extractor: whitespace-only
  // JSXText is source indentation, not content.
  const significant = (target.children ?? []).filter((c) => {
    if (c.type === "JSXText") {
      return typeof (c as BabelNode).value === "string" && String((c as BabelNode).value).trim().length > 0
    }
    if (c.type === "JSXExpressionContainer") {
      return (c as BabelNode).expression?.type !== "JSXEmptyExpression"
    }
    return true
  }) as BabelNode[]

  if (significant.length === 0) {
    return { ok: false, reason: "Element has no significant slot content" }
  }
  if (significant.length > 1) {
    return {
      ok: false,
      reason: `Element has ${significant.length} significant children; ambiguous which one carries the iteration field`,
    }
  }
  const only = significant[0]
  if (only.type !== "JSXExpressionContainer") {
    return {
      ok: false,
      reason: `Slot content is ${describeChild(only)}, not an expression; "this row" needs a map-bound text expression`,
    }
  }
  return readMemberKey(only.expression, itemVar)
}
