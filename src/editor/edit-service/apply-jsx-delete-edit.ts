/**
 * Pure (filesystem-free) DeleteEdit applicator for React/JSX — the `.tsx`/`.jsx`
 * sibling of [apply-delete-edit.ts](./apply-delete-edit.ts). Given a JSX
 * module's source and the `(line, column)` of an element's opening tag, produce
 * a new source with that element removed.
 *
 * Coordinate convention: Babel 1-based line, 0-based column (see
 * apply-jsx-prop-edit.ts). Babel offsets are absolute, so the element's
 * `start`/`end` snip directly — no template-block shift.
 *
 * Refusal cases (deferring to the LLM lane / surfacing to the user):
 *   - The (line, column) doesn't match any JSX element.
 *   - The element is NOT nested inside another JSX element — i.e. it's the
 *     component's returned root, or sits directly inside a JSX expression
 *     container (`{cond && <X/>}`, `{items.map(…)}`). Snipping a returned root
 *     would leave an empty/invalid `return`; expression-embedded JSX is fuzzy
 *     enough to hand to the LLM. This mirrors the Vue applicator's "refuse to
 *     delete the template's only root" guard, generalized to JSX nesting.
 *
 * V1 simplification: snip the element's exact byte range without consuming
 * surrounding whitespace. HMR re-render / a prettier pass normalizes drift.
 */

import { parse } from "@babel/parser"

import {
  parseJsxModule,
  findJsxElementAt,
  walkJsx,
  type JsxNode,
} from "./resolve-jsx-target"

export interface ApplyJsxDeleteEditInput {
  /** Full `.tsx`/`.jsx` source text. */
  source: string
  /** Element opening-tag location — Babel 1-based line / 0-based column. */
  line: number
  column: number
}

export type ApplyJsxDeleteEditResult =
  | { ok: true; source: string }
  | { ok: false; reason: string }

type BabelNode = JsxNode

export function applyJsxDeleteEdit(input: ApplyJsxDeleteEditInput): ApplyJsxDeleteEditResult {
  const { source, line, column } = input

  const parsed = parseJsxModule(source)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const ast: BabelNode = parsed.ast

  const target = findJsxElementAt(ast, line, column)
  if (!target) {
    return { ok: false, reason: `No JSX element found at ${line}:${column}` }
  }

  // Refuse unless the target is a direct JSXElement/JSXFragment child of
  // another JSX container — i.e. it has a safe sibling-slot to remove from.
  // A non-nested target is a returned root (→ empty/invalid return) or lives
  // inside an expression (`{cond && <X/>}`) where a naive snip is unsafe.
  if (!hasJsxElementParent(ast, target)) {
    return {
      ok: false,
      reason:
        "Refusing to delete a root or expression-embedded JSX element: deleting it could leave an empty return or break the surrounding expression. Edit the source directly via chat.",
    }
  }

  if (typeof target.start !== "number" || typeof target.end !== "number") {
    return { ok: false, reason: "could not locate element byte range" }
  }

  const newSource = source.slice(0, target.start) + source.slice(target.end)

  // Post-splice parse check — same hygiene as the Vue applicator.
  try {
    parse(newSource, { sourceType: "module", plugins: ["jsx", "typescript"] })
  } catch (err) {
    return { ok: false, reason: `Post-splice JSX parse failed: ${(err as Error).message}` }
  }

  return { ok: true, source: newSource }
}

/** True when `target` is a direct child (in `.children`) of some JSXElement or
 *  JSXFragment in the tree. */
function hasJsxElementParent(ast: BabelNode, target: BabelNode): boolean {
  let parented = false
  walkJsx(ast, (node) => {
    if (parented) return
    if (node.type !== "JSXElement" && node.type !== "JSXFragment") return
    if ((node.children ?? []).some((c) => c === target)) parented = true
  })
  return parented
}
