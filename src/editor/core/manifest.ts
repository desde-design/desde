/**
 * Normalized component metadata model for editor's inspector. Adapters
 * convert their framework-and-design-system-specific extractor output into
 * `ComponentManifest`s; the inspector consumes these without caring which
 * adapter produced them.
 *
 * Cross-framework conventions (slots vs. children, callback props vs. events,
 * optional-state filtering, inherited platform-prop filtering, variant
 * grouping) live in {@link ../../../docs/_archive/composer-cross-framework-check.md}.
 * Adapter implementations MUST honor these conventions.
 */

export type FrameworkId = 'vue3' | 'react' | (string & {})

/**
 * Any design system's id — `'acme-ds'`, `'material-ui'`, `'naive-ui'`,
 * whatever a customer onboards.
 *
 * Deliberately NOT `'acme-ds' | (string & {})`, which is how this was
 * written until 2026-08-09. That idiom accepts any string, so it never
 * constrained anything — its only effect was to offer `'acme-ds'` as the
 * one autocomplete suggestion, in a core module CLAUDE.md requires to stay
 * design-system-neutral. `FrameworkId` keeps its union because those literals
 * are load-bearing: adapters branch on `'vue3'` vs `'react'`. Nothing branches
 * on a design-system id.
 */
export type DesignSystemId = string

export type ManifestValue =
  | string
  | number
  | boolean
  | null
  | ManifestValue[]
  | { [key: string]: ManifestValue }

/**
 * How the inspector should render a prop (or slot/event surfaced as a prop).
 *
 * - `'event'` — function-typed prop. React adapters use this to fold callback
 *   props (`onClick`, etc.) into `props[]` rather than populating `events[]`.
 * - `'slot'` — content-rendering prop. React adapters use this for `children`,
 *   `asChild`, render props, etc., in lieu of populating `slots[]`.
 * - Other kinds are framework-neutral.
 */
export type ControlKind =
  | 'boolean'
  | 'finite-choice'
  | 'text'
  | 'number'
  | 'token'
  | 'object'
  | 'array'
  | 'function'
  | 'slot'
  | 'event'
  | 'unknown'

export type DefaultValueSource = 'runtime' | 'documentation' | 'registration'

export interface SourceDeclaration {
  file: string
  range?: [number, number]
}

export interface ManifestSource {
  framework: FrameworkId
  designSystem: DesignSystemId
  extractor: string
  declarations?: SourceDeclaration[]
}

export interface ControlOption {
  label: string
  value: ManifestValue
  description?: string
  deprecated?: boolean
}

/**
 * Describes how the inspector renders a prop.
 *
 * For `kind: 'finite-choice'`, adapters MUST drop `'undefined'` (Vue optional
 * unions) and `'null'` (cva-style React variants) from `options`. The unset
 * state is communicated via `required: false` on the parent prop, never as a
 * value-list member.
 */
export interface ManifestControl {
  kind: ControlKind
  options?: ControlOption[]
  valueType?: string
  tokenGroup?: string
}

export interface ManifestDefaultValue {
  value: ManifestValue
  source: DefaultValueSource
}

export interface ComponentPropManifest {
  name: string
  type: string
  required: boolean
  description?: string
  deprecated?: boolean | string
  category?: string
  defaultValue?: ManifestDefaultValue
  control: ManifestControl
  source?: ManifestSource
}

/**
 * A named slot (Vue-style). Vue adapters populate from `defineSlots<>()`.
 * React adapters typically leave `slots[]` empty and surface `children` /
 * `asChild` / render props as ordinary props with `control.kind === 'slot'`.
 */
export interface ComponentSlotManifest {
  name: string
  description?: string
  required?: boolean
  scope?: ComponentPropManifest[]
  source?: ManifestSource
}

/**
 * A first-class event emission (Vue-style). Vue adapters populate from
 * `defineEmits<>()`. React adapters typically leave `events[]` empty and
 * fold callback props into `props[]` with `control.kind === 'event'`,
 * because React expresses events as function-typed props.
 */
export interface ComponentEventManifest {
  name: string
  description?: string
  payloadType?: string
  payload?: ComponentPropManifest[]
  source?: ManifestSource
}

/**
 * Explicit variant axis surfaced for design-system-aware grouping in the
 * inspector. Populated when the design system has machine-readable variant
 * config (e.g. cva for shadcn) or hand-authored metadata. When undefined,
 * the inspector treats variant-like enum props as ordinary controls.
 *
 * `propName` cross-references the underlying `ComponentPropManifest`.
 */
export interface VariantGroupManifest {
  name: string
  propName?: string
  values: ControlOption[]
  defaultValue?: ManifestValue
}

export interface StatePreviewManifest {
  name: string
  description?: string
  props?: Record<string, ManifestValue>
}

export interface DataContractManifest {
  name?: string
  shape?: ComponentPropManifest[]
  example?: ManifestValue
}

export interface ComponentManifestExtensions {
  docsUrl?: string
  storybookId?: string
  categories?: string[]
  variants?: VariantGroupManifest[]
  statePreviews?: StatePreviewManifest[]
  dataContract?: DataContractManifest
  offSystemPolicy?: 'disallow' | 'allow-with-marker' | 'allow'
  [key: string]: unknown
}

/**
 * Where in the rendered DOM a prop or slot ends up. Used by the attribution
 * function (see `tasks/attribution-rewrite.md`) to deterministically map a
 * clicked DOM element back to the prop/slot that produced it — replacing
 * today's heuristic string-matching of prop values against rendered text.
 *
 * `RenderingHint`s describe rendering FORWARD ("this prop ends up here"),
 * which is the inverse of the heuristic walks that try to recover the
 * mapping backward from the DOM. Forward description is local to each
 * component definition and composes cleanly through wrappers — every
 * library component that wraps another component can declare its own
 * hints without needing to know how its consumers use it.
 *
 * Two flavors:
 *
 * - `kind: 'dom'` — the prop/slot renders at a specific element in this
 *   component's own DOM output. The attribution function tests the
 *   clicked element against `domTarget.selector` (rooted at the
 *   component's mount root) to identify which hint matches.
 *
 * - `kind: 'forward'` — the prop/slot is forwarded into a child
 *   component's prop/slot (composition). E.g., `UiInput.label` is
 *   forwarded to UiInput's internal `<UiLabel>`'s default slot.
 *   The attribution function recurses through the child component's
 *   manifest to resolve the final rendering site. This is what makes
 *   the EntityFormBlock → UiInput → UiLabel chain attributable without
 *   any single manifest having to know the full tree.
 *
 * Both variants carry shared provenance/trust fields (intersected in via
 * `RenderingHintProvenance` rather than duplicated per-variant) — see
 * `isTrustedHint` in `src/editor/attribution/attribute.ts`, the sole
 * consumer that gates on them. Hand-authored hints (no `provenance` field
 * at all) are trusted unconditionally; that's the legacy default this
 * schema must not regress. There is no current producer of hand-authored
 * hints — the one that existed, a bundled-JSON manifest source at
 * `src/editor/adapters/acme-ds/rendering-hints.ts`, was deleted 2026-08-10
 * (see `src/editor/adapters/README.md` § "No vendor adapters") — but the
 * convention stays supported by the schema and by `isTrustedHint`.
 */
export interface RenderingHintProvenance {
  /** Who authored this hint. Absent ⇒ 'hand-authored' (legacy). */
  provenance?: 'hand-authored' | 'inferred' | 'generated'
  /** Probe-confirmed. Hand-authored hints are trusted regardless. */
  verified?: boolean
}

export type RenderingHint =
  | ({
      kind: 'dom'
      /** Which authored input this hint describes. */
      source: { kind: 'prop' | 'slot'; name: string }
      /** Where the input shows up in this component's rendered DOM. */
      domTarget: {
        /**
         * CSS selector rooted at the component's mount-root element.
         * Use `':root'` when the target IS the mount root itself.
         */
        selector: string
        /** Which part of the matched element carries the value. */
        field: 'textContent' | 'attribute' | 'innerHTML'
        /** Required when `field === 'attribute'`. */
        attribute?: string
      }
      /**
       * How the input can be edited at the source. Affects which
       * `AttributionResult.kind` the attribution function emits.
       *
       * - `'literal'`   — direct edit at the consumer's call site.
       * - `'binding'`   — cross-file edit at the binding's definition.
       *                   Attribution further classifies (ref / parent-prop / etc.).
       * - `'uneditable'` — library-internal, no editable surface; the
       *                    inspector should refuse with `uneditableReason`.
       */
      editability?: 'literal' | 'binding' | 'uneditable'
      uneditableReason?: string
    } & RenderingHintProvenance)
  | ({
      kind: 'forward'
      /** Which authored input on this component is being forwarded. */
      source: { kind: 'prop' | 'slot'; name: string }
      /** The child component receiving the forwarded input. */
      forwardTo: {
        /** The child component's name as registered in the manifest registry. */
        component: string
        /**
         * Where the input lands on the child. Exactly one of
         * `childProp` / `childSlot` should be set.
         */
        childProp?: string
        childSlot?: string
      }
    } & RenderingHintProvenance)

export interface ComponentManifest {
  id: string
  name: string
  framework: FrameworkId
  designSystem: DesignSystemId
  importPath?: string
  description?: string
  props: ComponentPropManifest[]
  slots?: ComponentSlotManifest[]
  events?: ComponentEventManifest[]
  /**
   * Forward description of how props/slots show up in the rendered DOM.
   * Drives the attribution function's element-to-prop mapping. Optional
   * because not every manifest source can populate it: auto-extraction
   * via vue-component-meta gets props/slots but not rendering hints —
   * those have to be hand-authored or inferred from SFC analysis.
   * When absent, attribution falls back to today's heuristic behavior.
   */
  rendering?: RenderingHint[]
  extensions?: ComponentManifestExtensions
  source?: ManifestSource
}

/**
 * Produces normalized `ComponentManifest`s for a (framework, design system)
 * combination. One implementation per supported pairing.
 *
 * Adapter responsibilities (these are NOT inspector concerns — adapters do
 * them before returning manifests):
 *
 * 1. **Filter platform-inherited props.** React adapters MUST exclude HTML/DOM
 *    attributes inherited from `React.ComponentProps<...>` (typically by
 *    excluding declarations from `node_modules/@types/react`). The Vue
 *    extractor's analogue is the `node_modules` ignore predicate that keeps
 *    schema expansion bounded — without it the Acme DS `UiInput` manifest
 *    blew up to 71 MB.
 * 2. **Normalize raw extractor output.** Classify `control.kind` per prop;
 *    don't expose raw TypeScript schema as the UI control shape. Drop
 *    `'undefined'` / `'null'` from finite-choice option lists; rely on
 *    `required: false` for the unset state.
 * 3. **Track default-value provenance.** Use {@link DefaultValueSource} to
 *    distinguish runtime defaults (from `defineProps` destructure or React
 *    destructure-with-defaults) from documentation defaults (`@default`
 *    JSDoc), which can be stale.
 * 4. **Populate framework-natural shapes.** Vue adapters use `slots[]` and
 *    `events[]`. React adapters typically leave both empty and surface the
 *    same concepts as props with `control.kind === 'slot'` or `'event'`.
 */
export interface ComponentManifestSource {
  id: string
  framework: FrameworkId
  designSystem: DesignSystemId
  listComponents(): Promise<ComponentManifest[]>
  getComponent(componentName: string): Promise<ComponentManifest | null>
  /**
   * Optional: every manifest, across ALL composed sources, that declares
   * `componentName` — in the same source-priority order `getComponent`
   * walks, without collapsing to a single winner. `getComponent` and
   * `listComponents` both resolve same-name collisions first-source-wins,
   * which is exactly the information a caller needs to lose when it wants
   * to disambiguate a collision itself (e.g. by the edited file's actual
   * import path) instead of trusting the default winner. Individual
   * (non-composite) sources may leave this unimplemented — a caller that
   * needs cross-source disambiguation must treat a missing implementation
   * as "candidates unknown," not "zero candidates." See
   * `CompositeManifestSource.getComponentCandidates` for the only current
   * implementation and `manifest-value-mismatch-drift.ts` for the consumer
   * this was added for (2026-07-30).
   */
  getComponentCandidates?(componentName: string): Promise<ComponentManifest[]>
}
