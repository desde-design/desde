"use client"

import { memo, useEffect, useMemo, useRef, useState } from "react"
import {
  ChevronRight,
  ChevronsUpDown,
  GitBranch,
  ListTree,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react"
import type { OutlineNode } from "@/types/bridge"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ListRow } from "@/components/blocks"
import { cn } from "@/lib/utils"
import {
  DEFAULT_LAYERS_DENSITY,
  findVisibleSelector,
  type LayersDensity,
} from "@/hooks/layers-density-filter"
import { INSERT_CATALOG } from "./insert-catalog"
import { SectionHeader } from "./section-header"

/**
 * Reason a drag/drop attempt was refused. Surfaced for telemetry/inline
 * feedback without coupling LayersPanel to a toast system.
 */
export type LayersDropRefusal =
  | "no-source-location"
  | "no-parent-source-location"
  | "different-file"
  | "self-or-descendant"
  | "no-parent"
  /**
   * A row the panel rendered has no counterpart in the RAW tree, and it is
   * not a conditional-group row (the one shape that legitimately exists
   * only in the rendered tree, and that anchors on its members instead).
   *
   * Every move index is counted over the raw tree. Falling back to the
   * rendered node here would splice at an index counted off a tree that is
   * missing rows source still has — a silently wrong-position move, which
   * is unrecoverable. A refusal is recoverable, so an unmapped row refuses.
   */
  | "unmapped-row"

export interface LayersMovePayload {
  source: OutlineNode
  /** The destination parent node — the node the source will become a child of. */
  destParent: OutlineNode
  /** Final 0-based index in destParent's children list AFTER the move. */
  destIndex: number
}

/** Menu rows for the density control, in the order they are offered. */
const DENSITY_OPTIONS: { value: LayersDensity; label: string }[] = [
  { value: "essentials", label: "Essentials" },
  { value: "detailed", label: "Detailed" },
  { value: "everything", label: "Everything" },
]

interface LayersPanelProps {
  /**
   * Roots the panel renders — `getStructure()`'s tree after the caller has
   * applied the density filter and merged conditional groups. `null` while
   * the initial fetch is in flight.
   */
  roots: OutlineNode[] | null
  /**
   * The UNFILTERED tree, when the caller has one. Two consumers:
   *
   * 1. Mapping a selection the density filter hid back onto the nearest
   *    ancestor still on screen — see {@link findVisibleSelector}.
   * 2. **All drag/drop move-index math.** `parentByChildId`,
   *    `findEffectiveSlotParent` and `collectSameFileDescendants` walk THIS
   *    tree, and a dropped-on row is resolved back to its raw counterpart by
   *    `id` before any index is computed. A move's `destIndex` is a
   *    source-order position, and the filtered tree is missing rows source
   *    still has — counting rendered rows dispatched silently wrong moves.
   *
   * Omit it and both fall back to `roots` — correct only when `roots` IS the
   * unfiltered tree.
   */
  rawRoots?: OutlineNode[] | null
  /**
   * How much of the tree `roots` represents. Display only: the panel is a
   * pure renderer and never filters. Defaults to the filter's own default so
   * callers that don't offer the control still show a coherent menu state.
   */
  density?: LayersDensity
  /**
   * Density change handler. The control is rendered ONLY when this is
   * provided — a radio menu whose choice went nowhere would be a dead
   * control.
   */
  onDensityChange?: (density: LayersDensity) => void
  /** `selector` of the currently selected node (matches `OutlineNode.selector`). */
  selectedSelector: string | null
  /** Click handler — fires with the node's `selector` (the `targetId` per the bridge protocol). */
  onSelect: (selector: string) => void
  /**
   * Hover handler — fires with the node's `selector` on row enter and
   * `null` on row leave. Drives the iframe's non-committal preview overlay
   * via the adapter's `previewHighlight` method.
   */
  onHover?: (selector: string | null) => void
  /**
   * Move handler — fires when the user completes a valid drag/drop.
   * Caller is expected to translate this into a `MoveEdit` and dispatch
   * via the framework adapter. See {@link LayersMovePayload}.
   */
  onMove?: (payload: LayersMovePayload) => void
  /**
   * Optional: surface a reason when a drop was refused (no source location,
   * cross-file move, etc.). Used for inline UX hints; the panel itself
   * silently rejects invalid drops.
   */
  onMoveRefused?: (reason: LayersDropRefusal) => void
  /** Refresh callback — re-runs `getStructure()` on the adapter. */
  onRefresh: () => void
  /** True while a refresh is in flight. */
  refreshing: boolean
  /**
   * True when the structure fetch exhausted its retries and left `roots`
   * null. Distinguishes a hard load failure from the initial in-flight
   * state so the panel can offer a retry instead of an endless spinner.
   */
  error?: boolean
  /**
   * Right-click → "Detach component" handler. Fires with the node the
   * designer right-clicked. Caller is expected to translate into a
   * `DetachEdit` and dispatch via the framework adapter. The menu item
   * is shown only when the node looks detachable — see
   * {@link canDetachNode}.
   */
  onDetach?: (node: OutlineNode) => void
  /**
   * Right-click → "Delete" handler. Fires with the node the designer
   * right-clicked. Caller dispatches a `DeleteEdit`. The menu item
   * is shown only when the node has a editTarget — see
   * {@link canDeleteNode}.
   */
  onDelete?: (node: OutlineNode) => void
  /**
   * Right-click → "Insert child…" handler. Fires with the parent
   * node and a snippet from the {@link INSERT_CATALOG}. Caller
   * dispatches an `InsertEdit` appending the snippet as the parent's
   * last child. The submenu is shown only when the parent can hold
   * children (has editTarget) — see {@link canInsertIntoNode}.
   */
  onInsert?: (parentNode: OutlineNode, snippet: string) => void
  /**
   * Right-click → "Unwrap" handler. Dissolves the wrapper element,
   * hoisting its children up to its parent. Shown for non-text nodes
   * with a editTarget — see {@link canUnwrapNode}. Caller
   * dispatches an `UnwrapEdit`.
   */
  onUnwrap?: (node: OutlineNode) => void
  /**
   * Right-click → "Flatten conditional → …" handler. Collapses a v-if
   * chain down to a single chosen branch. V1 surfaces two choices in
   * the submenu: "Keep this branch" (branchToKeep=0, the v-if itself)
   * and "Keep else branch" (branchToKeep="else"). Multi-else-if chains
   * still buffer but the user must currently pick one of these two —
   * a richer chain-aware menu is V2 work pending OutlineNode carrying
   * directive metadata.
   */
  onFlattenConditional?: (
    node: OutlineNode,
    branchToKeep: number | "else",
  ) => void
}

/**
 * Whether the layers-panel context menu should offer "Insert child…"
 * for this node. Insert needs a editTarget on the parent so the
 * applicator can find the splice point.
 */
function canInsertIntoNode(node: OutlineNode): boolean {
  return !!node.editTarget
}

/**
 * Whether the layers-panel context menu should offer "Delete". Any
 * element with a editTarget can be deleted (the SFC applicator
 * itself refuses to delete the template's only root element).
 */
function canDeleteNode(node: OutlineNode): boolean {
  return !!node.editTarget
}

/**
 * Whether the layers-panel context menu should offer "Detach component"
 * for this node. Mirrors the inspector-panel's detach gating: detach is
 * for prototype-authored components (componentFile outside node_modules)
 * with a source location the edit service can rewrite.
 */
function canDetachNode(node: OutlineNode): boolean {
  return (
    node.type === "component" &&
    !!node.componentFile &&
    !node.componentFile.includes("node_modules") &&
    !!node.editTarget
  )
}

/**
 * Whether the layers-panel context menu should offer "Unwrap". The
 * applicator handles deeper refusals (self-closing tag, empty wrapper,
 * orphaned v-else sibling). UI just gates on the basics: an element
 * with a source location and at least one child.
 */
function canUnwrapNode(node: OutlineNode): boolean {
  return (
    node.type !== "text" &&
    !!node.editTarget &&
    Array.isArray(node.children) &&
    node.children.length > 0
  )
}

/**
 * Whether the layers-panel context menu should offer
 * "Flatten conditional → …". OutlineNode doesn't carry directive info
 * today, so we can't filter on "is a v-if root" precisely. V1 surfaces
 * the option on any element with a editTarget; the applicator
 * returns a clear refusal if the target isn't actually a v-if.
 */
function canFlattenConditionalNode(node: OutlineNode): boolean {
  return node.type !== "text" && !!node.editTarget
}

/**
 * The row's hover tooltip (native `title`). For an ordinary row this is
 * just the CSS selector — useful as-is for debugging.
 *
 * A synthetic conditional-group row (`node.conditionalGroup` set, see
 * `layers-conditional-groups.ts`) is different: its `selector` is the
 * `__desde-group__<file>:<line>:<col>` sentinel, an internal value that
 * never resolves via `document.querySelector` and reads as gibberish to a
 * person. Describe the row in the reader's own terms instead, from the
 * information the node actually carries: it represents a `v-if`/`v-else`
 * (or `v-for`) cluster (`node.conditionalGroup.directive`), and
 * `node.editTarget` names the source line the cluster starts at.
 */
function layerRowTitle(node: OutlineNode): string {
  if (node.conditionalGroup) {
    const kind = node.conditionalGroup.directive === "for" ? "Loop group" : "Conditional group"
    const loc = node.editTarget ? `${node.editTarget.file}:${node.editTarget.line}` : null
    return loc ? `${kind} · ${loc}` : kind
  }
  return node.selector || "(no selector)"
}

type DropPosition = "before" | "inside" | "after"

interface DragState {
  draggingId: string | null
  hoverTarget: { nodeId: string; position: DropPosition } | null
}

/**
 * Left-rail layers panel. Mirrors the prototype's component / element tree
 * the way Figma's Layers panel mirrors a frame. Click a row to drive the
 * iframe selection; the row corresponding to the iframe's current selection
 * is auto-expanded and highlighted. Drag a row up or down to reorder it
 * within its parent (or move it to a different parent in the same file).
 *
 * Drag-drop semantics (V2):
 * - Drop on the top quarter of a row → insert source BEFORE that row in its parent.
 * - Drop on the bottom quarter of a row → insert source AFTER that row.
 * - Drop on the middle half of a row (when the row itself has a `editTarget`)
 *   → nest source as the LAST child of that row.
 * - Same-file only (cross-file moves are future work — they require new prop wiring).
 * - Refuses drop on self or any descendant of the dragged node.
 * - Refuses if either the source or the destination parent lacks a
 *   `editTarget` (no `data-desde-src` mapping → can't rewrite source).
 *
 * Color coding:
 * - **Component** (`type === "component"`) — accent color (purple/violet).
 * - **Element** (raw DOM) — muted gray.
 * - **Text** — lighter gray, italic.
 */
function LayersPanelImpl({
  roots,
  rawRoots,
  density = DEFAULT_LAYERS_DENSITY,
  onDensityChange,
  selectedSelector,
  onSelect,
  onHover,
  onMove,
  onMoveRefused,
  onRefresh,
  refreshing,
  error = false,
  onDetach,
  onDelete,
  onInsert,
  onUnwrap,
  onFlattenConditional,
}: LayersPanelProps) {
  const [userToggled, setUserToggled] = useState<{
    expanded: Set<string>
    collapsed: Set<string>
  }>(() => ({ expanded: new Set(), collapsed: new Set() }))
  const [drag, setDrag] = useState<DragState>({ draggingId: null, hoverTarget: null })
  const selectedRowRef = useRef<HTMLButtonElement | null>(null)

  /**
   * The selection as a row THIS TREE contains.
   *
   * Clicking an element in the prototype iframe is the primary way a
   * selection arrives, and it can name an element the density filter hid.
   * `findAncestorIds` returns `[]` for a selector it can't find, so without
   * this the panel would expand nothing and highlight nothing — indis-
   * tinguishable from broken. Falls back to the nearest surviving ancestor.
   */
  const visibleSelectedSelector = useMemo(() => {
    if (!selectedSelector || !roots) return null
    return findVisibleSelector(roots, rawRoots ?? null, selectedSelector)
  }, [selectedSelector, roots, rawRoots])

  /**
   * True when the highlighted row is NOT the selection, only its nearest
   * visible ancestor standing in for it.
   *
   * The substitution above is silent by construction, and it used to be
   * harmless because the filter barely hid anything on a stamped app. Now
   * that it hides real wrapper chains, the Structure panel would routinely
   * highlight a different element than the Inspector and the selection HUD
   * are showing, with nothing on screen saying so. The badge on the row is
   * that signal; "Everything" is how the user reaches the real element.
   */
  const selectionIsSubstituted =
    !!selectedSelector &&
    !!visibleSelectedSelector &&
    visibleSelectedSelector !== selectedSelector

  const ancestorsOfSelected = useMemo(
    () =>
      visibleSelectedSelector && roots
        ? findAncestorIds(roots, visibleSelectedSelector)
        : [],
    [visibleSelectedSelector, roots],
  )

  const expanded = useMemo(() => {
    const next = new Set(userToggled.expanded)
    for (const id of ancestorsOfSelected) next.add(id)
    for (const id of userToggled.collapsed) next.delete(id)
    return next
  }, [userToggled, ancestorsOfSelected])

  // Index of node id → node, used by drag handlers to resolve source/parent
  // without re-walking the tree on every dragover. Rebuilt when roots change.
  const nodeIndex = useMemo(() => {
    const index = new Map<string, OutlineNode>()
    if (roots) {
      for (const root of roots) walkAndIndex(root, index)
    }
    return index
  }, [roots])

  // RAW-tree node id → node. Move-index math must read the raw tree: a
  // `destIndex` is a source-order position, and the density filter hides
  // rows source still has. The filter rebuilds nodes with `{...node,
  // children}` and preserves `id`, so a rendered row's id looks up its raw
  // counterpart directly. Falls back to `roots` when no raw tree was given.
  const rawNodeById = useMemo(() => {
    const index = new Map<string, OutlineNode>()
    const source = rawRoots ?? roots
    if (source) {
      for (const root of source) walkAndIndex(root, index)
    }
    return index
  }, [rawRoots, roots])

  // Child id → its parent OutlineNode — over the RAW tree, for the same
  // reason as `rawNodeById`. The slot-aware "walk up to find the effective
  // parent" lookup in drag handlers is O(depth) instead of an O(N) re-walk
  // on every dragover.
  const parentByChildId = useMemo(() => {
    const map = new Map<string, OutlineNode>()
    const source = rawRoots ?? roots
    if (source) {
      for (const root of source) walkAndIndexParents(root, map)
    }
    return map
  }, [rawRoots, roots])

  useEffect(() => {
    if (!visibleSelectedSelector) return
    const node = selectedRowRef.current
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "center", behavior: "smooth" })
    }
  }, [visibleSelectedSelector])

  const toggle = (id: string) => {
    setUserToggled((prev) => {
      const expandedNext = new Set(prev.expanded)
      const collapsedNext = new Set(prev.collapsed)
      const isCurrentlyExpanded =
        prev.expanded.has(id) ||
        (ancestorsOfSelected.includes(id) && !prev.collapsed.has(id))
      if (isCurrentlyExpanded) {
        expandedNext.delete(id)
        collapsedNext.add(id)
      } else {
        collapsedNext.delete(id)
        expandedNext.add(id)
      }
      return { expanded: expandedNext, collapsed: collapsedNext }
    })
  }

  const handleDragStart = (node: OutlineNode) => {
    console.log("[LayersPanel] dragStart", { id: node.id, name: node.name, selector: node.selector, hasEditTarget: !!node.editTarget, editTarget: node.editTarget })
    if (!node.editTarget) {
      onMoveRefused?.("no-source-location")
      return false
    }
    setDrag({ draggingId: node.id, hoverTarget: null })
    return true
  }

  const handleDragEnd = () => {
    setDrag({ draggingId: null, hoverTarget: null })
  }

  const handleDragOver = (
    target: OutlineNode,
    parentNode: OutlineNode | null,
    position: DropPosition,
  ): boolean => {
    if (!drag.draggingId) return false
    if (drag.draggingId === target.id) return false
    const draggingNode = nodeIndex.get(drag.draggingId)
    if (!draggingNode || !draggingNode.editTarget) return false

    // Slot-aware destination resolution. For position="inside" the target
    // IS the destination — its file must match the source's. For
    // before/after we look at TARGET'S file (not parentNode's): in Vue
    // slot rendering the rendered DOM parent (e.g. EntityFormBlock's
    // internal wrapper div) lives in a different SFC than the slot
    // content that renders inside it (KInputs authored at the consumer
    // site). The authored parent — the one the applicator will splice
    // into — is found by walking UP from the target until we hit an
    // ancestor in the same file as the source. That ancestor is the
    // "effective parent" used by handleDrop.
    let refusal: LayersDropRefusal | null = null
    if (position === "inside") {
      if (!target.editTarget) refusal = "no-parent-source-location"
      else if (draggingNode.editTarget.file !== target.editTarget.file) refusal = "different-file"
      else if (isDescendant(draggingNode, target.id)) refusal = "self-or-descendant"
    } else {
      const rawTarget = resolveRawNode(target, rawNodeById)
      if (!target.editTarget) refusal = "no-parent-source-location"
      else if (draggingNode.editTarget.file !== target.editTarget.file) refusal = "different-file"
      else if (isDescendant(draggingNode, target.id)) refusal = "self-or-descendant"
      else if (!rawTarget) refusal = "unmapped-row"
      else if (
        !findEffectiveSlotParent(
          rawTarget,
          draggingNode.editTarget.file,
          parentByChildId,
        )
      ) {
        // Target is in the right file but no same-file ancestor exists
        // (would only happen for root-SFC native elements with no parent
        // — extremely unusual; refuse rather than guess).
        refusal = "no-parent"
      }
    }

    if (refusal) {
      // Only re-fire on transition so we don't spam the status banner every
      // frame the cursor is over the rejected row. Track via hoverTarget's
      // "rejected" sentinel.
      const rejectedKey = `${target.id}:${position}:refused`
      if (drag.hoverTarget?.nodeId !== rejectedKey) {
        console.log("[LayersPanel] dragOver refused", { targetName: target.name, parentName: parentNode?.name, position, refusal })
        onMoveRefused?.(refusal)
        setDrag((prev) => ({ ...prev, hoverTarget: { nodeId: rejectedKey, position } }))
      }
      return false
    }

    if (drag.hoverTarget?.nodeId !== target.id || drag.hoverTarget.position !== position) {
      console.log("[LayersPanel] dragOver accepted", { targetName: target.name, position })
      setDrag((prev) => ({ ...prev, hoverTarget: { nodeId: target.id, position } }))
    }
    return true
  }

  const handleDragLeave = (targetId: string) => {
    setDrag((prev) =>
      prev.hoverTarget?.nodeId === targetId
        ? { ...prev, hoverTarget: null }
        : prev,
    )
  }

  const handleDrop = (
    target: OutlineNode,
    parentNode: OutlineNode | null,
    position: DropPosition,
  ) => {
    console.log("[LayersPanel] drop", { targetId: target.id, targetName: target.name, parentId: parentNode?.id, parentName: parentNode?.name, position, draggingId: drag.draggingId })
    const draggingId = drag.draggingId
    setDrag({ draggingId: null, hoverTarget: null })
    if (!draggingId) return
    const draggingNode = nodeIndex.get(draggingId)
    if (!draggingNode) return
    if (!draggingNode.editTarget) {
      onMoveRefused?.("no-source-location")
      return
    }
    if (!target.editTarget) {
      onMoveRefused?.("no-parent-source-location")
      return
    }
    if (draggingNode.editTarget.file !== target.editTarget.file) {
      onMoveRefused?.("different-file")
      return
    }
    if (draggingId === target.id || isDescendant(draggingNode, target.id)) {
      onMoveRefused?.("self-or-descendant")
      return
    }

    // Everything from here down is INDEX MATH, and index math reads the RAW
    // tree only. A destIndex is a source-order position; the density filter
    // hides rows source still has, so counting rendered rows dispatches a
    // silently wrong-position move. The refusals above are the rendered
    // tree's business; the indices below are the raw tree's.
    //
    // `resolveRawNode` returns null when a rendered row has no raw
    // counterpart and is not a conditional-group row. Refuse rather than
    // fall back to the rendered node — see its doc comment.
    const rawSource = resolveRawNode(draggingNode, rawNodeById)
    if (!rawSource) {
      onMoveRefused?.("unmapped-row")
      return
    }

    // "inside" → append source as the LAST child of target (target IS
    // the dest parent), counting the RAW child list. Same off-by-one for
    // same-direct-parent reorder.
    if (position === "inside") {
      const rawTarget = resolveRawNode(target, rawNodeById)
      if (!rawTarget) {
        onMoveRefused?.("unmapped-row")
        return
      }
      const children = rawTarget.children ?? []
      const sourceIndex = children.findIndex((c) => c.id === draggingNode.id)
      let destIndex = children.length
      if (sourceIndex >= 0) destIndex -= 1
      onMove?.({ source: rawSource, destParent: rawTarget, destIndex })
      return
    }

    // before/after: find the effective parent (the nearest RAW-tree ancestor
    // of target whose editTarget is in the same SFC as the source). This is
    // the slot provider in Vue's slot model — the file where target was
    // authored as a child, NOT the rendered DOM parent (which may live
    // in a different SFC's template).
    const rawDropTarget = resolveRawNode(target, rawNodeById)
    if (!rawDropTarget) {
      onMoveRefused?.("unmapped-row")
      return
    }
    const effectiveParent = findEffectiveSlotParent(
      rawDropTarget,
      draggingNode.editTarget.file,
      parentByChildId,
    )
    if (!effectiveParent) {
      onMoveRefused?.("no-parent")
      return
    }

    // Enumerate the effective parent's same-file RAW descendants (its
    // source-authored children, including any inside intervening
    // wrapper components from a different SFC). Order is DOM order,
    // which equals source-write order for slot content.
    const sameFileDescendants = collectSameFileDescendants(
      effectiveParent,
      draggingNode.editTarget.file,
    )
    const targetIndex = indexInSameFileList(
      sameFileDescendants,
      target,
      position === "after" ? "last" : "first",
    )
    if (targetIndex < 0) {
      onMoveRefused?.("no-parent")
      return
    }
    const sourceIndex = indexInSameFileList(
      sameFileDescendants,
      draggingNode,
      "first",
    )
    const isSameParentReorder = sourceIndex >= 0
    // The applicator expects the FINAL post-move index. When source and
    // drop target share the same effective parent AND source currently
    // sits BEFORE the target, removing source first shifts the target up
    // by 1, so we subtract 1 from the naive drop-position index.
    let destIndex = position === "before" ? targetIndex : targetIndex + 1
    if (isSameParentReorder && sourceIndex < targetIndex) {
      destIndex -= 1
    }
    onMove?.({ source: rawSource, destParent: effectiveParent, destIndex })
  }

  return (
    <aside
      aria-label="Editor layers"
      className="flex h-full w-full min-h-0 flex-col px-3"
    >
      {/* No horizontal padding of its own: the panel root carries the rail
          gutter, and a second `px-3` here put this header at 24px while the
          component header opposite it sits at 12px. */}
      <div className="pt-1 pb-1">
        <SectionHeader
          variant="panel"
          title="Structure"
          action={
            <div className="flex items-center gap-0.5">
              {onDensityChange ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Choose how much detail the structure shows"
                    >
                      <ListTree aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuRadioGroup
                      value={density}
                      onValueChange={(value) =>
                        onDensityChange(value as LayersDensity)
                      }
                    >
                      {DENSITY_OPTIONS.map((option) => (
                        <DropdownMenuRadioItem
                          key={option.value}
                          value={option.value}
                          className="text-xs"
                        >
                          {option.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onRefresh}
                disabled={refreshing}
                aria-label="Refresh layers"
              >
                <RefreshCw
                  className={cn(refreshing && "animate-spin")}
                  aria-hidden="true"
                />
              </Button>
            </div>
          }
        />
      </div>
      <ScrollArea className="flex-1">
        <div className="px-1 pb-2">
          {roots === null && error ? (
            <div className="flex flex-col items-center gap-2 px-3 py-6 text-center">
              <p className="text-xs text-muted-foreground">
                Couldn&rsquo;t load the layer tree.
              </p>
              <Button
                variant="outline"
                size="xs"
                onClick={onRefresh}
                disabled={refreshing}
              >
                <RefreshCw
                  className={cn("h-3.5 w-3.5", refreshing && "animate-spin")}
                  aria-hidden="true"
                />
                Retry
              </Button>
            </div>
          ) : roots === null ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              Loading layers…
            </p>
          ) : roots.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              No elements detected.
            </p>
          ) : (
            <TooltipProvider delayDuration={200}>
            <ul
              role="tree"
              className="space-y-px"
              onMouseLeave={() => onHover?.(null)}
            >
              {roots.map((node) => (
                <LayerNode
                  key={node.id}
                  node={node}
                  parentNode={null}
                  depth={0}
                  expanded={expanded}
                  onToggle={toggle}
                  selectedSelector={visibleSelectedSelector}
                  selectionIsSubstituted={selectionIsSubstituted}
                  onSelect={onSelect}
                  onHover={onHover}
                  selectedRowRef={selectedRowRef}
                  drag={drag}
                  draggable={!!onMove}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onDetach={onDetach}
                  onDelete={onDelete}
                  onInsert={onInsert}
                  onUnwrap={onUnwrap}
                  onFlattenConditional={onFlattenConditional}
                />
              ))}
            </ul>
            </TooltipProvider>
          )}
        </div>
      </ScrollArea>
    </aside>
  )
}

/**
 * Memoized. The right rail re-renders on every editor-surface render —
 * including one per streamed chat token — but this panel's props are the
 * layers state plus `useEditorEditing`'s useCallback-stable handlers, so
 * they change only when the tree, the selection, or the refresh state does.
 * Without memo a long streamed reply re-rendered this 1,000-line tree once
 * per commit.
 */
export const LayersPanel = memo(LayersPanelImpl)
LayersPanel.displayName = "LayersPanel"

interface LayerNodeProps {
  node: OutlineNode
  /** The parent OutlineNode in the tree, or null for roots. Drag/drop uses
   *  this to resolve insertion index when the user drops on this row. */
  parentNode: OutlineNode | null
  depth: number
  expanded: Set<string>
  onToggle: (id: string) => void
  selectedSelector: string | null
  /**
   * True when `selectedSelector` is a stand-in: the real selection is a
   * descendant the density filter hid. The highlighted row renders a badge
   * saying so instead of claiming to be the selection.
   */
  selectionIsSubstituted: boolean
  onSelect: (selector: string) => void
  onHover?: (selector: string | null) => void
  selectedRowRef: React.MutableRefObject<HTMLButtonElement | null>
  drag: DragState
  draggable: boolean
  onDragStart: (node: OutlineNode) => boolean
  onDragEnd: () => void
  onDragOver: (
    target: OutlineNode,
    parentNode: OutlineNode | null,
    position: DropPosition,
  ) => boolean
  onDragLeave: (targetId: string) => void
  onDrop: (
    target: OutlineNode,
    parentNode: OutlineNode | null,
    position: DropPosition,
  ) => void
  onDetach?: (node: OutlineNode) => void
  onDelete?: (node: OutlineNode) => void
  onInsert?: (parentNode: OutlineNode, snippet: string) => void
  onUnwrap?: (node: OutlineNode) => void
  onFlattenConditional?: (node: OutlineNode, branchToKeep: number | "else") => void
}

function LayerNode({
  node,
  parentNode,
  depth,
  expanded,
  onToggle,
  selectedSelector,
  selectionIsSubstituted,
  onSelect,
  onHover,
  selectedRowRef,
  drag,
  draggable,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  onDetach,
  onDelete,
  onInsert,
  onUnwrap,
  onFlattenConditional,
}: LayerNodeProps) {
  const hasChildren = !!node.children && node.children.length > 0
  const isExpanded = expanded.has(node.id)
  const isSelected = !!node.selector && node.selector === selectedSelector
  const indent = depth * 12 + 6
  const isDragging = drag.draggingId === node.id
  const showInsertionBefore =
    drag.hoverTarget?.nodeId === node.id && drag.hoverTarget.position === "before"
  const showInsertionAfter =
    drag.hoverTarget?.nodeId === node.id && drag.hoverTarget.position === "after"
  const showInsertionInside =
    drag.hoverTarget?.nodeId === node.id && drag.hoverTarget.position === "inside"

  const colorClass =
    node.type === "component"
      ? "text-component"
      : node.type === "text"
        ? "italic text-muted-foreground/80"
        : "text-muted-foreground"

  // Right-click → context menu with the actions available for this node.
  // V1 offers "Detach component" for prototype-authored components,
  // "Delete" for any source-tagged element, and "Insert child…" for any
  // source-tagged parent. Library components without editTarget get
  // no menu — falls through to native browser menu.
  const detachAvailable = !!onDetach && canDetachNode(node)
  const deleteAvailable = !!onDelete && canDeleteNode(node)
  const insertAvailable = !!onInsert && canInsertIntoNode(node)
  const unwrapAvailable = !!onUnwrap && canUnwrapNode(node)
  const flattenAvailable =
    !!onFlattenConditional && canFlattenConditionalNode(node)
  const showContextMenu =
    detachAvailable ||
    deleteAvailable ||
    insertAvailable ||
    unwrapAvailable ||
    flattenAvailable

  const rowButton = (
    <ListRow
      ref={isSelected ? selectedRowRef : undefined}
      density="dense"
      selected={isSelected}
      // Keep the DOM `draggable` attribute true whenever drag is wired
      // at all. We let `handleDragStart` be the gate — if the row lacks
      // `editTarget` it fires `onMoveRefused("no-source-location")` and
      // returns false, which we then translate into `e.preventDefault()`.
      // Without this, the browser silently refuses to initiate the drag
      // and the user sees no feedback at all.
      draggable={draggable}
      onClick={() => {
        if (node.selector) onSelect(node.selector)
      }}
      onMouseEnter={() => {
        // Synthetic conditional-group rows carry a sentinel selector that
        // is not valid CSS (contains `/` and `:` from the file path) — the
        // bridge's querySelector would throw. No DOM node exists to
        // highlight anyway; hover-preview is skipped for them.
        if (node.selector && !node.conditionalGroup) onHover?.(node.selector)
      }}
      onDragStart={(e) => {
        if (!draggable) return
        const ok = onDragStart(node)
        if (!ok) {
          e.preventDefault()
          return
        }
        e.dataTransfer.effectAllowed = "move"
        // Required for Firefox to actually fire dragover events.
        e.dataTransfer.setData("text/plain", node.id)
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        const position = computeDropPosition(e.currentTarget, e.clientY, node)
        const accepted = onDragOver(node, parentNode, position)
        if (accepted) {
          e.preventDefault()
          e.dataTransfer.dropEffect = "move"
        }
      }}
      onDragLeave={() => onDragLeave(node.id)}
      onDrop={(e) => {
        e.preventDefault()
        const position = computeDropPosition(e.currentTarget, e.clientY, node)
        onDrop(node, parentNode, position)
      }}
      disabled={!node.selector}
      className={cn(
        // Tighter than `dense`'s own py-1, and here only: a tree is many short
        // rows read as one structure, where the eight other dense lists are
        // lists of separate things and want the breathing room.
        "py-0.5 transition-colors",
        isDragging && "opacity-40",
        showInsertionInside && "ring-2 ring-inset ring-component",
      )}
      style={{ paddingLeft: indent }}
      title={layerRowTitle(node)}
    >
      {hasChildren ? (
        <span
          role="button"
          aria-label={isExpanded ? "Collapse" : "Expand"}
          onClick={(e) => {
            e.stopPropagation()
            onToggle(node.id)
          }}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-muted"
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 transition-transform",
              isExpanded && "rotate-90",
            )}
            aria-hidden="true"
          />
        </span>
      ) : (
        <span className="h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      {node.conditionalGroup ? (
        <GitBranch
          className="h-3 w-3 shrink-0 text-muted-foreground/70"
          aria-hidden="true"
        />
      ) : null}
      <span className={cn("truncate", colorClass)}>{node.name}</span>
      {isSelected && selectionIsSubstituted ? (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* h-4 keeps the tree row's height stable: Badge's own h-5 is
                taller than a dense row's content box. */}
            <Badge
              variant="outline"
              className="ml-1 h-4 shrink-0 px-1.5"
              data-testid="layers-substituted-selection"
            >
              Stands in
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            The selected element is hidden at this detail level. This row is
            its nearest visible parent. Choose Everything to show the element
            itself.
          </TooltipContent>
        </Tooltip>
      ) : null}
      {node.packageName ? (
        <span className="ml-auto truncate text-2xs text-muted-foreground/60">
          {node.packageName}
        </span>
      ) : null}
    </ListRow>
  )

  return (
    <li
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={hasChildren ? isExpanded : undefined}
      className="relative"
    >
      {showInsertionBefore ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded bg-component"
        />
      ) : null}
      {showContextMenu ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{rowButton}</ContextMenuTrigger>
          <ContextMenuContent>
            {insertAvailable ? (
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  Insert child…
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="max-h-[60vh] overflow-y-auto">
                  {INSERT_CATALOG.map((group, groupIdx) => (
                    <div key={group.label}>
                      {groupIdx > 0 ? <ContextMenuSeparator /> : null}
                      <ContextMenuLabel>{group.label}</ContextMenuLabel>
                      {group.entries.map((entry) => (
                        <ContextMenuItem
                          key={entry.id}
                          onSelect={() => onInsert?.(node, entry.snippet)}
                        >
                          <span className="text-xs">{entry.label}</span>
                        </ContextMenuItem>
                      ))}
                    </div>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
            ) : null}
            {unwrapAvailable ? (
              <ContextMenuItem onSelect={() => onUnwrap?.(node)}>
                <ChevronsUpDown className="h-3.5 w-3.5" aria-hidden="true" />
                Unwrap
              </ContextMenuItem>
            ) : null}
            {flattenAvailable ? (
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
                  Flatten conditional…
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <ContextMenuItem
                    onSelect={() => onFlattenConditional?.(node, 0)}
                  >
                    Keep this branch (v-if)
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => onFlattenConditional?.(node, "else")}
                  >
                    Keep else branch
                  </ContextMenuItem>
                </ContextMenuSubContent>
              </ContextMenuSub>
            ) : null}
            {detachAvailable ? (
              <ContextMenuItem onSelect={() => onDetach?.(node)}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                Detach component
              </ContextMenuItem>
            ) : null}
            {deleteAvailable ? (
              <ContextMenuItem
                variant="destructive"
                onSelect={() => onDelete?.(node)}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                Delete
              </ContextMenuItem>
            ) : null}
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        rowButton
      )}
      {showInsertionAfter ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-1 bottom-0 h-0.5 rounded bg-component"
        />
      ) : null}
      {hasChildren && isExpanded ? (
        <ul role="group" className="space-y-px">
          {node.children!.map((child) => (
            <LayerNode
              key={child.id}
              node={child}
              parentNode={node}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              selectedSelector={selectedSelector}
              selectionIsSubstituted={selectionIsSubstituted}
              onSelect={onSelect}
              onHover={onHover}
              selectedRowRef={selectedRowRef}
              drag={drag}
              draggable={draggable}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onDetach={onDetach}
              onDelete={onDelete}
              onInsert={onInsert}
              onUnwrap={onUnwrap}
              onFlattenConditional={onFlattenConditional}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

function findAncestorIds(roots: OutlineNode[], selectedSelector: string): string[] {
  const path: string[] = []

  function walk(nodes: OutlineNode[]): boolean {
    for (const node of nodes) {
      if (node.selector === selectedSelector) {
        return true
      }
      if (node.children && node.children.length > 0) {
        path.push(node.id)
        if (walk(node.children)) return true
        path.pop()
      }
    }
    return false
  }

  walk(roots)
  return path
}

function walkAndIndex(node: OutlineNode, index: Map<string, OutlineNode>): void {
  index.set(node.id, node)
  if (node.children) {
    for (const child of node.children) walkAndIndex(child, index)
  }
}

function walkAndIndexParents(
  node: OutlineNode,
  parentByChildId: Map<string, OutlineNode>,
): void {
  if (node.children) {
    for (const child of node.children) {
      parentByChildId.set(child.id, node)
      walkAndIndexParents(child, parentByChildId)
    }
  }
}

/**
 * Resolve a rendered row to the node the RAW tree knows for it. Every move
 * index is counted over the raw tree, so this is the gate between the two.
 *
 * Ids survive the density filter (it rebuilds nodes with `{...node,
 * children}` and never re-mints an id), so this is a direct lookup for
 * every real row. The one rendered-only shape is the synthetic
 * conditional-group row `mergeConditionalGroups` mints — it exists in no
 * raw tree, so it deliberately anchors on the first of its member children
 * the raw tree does know (members are real DOM-walked nodes and share the
 * group's parent).
 *
 * **Returns `null` for anything else that is missing from the raw index,
 * and the caller must REFUSE the move.** It must not fall back to the
 * rendered node: an index counted off the filtered tree is missing rows
 * source still has, which splices the move at the wrong position and says
 * nothing. A refused move is recoverable; a wrong-position move is not.
 */
function resolveRawNode(
  node: OutlineNode,
  rawNodeById: Map<string, OutlineNode>,
): OutlineNode | null {
  const own = rawNodeById.get(node.id)
  if (own) return own
  if (!node.conditionalGroup) return null
  for (const child of node.children ?? []) {
    const raw = rawNodeById.get(child.id)
    if (raw) return raw
  }
  return null
}

/**
 * Index of `node` in a raw same-file descendant list. Real rows are found by
 * id. A synthetic conditional-group row is not in any raw list, so it stands
 * where its members stand: `first` (drops BEFORE the group) resolves to the
 * first member's index, `last` (drops AFTER it) to the last member's — for a
 * v-if chain only one branch is rendered so the two coincide; for a v-for
 * group they span the rendered repetitions.
 */
function indexInSameFileList(
  list: OutlineNode[],
  node: OutlineNode,
  pick: "first" | "last",
): number {
  const own = list.findIndex((c) => c.id === node.id)
  if (own >= 0 || !node.conditionalGroup || !node.children) return own
  const memberIds = new Set(node.children.map((c) => c.id))
  if (pick === "last") {
    for (let i = list.length - 1; i >= 0; i--) {
      if (memberIds.has(list[i].id)) return i
    }
    return -1
  }
  return list.findIndex((c) => memberIds.has(c.id))
}

/**
 * Walk UP from `node` looking for the nearest ancestor whose `editTarget.file`
 * equals `sourceFile`. That's the slot provider in Vue's slot model — the
 * SFC where `node` is AUTHORED as a child, as opposed to the rendered DOM
 * parent which may live in a different SFC's internal template.
 *
 * Example: dragging the toggle from AIGatewayAgentCreate.vue near a KInput
 * that renders inside EntityFormBlock's internal wrapper div. The wrapper
 * div is from EntityFormBlock.vue; walking up past it finds EntityFormBlock
 * itself (whose callsite IS in AIGatewayAgentCreate.vue). That's the file
 * where the splice has to land.
 */
function findEffectiveSlotParent(
  node: OutlineNode,
  sourceFile: string,
  parentByChildId: Map<string, OutlineNode>,
): OutlineNode | null {
  let cur: OutlineNode | undefined = parentByChildId.get(node.id)
  while (cur) {
    if (cur.editTarget?.file === sourceFile) return cur
    cur = parentByChildId.get(cur.id)
  }
  return null
}

/**
 * Enumerate `root`'s descendants whose `editTarget.file` equals `sourceFile`,
 * in DOM (= source-write) order. Recurses THROUGH descendants whose file
 * differs — those are intervening wrapper elements rendered by some
 * different SFC; the slot content authored in `sourceFile` is nested inside
 * them. Does NOT recurse into a matching descendant: its own children are
 * authored as its children in source, not as siblings of itself in `root`.
 */
function collectSameFileDescendants(
  root: OutlineNode,
  sourceFile: string,
): OutlineNode[] {
  const result: OutlineNode[] = []
  function walk(n: OutlineNode): void {
    if (!n.children) return
    for (const child of n.children) {
      if (child.editTarget?.file === sourceFile) {
        result.push(child)
      } else {
        walk(child)
      }
    }
  }
  walk(root)
  return result
}

/**
 * Three-band cursor → drop-position mapping. Top 25% → before, bottom 25%
 * → after, middle 50% → inside (but only if the row can host children).
 * For rows without a `editTarget`, "inside" is impossible — fall back to
 * the original half/half before/after split.
 */
/**
 * HTML void elements — tags that the spec disallows from having children.
 * If the user aims a drop at the middle of one of these in the layers tree,
 * "inside" is impossible (apply-move-edit will refuse with a self-closing
 * error), so we never offer the inside zone for them. Vue components written
 * self-closing (`<KInput />`) can't be detected from the OutlineNode alone;
 * those still go through the post-drop refusal path.
 */
const VOID_HTML_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "source", "track", "wbr",
])

function canHostChildren(node: OutlineNode): boolean {
  if (!node.editTarget) return false
  if (node.type === "element" && VOID_HTML_ELEMENTS.has(node.name.toLowerCase())) {
    return false
  }
  return true
}

function computeDropPosition(
  el: HTMLElement,
  clientY: number,
  node: OutlineNode,
): DropPosition {
  const rect = el.getBoundingClientRect()
  const offset = clientY - rect.top
  // Some test environments (jsdom + DragEvent) don't propagate clientY into
  // the synthetic event — `offset` ends up NaN. Treat that as "after" to
  // preserve the prior 2-band fallthrough behavior. In a real browser
  // drag events always carry clientY, so this branch is dead in prod.
  if (!Number.isFinite(offset)) return "after"
  if (!canHostChildren(node)) {
    return offset < rect.height / 2 ? "before" : "after"
  }
  // 40/20/40 split. The narrow middle "inside" band is enough to remain
  // hittable while leaving generous before/after targets on small
  // text-xs rows (~24px tall).
  if (offset < rect.height * 0.4) return "before"
  if (offset > rect.height * 0.6) return "after"
  return "inside"
}

function isDescendant(ancestor: OutlineNode, candidateId: string): boolean {
  if (!ancestor.children) return false
  for (const child of ancestor.children) {
    if (child.id === candidateId) return true
    if (isDescendant(child, candidateId)) return true
  }
  return false
}
