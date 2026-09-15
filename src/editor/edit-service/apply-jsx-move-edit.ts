/**
 * Pure (filesystem-free) move/reorder applicator for React/JSX — the
 * `.tsx`/`.jsx` sibling of [apply-move-edit.ts](./apply-move-edit.ts). Given a
 * JSX module's source, the `(line, column)` of a source element's opening tag,
 * a destination parent element + a final child index, produce a new source
 * with the element relocated.
 *
 * Coordinate convention: **Babel coords — 1-based line, 0-based column** (what
 * `jsx-source-tag-plugin.ts` stamps and the bridge surfaces as `editTarget`).
 * No template-block shift like the Vue lane needs — Babel offsets are absolute
 * into the source string, so `JSXElement.start`/`.end` splice directly.
 *
 * Same-file scope only (the handler enforces `destFile === file`). `destIndex`
 * is the FINAL 0-based position the element should occupy among the destination
 * parent's *element* children after the move; negative counts from the end
 * (-1 = append). Same-parent reorder, cross-parent move, and same-position
 * no-ops all route through here.
 *
 * V1 simplifications mirror the Vue applicator: snip the element's exact byte
 * range with no re-indentation (HMR re-render / a prettier pass normalizes any
 * drift), and only count JSXElement children for indexing (text / expression
 * containers / fragments don't count toward `destIndex`).
 */

import { parse } from "@babel/parser"

import {
  parseJsxModule,
  findJsxElementAt,
  walkJsx,
  type JsxNode,
} from "./resolve-jsx-target"
import { findGutterStart, readGutterBefore, readLineIndent } from "./template-whitespace"

export interface ApplyJsxMoveEditInput {
  /** Full `.tsx`/`.jsx` source text. */
  source: string
  /** Source element opening-tag location — Babel 1-based line / 0-based column. */
  sourceLine: number
  sourceColumn: number
  /** Destination parent opening-tag location — Babel 1-based line / 0-based column. */
  destParentLine: number
  destParentColumn: number
  /**
   * Final 0-based index the moved element should occupy among the destination
   * parent's JSXElement children. Negative counts from the end (-1 = append).
   * Not consulted when `anchor` is given.
   */
  destIndex: number
  /**
   * Sibling-relative destination: land immediately before or after the
   * element at this coordinate, which must be a JSXElement child of the
   * destination parent. Preferred over `destIndex` whenever the gesture named
   * a sibling — an index the caller counted over the children it could SEE is
   * wrong the moment the parent has a child it could not (on a Next.js App
   * Router page, a server-rendered sibling attributes to another file and
   * drops out of the caller's count). The AST has every child; naming the
   * sibling lets this applicator count.
   */
  anchor?: { line: number; column: number; placement: "before" | "after" }
}

export type ApplyJsxMoveEditResult =
  | { ok: true; source: string }
  | { ok: false; reason: string }

type BabelNode = JsxNode

export function applyJsxMoveEdit(input: ApplyJsxMoveEditInput): ApplyJsxMoveEditResult {
  const { source, sourceLine, sourceColumn, destParentLine, destParentColumn, destIndex } = input

  const parsed = parseJsxModule(source)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const ast: BabelNode = parsed.ast

  const sourceEl = findJsxElementAt(ast, sourceLine, sourceColumn)
  if (!sourceEl) {
    return { ok: false, reason: `No JSX element found at ${sourceLine}:${sourceColumn}` }
  }
  const destEl = findJsxElementAt(ast, destParentLine, destParentColumn)
  if (!destEl) {
    return {
      ok: false,
      reason: `No destination parent found at ${destParentLine}:${destParentColumn}`,
    }
  }

  if (sourceEl === destEl) {
    return { ok: false, reason: "Source element cannot be its own destination parent" }
  }
  // Refuse moving a source that has no JSX element/fragment parent — i.e. a
  // component's returned root (`return <div/>`) or expression-embedded JSX
  // (`{cond && <X/>}`). Snipping such a source can leave `return` with no
  // argument; Babel accepts the result via ASI (`return;`) so the post-splice
  // parse passes, but the component now returns undefined. Requiring a safe
  // sibling slot mirrors the delete applicator's guard.
  if (!hasJsxElementParent(ast, sourceEl)) {
    return {
      ok: false,
      reason:
        "Refusing to move a root or expression-embedded JSX element: moving it could leave an empty return or break the surrounding expression. Edit the source directly via chat.",
    }
  }
  // Cycle guard via byte-range containment: refuse moving an element into one
  // of its own descendants.
  if (
    typeof sourceEl.start === "number" &&
    typeof sourceEl.end === "number" &&
    typeof destEl.start === "number" &&
    typeof destEl.end === "number" &&
    destEl.start >= sourceEl.start &&
    destEl.end <= sourceEl.end
  ) {
    return {
      ok: false,
      reason: "Cannot move an element into one of its descendants (would create a cycle)",
    }
  }

  if (destEl.openingElement?.selfClosing) {
    return {
      ok: false,
      reason: "Destination element is self-closing and can't contain children",
    }
  }

  const destElementChildren = elementChildren(destEl)

  let finalIndex = destIndex
  if (input.anchor) {
    const { line, column, placement } = input.anchor
    const anchorEl = findJsxElementAt(ast, line, column)
    if (!anchorEl) {
      return { ok: false, reason: `No anchor element found at ${line}:${column}` }
    }
    // Position among the parent's children WITHOUT the source: that is the
    // list the move lands in, so the anchor's index there is the source's
    // final index (before) or one past it (after).
    const siblings = destElementChildren.filter((c) => c !== sourceEl)
    const anchorIndex = siblings.indexOf(anchorEl)
    if (anchorIndex < 0) {
      return {
        ok: false,
        reason: `The anchor element at ${line}:${column} is not a child of the destination parent`,
      }
    }
    finalIndex = placement === "before" ? anchorIndex : anchorIndex + 1
  }
  if (finalIndex < 0) finalIndex = destElementChildren.length + 1 + finalIndex
  if (finalIndex < 0) finalIndex = 0
  if (finalIndex > destElementChildren.length) finalIndex = destElementChildren.length

  const currentIndexInDest = destElementChildren.indexOf(sourceEl)
  const isSameParent = currentIndexInDest >= 0
  if (isSameParent && currentIndexInDest === finalIndex) {
    return { ok: false, reason: "Element is already at the requested position. No move needed." }
  }

  if (typeof sourceEl.start !== "number" || typeof sourceEl.end !== "number") {
    return { ok: false, reason: "could not locate source element byte range" }
  }
  const srcStart = sourceEl.start
  const srcEnd = sourceEl.end
  // The range actually removed extends back over the element's gutter (the
  // whitespace run before it, newline included), so the vacated position
  // leaves no blank line and the neighbours that become adjacent keep one
  // separator between them. Same unit of relocation as the Vue applicator;
  // see `findGutterStart`.
  const removeStart = findGutterStart(source, srcStart)

  // Insertion offset is keyed off the PRE-MOVE child list; if source is in the
  // same parent before finalIndex, removing it shifts later indices left, so
  // insert before pre-move children[finalIndex + 1]. (Mirrors apply-move-edit.)
  const preIndex =
    isSameParent && currentIndexInDest < finalIndex ? finalIndex + 1 : finalIndex

  const slot = computeInsertionSlot(source, destEl, destElementChildren, preIndex)
  if (!slot) {
    return { ok: false, reason: "Could not compute destination insertion offset" }
  }
  // The boundary checks below reason about the sibling's own position; the
  // splice itself lands at `slot.offset`, the start of that sibling's gutter.
  const insertOffset = slot.anchor
  if (insertOffset > srcStart && insertOffset < srcEnd) {
    return { ok: false, reason: "Destination position falls inside the source element" }
  }

  // Semantic-closure guard (WS2, tasks/edit-pipeline-rearchitecture.md): the
  // JSX analog of the Vue lane's "invisible <template v-if> wrapper" guard
  // (apply-move-edit.ts's `nearestStructuralTemplateWrapper`). A
  // JSXExpressionContainer — `{cond && <div/>}`, `{cond ? <A/> : <B/>}`,
  // `{items.map(item => <Row/>)}` — renders no DOM of its own, so moving an
  // element out of it silently drops the gating condition (or, for `.map`,
  // strands references to the callback's item-scoped variables — worse than
  // the Vue case, since the moved JSX can end up referencing an identifier
  // that no longer exists at the destination). Refuse when the destination
  // insertion point falls outside the nearest enclosing expression
  // container's byte range; moves that stay within it (reorder inside the
  // same `{…}`) are unaffected.
  const wrapper = nearestJsxExpressionContainer(ast, sourceEl)
  if (wrapper && typeof wrapper.start === "number" && typeof wrapper.end === "number") {
    // Both bounds strict: Babel ranges are half-open, so `wrapper.end` is
    // one past the closing `}` — an insertion there sits immediately AFTER
    // the container (outside it — codex WS2 P1, the `}{<footer/>` no-
    // whitespace case). Same at `wrapper.start` (before the `{`).
    // Legitimate inside insertions land strictly between the braces.
    if (insertOffset <= wrapper.start || insertOffset >= wrapper.end) {
      const nameNode = sourceEl.openingElement?.name as BabelNode | undefined
      const tagText =
        typeof nameNode?.start === "number" && typeof nameNode?.end === "number"
          ? source.slice(nameNode.start, nameNode.end)
          : "element"
      const { description, isIterationCallback } = describeJsxExpressionContainer(wrapper, source)
      const consequence = isIterationCallback
        ? "it would stop repeating per item, and item-scoped variables it references would become undefined"
        : "it would silently stop being conditional and render always"
      return {
        ok: false,
        reason: `Cannot move <${tagText}> out of its enclosing ${description} expression: ${consequence}. The expression renders no visible element of its own, so the ${isIterationCallback ? "iteration" : "condition"} would not travel with the element. Move the whole ${description} block instead, or restructure via chat.`,
      }
    }
  }

  const srcText = source.slice(srcStart, srcEnd)
  const newSource = spliceMove(source, removeStart, srcEnd, slot.offset, slot.separator + srcText)

  // Post-splice validation — byte-offset splices don't prove the result still
  // parses. A re-parse (errorRecovery off) turns an offset-arithmetic bug into
  // an upfront refusal instead of a broken file write.
  try {
    parse(newSource, { sourceType: "module", plugins: ["jsx", "typescript"] })
  } catch (err) {
    return { ok: false, reason: `Post-splice JSX parse failed: ${(err as Error).message}` }
  }

  return { ok: true, source: newSource }
}

/** True when `target` is a direct child (in `.children`) of some JSXElement or
 *  JSXFragment in the tree — i.e. it has a safe sibling slot to remove from. */
function hasJsxElementParent(ast: BabelNode, target: BabelNode): boolean {
  let parented = false
  walkJsx(ast, (node) => {
    if (parented) return
    if (node.type !== "JSXElement" && node.type !== "JSXFragment") return
    if ((node.children ?? []).some((c) => c === target)) parented = true
  })
  return parented
}

/** JSXElement children of an element (text / expression / fragments excluded). */
function elementChildren(el: BabelNode): BabelNode[] {
  return (el.children ?? []).filter((c) => c.type === "JSXElement")
}

/**
 * Nearest (innermost) `JSXExpressionContainer` ancestor of `target` —
 * `{cond && …}` / `{cond ? … : …}` / `{items.map(fn)}`. Mirrors
 * `nearestStructuralTemplateWrapper` in apply-move-edit.ts: only the nearest
 * container matters, since it's nested inside any further-out ones, so an
 * insertion offset inside the nearest container is transitively inside all
 * of its ancestor containers too.
 */
function nearestJsxExpressionContainer(ast: BabelNode, target: BabelNode): BabelNode | null {
  const path = findAncestorPath(ast, target)
  if (!path) return null
  // path includes `target` itself as the last entry — walk the ancestors
  // (everything before it) from innermost (end) to outermost (start).
  for (let i = path.length - 2; i >= 0; i--) {
    if (path[i].type === "JSXExpressionContainer") return path[i]
  }
  return null
}

/** Depth-first search that returns the root-to-`target` node path (inclusive
 *  of both ends), or null if `target` isn't reachable from `ast`. Same
 *  traversal shape as `walkJsx` but threads an explicit ancestor stack. */
function findAncestorPath(ast: BabelNode, target: BabelNode): BabelNode[] | null {
  const path: BabelNode[] = []
  function visit(node: BabelNode | null | undefined): boolean {
    if (!node || typeof node !== "object") return false
    path.push(node)
    if (node === target) return true
    for (const key in node) {
      if (key === "loc" || key === "start" || key === "end" || key === "type") continue
      const v = (node as Record<string, unknown>)[key]
      if (Array.isArray(v)) {
        for (const item of v) {
          if (visit(item as BabelNode)) return true
        }
      } else if (v && typeof v === "object" && typeof (v as BabelNode).type === "string") {
        if (visit(v as BabelNode)) return true
      }
    }
    path.pop()
    return false
  }
  return visit(ast) ? path : null
}

/** Human-readable description of a JSXExpressionContainer's gating
 *  expression for refusal messages, plus whether it's an iteration callback
 *  (`.map`/`.flatMap`/`.forEach`) — the JSX-specific hazard where the moved
 *  element may reference the callback's item-scoped parameters. */
function describeJsxExpressionContainer(
  container: BabelNode,
  source: string,
): { description: string; isIterationCallback: boolean } {
  const expr = (container as { expression?: BabelNode }).expression
  if (
    expr?.type === "LogicalExpression" &&
    typeof (expr as { left?: BabelNode }).left?.start === "number" &&
    typeof (expr as { left?: BabelNode }).left?.end === "number"
  ) {
    const left = (expr as { left: BabelNode }).left
    const cond = source.slice(left.start as number, left.end as number)
    return { description: `{${cond} && …}`, isIterationCallback: false }
  }
  if (
    expr?.type === "ConditionalExpression" &&
    typeof (expr as { test?: BabelNode }).test?.start === "number" &&
    typeof (expr as { test?: BabelNode }).test?.end === "number"
  ) {
    const test = (expr as { test: BabelNode }).test
    const cond = source.slice(test.start as number, test.end as number)
    return { description: `{${cond} ? … : …}`, isIterationCallback: false }
  }
  if (expr?.type === "CallExpression") {
    const callee = (expr as { callee?: BabelNode }).callee
    const methodName =
      callee?.type === "MemberExpression" &&
      (callee as { property?: BabelNode }).property?.type === "Identifier"
        ? ((callee as { property: { name?: string } }).property.name ?? undefined)
        : undefined
    const isIterationCallback = methodName ? ["map", "flatMap", "forEach"].includes(methodName) : false
    if (typeof callee?.start === "number" && typeof callee?.end === "number") {
      const calleeText = source.slice(callee.start, callee.end)
      return { description: `{${calleeText}(…)}`, isIterationCallback }
    }
  }
  return { description: "{…}", isIterationCallback: false }
}

interface InsertionSlot {
  /** The sibling's own start (or the append point) — what the boundary checks reason about. */
  anchor: number
  /** Where the bytes are spliced: the start of that sibling's gutter. */
  offset: number
  /** The whitespace written before the moved element so it takes the slot's indentation. */
  separator: string
}

/**
 * Where a child goes so it lands at element-child index `preIndex`
 * (pre-move), with the whitespace that makes it sit on its own line at the
 * right indentation. Mirrors `computeInsertionSlot` in apply-move-edit.ts.
 */
function computeInsertionSlot(
  source: string,
  dest: BabelNode,
  destElementChildren: BabelNode[],
  preIndex: number,
): InsertionSlot | null {
  if (preIndex < destElementChildren.length) {
    // Before the Nth child: splice at the START of its gutter and reuse that
    // gutter as the separator, so both neighbours end up separated as before.
    const target = destElementChildren[preIndex]
    if (typeof target.start !== "number") return null
    return {
      anchor: target.start,
      offset: findGutterStart(source, target.start),
      separator: readGutterBefore(source, target.start),
    }
  }
  if (destElementChildren.length > 0) {
    // Append after the last child, reusing its own leading separator.
    const last = destElementChildren[destElementChildren.length - 1]
    if (typeof last.start !== "number" || typeof last.end !== "number") return null
    return { anchor: last.end, offset: last.end, separator: readGutterBefore(source, last.start) }
  }
  // Empty parent: right after the opening tag's `>`. No sibling to copy a
  // separator from, so indent one step past the parent.
  const openEnd = dest.openingElement?.end
  if (typeof openEnd !== "number" || typeof dest.start !== "number") return null
  return { anchor: openEnd, offset: openEnd, separator: `\n${readLineIndent(source, dest.start)}  ` }
}

/** Atomic move splice — offsets resolved against the ORIGINAL source. Mirrors
 *  spliceMove in apply-move-edit.ts. */
function spliceMove(
  source: string,
  srcStart: number,
  srcEnd: number,
  insertOffset: number,
  srcText: string,
): string {
  if (insertOffset >= srcStart && insertOffset <= srcEnd) {
    return source
  }
  if (srcEnd <= insertOffset) {
    return (
      source.slice(0, srcStart) +
      source.slice(srcEnd, insertOffset) +
      srcText +
      source.slice(insertOffset)
    )
  }
  return (
    source.slice(0, insertOffset) +
    srcText +
    source.slice(insertOffset, srcStart) +
    source.slice(srcEnd)
  )
}
