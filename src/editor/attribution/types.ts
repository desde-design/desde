/**
 * Types for the manifest-first attribution pipeline.
 *
 * Two roles:
 *
 * - {@link AttributionContext} is what the BRIDGE extracts from the
 *   live iframe runtime (Vue component chain, vnode props, clicked
 *   element selector relative to mount root) and ships to the shell
 *   via postMessage. It contains no Vue instances directly — only
 *   serializable identity + position info.
 *
 * - {@link AttributionResult} is what the SHELL produces by running
 *   `attribute(context, registry)` and ships back to the bridge. It
 *   describes what the click means in source terms, and what the edit
 *   destination is.
 *
 * The split keeps Vue-runtime introspection in the bridge (where it
 * has to live) and manifest-driven reasoning in the shell (where the
 * registry already lives). See `tasks/attribution-rewrite.md` for the
 * Phase 2 architecture decision (Option A — shell-side attribution).
 */

/** "file:line:column" — same shape `data-desde-src` and `data-desde-bind` carry. */
export interface SourceLoc {
  file: string
  line: number
  column: number
}

/**
 * The runtime snapshot the bridge ships to the shell. Built per click —
 * every field is what was true at extraction time and must not be relied
 * on past the postMessage roundtrip (the DOM may have re-rendered).
 */
export interface AttributionContext {
  /** What the user clicked, identified by its position within the owning component. */
  clickedElement: ClickedElementContext

  /**
   * The Vue component chain, walking from the owning component (index 0,
   * innermost — the component whose template rendered the clicked element)
   * outward toward the app root. Bounded at extraction time to keep the
   * postMessage payload small; typically 3–6 entries is plenty for any
   * realistic indirection chain.
   *
   * For `<UiInput label="Path">` clicking "Path": [UiLabel, UiInput, App, ...].
   * Attribution walks this chain looking for forward hints that explain
   * how the leaf's prop/slot got there.
   */
  componentChain: ComponentChainEntry[]
}

/**
 * Identifies the clicked element by its relationship to the owning
 * component's rendered DOM. The bridge composes the selector against
 * the live DOM at extraction time; the shell matches `RenderingHint`s
 * against it without needing to re-query the DOM.
 */
export interface ClickedElementContext {
  /**
   * CSS selector rooted at `componentChain[0]`'s mount root. The shell
   * tests `RenderingHint.domTarget.selector` against this string for
   * equality (V1) or selector containment (future) to identify which
   * hint matches.
   *
   * `':root'` means the clicked element IS the mount root.
   */
  selectorWithinMountRoot: string

  /**
   * Live text content of the clicked element (or the specific text node
   * the bridge targeted). Used for verification — attribution can
   * cross-check against rendered prop values to catch manifest drift
   * (selector matched a hint but the text doesn't equal the prop value).
   */
  textContent?: string

  /**
   * Text contributed ONLY by the element's direct child text nodes —
   * excludes text rendered by nested child elements. For slot-text
   * edits this is the load-bearing value: a library component like
   * `<UiLabel :info="…">Paths</UiLabel>` renders the slot text ("Paths")
   * as a direct text node AND an `:info` tooltip as a sibling `<div>`
   * inside the same `<label>`, so `textContent` over-captures
   * ("PathsA list of paths that match…"). The slot-text applicator
   * matches `before` against the source between the tags ("Paths"), so
   * the over-captured value would never match. `attribute()` uses
   * `ownText` for slot terminals when present, falling back to
   * `textContent` only when `ownText` is undefined (legacy / unset).
   */
  ownText?: string

  /**
   * When the click targeted an attribute (e.g., editing `placeholder`
   * via the inspector), the attribute name and current value.
   */
  attributeName?: string
  attributeValue?: string

  /**
   * Click-time selector-uniqueness signal (Phase 5 Task 3 of the grounding
   * rearchitecture — carry-forward I1). The bridge scopes a single
   * `querySelectorAll(selectorWithinMountRoot)` to the owning component's
   * mount root right after computing the selector, and records whether it
   * matched exactly one element:
   *
   * - `true` — the selector is unique within this mount root; a
   *   `RenderingHint.domTarget.selector` string-match against it is trusted
   *   as-is (today's behavior).
   * - `false` — the selector matches more than one element in this mount
   *   root, so a hint keyed to it may be pointing at the wrong instance.
   *   `attribute()` downgrades an otherwise-matching trusted dom hit to a
   *   refuse instead of returning `direct`/`cross-file`, and `detectDrift`
   *   emits a `selector-ambiguous` signal for the same condition.
   * - `undefined` — not computed (no mount root resolvable, an older
   *   bridge build that predates this field, or a substrate where the
   *   query itself failed). MUST behave EXACTLY as before this field
   *   existed — no regression for substrates that can't compute it.
   */
  soleMatchWithinMountRoot?: boolean
}

/**
 * One link in the Vue component chain. Identifies a component instance
 * by what the shell needs to look up its manifest and read its props —
 * NOT by direct instance reference (instances don't serialize).
 */
/**
 * The placeholder {@link ComponentChainEntry.name} carries when the runtime could
 * not identify the component at all — no `__name`, no source file to derive a
 * basename from (`readComponentName` in
 * `src/bridge/build-attribution-context.ts`).
 *
 * The chain entry legitimately needs a placeholder: dropping the entry would
 * break the chain's parent/child indices, which attribution walks. But the
 * placeholder is not a component name, so it can never match a manifest — and
 * the shell used to fetch it anyway, producing a guaranteed
 * `GET /api/editor/manifest?name=<anonymous> → 404` on ordinary selection (F9,
 * the only console error in two live sessions).
 *
 * Declared here, in the module that owns the field's vocabulary, so the guards
 * that must recognise it (`RemoteManifestSource.getComponent`,
 * `CachedManifestLookup`) and the bridge that produces it agree by construction
 * rather than by two matching string literals. `build-attribution-context.test.ts`
 * asserts the bridge's fallback still equals this value.
 */
export const NON_IDENTIFYING_COMPONENT_NAME = '<anonymous>'

/**
 * Can this name possibly identify a component in a manifest registry?
 *
 * False for the anonymous placeholder and for empty/whitespace — neither can
 * resolve, so a lookup for one is pure waste (a network round-trip and a 404 in
 * the console). A guarded skip is a CONFIRMED miss, not a failed fetch: callers
 * must record it as "resolved, nothing there" so drift detection's
 * `hasFailedFetch` gate keeps meaning "we never found out".
 */
export function isIdentifyingComponentName(name: string): boolean {
  return name.trim().length > 0 && name !== NON_IDENTIFYING_COMPONENT_NAME
}

export interface ComponentChainEntry {
  /**
   * Component name as it appears in the manifest registry, or
   * {@link NON_IDENTIFYING_COMPONENT_NAME} when the runtime could not name the
   * component (see that constant — such an entry never resolves to a manifest).
   */
  name: string

  /**
   * Import path (e.g., `@acme/design-system`). Disambiguates components
   * with colliding names across libraries. Optional — V1 lookup uses
   * name-only and trusts the registry's first-source-wins resolution.
   */
  importPath?: string

  /**
   * `data-desde-src` value on the vnode the PARENT created of this
   * component. Read from `instance.vnode.props["data-desde-src"]`. This is
   * the consumer's call-site stamp — where in user source the
   * `<ComponentName>` tag lives. Absent for the root component (no
   * parent stamped it) and for library-internal renders (no user
   * source position exists).
   */
  consumerSourceLoc?: SourceLoc

  /**
   * Did this component's NESTING parent also RENDER it?
   *
   * The two come apart for one shape, and that shape is why the field
   * exists: a component the user passes as slot/children content is nested
   * inside the component it was handed to, but authored by the component
   * that wrote it. Both frameworks report the nesting parent as `.parent`,
   * so the chain alone cannot tell "my parent rendered me" from "my parent
   * was handed me" — and only the first case licenses a parent's manifest
   * to describe what this component displays.
   *
   * Supplied by `FrameworkRuntimeAdapter.getRenderOwnerInstance` (Vue:
   * `vnode.ctx`; React: `fiber._debugOwner`), NOT inferred from source
   * paths. Path inference was tried and is wrong twice over: a
   * `data-desde-src` stamp can be inherited through a framework's attribute
   * fallthrough onto a component that did not author it, and the
   * definition-file path it would be compared against does not exist at all
   * on React.
   *
   * `undefined` means UNKNOWN — the adapter could not say (production
   * build, unsupported substrate, older bridge). It does NOT mean false.
   * Consumers must decide explicitly what to do with unknown; see
   * `walkForward` in `attribute.ts`, which refuses the forward hop, because
   * a lost hint degrades to the LLM lane while a wrong hop edits the wrong
   * source.
   */
  renderedByParent?: boolean

  /**
   * Subset of vnode props the bridge thought worth shipping. Includes
   * any prop whose value might be referenced by attribution (literal
   * strings/numbers/booleans). Excludes function props, slot contents,
   * Vue internals (`__*`, `key`, `ref`). Always a copy, never a live
   * reference to instance state.
   */
  consumerVnodeProps?: Record<string, ConsumerPropValue>
}

/**
 * What a consumer passed for a prop, plus whether it was a literal or
 * a binding. The compile-time `:prop` source stamp (`data-desde-bind:NAME`)
 * is what distinguishes the two — present means binding, absent means
 * literal.
 */
export type ConsumerPropValue =
  | { kind: 'literal'; value: string | number | boolean }
  | {
      kind: 'binding'
      /** Resolved runtime value (for display / verification). */
      value: string | number | boolean | null
      /**
       * Source location of the bound expression (from
       * `data-desde-bind:NAME`). When present, attribution can route
       * `cross-file` to the binding's definition site; when absent,
       * the binding falls through to LLM.
       */
      bindingLoc?: SourceLoc
      /**
       * The expression source text, when the compile stamp captured it.
       * Used to classify bindings into `ref` / `parent-prop` / `computed`
       * for cross-file routing.
       */
      expression?: string
      /**
       * Identifier roots that are `v-for` iteration variables in scope at
       * the binding site — e.g. `["option"]` for `:label="option.label"`
       * inside `v-for="option in options"`. A v-for variable has NO
       * standalone definition (it's bound to an array element), so treating
       * `option.label` as a `cross-file: ref` would point the edit at a
       * non-existent `option` declaration. When the bound expression's root
       * identifier is one of these, attribution must route AWAY from
       * `cross-file: ref` (to LLM today; to `cross-file: v-for-data` once
       * that path exists). Absent means "not in a loop / unknown", which
       * preserves today's behavior. Populated by the bridge / compile stamp
       * when v-for scope is detectable (deferred — see
       * `tasks/attribution-rewrite.md` case 6).
       */
      loopVariableRoots?: string[]
    }

// ──────────────── AttributionResult ────────────────

export type AttributionResult =
  | AttributionDirect
  | AttributionCrossFile
  | AttributionLlm
  | AttributionRefuse

/**
 * Where the edited input renders in the owning component's DOM — the
 * manifest `dom` hint that matched the clicked element, run *forward* as a
 * prop→DOM map. This is the "oracle for free" Tier-2 edit verification reads
 * back (see tasks/editor-edit-verification.md). The `selector` is rooted at
 * the owning component's mount root (`':root'` = the mount root itself), so
 * the shell composes the absolute read-back selector from the clicked
 * element's selector.
 */
export interface RenderSite {
  /** Selector within the owning component's mount root (`':root'` = mount root). */
  selector: string
  field: 'textContent' | 'attribute' | 'innerHTML'
  /** Present when `field === 'attribute'`. */
  attribute?: string
}

export interface AttributionDirect {
  kind: 'direct'
  /** File the edit will rewrite. */
  targetFile: string
  /** Position of the `<Tag>` (for prop edits) or the slot text (for slot edits). */
  sourceLoc: SourceLoc
  editKind: 'prop' | 'slot'
  /** Required when `editKind === 'prop'`. */
  propName?: string
  /** Required when `editKind === 'slot'`. */
  slotName?: string
  /** Current value (for display in the inspector and for `before` verification). */
  currentValue: string
  valueType: 'string' | 'number' | 'boolean'
  /** Where the value renders in the DOM (Tier-2 verification read-back target). */
  renders?: RenderSite
}

export interface AttributionCrossFile {
  kind: 'cross-file'
  /** File the edit will rewrite (different from the consumer's file). */
  targetFile: string
  /** Position of the editable expression at the target. */
  sourceLoc: SourceLoc
  pattern: 'ref' | 'parent-prop' | 'v-for-data' | 'imported-const'
  currentValue: string
  meta: CrossFileMeta
  /** Where the value renders in the DOM (Tier-2 verification read-back target). */
  renders?: RenderSite
}

export interface CrossFileMeta {
  /** Identifier being edited (variable, prop, key) — for the inspector descriptor. */
  identifier: string
  /** Number of distinct call sites that read this identifier; ≥1. */
  useCount?: number
  /** Pattern-specific: for `parent-prop`, which prop name on the parent. */
  propName?: string
}

export interface AttributionLlm {
  kind: 'llm'
  /** Rough latency expectation surfaced to the user. */
  estimatedSeconds: number
  /** Why deterministic paths refused — for the inspector descriptor. */
  reason: string
}

export interface AttributionRefuse {
  kind: 'refuse'
  /** Why nothing useful can be edited here. */
  reason: string
  /** Actionable hint, when one exists. */
  suggestion?: string
}

// ──────────────── Manifest lookup contract ────────────────

/**
 * Minimal lookup interface the attribution function depends on. The
 * shell typically supplies a wrapper over `ComponentManifestSource`
 * (or `CompositeManifestSource`); tests supply an in-memory map.
 *
 * Returning null means "no manifest for this component" — attribution
 * degrades to heuristic behavior for that case.
 */
export interface ManifestLookup {
  getByName(name: string, importPath?: string): import('../core').ComponentManifest | null
}
