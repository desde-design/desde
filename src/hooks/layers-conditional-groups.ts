/**
 * Pure merge step that folds source-derived `<template v-if>` / `v-for`
 * conditional groups into the layers panel's DOM-walked `OutlineNode` tree
 * (WS2 follow-up, tasks/edit-pipeline-rearchitecture.md § Deferred).
 *
 * Those `<template>` wrappers render no DOM element, so
 * `adapter.getStructure()`'s DOM walk can never surface them — the exact
 * gap `list-conditional-groups.ts` closes by listing groups straight from
 * the SFC template AST. This module is the shell-side counterpart: given
 * the DOM-walked tree and a per-file map of that server-side listing, it
 * synthesizes one extra "group" row per conditional/loop, wrapping the
 * member elements the DOM walk DID find as that row's children.
 *
 * No I/O here — `useEditorEditing.refreshLayers` owns fetching the
 * per-file listings (best-effort, `/api/editor/conditional-groups`) and
 * calls `mergeConditionalGroups` with the results.
 */

import type { ConditionalGroup } from "@/editor/edit-service/list-conditional-groups"
import type { OutlineNode, SourceLocation } from "@/types/bridge"
import { editorFetch } from "@/lib/editor-fetch"

/** Group listing for one file, as returned by the conditional-groups API. */
export interface FileConditionalGroups {
  /** 12-hex `data-desde-v` convention hash — threads onto the synthetic node's `editTarget`. */
  fileHash: string
  groups: ConditionalGroup[]
}

const GROUP_SELECTOR_PREFIX = "__desde-group__"

function locKey(file: string, line: number, column: number): string {
  return `${file}:${line}:${column}`
}

function groupNodeName(group: ConditionalGroup): string {
  const dir = group.directive === "for" ? "v-for" : "v-if"
  return group.expression ? `${dir}="${group.expression}"` : dir
}

function groupSelector(file: string, group: ConditionalGroup): string {
  return `${GROUP_SELECTOR_PREFIX}${file}:${group.head.line}:${group.head.column}`
}

function groupNodeId(file: string, group: ConditionalGroup): string {
  return `desde-group:${file}:${group.head.line}:${group.head.column}`
}

interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

function boundingUnion(nodes: OutlineNode[]): BoundingBox {
  if (nodes.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.width)
    maxY = Math.max(maxY, n.y + n.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

interface MemberEntry {
  file: string
  fileHash: string
  group: ConditionalGroup
}

/** Builds a flat `(file,line,column) → group` lookup across every fetched file. */
function buildMemberIndex(
  byFile: Map<string, FileConditionalGroups>,
): Map<string, MemberEntry> {
  const index = new Map<string, MemberEntry>()
  for (const [file, entry] of byFile) {
    for (const group of entry.groups) {
      for (const loc of group.memberLocs) {
        index.set(locKey(file, loc.line, loc.column), {
          file,
          fileHash: entry.fileHash,
          group,
        })
      }
    }
  }
  return index
}

function memberEntryFor(
  node: OutlineNode,
  memberIndex: Map<string, MemberEntry>,
): MemberEntry | undefined {
  const loc: SourceLocation | undefined = node.authoredAt ?? node.editTarget
  if (!loc) return undefined
  return memberIndex.get(locKey(loc.file, loc.line, loc.column))
}

function buildGroupNode(entry: MemberEntry, members: OutlineNode[]): OutlineNode {
  const { file, fileHash, group } = entry
  const bbox = boundingUnion(members)
  return {
    id: groupNodeId(file, group),
    name: groupNodeName(group),
    type: "element",
    selector: groupSelector(file, group),
    editTarget: {
      file,
      line: group.head.line,
      column: group.head.column,
      ...(fileHash ? { fileHash } : {}),
    },
    conditionalGroup: { directive: group.directive, expression: group.expression },
    x: bbox.x,
    y: bbox.y,
    width: bbox.width,
    height: bbox.height,
    children: members,
  }
}

/**
 * Replace every CONSECUTIVE run of `children` entries that match the same
 * group's `memberLocs` with one synthetic group node wrapping that run.
 * Non-matching children pass through unchanged. Returns the original array
 * reference when nothing matched (cheap no-op check for callers).
 */
function collapseConsecutiveGroups(
  children: OutlineNode[],
  memberIndex: Map<string, MemberEntry>,
): OutlineNode[] {
  let changed = false
  const result: OutlineNode[] = []
  let i = 0
  while (i < children.length) {
    const entry = memberEntryFor(children[i], memberIndex)
    if (!entry) {
      result.push(children[i])
      i++
      continue
    }
    const run: OutlineNode[] = [children[i]]
    let j = i + 1
    while (j < children.length) {
      const nextEntry = memberEntryFor(children[j], memberIndex)
      if (!nextEntry || nextEntry.group !== entry.group) break
      run.push(children[j])
      j++
    }
    result.push(buildGroupNode(entry, run))
    changed = true
    i = j
  }
  return changed ? result : children
}

function mergeNode(node: OutlineNode, memberIndex: Map<string, MemberEntry>): OutlineNode {
  if (!node.children || node.children.length === 0) return node
  const recursed = node.children.map((child) => mergeNode(child, memberIndex))
  // Reuse the original array reference when recursion changed nothing, so
  // `collapseConsecutiveGroups`'s own no-op check (and the caller's) can
  // detect "no change anywhere below this node" by identity instead of
  // deep-equality.
  const mergedChildren = recursed.every((child, i) => child === node.children![i])
    ? node.children
    : recursed
  const collapsed = collapseConsecutiveGroups(mergedChildren, memberIndex)
  if (collapsed === node.children) return node
  return { ...node, children: collapsed }
}

/**
 * Merge source-derived conditional/iteration groups into a DOM-walked
 * `OutlineNode` tree. Pure — no I/O, no framework/DOM dependency (plain
 * node-shape fixtures suffice for tests).
 *
 * Matching: a node is a group MEMBER when `(node.authoredAt ?? node.editTarget)`
 * has the same `(file, line, column)` as one of the group's `memberLocs`.
 * Bottom-up recursion means a nested group (deeper in the tree) is already
 * synthesized into its own single node before an ancestor level is
 * examined — so an outer group whose member is itself a nested
 * `<template>` head is matched against the ALREADY-BUILT inner synthetic
 * node when that nesting spans a real DOM boundary. (Same-level nesting —
 * an inner `<template>` with no intervening real element between it and
 * the outer wrapper — is a rare edge case not specially handled here.)
 *
 * Returns `roots` unchanged (same reference) when `byFile` is empty or no
 * group's members are found live in the tree.
 */
export function mergeConditionalGroups(
  roots: OutlineNode[],
  byFile: Map<string, FileConditionalGroups>,
): OutlineNode[] {
  if (byFile.size === 0) return roots
  const memberIndex = buildMemberIndex(byFile)
  if (memberIndex.size === 0) return roots
  const merged = roots.map((root) => mergeNode(root, memberIndex))
  return merged.every((node, i) => node === roots[i]) ? roots : merged
}

/**
 * Collects the distinct `.vue` files referenced by a DOM-walked tree's
 * `authoredAt`/`editTarget` locations — the fetch list for
 * `/api/editor/conditional-groups`. Non-`.vue` files (React JSX, etc.)
 * are excluded; the endpoint returns an empty group list for those anyway
 * (conditional groups are a Vue `<template>` concept).
 */
export function collectVueFiles(roots: OutlineNode[]): Set<string> {
  const files = new Set<string>()
  const visit = (node: OutlineNode): void => {
    const authoredFile = node.authoredAt?.file
    const editFile = node.editTarget?.file
    if (authoredFile?.endsWith(".vue")) files.add(authoredFile)
    if (editFile?.endsWith(".vue")) files.add(editFile)
    node.children?.forEach(visit)
  }
  roots.forEach(visit)
  return files
}

/** True for the non-resolving sentinel selector synthetic group rows carry. */
export function isGroupSelector(selector: string): boolean {
  return selector.startsWith(GROUP_SELECTOR_PREFIX)
}

function findNodeBySelector(roots: OutlineNode[], selector: string): OutlineNode | undefined {
  for (const node of roots) {
    if (node.selector === selector) return node
    if (node.children) {
      const found = findNodeBySelector(node.children, selector)
      if (found) return found
    }
  }
  return undefined
}

/**
 * A `__desde-group__…` selector never resolves via `document.querySelector` —
 * it's a sentinel, not a real selector — so dispatching it to
 * `selectBySelector` would just produce a harmless-but-useless
 * `ELEMENT_INSPECTION_UNRESOLVED`. Instead, resolve it to the group's
 * first child with a real selector (the row the user most likely means to
 * select). Returns `null` when the group node can't be found or has no
 * selectable child — callers should no-op in that case.
 */
export function findGroupFirstChildSelector(
  roots: OutlineNode[] | null,
  groupSel: string,
): string | null {
  if (!roots) return null
  const node = findNodeBySelector(roots, groupSel)
  const firstSelectable = node?.children?.find((child) => !!child.selector)
  return firstSelectable?.selector ?? null
}

/**
 * Best-effort fetch of `/api/editor/conditional-groups` for every `.vue`
 * file referenced by a layers tree. Failures (network error, non-200, a
 * file whose groups can't be parsed) are swallowed per-file — a missing
 * entry just means that file's `<template v-if>`/`v-for` wrappers won't
 * synthesize into group rows this refresh; the DOM-visible members still
 * render as ordinary rows. The one I/O-performing export in this otherwise
 * pure module — kept alongside its siblings so `useEditorEditing`'s
 * `refreshLayers` can call fetch + merge as one pipeline. See
 * {@link mergeConditionalGroups}.
 */
export async function fetchConditionalGroupsForFiles(
  files: string[],
): Promise<Map<string, FileConditionalGroups>> {
  const byFile = new Map<string, FileConditionalGroups>()
  await Promise.all(
    files.map(async (file) => {
      try {
        const res = await editorFetch(
          `/api/editor/conditional-groups?file=${encodeURIComponent(file)}`,
          { cache: "no-store" },
        )
        if (!res.ok) return
        const data = (await res.json()) as {
          ok?: boolean
          fileHash?: string
          groups?: ConditionalGroup[]
        }
        if (!data.ok || !Array.isArray(data.groups) || data.groups.length === 0) return
        byFile.set(file, { fileHash: data.fileHash ?? "", groups: data.groups })
      } catch {
        // Best-effort — see doc comment above.
      }
    }),
  )
  return byFile
}
