/**
 * Selection model used by FrameworkAdapter implementations. Adapters
 * resolve clicks (and keyboard navigation) into `Selection` objects that
 * the inspector reads, and accept incoming selection commands (drill,
 * ascend) from the inspector.
 */

import type { EditableTextField } from '@/types/bridge'
import type { AttributionContext } from '@/editor/attribution/types'
import type { OffSystemMarker } from './intent'

/**
 * Iframe-local point in CSS pixels. The shell translates host-window
 * coordinates into iframe coordinates before calling
 * {@link FrameworkAdapter.selectAt}.
 */
export interface IframePoint {
  x: number
  y: number
}

/**
 * Connection parameters passed to {@link FrameworkAdapter.init}.
 */
export interface AdapterTarget {
  /** The iframe element hosting the prototype. */
  iframe: HTMLIFrameElement
  /** Origin string used for postMessage targeting. */
  origin: string
  /** Optional prototype identifier (editor-internal). */
  prototypeId?: string
}

/**
 * What selection would resolve to at a given point. Cheap and
 * non-committal — used for hover preview and as the kernel inside a
 * full {@link Selection}.
 */
/**
 * Build-time source position of the *usage* of a component (the parent
 * template's tag), distinct from the component definition's file/line.
 * Captured by the substrate's Vite plugin (`data-desde-src` attributes) and
 * read by the bridge on selection. The editor edit service uses this to
 * rewrite the exact source position that produced the rendered DOM node.
 */
export interface SourceLocation {
  /** Path relative to the substrate's Vite root. */
  file: string
  /** 1-based line of the start tag. */
  line: number
  /** 1-based column of the start tag. */
  column: number
  /**
   * Per-file source-version hash (`data-desde-v` stamp) captured with the
   * coordinates from the same DOM snapshot. The edit server compares it
   * against current on-disk content and refuses stale-target edits.
   * Absent when the source-tag plugin didn't stamp versions.
   */
  fileHash?: string
}

/**
 * The coordinate a `[data-desde-src="…"]` CSS rule is anchored on, read off
 * the live DOM by the bridge and verified against it.
 *
 * Deliberately NOT a {@link SourceLocation}. A source location answers
 * "where do these bytes live?"; a CSS anchor answers "which attribute
 * value is actually in the document?". On a component root those differ —
 * the framework's attribute fallthrough overwrites the root's own
 * `data-desde-src` with the parent's callsite, so the bytes-level answer
 * (the `data-desde-own` rescue stamp) matches no element at all. Keeping the
 * shapes distinct is what stops the substitution that produced § 9g.8's
 * dead rules.
 */
export interface DomAnchor {
  file: string
  line: number
  column: number
  /** Elements matching `[data-desde-src="<file>:<line>:<column>"]` right now. */
  matchCount: number
  /** `direct` = the element's own attribute; `ancestor` = a stamped ancestor's. */
  resolution: 'direct' | 'ancestor'
}

/**
 * Iteration context for elements rendered by a framework loop construct
 * (Vue `v-for`, React `.map`, Svelte `#each`). When present, the selected
 * DOM element shares its `data-desde-src` with N-1 sibling renderings — a
 * naive structural edit on `editTarget` would rewrite the template and
 * affect every iteration. Iteration-aware edits use this context to scope
 * to the data array instead.
 *
 * `key` is the framework-emitted key for this iteration (Vue's `:key`,
 * React's `key`). Stable enough to identify the row across re-renders
 * when the substrate sets one; the bridge falls back to positional index
 * when no key is set, recorded as a number.
 *
 * `expression` is a best-effort string of the iteratee as written in
 * source (e.g. `"collection.items"`) — null when the framework runtime
 * doesn't expose it. Hint for both the static resolver and the LLM
 * fallback.
 */
export interface IterationContext {
  source: 'v-for' | 'map' | 'each' | 'unknown'
  key: string | number
  /** 0-based position among rendered siblings of this iteration. */
  index: number
  /** Total count of rendered siblings — UX surfaces this as "1 of 8". */
  siblingCount: number
  /** Iteratee expression as authored (e.g. "items"). Null if unknown. */
  expression: string | null
}

export interface SelectionTarget {
  /** Stable target id for this DOM element, scoped to the prototype iframe. */
  targetId: string
  /** CSS selector to re-find this element. Bridge-generated. */
  selector: string
  /** Component name when the target resolves to a registered component. */
  componentName?: string
  /** Source file path of the component definition, when the bridge resolves it. */
  componentFile?: string
  /** Source line of the component definition, when known. */
  componentLine?: number
  /** Package name when the component comes from a library (e.g., '@acme/design-system'). */
  packageName?: string
  /**
   * Where the selected element's bytes live in source. Drives "open file
   * at line" affordances and definition-scoped {@link DeleteEdit}. Equal
   * to {@link editTarget} for native elements and component leafs;
   * differs for slot interpolations and internal markup of user-authored
   * child SFCs. Absent when the substrate doesn't ship the source-tag
   * Vite plugin or the element couldn't be attributed.
   *
   * **NOT a selector.** On a component ROOT this is the `data-desde-own`
   * rescue stamp — a coordinate carried by no element's `data-desde-src`,
   * because the framework's attribute fallthrough overwrote the root's
   * own stamp with the parent's callsite. Anything building a CSS
   * selector must use {@link domAnchor}; the "This page" style lane read
   * this field and wrote rules that matched nothing while reporting
   * success (`tasks/dev-server-hosts.md` § 9g.8).
   */
  authoredAt?: SourceLocation
  /**
   * The `data-desde-src` value literally present on the element — or on its
   * nearest stamped ancestor — plus how many elements it matches in the
   * document right now. The only coordinate a `[data-desde-src="…"]` CSS
   * rule may be anchored on; `matchCount === 0` means the rule would be
   * dead and must be refused. Absent when nothing in the ancestry
   * carries a stamp.
   */
  domAnchor?: DomAnchor
  /**
   * Where structural / prop edits dispatch — the consumer's `<Tag>`
   * location for this element's leaf component, resolved through
   * transparent wrappers. Drives PropEdit, MoveEdit, and
   * callsite-scoped {@link DeleteEdit}. Equal to {@link authoredAt}
   * for native elements and component leafs; differs for slot
   * interpolations and internal markup of user-authored child SFCs.
   */
  editTarget?: SourceLocation
  /**
   * True when {@link editTarget}'s file is in `node_modules` —
   * editor can't rewrite library source. The adapter refuses
   * structural edits that would land in library files.
   */
  isLibrary?: boolean
  /**
   * Set when the selected element is one rendering of a framework loop
   * (Vue `v-for`, React `.map`, etc.). Drives the iteration-scope dialog:
   * structural edits (delete/duplicate/move/insert) and prop edits prompt
   * the user to choose between mutating the data array entry ("this row")
   * vs. rewriting the template ("all rows"). Absent for non-iterated
   * elements — the prompt never appears in that case.
   */
  iterationContext?: IterationContext
  /**
   * Manifest-first attribution snapshot the bridge extracted for this
   * selection (component chain + clicked-element descriptor). Consumed by
   * `attribute()` in the edit pipeline to decide deterministic vs.
   * cross-file vs. LLM vs. refuse routing. Optional — absent on substrates
   * whose bridge predates the attribution-context wiring, in which case
   * the edit pipeline falls back to the legacy walk-derived dispatch.
   */
  attributionContext?: AttributionContext
}

/**
 * One ancestor of the current selection, leaf-first. Adapters populate
 * this from the bridge's componentTree[] data.
 */
export interface SelectionAncestor {
  targetId: string
  componentName: string
  componentFile?: string
  /** Manifest id linking the ancestor to a ComponentManifest, when registered. */
  manifestId?: string
}

/**
 * Active selection. Carries enough data for the inspector to render its
 * panel without further round-trips to the bridge.
 */
export interface Selection extends SelectionTarget {
  /** Manifest id linking this selection to a ComponentManifest, when registered. */
  manifestId?: string
  /**
   * Lowercase tag name of the actual selected DOM element (e.g. "div",
   * "button"). Distinct from {@link componentName} — for an internal
   * element of a component, `tagName` is the element while `componentName`
   * is the enclosing component (when promoted). The inspector uses this
   * to label element-level selections so the displayed identity matches
   * what the layers panel showed.
   */
  tagName?: string
  /**
   * `true` when the selection resolves to an internal DOM element of a
   * component rather than the component's render root. The inspector
   * branches on this: element-level selections show the tag/classes
   * identity instead of the enclosing component's identity, hide
   * "Detach component", and don't load a component manifest. Component-
   * root selections (the layers tree's `type === "component"` rows)
   * keep the component-centric inspector behavior.
   */
  selectedAsElement?: boolean
  /** Ancestry breadcrumb leaf-first; index 0 is the current selection's parent. */
  ancestry: SelectionAncestor[]
  /** Off-system marker if the element has been authored off-system. */
  offSystem?: OffSystemMarker
  /**
   * Live prop values on the selected component instance, surfaced from the
   * bridge's `componentTree[leaf].props` (read at inspect time from Vue's
   * `__vueParentComponent.props` proxy / React's fiber `memoizedProps`).
   *
   * The inspector uses this as the *current* state of each prop, falling
   * back to the manifest default only when this is absent. Without it the
   * inspector would always render the manifest default — incorrect for any
   * instance whose source overrides it (e.g. `<UiButton variant="danger">`).
   *
   * Values are pre-serialized by the bridge (objects/arrays may be
   * shape-stripped or stringified — don't assume round-trippable identity).
   */
  currentProps?: Record<string, unknown>
  /**
   * Fallthrough attributes the parent passed to this instance that are
   * NOT in its typed prop signature — Vue's `instance.attrs`, React's
   * pass-through props. Surfaced as a separate map so the inspector
   * can render an "Attributes" section distinct from typed props
   * (which come from the manifest); editing flows through the same
   * `kind: 'prop'` edit pipeline.
   *
   * Common case: `<UiInput placeholder="Enter name" required>` —
   * the design system's `UiInput` doesn't type `placeholder` or `required`,
   * so they live here, not in `currentProps`.
   */
  currentAttrs?: Record<string, unknown>
  /**
   * Live DOM properties surfaced by the bridge on inspection. Editor's
   * right-rail "DOM" section reads these as the current values for
   * editable fields (text content, class tokens). Distinct from
   * `currentProps` — these belong to the rendered element, not a
   * component instance.
   */
  classes?: string[]
  /**
   * Editable text fields the framework adapter has surfaced for this
   * selection — one labeled input per entry in the right-rail inspector.
   * Mirrors `InspectionData.editableTexts`. See `EditableTextField` in
   * `@/types/bridge` for the shape and dispatch semantics.
   */
  editableTexts?: EditableTextField[]
  /**
   * Live computed CSS for the selected element — flat `property → value`
   * map of non-default declarations the bridge surfaces on inspection.
   * The right-rail sections (Spacing / Color / Border / Typography) read
   * this as a fallback when the element's class list doesn't carry a
   * Tailwind utility for a given property. Without it, an element styled
   * by component-internal CSS (an Acme DS `<UiButton>`, a CSS-modules
   * stylesheet, etc.) renders the inspector controls empty even though
   * the user can clearly see padding/colors in the iframe.
   *
   * Values are pre-resolved (`getComputedStyle`-shape: `"16px"`,
   * `"rgb(34, 197, 94)"`, `"0.875rem"`) — the inference helpers in
   * `infer-from-computed.ts` snap them to the nearest Tailwind step.
   */
  computedStyles?: Record<string, string>
}
