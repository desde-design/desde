/**
 * Density filter for the layers ("Structure") tree.
 *
 * The bridge's `getStructure()` walks every element in the document, so the
 * panel showed a row per component AND a row per DOM element. On a Vue +
 * Tailwind app that is mostly wrapper `<div>`s. Showing only components was
 * the opposite mistake: the elements a designer actually restyles are plain
 * DOM. This module is the middle ground, applied SHELL-side as a pure
 * `OutlineNode[] -> OutlineNode[]` transform.
 *
 * Shell-side, not bridge-side, deliberately. `getStructure()` has one caller,
 * so a filter here cannot regress anything else, and it keeps the bridge (and
 * its version-bump + rebuild ritual) out of a pure view preference.
 *
 * ## Why hiding a row is safe — and the defect that preceded this
 *
 * This filter is a VIEW concern. It has no say over source positions.
 *
 * What makes that true lives in `layers-panel.tsx`, not here: the panel's
 * move-index math (`parentByChildId`, `findEffectiveSlotParent`,
 * `collectSameFileDescendants`, and every `destIndex` computed from them)
 * reads the RAW tree (`rawRoots`), and a rendered row is resolved back to
 * its raw counterpart by `id` before any index is computed. So nothing this
 * filter hides can shift an index — the filtered tree is never counted.
 *
 * The first version of this filter did it the other way around: it refused
 * to hide any node carrying an `editTarget`, so that the panel's (then
 * rendered-tree) index math could never miscount. That protection was the
 * defect. The source-tag plugin stamps EVERY Vue SFC template element, so
 * every first-party element has an `editTarget` — including the pass-through
 * wrapper `<div>`s this filter exists to hide. The filter shipped inert: on
 * a real prototype it removed `<script>`/`<style>`, unstamped mount
 * wrappers, and unstamped third-party DOM, and nothing else.
 *
 * **Do not reintroduce an `editTarget` guard here as a "safety net."** It is
 * not one. The move-index invariant is owned by the panel's raw-tree math;
 * adding the guard back only reverts the filter to inert.
 *
 * Synthetic conditional-group rows (`conditionalGroup`) and loop members
 * (`iterationContext`) ARE still kept unconditionally: they are the rows
 * that carry structural meaning the DOM walk alone cannot show.
 *
 * ## Order: `mergeConditionalGroups` runs FIRST, this filter SECOND
 *
 * `useEditorEditing.refreshLayers`'s `layersRoots` memo merges conditional
 * groups into the RAW tree, then applies this filter to the merged tree.
 *
 * **The earlier order (filter, then merge) was the defect. Do not restore
 * it.** The merge matches a node by the `(file, line, column)` of
 * `authoredAt ?? editTarget`. A `<div v-if="…">` with a single child is a
 * stamped, single-child, non-semantic wrapper, which is exactly the shape
 * rule 3 elides. Filtering first deleted that node before the merge could
 * find it, so the group row was never built at the default density.
 *
 * The original argument for filter-first was that the merge collapses
 * CONSECUTIVE sibling runs, so filtering afterwards would build groups
 * against a shape that no longer exists. That confused two things. The
 * merge builds its groups ONCE, from the raw shape; filtering afterwards
 * cannot re-run the grouping, so there is nothing to invalidate. And
 * `isProtected` below already keeps every `conditionalGroup` row
 * unconditionally, which is the protection a merged tree needs. Filtering
 * first, by contrast, can DELETE the nodes the merge is about to look for.
 *
 * A group row's own CHILDREN still filter normally — `filterNode` recurses
 * before it consults `isProtected` — so wrappers inside a `v-for` body
 * still collapse.
 */

import type { OutlineNode } from "@/types/bridge"

/**
 * How much of the DOM tree the Structure panel shows.
 *
 * - `essentials` — the default. Rules 1-5: drop non-rendering tags, hoist
 *   invisible subtrees, and elide pass-through wrapper chains.
 * - `detailed` — rules 1-2 only. Every wrapper stays; only the tags that
 *   render nothing and the subtrees with no box are removed.
 * - `everything` — the raw tree, unfiltered.
 */
export type LayersDensity = "essentials" | "detailed" | "everything"

export const DEFAULT_LAYERS_DENSITY: LayersDensity = "essentials"

/** Every valid density, in the order the density menu offers them. */
export const LAYERS_DENSITIES: readonly LayersDensity[] = [
  "essentials",
  "detailed",
  "everything",
]

/**
 * Type guard for a value read back from storage or a URL. Anything that is
 * not one of the three densities is rejected, so a stale or hand-edited
 * value falls back to the default instead of rendering an empty tree.
 */
export function isLayersDensity(value: unknown): value is LayersDensity {
  return (
    typeof value === "string" &&
    (LAYERS_DENSITIES as readonly string[]).includes(value)
  )
}

/**
 * Rule 1a — tags that are NOT CONTENT. They render nothing, they are not
 * selectable, and there is nothing a designer can do to one from this
 * panel. Dropped at every density, `everything` excepted.
 */
const NEVER_CONTENT_TAGS = new Set([
  "script",
  "style",
  "link",
  "meta",
  "noscript",
])

/**
 * Rule 1b — tags that render no box but ARE real source elements: a `<br>`
 * is authored, selectable and deletable, and `<template>` is a Vue
 * structural element the user may want to reach.
 *
 * The call: they survive `detailed` and go only at `essentials`. `detailed`
 * means "show me every wrapper", so silently deleting a row the user can
 * legitimately act on would break that promise — and this filter used to
 * spare them only by accident, via the `editTarget` guard that made the
 * whole thing inert. `essentials` means "show me the structure I reason
 * about", where a line break is noise.
 */
const LAYOUT_ONLY_TAGS = new Set(["br", "wbr", "template"])

/**
 * Rule 4 — tags a designer reasons about by name, kept even when they are a
 * single-child pass-through. Only consulted for `type === "element"`: on a
 * component node `name` is the component's name, not a tag, and a component
 * named `Section` must not be matched against the `section` element here.
 */
const SEMANTIC_TAGS = new Set([
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "label",
  "form",
  "img",
  "svg",
  "video",
  "canvas",
  "iframe",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "nav",
  "header",
  "footer",
  "main",
  "aside",
  "section",
  "article",
  "dialog",
  "details",
  "summary",
])

/**
 * Rows kept unconditionally, checked BEFORE every drop rule so no rule —
 * including a future one — can hide them by accident: synthetic
 * conditional-group rows and loop members, the rows carrying structural
 * meaning the DOM walk cannot show. Deliberately NOT `editTarget`: every
 * stamped element has one, and protecting them made the filter inert (see
 * the header). Hiding a stamped row is safe because the panel's move-index
 * math reads the raw tree, never the filtered one.
 */
function isProtected(node: OutlineNode): boolean {
  return !!node.conditionalGroup || !!node.iterationContext
}

/** Rule 5 — a component root is always its own row. */
function isComponentRoot(node: OutlineNode): boolean {
  return node.type === "component"
}

function isNonRenderingTag(node: OutlineNode, elideWrappers: boolean): boolean {
  if (node.type !== "element") return false
  const tag = node.name.toLowerCase()
  if (NEVER_CONTENT_TAGS.has(tag)) return true
  return elideWrappers && LAYOUT_ONLY_TAGS.has(tag)
}

function isSemanticTag(node: OutlineNode): boolean {
  return node.type === "element" && SEMANTIC_TAGS.has(node.name.toLowerCase())
}

/**
 * Rule 2 — no box at all, or no selector to resolve. A zero-size node is
 * usually a layout artifact; a node with an empty selector renders as a
 * disabled row the user cannot click. Its CHILDREN are hoisted rather than
 * dropped: an absolutely-positioned child of a zero-size parent is still on
 * screen.
 */
function isInvisible(node: OutlineNode): boolean {
  return (node.width === 0 && node.height === 0) || node.selector === ""
}

/**
 * Filter one node. Returns the rows that stand in for it in its parent's
 * child list: `[]` when it is dropped, `[node]` when it is kept, and its
 * hoisted children when it dissolves.
 *
 * Bottom-up, which is what gives rule 3 its fixpoint for free: a chain of
 * pass-through wrappers collapses one level per return, so `A > B > C` with
 * A and B both pass-through yields `C` without a second pass.
 */
function filterNode(node: OutlineNode, elideWrappers: boolean): OutlineNode[] {
  const children = node.children
    ? filterNodeList(node.children, elideWrappers)
    : undefined

  if (!isProtected(node)) {
    // Rule 1 — drop outright, hoisting anything that did survive below.
    // These tags render no box of their own and in practice hold nothing
    // (a real `<template>` keeps its contents in `.content`, not
    // `.children`, and the rest are void or text-only). Hoisting rather
    // than returning `[]` costs nothing and keeps every drop rule uniform:
    // a hidden node's surviving children always get a row somewhere.
    // Split by density: never-content tags always go, real-but-boxless
    // source elements only at `essentials` (see the two sets above).
    if (isNonRenderingTag(node, elideWrappers)) return children ?? []
    // Rule 2 — dissolve, hoisting whatever survived below.
    if (isInvisible(node)) return children ?? []
    // Rule 3 — elide a pass-through wrapper (essentials only).
    //
    // Not when the single survivor is a synthetic conditional-group row.
    // Those rows now exist before this filter runs (the merge goes first),
    // and a group row resolves to no DOM element at all: its selector is a
    // `__desde-group__…` sentinel. Replacing a real, selectable, deletable
    // wrapper with one would delete the only row that can be clicked.
    if (
      elideWrappers &&
      node.type === "element" &&
      !isComponentRoot(node) &&
      !isSemanticTag(node) &&
      children?.length === 1 &&
      !children[0].conditionalGroup
    ) {
      return [children[0]]
    }
  }

  // Reuse the original node reference when recursion changed nothing below
  // it, so `filterNodeList`'s identity check can report "unchanged" for a
  // whole subtree and the caller's `useMemo` stays cheap.
  if (children === node.children) return [node]
  return [
    {
      ...node,
      children: children && children.length > 0 ? children : undefined,
    },
  ]
}

/** Returns the original array reference when no child changed. */
function filterNodeList(
  nodes: OutlineNode[],
  elideWrappers: boolean,
): OutlineNode[] {
  const result: OutlineNode[] = []
  let changed = false
  for (const node of nodes) {
    const replacement = filterNode(node, elideWrappers)
    if (replacement.length !== 1 || replacement[0] !== node) changed = true
    for (const entry of replacement) result.push(entry)
  }
  return changed ? result : nodes
}

/**
 * Apply a density level to a DOM-walked layers tree. Pure — no I/O, no DOM,
 * plain node-shape fixtures suffice for tests.
 *
 * Must run AFTER `mergeConditionalGroups`, not before. See the header's
 * "Order" section: filtering first deleted the `<div v-if>` wrappers the
 * merge matches on, so group rows were never built at the default density.
 *
 * Returns `roots` unchanged (same reference) for `everything`, and whenever
 * no node was removed.
 */
export function filterLayersByDensity(
  roots: OutlineNode[],
  density: LayersDensity,
): OutlineNode[] {
  if (density === "everything") return roots
  return filterNodeList(roots, density === "essentials")
}

function collectSelectors(nodes: OutlineNode[], into: Set<string>): void {
  for (const node of nodes) {
    if (node.selector) into.add(node.selector)
    if (node.children) collectSelectors(node.children, into)
  }
}

/** Path of ancestors from root down to (but excluding) the matching node. */
function findAncestorPath(
  nodes: OutlineNode[],
  selector: string,
  path: OutlineNode[],
): boolean {
  for (const node of nodes) {
    if (node.selector === selector) return true
    if (node.children && node.children.length > 0) {
      path.push(node)
      if (findAncestorPath(node.children, selector, path)) return true
      path.pop()
    }
  }
  return false
}

/**
 * Map a selection onto a row the panel is actually showing.
 *
 * Clicking an element in the prototype iframe can select a node this filter
 * hid, and the panel's `findAncestorIds` returns `[]` for a selector it
 * cannot find — nothing expands, nothing highlights, and the panel looks
 * broken. Click-in-iframe is the primary selection path, so that has to be
 * handled rather than tolerated.
 *
 * Returns `selector` itself when it is visible; otherwise the selector of the
 * nearest surviving ancestor, found by walking the RAW tree upward; otherwise
 * `null`.
 */
export function findVisibleSelector(
  visibleRoots: OutlineNode[],
  rawRoots: OutlineNode[] | null,
  selector: string,
): string | null {
  const visible = new Set<string>()
  collectSelectors(visibleRoots, visible)
  if (visible.has(selector)) return selector
  if (!rawRoots) return null

  const path: OutlineNode[] = []
  if (!findAncestorPath(rawRoots, selector, path)) return null
  for (let i = path.length - 1; i >= 0; i--) {
    const ancestor = path[i]
    if (ancestor.selector && visible.has(ancestor.selector)) {
      return ancestor.selector
    }
  }
  return null
}
