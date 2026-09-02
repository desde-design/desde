/**
 * Pure (filesystem-free) UnwrapEdit applicator for React/JSX — the `.tsx`/`.jsx`
 * sibling of [apply-unwrap-edit.ts](./apply-unwrap-edit.ts). Given a JSX module's
 * source and the `(line, column)` of a wrapper element's opening tag, produce a
 * new source with the wrapper's tags removed and its children hoisted into the
 * wrapper's former position.
 *
 * `<div><span/><p/></div>` becomes `<span/><p/>`.
 *
 * Coordinate convention: Babel 1-based line / 0-based column (see
 * apply-jsx-prop-edit.ts). Babel offsets are absolute, so the wrapper's inner
 * content (between the opening tag's `>` and the closing tag's `<`) snips
 * directly — no template-block shift.
 *
 * Refusal cases:
 *   - The (line, column) doesn't match any JSX element.
 *   - The target is self-closing (`<div/>`) — no children to hoist; the user
 *     wants Delete, not Unwrap.
 *   - The target has no meaningful children (whitespace only) — same: Delete.
 *   - The post-splice result doesn't parse — e.g. unwrapping a returned root
 *     that has multiple element children produces adjacent top-level JSX
 *     (`return <a/><b/>`), which is invalid without a fragment. The post-splice
 *     parse guard surfaces this rather than writing broken source.
 *
 * V1 simplification: snip the wrapper's open/close tags without re-indenting the
 * promoted children (minor leading-whitespace drift); HMR re-render / a prettier
 * pass normalizes. Same trade-off as the JSX move/delete applicators.
 */

import { parse } from "@babel/parser"

import {
  parseJsxModule,
  findJsxElementAt,
  walkJsx,
  type JsxNode,
} from "./resolve-jsx-target"

export interface ApplyJsxUnwrapEditInput {
  /** Full `.tsx`/`.jsx` source text. */
  source: string
  /** Wrapper opening-tag location — Babel 1-based line / 0-based column. */
  line: number
  column: number
}

export type ApplyJsxUnwrapEditResult =
  | { ok: true; source: string }
  | { ok: false; reason: string }

/** Local extension of the shared node shape: unwrap also reads the closing
 *  tag's position. */
interface BabelNode extends JsxNode {
  closingElement?: BabelNode | null
}

export function applyJsxUnwrapEdit(
  input: ApplyJsxUnwrapEditInput,
): ApplyJsxUnwrapEditResult {
  const { source, line, column } = input

  const parsed = parseJsxModule(source)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const ast = parsed.ast as BabelNode

  const target = findJsxElementAt(ast, line, column) as BabelNode | null
  if (!target) {
    return { ok: false, reason: `No JSX element found at ${line}:${column}` }
  }

  // Self-closing → no closingElement, no children to hoist.
  if (!target.closingElement) {
    return {
      ok: false,
      reason: "Can't unwrap a self-closing element: it has no children. Use Delete.",
    }
  }

  const children = target.children ?? []
  const hasMeaningful = children.some((c) => {
    if (c.type === "JSXText") {
      return typeof c.value === "string" && c.value.trim().length > 0
    }
    return (
      c.type === "JSXElement" ||
      c.type === "JSXFragment" ||
      c.type === "JSXExpressionContainer"
    )
  })
  if (!hasMeaningful) {
    return {
      ok: false,
      reason: "Can't unwrap an empty element: there are no children to hoist. Use Delete.",
    }
  }

  // Context guard. When the wrapper is itself a JSX child (it has a JSX
  // element/fragment parent), its promoted content lands in JSX-children
  // position where text / `{expr}` / elements are all valid. But when the
  // wrapper sits in a JS-EXPRESSION position (a returned root, or inside a
  // `{…}` container), promoting non-element content silently changes meaning
  // and still parses: `() => <div>Save</div>` → `() => Save` (an identifier),
  // `return <div>{foo}</div>` → `return {foo}` (an object). The post-splice
  // parse can't catch these, so refuse unless the promoted content is exactly
  // one JSX element/fragment (which IS valid in an expression position).
  const meaningful = children.filter((c) => {
    if (c.type === "JSXText") return typeof c.value === "string" && c.value.trim().length > 0
    return (
      c.type === "JSXElement" ||
      c.type === "JSXFragment" ||
      c.type === "JSXExpressionContainer"
    )
  })
  const inExpressionPosition = !hasJsxElementParent(ast, target)
  const rootOnlyElement =
    meaningful.length === 1 &&
    (meaningful[0].type === "JSXElement" || meaningful[0].type === "JSXFragment")
      ? meaningful[0]
      : null
  if (inExpressionPosition && !rootOnlyElement) {
    return {
      ok: false,
      reason:
        "Can't unwrap here: this wrapper is a returned root (or inside a `{…}` expression), so promoting text or an expression would change the code's meaning. Wrap the children in a fragment, or edit via chat.",
    }
  }

  const openEnd = target.openingElement?.end
  const closeStart = target.closingElement?.start
  if (
    typeof target.start !== "number" ||
    typeof target.end !== "number" ||
    typeof openEnd !== "number" ||
    typeof closeStart !== "number"
  ) {
    return { ok: false, reason: "could not locate wrapper tag byte ranges" }
  }

  // In a JS-expression position, splice the single element's EXACT source —
  // not the whitespace-padded inner content. A preserved leading newline would
  // make `return <div>\n<span/>\n</div>` become `return \n<span/>`, which ASI
  // turns into `return;` + an orphan expression. In JSX-children position the
  // full inner content (whitespace included) is fine.
  const promoted =
    inExpressionPosition && rootOnlyElement
      ? source.slice(rootOnlyElement.start as number, rootOnlyElement.end as number)
      : source.slice(openEnd, closeStart)
  const newSource = source.slice(0, target.start) + promoted + source.slice(target.end)

  // Post-splice parse — catches adjacent-root JSX and other structural breaks.
  try {
    parse(newSource, { sourceType: "module", plugins: ["jsx", "typescript"] })
  } catch (err) {
    return {
      ok: false,
      reason: `Unwrapping here produces invalid JSX (${(err as Error).message}). The wrapper may be a single returned root with multiple children. Wrap them in a fragment first, or edit via chat.`,
    }
  }

  return { ok: true, source: newSource }
}

/** True when `target` is a direct child (in `.children`) of some JSXElement or
 *  JSXFragment — i.e. it sits in JSX-children position, not a JS-expression
 *  position (returned root / inside `{…}`). Mirrors apply-jsx-delete-edit. */
function hasJsxElementParent(ast: BabelNode, target: BabelNode): boolean {
  let parented = false
  walkJsx(ast, (node) => {
    if (parented) return
    if (node.type !== "JSXElement" && node.type !== "JSXFragment") return
    if ((node.children ?? []).some((c) => c === target)) parented = true
  })
  return parented
}
