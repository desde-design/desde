/**
 * Desde Bridge — element attribution + inspection engine
 *
 * Extracted from `comment-bridge.ts` (audit Task 22) so the bridge entry
 * keeps only the postMessage protocol handler, init/wiring, and the
 * framework runtime adapters. Everything here answers one of two
 * questions about a DOM element:
 *
 *   1. "Where in source did this come from?" — `attributeElement` and the
 *      thin wrappers over it (`getSourceLocation`,
 *      `computeIterationContext`, `computeCallsiteLocation`,
 *      `findEditTargetComponent`, `findSourceAnchorElement`).
 *   2. "What can be edited on it?" — `findEditableTextFields` /
 *      `findSlotTextLeaves` (+ the authored-unit boundary rules) and the
 *      full `inspectElement` payload the shell's inspector renders.
 *
 * Framework specifics do NOT live here. Every runtime read goes through
 * the `FrameworkRuntimeAdapter` injected by `configureElementAttribution`
 * — the Vue 3 / React adapter impls stay in `comment-bridge.ts` next to
 * the DOM-convention detection that picks between them. Same seam the
 * extracted manager classes use via `bridge-runtime.ts`, and the reason
 * the pure parts of this module are unit-testable against a stub adapter
 * (see `element-attribution.test.ts`).
 *
 * esbuild inlines this back into the single bridge IIFE at bundle time.
 */

import {
  resolveLeafChildPropAttribution as importedResolveLeafChildPropAttribution,
  type FrameworkRuntimeAdapter,
} from "./leaf-prop-attribution"
import { buildAttributionContext } from "./build-attribution-context"
import { generateSelector } from "./selector-engine"
import { STYLE_CATEGORIES, isDefaultValue } from "./style-categories"
import {
  buildVue3ComponentTree,
  buildReactComponentTree,
  detectFrameworkComponent,
  detectOutlineComponent,
  extractComponentInfo,
  findOutermostInstanceRootedAt,
  detectDirectComponent,
  type FrameworkComponentInfo,
  type ComponentTreeNode,
} from "./framework-component-detection"
import {
  extractDesignTokens,
  buildRawValueMap,
  getPageSourceFile,
  parseSourceTag,
  fileVersionFor,
  type InspectionStyleProperty,
  type InspectionStyleCategory,
  type InspectionDesignToken,
  type InspectionBoxModelData,
} from "./inspection-extractors"
import type { Attribution } from "./bridge-types"
import { tracer, detectIteration } from "./tracer-attribution"

/**
 * The live framework runtime adapter. Injected rather than imported so
 * this module stays framework-neutral (and stubbable in tests) while the
 * concrete Vue/React impls + the DOM-convention detection that chooses
 * between them stay in `comment-bridge.ts`.
 *
 * Unconfigured access throws instead of silently returning undefined:
 * a missing `configureElementAttribution` call is a wiring bug, and a
 * silent null would surface as "no attribution anywhere" — the single
 * hardest bridge symptom to diagnose.
 */
let frameworkAdapter: FrameworkRuntimeAdapter = new Proxy(
  {} as FrameworkRuntimeAdapter,
  {
    get(_target, prop) {
      throw new Error(
        `[Desde Bridge] element-attribution used before ` +
          `configureElementAttribution() (property: ${String(prop)})`,
      )
    },
  },
)

export function configureElementAttribution(adapter: FrameworkRuntimeAdapter): void {
  frameworkAdapter = adapter
}

// resolveLeafChildPropAttribution lives in `./leaf-prop-attribution`
// so its pure logic + adapter contract are unit-testable without
// booting a browser. The Vue 3 / React adapter impls stay in
// `comment-bridge.ts` because they read live runtime conventions
// (`__vueParentComponent`, `instance.props`, `__reactFiber$…`) that
// don't make sense to stub; this local binding just curries the
// injected adapter in.
const resolveLeafChildPropAttribution = (
  leafEl: Element,
  trimmedText: string,
) => importedResolveLeafChildPropAttribution(leafEl, trimmedText, frameworkAdapter)

/**
 * Unified source attribution for a DOM element. Replaces the four
 * scattered walks (`getSourceLocation`, `computeCallsiteLocation`,
 * `findEditableTextFields`' outermost-wrapper walk, and
 * `computeIterationContext`) with one authoritative computation —
 * everything else derives from this. See
 * `tasks/_archive/one-shot-tasks/bridge-attribution-consolidation.md` for the design and the
 * cases each field covers.
 *
 * - `editTarget` is where structural / prop edits dispatch: the
 *   consumer's `<Tag>` location for the leaf component. Falls back to
 *   `authoredAt` for native elements in the root SFC (App has no
 *   parent-template tag).
 * - `authoredAt` is where the BYTES live: the leaf's own
 *   `data-desde-src` when the leaf rendered `el` directly (slot
 *   interpolations, internal markup of a user-authored child SFC).
 *   Equal to `editTarget` when `el` is a component leaf.
 * - `editableComponent` is the OUTERMOST instance whose
 *   `vnode.props["data-desde-src"]` matches the leaf's — the
 *   transparent-wrapper resolution that picks `MyCard` over the
 *   inner `KLabel` so prop walking surfaces `cardLabel` (consumer)
 *   not `label` (internal binding).
 * - `iteration` is DOM-derived (querySelectorAll over the stamp) so
 *   it catches both native v-for (`<li v-for>`) and component v-for.
 *   Vue-runtime-based detection would miss the native case (the
 *   leaf instance is the owning SFC, not the iterated li).
 */
// Attribution type lives in ./bridge-types

// detectIteration / detectIterationViaStamp / detectIterationViaTracer
// live in ./tracer-attribution (imported above). They take
// `frameworkAdapter` as an explicit param (rather than closing over the
// module-scope binding above) since they live in a sibling module.

/**
 * Parse a `data-desde-own` value: `"<file>:<line>:<col> <sourceVersion>"`.
 *
 * Split on the LAST space, never the first — the version and the line/column
 * never contain one, but the FILE can (`ui drafts/Foo.vue`). Same convention
 * as `data-desde-bind:<prop>`, whose payload is base64 for the same reason.
 * A value with no space is still accepted as a bare loc, so an older plugin
 * (or a hand-written stamp) degrades to "coordinates, no version" instead of
 * failing to parse at all.
 */
function parseOwnStamp(
  raw: string,
): { loc: { file: string; line: number; column: number }; version?: string } | undefined {
  const sep = raw.lastIndexOf(" ")
  const locPart = sep >= 0 ? raw.slice(0, sep) : raw
  const version = sep >= 0 ? raw.slice(sep + 1) : ""
  const loc = parseSourceTag(locPart)
  if (!loc) return undefined
  return { loc, version: version || undefined }
}

export function attributeElement(el: Element): Attribution | undefined {
  const leafInst = frameworkAdapter.getOwningInstance(el)
  if (!leafInst) return undefined

  // Is `el` the COMPONENT ROOT of `leafInst`, or a native element inside it?
  // This gates how `authoredAt` is resolved (below) and `editTarget` (3).
  const mountRoot = frameworkAdapter.getInstanceMountRoot(leafInst)
  const isComponentRoot = !!mountRoot && mountRoot === el

  // (1) `el`'s own bytes-level source location.
  //     PRIMARY: `data-desde-src` (editor's injected source-tag plugin). It
  //     carries the EXACT template-AST column, which the edit service needs
  //     to locate the node. DOM-walk up to `el`'s own stamp, trusted only
  //     when the stamp's owning instance matches the leaf (cross-instance
  //     hits are slot-wrapper leaks). For a single-root component this also
  //     yields the inherited `<Tag>` callsite (attribute fallthrough), which
  //     is the right authored position for a component leaf.
  //     `data-desde-src` alone is NOT trustworthy on a component's ROOT
  //     element, and that is not an edge case — it is every single-root
  //     child component in the project. Vue applies a child's inherited
  //     attrs to its root vnode LAST (`cloneVNode(root, fallthroughAttrs)`),
  //     so the parent's `<Child data-desde-src="Parent.vue:11:5">` OVERWRITES
  //     the root element's own stamp. Reading it back gives the parent's
  //     callsite for an element authored in the child's file. The source-tag
  //     plugin therefore publishes the root's own coordinate a SECOND time
  //     under `data-desde-own`, a name it never writes onto a component tag, so
  //     fallthrough cannot reach it. Where nothing was overwritten the two
  //     describe the same AST node and are identical, which makes preferring
  //     `data-desde-own` a no-op everywhere except where it is the fix.
  let authoredAtLoc: { file: string; line: number; column: number } | undefined
  //     `data-desde-own` carries its own file version: the sibling `data-desde-v`
  //     on a polluted root belongs to the PARENT's file, so pairing the
  //     child's coordinates with it would defeat the stale-target guard.
  let ownVersion: string | undefined
  //     True only when `el` ITSELF is a rescued component root — the signal
  //     that its bytes are first-party and editable in their own file.
  let elIsOwnStampedRoot = false
  let cursor: Element | null = el
  while (cursor) {
    const ownRaw = (cursor as HTMLElement).dataset?.desdeOwn
    const raw = (cursor as HTMLElement).dataset?.desdeSrc
    if (ownRaw || raw) {
      const ownerInst = frameworkAdapter.getOwningInstance(cursor)
      if (ownerInst === leafInst) {
        const own = ownRaw ? parseOwnStamp(ownRaw) : undefined
        if (own) {
          authoredAtLoc = own.loc
          ownVersion = own.version
          elIsOwnStampedRoot = cursor === el
        } else if (raw) {
          authoredAtLoc = parseSourceTag(raw)
        }
      }
      break
    }
    cursor = cursor.parentElement
  }
  //     FALLBACK (zero-config substrates with no `data-desde-src`): the tracer's
  //     own recorded position for a NATIVE element (`el.__vnode`). Component
  //     ROOTS are excluded — the tracer would report the component's internal
  //     root line; `editTarget` (3) supplies the callsite instead. NOTE the
  //     tracer column is sourcemap-coarse for static-hoisted / mid-line nodes,
  //     so this degrades edit-targeting precision vs `data-desde-src` — which is
  //     exactly why it's the fallback, not the primary.
  if (!authoredAtLoc && !isComponentRoot) {
    authoredAtLoc = tracer.locFromElement(el) ?? undefined
  }

  // (2) Leaf instance's own vnode-stamp equivalent — the consumer's
  //     `<Tag>` location for `leafInst`. Always reliable when set
  //     (Vue stores `vnode.props` before applying inheritAttrs /
  //     multi-root fallthrough; React stores it on `_debugSource`),
  //     unset only when leafInst has no parent template (root App,
  //     router-view manufactured vnode).
  const leafVnodeStampRaw = frameworkAdapter.getCallSiteStamp(leafInst) ?? undefined
  const leafVnodeStampLoc = leafVnodeStampRaw
    ? parseSourceTag(leafVnodeStampRaw)
    : undefined

  // (3) editTarget priority depends on whether `el` is the COMPONENT
  //     ROOT of `leafInst` or just a native element inside it:
  //     - Component root: `leafVnodeStampLoc` IS the consumer's `<Tag>`
  //       position (e.g. where `<KCard>` is written in the parent
  //       template). That's the right edit point.
  //     - Native element inside `leafInst` (e.g. `<div class="enabled-row">`
  //       inside `AIGatewayAgentCreate`'s template): `leafVnodeStampLoc`
  //       is the *containing component's* callsite, which lives in a
  //       DIFFERENT file (the consumer of AIGatewayAgentCreate). Using
  //       it as editTarget would make every drag a cross-file move
  //       and silently refuse. `authoredAtLoc` (the element's own
  //       `data-desde-src`) IS the editable position.
  //     - Fallback if `authoredAtLoc` is in node_modules (library
  //       internals — user can't edit those): prefer the consumer's
  //       tag so prop edits land in the prototype-authored caller.
  //     (`mountRoot` / `isComponentRoot` computed above, before authoredAt.)
  //     - Component root WITH a `data-desde-own` rescue stamp: the root is a
  //       first-party element whose bytes we can point at exactly, so it
  //       takes the same branch as any other native element. Without this
  //       the click still resolves to the parent's `<Child/>` tag — often a
  //       self-closing tag with nothing editable on it — which is the
  //       user-visible half of the fallthrough defect. The callsite is not
  //       lost: `leafVnodeStampRaw` still carries it, prop fields carry
  //       their own `editTarget` (see `findEditableTextFields`), and the
  //       shell's manifest-first `attribute()` routes consumer props off
  //       `attributionContext`, none of which read this field.
  const authoredInLibrary =
    !!authoredAtLoc && authoredAtLoc.file.split("/").includes("node_modules")
  const preferOwnRoot = elIsOwnStampedRoot && !authoredInLibrary
  const editTargetLoc = isComponentRoot && !preferOwnRoot
    ? (leafVnodeStampLoc ?? authoredAtLoc)
    : (
        authoredAtLoc && !authoredInLibrary
          ? authoredAtLoc
          : (leafVnodeStampLoc ?? authoredAtLoc)
      )
  if (!editTargetLoc) return undefined
  const finalAuthoredAt = authoredAtLoc ?? editTargetLoc

  // (4) editableComponent: walk UP from leafInst finding the OUTERMOST
  //     instance whose vnode stamp matches the leaf's. Resolves
  //     transparent wrappers (MyCard wraps <KLabel/> as sole root —
  //     both share the App.vue:5 stamp; MyCard's `cardLabel` prop is
  //     the consumer-written one, KLabel's `label` is the internal
  //     binding).
  //
  // Cast to Record<string, unknown> at the boundary to preserve the
  // Attribution wire shape downstream consumers expect; the adapter
  // contract just guarantees we get back the same `unknown` we put in.
  let editableComponent: Record<string, unknown> = leafInst as Record<string, unknown>
  if (leafVnodeStampRaw) {
    let next = frameworkAdapter.getParentInstance(leafInst)
    while (next) {
      const nextRaw = frameworkAdapter.getCallSiteStamp(next)
      if (nextRaw !== leafVnodeStampRaw) break
      editableComponent = next as Record<string, unknown>
      next = frameworkAdapter.getParentInstance(next)
    }
  }

  const isLibrary = editTargetLoc.file.split("/").includes("node_modules")
  const iteration = detectIteration(el, leafInst, frameworkAdapter)

  // `getOwningInstance` walks up when `el` has no `__vueParentComponent`
  // (a static-stringified subtree — see the adapter). That recovers `el`'s
  // own `data-desde-src` for `editTarget`/`authoredAt` (always correct: the
  // source stamp is `el`'s own, and `isComponentRoot` can't be true for an
  // adopted static descendant, so `editTargetLoc` falls through to it). But
  // `leafInst` is then an ADOPTED ancestor, not `el`'s real owner — so the
  // instance-derived fields (`editableComponent` for prop editing,
  // `leafVnodeStampRaw`, `iteration`) could describe a wrapper/parent
  // (slot or static-root content), weakening the cross-instance guard.
  // Only expose them when `el` has its OWN direct pointer; for an adopted
  // static element we keep the source location but report no component
  // context. (Codex review P1.)
  // Asked through the adapter, not by reading `__vueParentComponent`.
  //
  // That property is Vue-only, so on a React substrate this was ALWAYS false
  // — silently blanking `editableComponent`, `leafVnodeStampRaw` and
  // `iteration` for every React selection, and disabling prop/iteration
  // targeting for a framework the adapter fully supports. The guard itself is
  // right (an adopted static descendant must not inherit a wrapper's props);
  // only the framework-specific way it asked was wrong.
  const hasDirectInstance = frameworkAdapter.hasOwnInstancePointer(el)
  return {
    // fileHash pairs the coordinates with the exact file version the DOM
    // was rendered from (data-desde-v). The server's stale-target guard
    // compares it against current disk content before splicing.
    //
    // `fileVersionFor` finds any element whose `data-desde-src` names the file,
    // which normally includes this one. It comes up empty for a component
    // whose whole template is a single element — that element's `data-desde-src`
    // was overwritten by the parent's callsite, so nothing in the DOM claims
    // the child's file. The rescue stamp carries the version for exactly that
    // case; it is the fallback, not the primary, because a `data-desde-src` hit
    // is the same value and covers every file, not just this one.
    editTarget: {
      ...editTargetLoc,
      fileHash:
        fileVersionFor(editTargetLoc.file) ??
        (authoredAtLoc?.file === editTargetLoc.file ? ownVersion : undefined),
    },
    authoredAt: finalAuthoredAt,
    // The CSS-rule anchor. Deliberately NOT derived from the two fields
    // above — see `resolveDomAnchor`'s note on why a rescued root makes
    // `authoredAt` unusable as a selector.
    domAnchor: resolveDomAnchor(el),
    editableComponent: hasDirectInstance
      ? editableComponent
      : ({} as Record<string, unknown>),
    leafVnodeStampRaw: hasDirectInstance ? leafVnodeStampRaw : undefined,
    iteration: hasDirectInstance ? iteration : undefined,
    isLibrary,
  }
}

export function getSourceLocation(el: Element): { file: string; line: number; column: number } | undefined {
  // Thin wrapper over `attributeElement`. Returns `authoredAt` —
  // where the bytes for `el` live in source. Kept as a convenience
  // for the few emission sites that don't need the full Attribution
  // object; sites that ship the wire shape (InspectionData,
  // OutlineNode, TableEdgeContextMenuPayload, HoverTarget) should
  // call `attributeElement` directly and emit all three fields
  // (`authoredAt`, `editTarget`, `isLibrary`).
  return attributeElement(el)?.authoredAt
}

/**
 * Compute iteration context for an element rendered by a framework loop
 * (Vue `v-for`, React `.map`, etc.). Thin wrapper over `attributeElement`,
 * which performs the same DOM-based detection: find the nearest
 * own-instance `data-desde-src` ancestor, count `document.querySelectorAll`
 * siblings with the same exact stamp, walk the vnode chain for the
 * per-iteration `:key` value.
 *
 * `expression` (the iteratee text) is left null at runtime — it lives in
 * the template source and requires AST parsing to recover. Phase 3+'s
 * static resolver reads it from the SFC when needed.
 *
 * React/Svelte: not implemented here; their bridges (when they ship)
 * supply their own equivalent.
 */
export function computeIterationContext(
  el: Element,
): {
  source: "v-for" | "map" | "each" | "unknown"
  key: string | number
  index: number
  siblingCount: number
  expression: string | null
} | undefined {
  return attributeElement(el)?.iteration
}

/**
 * Resolve the call-site source location of the nearest reused component
 * that *authors* `el` — the parent-template `<Tag>` for the SFC `el` was
 * written in. Used to offer a `'callsite'`-scoped delete (remove just that
 * one usage) instead of editing the component definition.
 *
 * Thin wrapper over `attributeElement`. Returns `editTarget` (the
 * consumer's `<Tag>` location), filtered out when its file equals
 * `authoredAt.file` — same-file usage (recursive component, or the
 * common case where the element is a native child of its authoring
 * SFC) isn't a distinct call site. New emission sites should call
 * `attributeElement` directly and ship `authoredAt` + `editTarget`
 * as separate wire fields without the filter.
 */
export function computeCallsiteLocation(
  el: Element,
  authoredAt: { file: string; line: number; column: number } | undefined,
): { file: string; line: number; column: number } | undefined {
  if (!authoredAt) return undefined
  const editTarget = attributeElement(el)?.editTarget
  if (!editTarget || editTarget.file === authoredAt.file) return undefined
  return editTarget
}

/**
 * Find the Vue component whose subTree root carries the resolved
 * `data-desde-src` ancestor for `el` — i.e. the component whose source
 * declaration would be patched by an edit. Walks up the DOM to the first
 * `data-desde-src`-bearing element, then defers to `detectOutlineComponent`
 * to resolve which component "owns" that element (preferring outermost
 * user-authored, then outermost named, mirroring the layers tree's logic).
 *
 * Why this exists: editor's edit dispatch resolves source location by
 * walking up DOM to the first `data-desde-src`. The leaf Vue instance
 * (`detectDirectComponent`) is often a library internal — KButton inside
 * a KDropdown, KCard inside a ProtoCatalogCard — that has no
 * `data-desde-src` of its own. Identifying the leaf in the inspector while
 * silently editing a different component is a footgun: prop-name overlap
 * lets it appear to work for some props and silently fail for others.
 * The editor adapter prefers this when present so the inspector
 * display, the manifest lookup, and the edit dispatch all agree.
 */
export function findEditTargetComponent(
  el: Element,
  precomputed?: {
    /** The nearest stamped ancestor (or `el` itself) the caller already resolved. */
    anchorEl: Element
    /** The caller's attribution, when it describes `anchorEl` — see below. */
    anchorAttribution: ReturnType<typeof attributeElement>
    /**
     * Whether `anchorAttribution` was computed FOR `anchorEl`. False in the
     * rare shape where `attributeElement(el)` succeeded through a vnode-prop
     * stamp on an element that carries no DOM stamp of its own (multi-root
     * children get no attribute fallthrough): the attribution then describes
     * `el`, not the anchor, and feeding it into the walk would hand
     * `findOutermostInstanceRootedAt` the wrong owner. Recomputed here for
     * that shape only.
     */
    attributionMatchesAnchor: boolean
  },
): FrameworkComponentInfo | null {
  // Walk DOM to the first source-mapped ancestor. The component label
  // is only meaningful for elements with known source positions; if
  // nothing in the chain carries `data-desde-src`, the click can't be
  // attributed to a source-side edit target. `inspectElement` passes the
  // walk + attribution it already performed so an inspection does the
  // anchor resolution exactly once.
  let cursor: Element | null
  if (precomputed) {
    cursor = (precomputed.anchorEl as HTMLElement).dataset?.desdeSrc ? precomputed.anchorEl : null
  } else {
    cursor = el
    while (cursor) {
      if ((cursor as HTMLElement).dataset?.desdeSrc) break
      cursor = cursor.parentElement
    }
  }
  if (!cursor) return null

  const attribution =
    precomputed && precomputed.attributionMatchesAnchor
      ? precomputed.anchorAttribution
      : attributeElement(cursor)
  if (!attribution) {
    // Non-Vue3 substrate (Vue2/Angular/Svelte/WC) — defer to the
    // legacy chain which has detectors for those frameworks.
    return detectOutlineComponent(cursor)
  }
  // The edit target the inspector should surface is the component ELEMENT the
  // owner's template wrote at the stamped coordinate — not the file owner
  // itself. `findOutermostInstanceRootedAt` resolves that through Vue's
  // root-chaining; the worked cases are documented once, on
  // `InspectionData.editTargetComponent`. On React the helper returns null
  // (no `__vueParentComponent`), which is also what the old `subTree.el`
  // guard produced for fibers — no change there.
  const callsite = findOutermostInstanceRootedAt(cursor, attribution.editableComponent)
  if (callsite) {
    return extractComponentInfo(callsite, true) ?? extractComponentInfo(callsite, false)
  }
  // No non-owner instance roots at the stamped node. The pre-F-08 guarantee
  // still applies: when the stamped node IS the owner's own render root,
  // the owner is the edit target (review round 2, finding B1 — dropping
  // this let the conversion's tree-leaf fallback surface a too-deep library
  // component for fragment-rooted children, where attribute fallthrough
  // cannot stamp the child's DOM).
  const owner = attribution.editableComponent
  const ownerRootEl = (owner.subTree as { el?: Element } | undefined)?.el
  if (ownerRootEl === cursor) {
    return extractComponentInfo(owner, true) ?? extractComponentInfo(owner, false)
  }
  return null
}

/**
 * Mirror of {@link EditableTextField} in `@/types/bridge`. Bridge runs in
 * the iframe with no access to shell types, so we redeclare the shape
 * locally — same pattern as {@link SourceLocation}, {@link IterationContext}.
 */
export interface EditableTextField {
  id: string
  label: string
  value: string
  kind: "dom-text" | "prop"
  propName?: string
  selector?: string
  /**
   * 0-based index of the specific text node within the selector's
   * childNodes to mutate. Set when the editable text is a text-node
   * sibling of element children (e.g. `<label>Default ACL<KTooltip/></label>`).
   * Omitted when the element has only the one text child (pure leaf) —
   * the dispatch can set `el.textContent` directly without losing
   * siblings.
   */
  textNodeIndex?: number
  readOnly?: boolean
  readOnlyReason?: string
  /**
   * Explicit dispatch target for the prop edit. Set by the ancestor
   * walk when the editable prop lives on a parent component's tag
   * (in the consumer SFC) rather than on the current selection.
   * Overrides the selection's own `editTarget` at dispatch time.
   */
  editTarget?: { file: string; line: number; column: number }
  /**
   * Original prop type. Lets the dispatcher coerce the user's string
   * input back to a number / boolean so the source emits `:step="1"`
   * (bound number) rather than `step="1"` (string attribute). Absent
   * means "string" (default).
   */
  valueType?: "string" | "number" | "boolean"
}

/**
 * Surface editable text fields for the inspector's "DOM" section. Two
 * same-component sources (the legacy upward ancestor-prop walk was
 * removed in the Phase 3 attribution cutover — see the NOTE below where
 * it used to run; that attribution is now manifest-first and shell-side):
 *  1. A plain DOM text leaf (`<div>Hello</div>`) — one entry, edited via
 *     `SET_ELEMENT_TEXT` + mutation capture (legacy path).
 *  2. Slot text whose leaf attributes to a library component's prop via
 *     `resolveLeafChildPropAttribution` (e.g. `<KLabel label="Email">`
 *     rendered as `<label><span>Email</span></label>`) — one `kind:"prop"`
 *     entry whose `editTarget` is the consumer's call-site stamp, edited
 *     deterministically via the `PropEdit` pipeline. Leaves that don't
 *     attribute fall back to `kind:"dom-text"` slot-text entries.
 *
 * Bound props (`:label="title"`) can't be detected from the bridge today;
 * the server-side `apply-prop-edit.ts` refuses to overwrite a non-literal
 * v-bind with a literal as the hard backstop.
 */
export function findEditableTextFields(
  el: Element,
  domTextValue: string | null,
): EditableTextField[] {
  const fields: EditableTextField[] = []

  if (domTextValue !== null) {
    fields.push({
      id: "dom-text",
      kind: "dom-text",
      label: "Text",
      value: domTextValue,
    })
  }

  const attribution = attributeElement(el)
  if (!attribution) return fields

  // Cross-walk label dedupe — both the slot-text loop (with child-
  // component prop attribution) and the upward-walk loop below can
  // emit `kind: "prop"` fields. Hoisted so both honor the same
  // "Text" / propName collisions.
  const seenLabels = new Set<string>()
  if (domTextValue !== null) seenLabels.add("Text")

  // Slot-text surfacing — walk the editable component's rendered
  // subtree for text leaves. Each leaf is run through child-component
  // prop attribution: if the leaf is rendered by a library
  // component's template and exactly one of that component's props
  // carries the leaf text, surface a named-prop field that dispatches
  // the deterministic prop-edit pipeline (with editTarget pointing at
  // the consumer's call-site stamp). Leaves that don't attribute fall
  // back to the legacy slot-text emission (Text (N) labels routed
  // through SET_ELEMENT_TEXT + server-side text-equality lookup).
  //
  // Walk root: the selected element's AUTHORED UNIT, resolved via the same
  // anchor `findSourceAnchorElement` gives the edit path — so discovery
  // starts from exactly the element an edit would write to. For an authored
  // element (carries `data-desde-src`) or a single-root component (its root
  // inherits the stamp via attribute fallthrough) this is `el` itself, so
  // the common case is unchanged. For an UNSTAMPED library-internal element
  // — clicking a `KCard`'s `.card-content` chrome, or a div deep inside a
  // `KEmptyState` — it resolves UP to the nearest authored unit, so the
  // selection surfaces that unit's editable text instead of a fragment of
  // it (or nothing). This was over-reaching the other way before the fix:
  // the walk rooted at the whole editable component, so any descendant
  // surfaced EVERY text leaf and parent/child showed identical fields.
  {
    const walkRoot: Element = findSourceAnchorElement(el)
    {
      const slotLeaves = findSlotTextLeaves(walkRoot)
      const seenSlotValues = new Set<string>()
      if (domTextValue !== null) seenSlotValues.add(domTextValue)
      let slotIdx = 0
      const slotTextLeafCount = slotLeaves.length
      for (const leaf of slotLeaves) {
        const trimmed = leaf.text.trim()
        if (trimmed.length === 0) continue
        if (seenSlotValues.has(trimmed)) continue
        seenSlotValues.add(trimmed)

        const propAttribution = resolveLeafChildPropAttribution(leaf.element, trimmed)
        if (propAttribution) {
          let label = propAttribution.propName
          if (seenLabels.has(label)) label = `${propAttribution.propName} (prop)`
          if (seenLabels.has(label)) continue
          seenLabels.add(label)
          // Drop a duplicate top-level "Text" field if the slot leaf
          // happens to also be the element's own textContent — same
          // motivation as the upward walk's identical guard.
          if (domTextValue !== null && trimmed === domTextValue) {
            const domIndex = fields.findIndex((f) => f.id === "dom-text")
            if (domIndex >= 0) fields.splice(domIndex, 1)
          }
          fields.push({
            id: `child-prop:${propAttribution.propName}@${propAttribution.stampRaw}`,
            kind: "prop",
            label,
            value: propAttribution.rawValue,
            propName: propAttribution.propName,
            editTarget: {
              ...propAttribution.editTarget,
              fileHash: fileVersionFor(propAttribution.editTarget.file),
            },
            valueType: propAttribution.valueType,
          })
          continue
        }

        fields.push({
          id: `slot-text:${leaf.selector}`,
          kind: "dom-text",
          label: slotTextLeafCount === 1 ? "Text" : `Text (${slotIdx + 1})`,
          value: trimmed,
          selector: leaf.selector,
          textNodeIndex: leaf.textNodeIndex,
        })
        slotIdx++
      }
    }
  }

  // NOTE (Phase 3 attribution cutover): the legacy upward ancestor-prop
  // emission walk used to live here. It walked UP the vnode chain and
  // surfaced any user-authored ancestor prop whose stringified value
  // string-matched a descendant text node of `el`. That string-match
  // heuristic was the OVER-ATTRIBUTION source — selecting a child element
  // leaked unrelated ancestor props onto it (e.g. an EntityFormBlock's
  // step/title/description appearing when a base-path select's parent div
  // was selected; the org-picker surfacing Ask-Kai/profile fields). That
  // attribution is now done shell-side by the manifest-first `attribute()`
  // function over `InspectionData.attributionContext`, which scopes to the
  // clicked element's own rendering rather than walking upward looking for
  // things to add. The same-component fields below (Walk 1 slot-text +
  // Walk 2 child-component prop attribution) are retained as the fallback
  // for plain template content `attribute()` declines (literal text,
  // interpolation, v-for rows).

  // Final dedupe — drop dom-text / slot-text leaves whose trimmed
  // value matches an emitted prop field's value. Without this the
  // inspector surfaces the same string twice (e.g. TEXT (2) and
  // TITLE both reading "Policy configuration") and the slot-text
  // entry is the wrong path for the designer to take — it bypasses
  // the iteration-scope dialog and doesn't enter the prop-edit
  // buffer. The earlier in-loop dedupe at the prop-emission sites
  // only catches the singular `id: "dom-text"` field; this final
  // pass also picks up `slot-text:*` entries from the slot-text
  // loop above. Prop wins because it routes through the
  // deterministic prop-edit pipeline.
  const propValues = new Set<string>()
  for (const f of fields) {
    if (f.kind === "prop") propValues.add(f.value.trim())
  }
  return fields.filter(
    (f) => f.kind === "prop" || !propValues.has(f.value.trim()),
  )
}

/**
 * Find editable text inside the component's rendered DOM. Walks the
 * subtree and emits a field for each element with exactly ONE
 * significant direct text-node child. Two shapes are covered:
 *
 *   1. Pure text leaf: `<span>Default ACL</span>` — childNodes = [text],
 *      no element siblings. The whole element is the editable unit.
 *   2. Text-with-element-siblings: `<label>Default ACL<KTooltip/></label>`
 *      — the slot text "Default ACL" is a direct text-node child of
 *      `<label>`, alongside the KTooltip element. KLabel and most
 *      design-system components surface their content this way. We
 *      emit a field with a `textNodeIndex` so the dispatch can mutate
 *      ONLY that text node (replacing `el.textContent` here would
 *      nuke the KTooltip sibling).
 *
 * "Significant" = non-empty after trimming; whitespace-only text
 * nodes are skipped. Multiple significant text-node children on one
 * element are ambiguous, so we skip the element-level emission and
 * recurse — each child element gets its own check.
 *
 * Excludes `data-prototype-flow` elements (editor's own DOM) and
 * caps depth + result count so a pathological tree doesn't run away.
 */
export function findSlotTextLeaves(
  root: Element,
): Array<{ text: string; selector: string; element: Element; textNodeIndex?: number }> {
  const out: Array<{ text: string; selector: string; element: Element; textNodeIndex?: number }> = []
  const MAX_LEAVES = 6
  const MAX_DEPTH = 12
  function visit(el: Element, depth: number): void {
    if (out.length >= MAX_LEAVES) return
    if (depth > MAX_DEPTH) return
    if ((el as HTMLElement).dataset?.prototypeFlow) return
    // Skip script/style — they're "leaf-like" but never editable text.
    const tag = el.tagName
    if (tag === "SCRIPT" || tag === "STYLE") return

    // Direct text-node children with non-empty trimmed content.
    let textChildIdx = -1
    let textChildContent = ""
    let multipleTextChildren = false
    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes[i]
      if (child.nodeType !== Node.TEXT_NODE) continue
      const text = (child.textContent ?? "").trim()
      if (text.length === 0) continue
      if (textChildIdx >= 0) {
        multipleTextChildren = true
        break
      }
      textChildIdx = i
      textChildContent = text
    }

    if (textChildIdx >= 0 && !multipleTextChildren) {
      let selector = ""
      try {
        selector = generateSelector(el)
      } catch { /* ignore */ }
      if (selector) {
        // textNodeIndex is omitted when the text is the element's
        // ONLY child (pure-leaf case) — the dispatch can set
        // `el.textContent` safely. Set otherwise so the dispatch
        // mutates only the targeted text node.
        const isPureLeaf = el.childNodes.length === 1
        out.push(
          isPureLeaf
            ? { text: textChildContent, selector, element: el }
            : { text: textChildContent, selector, element: el, textNodeIndex: textChildIdx },
        )
      }
      // Don't return — element children (an icon, a tooltip) may
      // themselves carry leaf text we want to expose too.
    }

    for (const child of Array.from(el.children)) {
      // The walk surfaces only text belonging to the SAME authored unit as
      // `root` (the selected element). A child that begins a DIFFERENT unit
      // ends the descent — its text belongs to it, not to `root`. The walk
      // root itself is always exempt (we inspect ITS subtree).
      if (child !== root && isAuthoredUnitBoundary(child)) continue
      visit(child, depth + 1)
    }
  }
  visit(root, 0)
  return out
}

// True when `el` IS the rendered mount root of its owning Vue component
// (i.e., crossing into it means crossing into that component's own
// template). Mirrors the boundary check `detectOutlineComponent` uses
// for the layers tree.
export function isComponentMountRoot(el: Element): boolean {
  const inst = frameworkAdapter.getOwningInstance(el)
  if (!inst) return false
  return frameworkAdapter.getInstanceMountRoot(inst) === el
}

// True when `el` begins a DIFFERENT authored unit than the element being
// inspected — the boundary the editable-text walk must not cross. This is
// the discovery-side complement of `findSourceAnchorElement`'s walk UP to
// the nearest stamped ancestor: a text node's authoring owner is its
// nearest stamped (or component-root) ancestor, so an element surfaces
// exactly the text whose nearest such ancestor IS that element. Two
// complementary signals define a boundary:
//   1. Component mount root — its DOM is rendered by another component's
//      template (a nested library sub-component, or a user child SFC), not
//      by the inspected element's own authoring.
//   2. Own `data-desde-src` stamp — a separately-selectable authored element
//      in SOME SFC template: a sibling div, or content slotted in from a
//      parent (stamped with the parent's file). Either way its text is its
//      own, not the inspected element's.
// Presence-based, not ownership-based, so slotted-in content (owned by a
// different instance) is still treated as a boundary. Library-internal DOM
// is never stamped (source-tag-plugin skips node_modules) and is not a
// mount root, so the walk still descends through a selected library
// component's own render tree to reach its prop-rendered text — that path
// is what `resolveLeafChildPropAttribution` turns into named-prop fields.
export function isAuthoredUnitBoundary(el: Element): boolean {
  return isComponentMountRoot(el) || !!(el as HTMLElement).dataset?.desdeSrc
}

// Walk up from `el` to the nearest ancestor carrying `data-desde-src`.
// Used by SET_ELEMENT_TEXT so a slot-text edit on an internal wrapper
// (no own `data-desde-src`) resolves against the enclosing user-authored
// tag instead of failing with `resolutionKind: "ancestor"`. Falls back
// to `el` when no ancestor is found — emit will reject with a clean
// "no source-location ancestor" message in that case.
export function findSourceAnchorElement(el: Element): Element {
  let cur: Element | null = el
  while (cur) {
    if ((cur as HTMLElement).dataset?.desdeSrc) return cur
    cur = cur.parentElement
  }
  return el
}

/**
 * Count the elements a `[data-desde-src="<loc>"]` selector matches RIGHT NOW.
 *
 * The attribute selector is the primary because it is the exact predicate the
 * emitted CSS rule will use — counting by any other means would verify
 * something adjacent to the rule rather than the rule. The manual scan is the
 * fallback for a value that can't be expressed as a quoted CSS string (a file
 * path with an unbalanced escape); returning 0 there would refuse a live
 * anchor, which is the opposite of this function's purpose.
 */
function countAnchorMatches(loc: string): number {
  const escaped = loc.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  try {
    return document.querySelectorAll(`[data-desde-src="${escaped}"]`).length
  } catch {
    let n = 0
    for (const candidate of Array.from(
      document.querySelectorAll("[data-desde-src]"),
    )) {
      if ((candidate as HTMLElement).dataset?.desdeSrc === loc) n++
    }
    return n
  }
}

/**
 * The coordinate a `[data-desde-src="…"]` CSS rule can be anchored on for `el` —
 * read off the LIVE DOM, and verified against it.
 *
 * This answers a different question from {@link attributeElement}'s
 * `authoredAt`, and conflating the two is what broke the scoped-css-override
 * lane (`tasks/dev-server-hosts.md` § 9g.8):
 *
 *   - `authoredAt` answers "where do this element's bytes live in source?".
 *     On a component root it deliberately prefers the `data-desde-own` rescue
 *     stamp, because Vue's attribute fallthrough overwrote the root's own
 *     `data-desde-src` with the PARENT's callsite. That is the right answer for
 *     opening a file or splicing a prop.
 *   - `domAnchor` answers "which attribute value is literally on an element
 *     in this document?". For a CSS rule that is the only answer that can
 *     match anything — and on a rescued root the rescue stamp matches
 *     nothing, because it was never written back onto the element.
 *
 * The two coincide everywhere except a component root, which is also why the
 * defect survived: the divergence is invisible on the control cases and
 * total on every single-root child component.
 *
 * `matchCount` is the live count for the emitted rule head. A caller must
 * treat 0 as a refusal — a rule that matches nothing is a silent no-op that
 * still writes bytes into the user's source file.
 */
export interface DomAnchor {
  file: string
  line: number
  column: number
  /** Elements matching `[data-desde-src="<file>:<line>:<column>"]` right now. */
  matchCount: number
  /** `direct` = `el`'s own attribute; `ancestor` = nearest stamped ancestor. */
  resolution: "direct" | "ancestor"
}

export function resolveDomAnchor(el: Element): DomAnchor | undefined {
  const anchorEl = findSourceAnchorElement(el)
  const raw = (anchorEl as HTMLElement).dataset?.desdeSrc
  if (!raw) return undefined
  const loc = parseSourceTag(raw)
  if (!loc) return undefined
  // Count against the RECONSTRUCTED value, not `raw`: the applicator builds
  // the rule head from the parsed coordinates, so that is the string whose
  // match count decides whether the rule is alive.
  const emitted = `${loc.file}:${loc.line}:${loc.column}`
  return {
    ...loc,
    matchCount: countAnchorMatches(emitted),
    resolution: anchorEl === el ? "direct" : "ancestor",
  }
}

export function inspectElement(el: Element): Record<string, unknown> {
  const computed = window.getComputedStyle(el)
  const rawValues = buildRawValueMap(el)

  let styles: InspectionStyleCategory[] = []
  try {
    for (const category of STYLE_CATEGORIES) {
      const properties: InspectionStyleProperty[] = []
      for (const prop of category.properties) {
        const value = computed.getPropertyValue(prop).trim()
        if (!value || isDefaultValue(prop, value)) continue
        const rawValue = rawValues.get(prop)
        properties.push({ name: prop, value, rawValue: rawValue && rawValue !== value ? rawValue : undefined })
      }
      if (properties.length > 0) {
        styles.push({ name: category.name, properties })
      }
    }
  } catch (e) {
    console.warn("[Desde Inspector] style extraction failed:", e)
  }

  let tokens: InspectionDesignToken[] = []
  try {
    tokens = extractDesignTokens(el, computed)
  } catch (e) {
    console.warn("[Desde Inspector] token extraction failed:", e)
  }

  const rect = el.getBoundingClientRect()
  const boxModel: InspectionBoxModelData = {
    width: rect.width,
    height: rect.height,
    margin: {
      top: parseFloat(computed.marginTop) || 0,
      right: parseFloat(computed.marginRight) || 0,
      bottom: parseFloat(computed.marginBottom) || 0,
      left: parseFloat(computed.marginLeft) || 0,
    },
    border: {
      top: parseFloat(computed.borderTopWidth) || 0,
      right: parseFloat(computed.borderRightWidth) || 0,
      bottom: parseFloat(computed.borderBottomWidth) || 0,
      left: parseFloat(computed.borderLeftWidth) || 0,
    },
    padding: {
      top: parseFloat(computed.paddingTop) || 0,
      right: parseFloat(computed.paddingRight) || 0,
      bottom: parseFloat(computed.paddingBottom) || 0,
      left: parseFloat(computed.paddingLeft) || 0,
    },
    content: {
      width: rect.width - (parseFloat(computed.paddingLeft) || 0) - (parseFloat(computed.paddingRight) || 0) - (parseFloat(computed.borderLeftWidth) || 0) - (parseFloat(computed.borderRightWidth) || 0),
      height: rect.height - (parseFloat(computed.paddingTop) || 0) - (parseFloat(computed.paddingBottom) || 0) - (parseFloat(computed.borderTopWidth) || 0) - (parseFloat(computed.borderBottomWidth) || 0),
    },
  }

  let component: FrameworkComponentInfo | null = null
  try {
    component = detectFrameworkComponent(el)
  } catch (e) {
    console.warn("[Desde Inspector] framework detection failed:", e)
  }

  let componentTree: ComponentTreeNode[] | undefined
  try {
    if (component?.framework === "vue") {
      const tree = buildVue3ComponentTree(el)
      if (tree.length > 0) componentTree = tree
    } else if (component?.framework === "react") {
      const tree = buildReactComponentTree(el)
      if (tree.length > 0) componentTree = tree
    }
  } catch (e) {
    console.warn("[Desde Inspector] component tree failed:", e)
  }

  let selector = ""
  try {
    selector = generateSelector(el)
  } catch (e) {
    console.warn("[Desde Inspector] selector generation failed:", e)
  }

  let directComponent: FrameworkComponentInfo | null = null
  try {
    directComponent = detectDirectComponent(el)
  } catch { /* ignore */ }

  // Resolved after `attribution` below: the callsite extraction reuses the
  // single anchor walk + attributeElement call instead of redoing both
  // (review finding E1 — the naive shape ran attributeElement three times
  // per inspection on exactly the library-internal clicks F-08 fixes).
  let editTargetComponent: FrameworkComponentInfo | null = null

  // Capture inner text only when the element has a single text child
  // (a leaf-text node). Mixed-content elements (icon + text, etc.)
  // need a different editing UX; the inspector V1 only shows text
  // when it can map to a single editable string.
  //
  // Local only — this is the seed for `editableTexts`, not a wire field.
  // The deprecated `InspectionData.textContent` mirror was removed
  // 2026-08-04 now that every consumer reads `editableTexts`.
  let leafText: string | null = null
  if (
    el.childNodes.length === 1 &&
    el.firstChild?.nodeType === Node.TEXT_NODE
  ) {
    leafText = (el.firstChild.textContent ?? "").trim() || null
  }

  let editableTexts: EditableTextField[] = []
  try {
    editableTexts = findEditableTextFields(el, leafText)
  } catch (e) {
    console.warn("[Desde Inspector] editable text discovery failed:", e)
  }

  // Single attribution lookup so we don't recompute it across the
  // three wire fields and the iteration context.
  let attribution: ReturnType<typeof attributeElement> = undefined
  try { attribution = attributeElement(el) } catch { /* leave undefined */ }
  // Library-internal markup (no stamp of its own) attributes to nothing —
  // right for the ELEMENT, but the click still has an edit target: the
  // nearest stamped ancestor's coordinate is the callsite the consumer
  // wrote (`<KDropdown ...>` in a first-party template), and that is where
  // a prop edit on the surfaced callsite component splices. Without this,
  // the F-08 component view carried no `editTarget` and every prop edit
  // refused with "PropEdit requires target.editTarget". Iteration context
  // rides along deliberately: the ancestor callsite sits in the same loop
  // row as the clicked descendant, and narrowing it back out would silently
  // re-scope row edits. The element's own stamp state still travels
  // separately as `selfStamped`.
  let attributionFromAncestor = false
  let anchorEl: Element = el
  try { anchorEl = findSourceAnchorElement(el) } catch { /* keep el */ }
  if (!attribution && anchorEl !== el) {
    try {
      attribution = attributeElement(anchorEl)
      attributionFromAncestor = attribution !== undefined
    } catch { /* leave undefined */ }
  }
  try {
    editTargetComponent = findEditTargetComponent(el, {
      anchorEl,
      anchorAttribution: attribution,
      // True when the attribution describes the anchor node itself: either
      // the anchor IS the element, or the ancestor fallback computed it.
      // False only for the vnode-prop-stamp shape, where the attribution
      // succeeded for `el` while the anchor is a different node.
      attributionMatchesAnchor: anchorEl === el || attributionFromAncestor,
    })
  } catch { /* ignore */ }

  // Phase 2d (dark-mode): build the manifest-first AttributionContext
  // alongside the legacy attribution. Optional — when buildAttribution-
  // Context can't identify an owning instance it returns null, and
  // the shell falls back to the legacy attribution path for that
  // selection. Try/catch defensively so a bug in the new extraction
  // can't break the inspector entirely.
  let attributionContext: ReturnType<typeof buildAttributionContext> | undefined
  try {
    attributionContext = buildAttributionContext(el, frameworkAdapter) ?? undefined
  } catch (e) {
    console.warn("[Desde Inspector] buildAttributionContext failed:", e)
  }

  return {
    tagName: el.tagName.toLowerCase(),
    id: el.id || "",
    classes: Array.from(el.classList),
    editableTexts,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
    styles,
    tokens,
    boxModel,
    component: component || undefined,
    directComponent: directComponent || undefined,
    componentTree,
    selector,
    pageRoute: window.location.pathname || undefined,
    pageSourceFile: getPageSourceFile() || undefined,
    authoredAt: attribution?.authoredAt,
    editTarget: attribution?.editTarget,
    // NOT gated on attribution succeeding — and this is the whole point.
    //
    // `attributeElement` returns undefined when it cannot find an editable
    // source position (`if (!editTargetLoc) return undefined`), which is the
    // right answer for an EDIT: there are no bytes to mutate. MEASURED on
    // @mui/material, `tasks/dev-server-hosts.md` § 9g.2 — clicking
    // `.MuiAlert-message` yields `editTarget null, authoredAt null`, because
    // the attribution walk only accepts an ancestor's stamp when the ancestor
    // and the leaf belong to the SAME component instance, and on React those
    // are different fibers.
    //
    // A CSS anchor needs a strictly weaker property: not "which file's bytes
    // do I mutate" but "which attribute value is on an element in this
    // document". `resolveDomAnchor` answers that with its own instance-free
    // walk. Reading it only out of a successful attribution made the lane
    // refuse exactly the case it exists for — an element inside a component
    // nobody can edit. Caught by the live React smoke, not by any unit test,
    // because the fact lives in a browser.
    //
    // `??` and not a second unconditional call: when attribution succeeded it
    // already holds the result of `resolveDomAnchor(el)` for this same
    // element, so the anchor and its match count still come from ONE call
    // (§ 9g.9's producer-discipline constraint).
    // When the attribution came from the ANCESTOR fallback, its domAnchor
    // describes the ancestor — including `resolution: "direct"`, which the
    // "This page" scoped-CSS builder reads as "no descendant qualifier
    // needed" and would write a rule that styles the whole callsite element
    // instead of the clicked child (review finding C1). The anchor for the
    // CLICKED element must come from its own resolveDomAnchor walk, which
    // correctly reports `resolution: "ancestor"`.
    domAnchor:
      (attributionFromAncestor ? undefined : attribution?.domAnchor) ?? resolveDomAnchor(el),
    isLibrary: attribution?.isLibrary,
    // Whether the element ITSELF is stamped. Library-internal markup is not
    // (its anchor comes from an ancestor), and the shell's element-vs-
    // component split keys off exactly that — see InspectionData.selfStamped.
    selfStamped: !!(el as HTMLElement).dataset?.desdeSrc,
    editTargetComponent: editTargetComponent || undefined,
    iterationContext: attribution?.iteration,
    attributionContext,
  }
}
