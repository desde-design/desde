/**
 * Desde Bridge — Table-edge Overlay
 *
 * Extracted from `comment-bridge.ts`. Detects row/column-shaped containers and
 * draws insert-band overlays (own shadow DOM); emits TABLE_EDGE_CONTEXT_MENU
 * through the injected `sendToShell`. Class body verbatim; the TABLE_EDGE_*
 * tuning consts and TableEdgeBandHit type co-moved.
 */
import { sendToShell } from "./bridge-runtime"
import { generateSelector } from "./selector-engine"
import { hasBridgeOwnAttr, isBridgeOwnElement } from "./selector-helpers"
import type { SelectModeOverlay } from "./bridge-types"

/** `window.__DESDE_TABLE_EDGE_DEBUG__ = true` in the iframe console turns
 *  on the overlay's tracing. Off by default — this runs on every mousemove. */
function tableEdgeDebug(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as unknown as { __DESDE_TABLE_EDGE_DEBUG__?: boolean })
      .__DESDE_TABLE_EDGE_DEBUG__
  )
}

const TABLE_EDGE_STYLES = `
  :host { all: initial; }

  .pt-edge-band {
    position: fixed;
    pointer-events: none;
    z-index: 2147483643;
    background: rgba(56, 189, 248, 0.14);
    border: 1.5px solid rgba(56, 189, 248, 0.75);
    border-radius: 2px;
    box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.2);
    transition: top 0.04s linear, left 0.04s linear, width 0.04s linear, height 0.04s linear;
  }
`

/** Distance from an edge (in px) at which the band appears. */
const TABLE_EDGE_GUTTER = 32
/**
 * Minimum direct children before a *generic* (non-table) container
 * is treated as row/column-shaped. 3 avoids matching tiny two-child
 * containers like header label+icon pairs, toolbars with two
 * buttons, or two-section stacks (toolbar above body). Real tables
 * (<table>) and grids the user cares about almost always have
 * three or more rows / columns. The cost of this threshold is that
 * a two-row plain list won't trigger — acceptable v1 trade.
 */
const TABLE_EDGE_MIN_CHILDREN = 3
/** Caps the cell fingerprint list sent to the shell. */
const TABLE_EDGE_FINGERPRINT_LIMIT = 5
/** Truncates each fingerprint string. */
const TABLE_EDGE_FINGERPRINT_TEXT_LIMIT = 80

interface TableEdgeBandHit {
  kind: "row" | "column"
  bandRect: { top: number; left: number; width: number; height: number }
  containerEl: Element
  index: number
  totalBands: number
  /** Representative element for source-mapping (the row for rows, first column cell for columns). */
  targetEl: Element
  /** All cell elements in the band; used for fingerprint generation. */
  cellEls: Element[]
}


/** Cluster rects by Y-midpoint ("y") or X-midpoint ("x"); used by
 *  classifyGeneric to group children into rows or columns.
 *
 *  Moved here from comment-bridge.ts 2026-08-04: this module was its only
 *  caller but referenced it WITHOUT an import — a latent orphan from the
 *  2026-05-29 modularization that only worked while esbuild happened to
 *  hoist both into one scope. When Phase 2 moved the last comment-bridge
 *  caller out, the unused definition was dropped from the bundle and the
 *  accidental binding broke at runtime (ReferenceError on hit-test).
 */
function clusterByAxis(
  items: { el: Element; rect: DOMRect }[],
  axis: "x" | "y",
  tolerance: number,
): { el: Element; rect: DOMRect }[][] {
  const midOf = (r: DOMRect) =>
    axis === "y" ? r.top + r.height / 2 : r.left + r.width / 2
  const clusters: { el: Element; rect: DOMRect }[][] = []
  for (const item of items) {
    const mid = midOf(item.rect)
    let placed = false
    for (const cluster of clusters) {
      const refMid = midOf(cluster[0].rect)
      if (Math.abs(mid - refMid) <= tolerance) {
        cluster.push(item)
        placed = true
        break
      }
    }
    if (!placed) clusters.push([item])
  }
  clusters.sort((a, b) => midOf(a[0].rect) - midOf(b[0].rect))
  return clusters
}

export class TableEdgeOverlayManager implements SelectModeOverlay {
  private root: HTMLElement
  private shadow: ShadowRoot
  private bandEl: HTMLElement | null = null
  private active = false
  private currentHit: TableEdgeBandHit | null = null
  private rafToken = 0
  private lastMouse: { x: number; y: number } | null = null
  private prevBodyCursor: string | null = null
  private boundMouseMove: (e: MouseEvent) => void
  private boundContextMenu: (e: MouseEvent) => void
  private boundScrollOrResize: () => void

  constructor() {
    this.root = document.createElement("div")
    this.root.setAttribute("data-prototype-flow", "table-edge-overlay")
    this.shadow = this.root.attachShadow({ mode: "closed" })
    const style = document.createElement("style")
    style.textContent = TABLE_EDGE_STYLES
    this.shadow.appendChild(style)
    document.body.appendChild(this.root)
    this.boundMouseMove = this.handleMouseMove.bind(this)
    this.boundContextMenu = this.handleContextMenu.bind(this)
    this.boundScrollOrResize = this.handleScrollOrResize.bind(this)
  }

  activate(): void {
    if (this.active) return
    this.active = true
    document.addEventListener("mousemove", this.boundMouseMove, true)
    document.addEventListener("contextmenu", this.boundContextMenu, true)
    window.addEventListener("scroll", this.boundScrollOrResize, true)
    window.addEventListener("resize", this.boundScrollOrResize, true)
    if (tableEdgeDebug()) {
      // eslint-disable-next-line no-console
      console.log("[table-edge] activated")
    }
  }

  deactivate(): void {
    if (!this.active) return
    this.active = false
    document.removeEventListener("mousemove", this.boundMouseMove, true)
    document.removeEventListener("contextmenu", this.boundContextMenu, true)
    window.removeEventListener("scroll", this.boundScrollOrResize, true)
    window.removeEventListener("resize", this.boundScrollOrResize, true)
    if (this.rafToken !== 0) {
      cancelAnimationFrame(this.rafToken)
      this.rafToken = 0
    }
    this.hideBand()
    if (tableEdgeDebug()) {
      // eslint-disable-next-line no-console
      console.log("[table-edge] deactivated")
    }
  }

  isActive(): boolean {
    return this.active
  }

  /** Route changed (SPA pushState/replaceState, popstate, or full reload).
   *  The container the band was tracking is detached from the new
   *  document, so the band would linger frozen at the old coordinates
   *  until the next mousemove. Hide it; the next mousemove recomputes a
   *  fresh hit against the new page. Listeners stay attached so the
   *  overlay keeps working. Registered in `comment-bridge.ts` navigation
   *  callbacks alongside the inspector/recorder/player/pins handlers. */
  handleNavigation(): void {
    this.hideBand()
  }

  private handleMouseMove(e: MouseEvent): void {
    this.lastMouse = { x: e.clientX, y: e.clientY }
    if (this.rafToken !== 0) return
    this.rafToken = requestAnimationFrame(() => {
      this.rafToken = 0
      if (!this.lastMouse) return
      this.updateBand(this.lastMouse.x, this.lastMouse.y)
    })
  }

  private handleScrollOrResize(): void {
    // Rects change during scroll/resize. Hide the band and let the
    // next mousemove recompute. Avoids the band drifting away from
    // its container.
    this.hideBand()
  }

  private handleContextMenu(e: MouseEvent): void {
    const debug = tableEdgeDebug()
    if (debug) {
      // eslint-disable-next-line no-console
      console.log("[table-edge] contextmenu", { hasCurrentHit: !!this.currentHit, x: e.clientX, y: e.clientY })
    }
    if (!this.currentHit) return
    e.preventDefault()
    e.stopPropagation()
    const hit = this.currentHit
    const payload = this.buildPayload(hit, e.clientX, e.clientY)
    if (debug) {
      // eslint-disable-next-line no-console
      console.log("[table-edge] sending TABLE_EDGE_CONTEXT_MENU", payload)
    }
    sendToShell({ type: "TABLE_EDGE_CONTEXT_MENU", payload })
    this.hideBand()
  }

  private updateBand(x: number, y: number): void {
    const hit = this.hitTest(x, y)
    if (tableEdgeDebug()) {
      // eslint-disable-next-line no-console
      console.log("[table-edge] hitTest", { x, y, hit })
    }
    if (!hit) {
      this.hideBand()
      return
    }
    this.currentHit = hit
    this.showBand(hit)
  }

  /** Debug entry-point: returns what hitTest sees at (x, y) without
   *  showing the band. Exposed via `window.__DESDE_TABLE_EDGE__.probe(x, y)`. */
  probe(x: number, y: number): unknown {
    return this.hitTest(x, y)
  }

  private hitTest(x: number, y: number): TableEdgeBandHit | null {
    // Walk the element stack; skip our own/inspector/flow elements so
    // hit-testing reflects the substrate's DOM, not our overlays.
    const stack = document.elementsFromPoint(x, y)
    let leaf: Element | null = null
    for (const el of stack) {
      if (!isBridgeOwnElement(el)) {
        leaf = el
        break
      }
    }
    if (!leaf) return null

    // <table> wins. When the cursor is anywhere inside a <table>,
    // that table's rows/columns are the user's intent. Inner divs
    // (cell wrappers, header containers) often match the generic
    // classifier and would otherwise produce nonsense bands on the
    // header internals — short-circuit to the table.
    const tableAncestor = leaf.closest("table")
    if (tableAncestor) {
      return this.classifyTable(tableAncestor, x, y)
    }

    // No table — fall back to grid / flex / list classification by
    // walking up; first valid hit wins.
    let container: Element | null = leaf
    while (container && container !== document.documentElement) {
      const hit = this.classify(container, x, y)
      if (hit) return hit
      container = container.parentElement
    }
    return null
  }

  private classify(container: Element, x: number, y: number): TableEdgeBandHit | null {
    const tag = container.tagName
    if (tag === "TABLE") return this.classifyTable(container, x, y)
    const computed = window.getComputedStyle(container)
    const display = computed.display
    if (display === "grid" || display === "inline-grid") {
      return this.classifyGeneric(container, x, y)
    }
    if (display === "flex" || display === "inline-flex") {
      return this.classifyGeneric(container, x, y)
    }
    if (container.children.length >= TABLE_EDGE_MIN_CHILDREN) {
      return this.classifyGeneric(container, x, y)
    }
    return null
  }

  private classifyTable(table: Element, x: number, y: number): TableEdgeBandHit | null {
    const containerRect = table.getBoundingClientRect()
    if (
      x < containerRect.left - TABLE_EDGE_GUTTER ||
      x > containerRect.right + TABLE_EDGE_GUTTER ||
      y < containerRect.top - TABLE_EDGE_GUTTER ||
      y > containerRect.bottom + TABLE_EDGE_GUTTER
    ) {
      return null
    }

    const rows = Array.from(
      table.querySelectorAll(
        ":scope > tbody > tr, :scope > thead > tr, :scope > tfoot > tr, :scope > tr",
      ),
    ) as HTMLElement[]
    if (rows.length === 0) return null

    // Row test — y inside a row's vertical range, x within the
    // left-edge gutter (a wide grabbable strip outside the table).
    if (x <= containerRect.left + TABLE_EDGE_GUTTER) {
      for (let i = 0; i < rows.length; i++) {
        const rRect = rows[i].getBoundingClientRect()
        if (y >= rRect.top - 2 && y <= rRect.bottom + 2) {
          return {
            kind: "row",
            bandRect: {
              top: rRect.top,
              left: containerRect.left,
              width: containerRect.width,
              height: rRect.height,
            },
            containerEl: table,
            index: i,
            totalBands: rows.length,
            targetEl: rows[i],
            cellEls: Array.from(rows[i].children),
          }
        }
      }
    }

    // Column test — x inside a column's horizontal range, y within
    // the top-edge gutter.
    if (y <= containerRect.top + TABLE_EDGE_GUTTER) {
      // Pick the row with the most cells as the column-count spec.
      // Avoids spans/colspans confusing the band index.
      let specRow = rows[0]
      let maxCells = specRow.children.length
      for (const r of rows) {
        if (r.children.length > maxCells) {
          specRow = r
          maxCells = r.children.length
        }
      }
      const cols = Array.from(specRow.children) as HTMLElement[]
      for (let i = 0; i < cols.length; i++) {
        const cRect = cols[i].getBoundingClientRect()
        if (x >= cRect.left - 2 && x <= cRect.right + 2) {
          const cellsInCol: Element[] = []
          for (const r of rows) {
            const c = r.children[i]
            if (c) cellsInCol.push(c)
          }
          return {
            kind: "column",
            bandRect: {
              top: containerRect.top,
              left: cRect.left,
              width: cRect.width,
              height: containerRect.height,
            },
            containerEl: table,
            index: i,
            totalBands: cols.length,
            targetEl: cols[i],
            cellEls: cellsInCol,
          }
        }
      }
    }
    return null
  }

  private classifyGeneric(
    container: Element,
    x: number,
    y: number,
  ): TableEdgeBandHit | null {
    const containerRect = container.getBoundingClientRect()
    if (
      x < containerRect.left - TABLE_EDGE_GUTTER ||
      x > containerRect.right + TABLE_EDGE_GUTTER ||
      y < containerRect.top - TABLE_EDGE_GUTTER ||
      y > containerRect.bottom + TABLE_EDGE_GUTTER
    ) {
      return null
    }

    const childRects: { el: Element; rect: DOMRect }[] = []
    for (let i = 0; i < container.children.length; i++) {
      const c = container.children[i]
      if (hasBridgeOwnAttr(c)) continue
      const r = c.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      childRects.push({ el: c, rect: r })
    }
    if (childRects.length < TABLE_EDGE_MIN_CHILDREN) return null

    // Cluster children by Y-midpoint (rows) and X-midpoint (columns).
    // Median dimension drives cluster tolerance; tighter than half-
    // height/width avoids merging adjacent rows that visually touch.
    const heights = childRects
      .map((c) => c.rect.height)
      .sort((a, b) => a - b)
    const widths = childRects
      .map((c) => c.rect.width)
      .sort((a, b) => a - b)
    const medianH = heights[Math.floor(heights.length / 2)] || 1
    const medianW = widths[Math.floor(widths.length / 2)] || 1
    const tolY = Math.max(4, medianH * 0.4)
    const tolX = Math.max(4, medianW * 0.4)

    const rowClusters = clusterByAxis(childRects, "y", tolY)
    const colClusters = clusterByAxis(childRects, "x", tolX)

    // Row test
    if (
      rowClusters.length >= TABLE_EDGE_MIN_CHILDREN &&
      x <= containerRect.left + TABLE_EDGE_GUTTER
    ) {
      for (let i = 0; i < rowClusters.length; i++) {
        const row = rowClusters[i]
        let top = Infinity
        let bottom = -Infinity
        for (const c of row) {
          if (c.rect.top < top) top = c.rect.top
          if (c.rect.bottom > bottom) bottom = c.rect.bottom
        }
        if (y >= top - 2 && y <= bottom + 2) {
          return {
            kind: "row",
            bandRect: {
              top,
              left: containerRect.left,
              width: containerRect.width,
              height: bottom - top,
            },
            containerEl: container,
            index: i,
            totalBands: rowClusters.length,
            targetEl: row[0].el,
            cellEls: row.map((c) => c.el),
          }
        }
      }
    }

    // Column test
    if (
      colClusters.length >= TABLE_EDGE_MIN_CHILDREN &&
      y <= containerRect.top + TABLE_EDGE_GUTTER
    ) {
      for (let i = 0; i < colClusters.length; i++) {
        const col = colClusters[i]
        let left = Infinity
        let right = -Infinity
        for (const c of col) {
          if (c.rect.left < left) left = c.rect.left
          if (c.rect.right > right) right = c.rect.right
        }
        if (x >= left - 2 && x <= right + 2) {
          return {
            kind: "column",
            bandRect: {
              top: containerRect.top,
              left,
              width: right - left,
              height: containerRect.height,
            },
            containerEl: container,
            index: i,
            totalBands: colClusters.length,
            targetEl: col[0].el,
            cellEls: col.map((c) => c.el),
          }
        }
      }
    }

    return null
  }

  private showBand(hit: TableEdgeBandHit): void {
    if (!this.bandEl) {
      this.bandEl = document.createElement("div")
      this.bandEl.className = "pt-edge-band"
      this.shadow.appendChild(this.bandEl)
    }
    this.bandEl.style.top = `${hit.bandRect.top}px`
    this.bandEl.style.left = `${hit.bandRect.left}px`
    this.bandEl.style.width = `${hit.bandRect.width}px`
    this.bandEl.style.height = `${hit.bandRect.height}px`
    this.bandEl.style.display = "block"
    this.applyEdgeCursor(hit.kind)
  }

  private hideBand(): void {
    if (this.bandEl) this.bandEl.style.display = "none"
    this.currentHit = null
    this.restoreBodyCursor()
  }

  private applyEdgeCursor(kind: "row" | "column"): void {
    if (this.prevBodyCursor === null) {
      // Snapshot only the inline cursor; CSS cursors from page styles
      // remain untouched by setProperty/removeProperty.
      this.prevBodyCursor = document.body.style.cursor
    }
    document.body.style.setProperty(
      "cursor",
      kind === "row" ? "row-resize" : "col-resize",
      "important",
    )
  }

  private restoreBodyCursor(): void {
    if (this.prevBodyCursor === null) return
    if (this.prevBodyCursor) {
      document.body.style.cursor = this.prevBodyCursor
    } else {
      document.body.style.removeProperty("cursor")
    }
    this.prevBodyCursor = null
  }

  private buildPayload(
    hit: TableEdgeBandHit,
    anchorX: number,
    anchorY: number,
  ): Record<string, unknown> {
    let containerSelector = ""
    let targetSelector = ""
    try { containerSelector = generateSelector(hit.containerEl) } catch { /* leave empty */ }
    try { targetSelector = generateSelector(hit.targetEl) } catch { /* leave empty */ }

    let targetAttribution: ReturnType<typeof attributeElement> = undefined
    let containerAttribution: ReturnType<typeof attributeElement> = undefined
    try { targetAttribution = attributeElement(hit.targetEl) } catch { /* leave undefined */ }
    try { containerAttribution = attributeElement(hit.containerEl) } catch { /* leave undefined */ }

    const fingerprints: string[] = []
    for (
      let i = 0;
      i < hit.cellEls.length && fingerprints.length < TABLE_EDGE_FINGERPRINT_LIMIT;
      i++
    ) {
      const raw = hit.cellEls[i].textContent ?? ""
      const text = raw.replace(/\s+/g, " ").trim()
      if (!text) continue
      fingerprints.push(
        text.length > TABLE_EDGE_FINGERPRINT_TEXT_LIMIT
          ? text.slice(0, TABLE_EDGE_FINGERPRINT_TEXT_LIMIT - 1) + "…"
          : text,
      )
    }

    return {
      kind: hit.kind,
      index: hit.index,
      totalBands: hit.totalBands,
      containerSelector,
      targetSelector,
      containerEditTarget: containerAttribution?.editTarget,
      editTarget: targetAttribution?.editTarget,
      iterationContext: targetAttribution?.iteration,
      cellFingerprints: fingerprints,
      cellCount: hit.cellEls.length,
      menuAnchor: {
        x: anchorX,
        y: anchorY,
        bandRect: hit.bandRect,
      },
    }
  }
}
