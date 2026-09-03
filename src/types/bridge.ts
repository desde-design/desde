// ── Style provenance wire types ─────────────────────────────────────
// The bridge↔shell contract for inspector style provenance. Defined HERE
// (not in the bridge module) so consumers of these types — including the
// editor-cli subproject — don't transitively typecheck the bridge's
// browser-only walker + its `@bramus/specificity` dependency. The cascade
// walker (src/bridge/style-provenance.ts) imports these back.
export interface StyleStylesheetRef {
  /** Stylesheet href, or a synthetic marker for embedded sheets. */
  href: string
  /**
   * npm package parsed from a `node_modules/<pkg>` path — the `href` when it has
   * one, else the {@link sourceHint}. Present ⇒ the sheet ships from a library
   * and nothing can be written into it.
   */
  package?: string
  /**
   * Bundler-declared SOURCE FILE for an embedded (`href`-less) sheet — an
   * absolute filesystem path, possibly with a bundler query suffix
   * (`…/src/style.css?used`). Vite dev serves EVERY first-party stylesheet as
   * an injected `<style>` (CSS imported from JS), so `href` is null and the
   * synthetic `'<style>'` marker was all the shell ever saw: the token scope —
   * which the failure copy recommends as the remedy for a lost cascade — was
   * unreachable on any Vite dev substrate, and library-shipped CSS was
   * indistinguishable from first-party. The bridge now reports the owner node's
   * source hint (`data-vite-dev-id`) so the shell can map it back to a
   * repo-relative file (`resolveTokenSourceFile`).
   *
   * OPTIONAL and absent-by-default: absent means "no bundler stamped one, or the
   * sheet has a real href" — i.e. exactly the pre-2026-08-06 behavior, so a
   * consumer that ignores it keeps working (and offers no token scope, which is
   * the fail-safe direction).
   */
  sourceHint?: string
}
export interface StyleWinningRule {
  /** The single matching selector (one comma-part), e.g. `.acme-empty-state`. */
  selector: string
  stylesheet: StyleStylesheetRef
  /** The authored declaration, e.g. `background: var(--acme-color-background-disabled)`. */
  declaration: string
  /** [id, class, type] specificity of `selector`. */
  specificity: [number, number, number]
  /** Media condition when the rule lives inside an `@media` block. */
  media?: string
  /** Pseudo-class on the selector (e.g. `:hover`) when present. */
  pseudoClass?: string
}
export interface StyleVarChainEntry {
  /** Custom property name, e.g. `--acme-color-background-disabled`. */
  name: string
  /** Authored value at the definition site, e.g. `#f7f7f7` (or another `var(...)`). */
  value: string
  definedAt: { selector: string; stylesheet: StyleStylesheetRef }
}
export interface StyleOrigin {
  property: string
  /** `getComputedStyle` value — best-effort; may be empty under jsdom. */
  computedValue: string
  /** Winning cascade rule, or null when no stylesheet rule declares the property. */
  winningRule: StyleWinningRule | null
  /** `var(--…)` chain from the winning value back to its root definition. */
  varChain: StyleVarChainEntry[]
  /**
   * Present when the element's inline `style="…"` sets the property directly.
   *
   * `fromPreview` is the bridge's own answer to "is this declaration editor's
   * live-preview shim?". The class/style live preview stamps its resolved
   * declarations inline with `!important` (`applyClassOverride` in
   * `src/bridge/override-preview.ts`) so a low-specificity utility beats
   * library scoped CSS — which means, for the whole preview window, an inline
   * `!important` declaration sits on the very property a consumer wants to
   * reason about. Shell-side consumers previously had to GUESS (the pre-flight
   * scope gate discounted any inline `!important` on a property it had recently
   * previewed, which also discounted an author's own). The flag makes it exact:
   * the preview layer records which properties it stamped, and the provenance
   * walker reports that verbatim.
   *
   * OPTIONAL and absent-by-default: absent means "not stamped by the preview, or
   * the reader had no preview registry to consult" — i.e. exactly today's
   * behavior, so no consumer needs to change to keep working. Only `true` is a
   * positive claim.
   */
  inline?: { value: string; important: boolean; fromPreview?: boolean }
  /**
   * True when no rule matched the element itself and the value was resolved
   * from an ancestor (the property inherits). `winningRule` then describes the
   * ANCESTOR's rule.
   */
  inherited?: boolean
  /**
   * Blast radius of patching the var-chain ROOT token: the number of
   * declaration sites across all accessible stylesheets that reference
   * `var(--root)` (consumers, not the definition). Present only when
   * `varChain` is non-empty. Drives the scope dialog's "affects N uses"
   * warning before a "The token" edit. Best-effort — counts only same-origin
   * (readable) stylesheets, like the rest of the walk.
   */
  tokenUsageCount?: number
  /**
   * Present when a TRANSIENT-state rule (`:hover`, `:focus`, `:active`, …)
   * currently matches the element AND outranks `winningRule` — i.e. the rule
   * painting the pixels right now is not the one reported.
   *
   * `winningRule` deliberately answers for the element AT REST (see
   * `dependsOnTransientState` in `src/bridge/style-provenance.ts`): the resting
   * rule is what the user means to restyle, and a `:hover` rule outranking
   * editor's override would otherwise make the cascade verifier cry
   * `css-overridden` over an edit that visibly works. But `computedValue` is a
   * LIVE `getComputedStyle` sample, and clicking an element to inspect it puts
   * the cursor on it — so for any hover-styled property the two halves of this
   * payload disagreed with no explanation (live: a winner declaring `#0044f4`
   * beside `computedValue: "rgb(0, 48, 204)"`, and worse, a property declared
   * ONLY under `:hover` reporting `winningRule: null` beside a real opaque
   * colour). This field turns that contradiction into a statement: the rule
   * shown is the resting one, `pseudoClass` is why the screen shows something
   * else.
   *
   * OPTIONAL and absent-by-default: absent means "no transient rule changes
   * this property right now", which is the overwhelmingly common case and
   * exactly the previous payload — no consumer must change to keep working.
   */
  transientRuleApplies?: { pseudoClass: string }
}

export interface CommentPosition {
  anchorSelector: string
  page: string
  tabPanelIds?: string[]
  /** Document-relative X coordinate — fallback when selector no longer matches */
  anchorX?: number
  /** Document-relative Y coordinate — fallback when selector no longer matches */
  anchorY?: number
}

export interface CommentAuthor {
  uid: string
  displayName: string
  email: string
  photoURL: string
}

export interface CommentReply {
  id: string
  body: string
  author: CommentAuthor
  createdAt: string
  mentions: string[]
}

export interface Comment {
  id: string
  number: number
  position: CommentPosition
  body: string
  author: CommentAuthor
  createdAt: string
  resolved: boolean
  replies: CommentReply[]
  mentions: string[]
  participantEmails: string[]
  projectId?: string
}

// ── Inspector types ──────────────────────────────────────────────────

export interface StyleProperty {
  name: string
  value: string
  rawValue?: string
}

export interface StyleCategory {
  name: string
  properties: StyleProperty[]
}

export interface DesignToken {
  name: string
  value: string
  source: "element" | "inherited"
}

export interface BoxModelSides {
  top: number
  right: number
  bottom: number
  left: number
}

export interface BoxModelData {
  width: number
  height: number
  margin: BoxModelSides
  border: BoxModelSides
  padding: BoxModelSides
  content: { width: number; height: number }
}

export interface FrameworkComponentInfo {
  framework: "vue" | "react" | "angular" | "svelte" | "web-component"
  name: string
  file?: string
  line?: number
  props?: Record<string, unknown>
}

export interface ComponentTreeNode {
  name: string
  file?: string
  line?: number
  props?: Record<string, unknown>
  /**
   * Fallthrough attributes the parent template/JSX passed to this
   * component instance that are NOT part of its typed prop signature.
   * In Vue this is `instance.attrs` (everything bound that doesn't
   * match a `defineProps` entry); in React this is the equivalent
   * pass-through props that aren't in the component's prop types.
   *
   * The editor inspector renders these as an "Attributes" section
   * so designers can edit substrate-level attrs (`placeholder`,
   * `data-testid`, `required`, ...) without needing them to be
   * formally typed by the design system. Editing dispatches the same
   * `kind: 'prop'` edit as typed props — the apply-prop-edit service
   * handles arbitrary attribute names at the call site.
   */
  attrs?: Record<string, unknown>
  elementSelector: string
  isLibrary?: boolean
  packageName?: string
  /**
   * The source-tag plugin's callsite stamp on this component's tag
   * (`file:line:col`), present when the tag was written in a stamped
   * first-party file and absent for a component instantiated inside
   * library code. See the bridge's `ComponentTreeNode` for why the shell
   * uses it to pick the selection's component on React.
   */
  callsite?: string
  /** The `data-desde-v` file version paired with `callsite`. */
  callsiteVersion?: string
}

/**
 * Build-time element source location, captured by a Vite plugin in the
 * substrate (see `vite-plugin-source-tag.ts` in the prototype repo). Lets
 * editor apply edits to the exact source position that produced the
 * rendered DOM node, rather than guessing from the component definition.
 *
 * `file` is the path relative to the substrate's Vite root. `line` and
 * `column` are 1-based, from the Vue compiler's start-tag position.
 */
export interface SourceLocation {
  file: string
  line: number
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
 * the live DOM and verified against it.
 *
 * Deliberately a separate type from {@link SourceLocation}: a source
 * location answers "where do these bytes live?", which on a component root
 * is the `data-desde-own` rescue stamp — a coordinate that appears on no
 * element's `data-desde-src` at all, because Vue's attribute fallthrough
 * overwrote the root's own stamp with the parent's callsite. A selector
 * built from it matches nothing. Keeping the two shapes distinct is what
 * stops the next caller from substituting one for the other.
 *
 * `matchCount` is the live count for the rule head the applicator will
 * emit. Zero means the rule is dead on arrival and must be refused, not
 * written. See `tasks/dev-server-hosts.md` § 9g.8.
 */
export interface DomAnchor {
  file: string
  line: number
  column: number
  /** Elements matching `[data-desde-src="<file>:<line>:<column>"]` right now. */
  matchCount: number
  /** `direct` = the element's own attribute; `ancestor` = a stamped ancestor's. */
  resolution: "direct" | "ancestor"
}

/**
 * Iteration context for elements rendered by a framework loop construct
 * (Vue `v-for`, React `.map`, Svelte `#each`). Editor's structural edit
 * pipeline reads this to scope edits to a single iteration vs. the
 * template (see `src/editor/core/selection.ts` for the rationale).
 *
 * Duplicated here (rather than imported) because the bridge bundle runs
 * inside the iframe with no access to `src/editor/core` — mirroring how
 * {@link SourceLocation} is duplicated for the same reason.
 */
export interface IterationContext {
  source: "v-for" | "map" | "each" | "unknown"
  key: string | number
  /** 0-based position among rendered siblings. */
  index: number
  /** Total count of rendered siblings (= total iterations). */
  siblingCount: number
  /** Iteratee expression as authored. Null when the framework runtime doesn't expose it. */
  expression: string | null
}

/**
 * A single editable text field surfaced for the selected element. The
 * bridge populates an array of these so the right-rail inspector can render
 * one labeled input per editable text — covering both plain DOM text leaves
 * and design-system component props whose value is rendered as text inside
 * the selection. Edits route by `kind`: `prop` flows through the
 * deterministic `PropEdit` pipeline (source-rewrites the SFC attribute);
 * `dom-text` flows through `SET_ELEMENT_TEXT` + mutation capture (the
 * legacy text-edit path, kept for plain DOM text leaves).
 */
export interface EditableTextField {
  /** Stable per-selection ID used as the React key in the panel. */
  id: string
  /** Display label shown above the input (e.g. "Text", "label"). */
  label: string
  /** Current rendered/source value. */
  value: string
  kind: "dom-text" | "prop"
  /** Required when `kind === "prop"` — the component prop name to rewrite. */
  propName?: string
  /**
   * Optional CSS selector for the specific element this edit targets.
   * Bridge sets this for slot-text fields whose leaf isn't the same as
   * `selection.selector` (e.g. `<UiLabel>` is selected but the editable
   * text is inside an internal span). Dispatcher prefers this when set
   * over `selection.selector`. Absent for prop edits (the propName +
   * source location are the dispatch keys there).
   */
  selector?: string
  /**
   * 0-based index of the specific text node within `selector`'s
   * childNodes that should be mutated. Bridge sets this when the
   * editable text is a text-node sibling of element children
   * (e.g. `<label>Default ACL<UiTooltip/></label>` — the slot text and a
   * tooltip share the same parent element). Without this index, replacing
   * the element's textContent would nuke the sibling element. Omitted
   * for pure text leaves (the dispatch can safely set textContent).
   */
  textNodeIndex?: number
  /** When true the panel renders the value as read-only with `readOnlyReason`. */
  readOnly?: boolean
  /** Muted explanation shown next to a read-only field. */
  readOnlyReason?: string
  /**
   * Explicit dispatch target for a prop edit — set when the editable
   * prop lives on an ancestor component's tag (in a parent SFC)
   * rather than on the current selection. Overrides the selection's
   * own `editTarget`. E.g. the rendered "3" inside
   * `<EntityFormBlock :step="3">`'s slot routes the edit to the
   * `<EntityFormBlock>` tag in the consumer SFC, not the inner div
   * the user clicked.
   */
  editTarget?: { file: string; line: number; column: number; fileHash?: string }
  /**
   * Original prop type. Lets the dispatcher coerce the user's string
   * input back to a number / boolean so the source emits `:step="1"`
   * (bound number) rather than `step="1"` (string attribute). Absent
   * means "string" (default).
   */
  valueType?: "string" | "number" | "boolean"
}

export interface InspectionData {
  tagName: string
  id: string
  classes: string[]
  /**
   * Editable text fields surfaced for the selected element. Populated by
   * the framework adapter; the panel renders one labeled input per entry.
   * Empty array when no text is editable on the selection.
   */
  editableTexts?: EditableTextField[]
  rect: DOMRectJSON
  styles: StyleCategory[]
  tokens: DesignToken[]
  boxModel: BoxModelData
  component?: FrameworkComponentInfo
  directComponent?: FrameworkComponentInfo
  componentTree?: ComponentTreeNode[]
  selector: string
  pageRoute?: string
  pageSourceFile?: string
  /**
   * Where the selected element's bytes live in source. Drives "open file
   * at line" affordances and definition-scoped DeleteEdit. Equal to
   * {@link editTarget} for native elements and component leafs; differs
   * for slot interpolations and internal markup of user-authored child
   * SFCs. Absent when the substrate doesn't ship the source-tag plugin or
   * the element couldn't be attributed.
   *
   * **NOT a selector.** This used to be documented as "the `data-desde-src`
   * on the element itself, or on its nearest own-instance ancestor" —
   * true until the `data-desde-own` rescue stamp landed, and false since:
   * on a component ROOT this is the rescue stamp, a coordinate that is
   * on NO element's `data-desde-src` because Vue's fallthrough overwrote it
   * with the parent's callsite. Two callers read the old contract
   * differently and one of them shipped a `[data-desde-src="…"]` rule that
   * matched nothing while reporting success. Anything building a CSS
   * selector must use {@link domAnchor}. See `tasks/dev-server-hosts.md`
   * § 9g.8.
   */
  authoredAt?: SourceLocation
  /**
   * The `data-desde-src` value literally present on the element — or on its
   * nearest stamped ancestor — together with how many elements it matches
   * in the document right now. The ONLY coordinate a `[data-desde-src="…"]`
   * CSS rule may be anchored on, and the count is what lets a consumer
   * refuse a rule that would match nothing. Absent when nothing in the
   * ancestry carries a stamp.
   */
  domAnchor?: DomAnchor
  /**
   * Where structural / prop edits dispatch — the consumer's `<Tag>`
   * location for the element's leaf component, resolved through
   * transparent wrappers (a `<MyCard>` wrapping `<UiLabel/>` as its
   * sole root resolves to `<MyCard>`, not `<UiLabel>`). For native
   * elements and component leafs this equals {@link authoredAt}; for
   * slot interpolations and internal markup of user-authored child
   * SFCs it points one SFC up to the parent's call site.
   */
  editTarget?: SourceLocation
  /**
   * True when {@link editTarget}'s file is in `node_modules` —
   * editor can't rewrite library source. Adapter refusals key off
   * this rather than re-deriving the check at each call site.
   */
  isLibrary?: boolean
  /**
   * The component ELEMENT written at the resolved `data-desde-src`
   * coordinate — the callsite component whose props an edit at that
   * coordinate patches. For a stamp that fell through from `<KDropdown ...>`
   * in a first-party template this is KDropdown, even when Vue root-chaining
   * makes the same DOM node double as the first-party wrapper's own render
   * root (bridge `2026-09-01a-callsite-edit-target`; before that it was the
   * file OWNER, whose root selector never matched the clicked element, so
   * wrapper-nested library components had no reachable Variants & Props —
   * stress-test finding F-08). Distinct from `directComponent` (the leaf
   * instance) and from `component` (whatever the framework detector picks
   * first). Editor's adapter prefers this when present so the inspector
   * display, the manifest lookup, and the edit dispatch all agree on the
   * same component. Optional because the leaf may have no
   * `data-desde-src`-bearing ancestor (substrate plugin missing, slot fragments).
   */
  editTargetComponent?: FrameworkComponentInfo
  /**
   * True when the inspected element ITSELF carries a `data-desde-src` stamp;
   * false when its anchor came from an ancestor (library-internal markup).
   * The adapter's element-vs-component split keys off this: an unstamped
   * element has no bytes of its own to edit, so the selection surfaces the
   * edit-target component instead of a bare element. Optional because
   * bundles before `2026-09-01a` never sent it; absent keeps the older
   * selector-equality behavior.
   */
  selfStamped?: boolean
  /**
   * Iteration context when the element is one rendering of a framework
   * loop (`v-for`, `.map`, etc.). Editor surfaces this so structural
   * edits can scope to the data array entry instead of rewriting the
   * shared template position.
   */
  iterationContext?: IterationContext
  /**
   * Bridge-extracted attribution context for the new manifest-first
   * attribution pipeline (see `tasks/attribution-rewrite.md`). Carries
   * the Vue/React component chain + clicked-element selector so the
   * shell can run the pure `attribute()` function over manifests
   * (existing /api/editor/manifest) without touching the iframe's
   * runtime. Absent when the bridge couldn't identify an owning
   * component instance — the shell falls back to legacy attribution
   * for that selection. Phase 2d (dark-mode) populates this field
   * alongside the existing `editTarget` / `authoredAt` / etc., so the
   * old inspector path keeps working unchanged.
   */
  attributionContext?: import('@/editor/attribution/types').AttributionContext
}

// ── Flow types ──────────────────────────────────────────────────────

export interface FlowScreenshot {
  stepIndex: number
  dataUrl: string
  width: number
  height: number
}

// ── Note types (bridge payload) ────────────────────────────────────

export interface BridgeNote {
  id: string
  number: number
  position: CommentPosition
  body: string
  author: CommentAuthor
  createdAt: string
  resolved: boolean
  minimized: boolean
  replies: CommentReply[]
}

// ── Editor hover-target type ─────────────────────────────────────

/**
 * Lightweight selection-target shape sent on every hover event in
 * editor mode. Distinct from `InspectionData` (heavyweight: styles,
 * tokens, box model, component tree). Editor translates this into
 * its own SelectionTarget at the adapter layer.
 */
export interface HoverTarget {
  selector: string
  componentName?: string
  componentFile?: string
  componentLine?: number
  packageName?: string
  /** Where the hovered element's bytes live (see {@link InspectionData.authoredAt}). */
  authoredAt?: SourceLocation
  /** Dispatch target for edits on the hovered element (see {@link InspectionData.editTarget}). */
  editTarget?: SourceLocation
  /** True when {@link editTarget} is in node_modules. */
  isLibrary?: boolean
  /** Iteration context when the hovered element is rendered by a framework loop. */
  iterationContext?: IterationContext
}

// ── MCP inspection types ───────────────────────────────────────────

export interface OutlineNode {
  id: string
  name: string
  type: "element" | "component" | "text"
  x: number
  y: number
  width: number
  height: number
  /**
   * Selector that re-resolves to this element via `document.querySelector`.
   * Same engine as {@link InspectionData.selector}. Editor uses this as
   * the `targetId` when dispatching `INSPECT_SELECTOR` from the layers panel.
   * Empty string when the element falls under `[data-prototype-flow]` or no
   * stable selector could be generated.
   */
  selector: string
  /**
   * Source file of the component definition when `type === "component"`. Maps
   * to `__file` for Vue, the equivalent for other frameworks. Editor uses
   * this together with `name` to look up a `ComponentManifest`.
   */
  componentFile?: string
  /**
   * Package name when the component comes from a library (e.g. `@acme/design-system`).
   * Inferred from `componentFile` containing `node_modules/<scope>/<pkg>`.
   */
  packageName?: string
  /**
   * Where this element's bytes live in source — drives "open file at
   * line" and definition-scoped DeleteEdit (which removes the element
   * from its own SFC, affecting every instance of the component that
   * authors it). See {@link InspectionData.authoredAt} for the full
   * shape contract.
   */
  authoredAt?: SourceLocation
  /**
   * Where structural edits dispatch — the consumer's `<Tag>` location
   * for this element's leaf component. Drives callsite-scoped
   * DeleteEdit (which removes just one usage), MoveEdit, and
   * PropEdit dispatch. See {@link InspectionData.editTarget} for the
   * full shape contract.
   */
  editTarget?: SourceLocation
  /** True when {@link editTarget} is in node_modules. */
  isLibrary?: boolean
  /**
   * Iteration context when this element is one rendering of a framework
   * loop (`v-for`, `.map`, etc.). Lets the layers panel surface "1 of N"
   * cardinality before the user clicks, and lets the editing pipeline
   * route the click through the iteration-scope dialog.
   */
  iterationContext?: IterationContext
  /**
   * Present when this node is a SYNTHETIC row standing in for a
   * `<template v-if>` / `<template v-for>` group (see
   * `src/editor/edit-service/list-conditional-groups.ts`). Those
   * wrappers render no DOM element, so the layers panel's DOM walk can
   * never surface them directly — `useEditorEditing`'s `refreshLayers`
   * merges source-derived groups into the tree as one extra row per
   * group, wrapping the rendered member(s) as its `children`. The row's
   * `selector` is a non-resolving `__desde-group__…` sentinel (draggable,
   * never dispatched to `selectBySelector`) and `editTarget` points at
   * the group's HEAD wrapper — the coordinate a `moveGroup` edit
   * dispatches against.
   */
  conditionalGroup?: { directive: 'if' | 'for'; expression: string | null }
  children?: OutlineNode[]
}

/**
 * Why a live-preview poke (`PROP_OVERRIDE_RESULT` / `ATTR_OVERRIDE_RESULT` with
 * `ok: false`) applied nothing — the machine-readable half of the bridge's
 * `reason` prose.
 *
 * It exists because ONE of these causes is not a failure at all in the sense the
 * user cares about. `'unsupported-substrate'` is a **capability gap**: the
 * live-preview write path reads Vue's dev-mode instance metadata
 * (`__vueParentComponent`), so on a React substrate — or a Vue production build
 * — EVERY prop and attr poke reports `ok: false` while the source write beside
 * it succeeds normally. Alarming the user on every edit that actually worked is
 * strictly worse than saying nothing: it trains them to ignore the one signal
 * this surface exists to deliver. The other three are genuine, per-target, and
 * actionable, so the shell surfaces them (see
 * `src/hooks/override-preview-notice.ts`, which gates on exactly this field).
 *
 * Prose alone could not carry that decision — the shell would have to
 * string-match the bridge's wording, which is the drift shape that gave
 * `MUTATION_RESOLUTION_FAILED` three separate lives.
 *
 * - `unsupported-substrate` — the page exposes no Vue component-instance data
 *   anywhere, so no element could ever be previewed. Always-fires; not surfaced.
 * - `selector-unresolvable` — the selector is invalid or matches nothing now
 *   (typically a re-render). Actionable: re-select and edit again.
 * - `no-component-instance` — the substrate DOES expose instance data, but not
 *   for this element (raw DOM outside the app, a portal), or the instance has no
 *   props object / no rendered element to carry the attribute.
 * - `assignment-refused` — the component threw on the assignment (frozen or
 *   read-only props).
 */
export type PreviewFailureKind =
  | "unsupported-substrate"
  | "selector-unresolvable"
  | "no-component-instance"
  | "assignment-refused"

// ── Bridge messages ─────────────────────────────────────────────────

// Bridge → Shell messages
export type BridgeToShellMessage =
  | { type: "BRIDGE_READY"; payload?: { version?: string } }
  // Tier-2 edit verification response (paired with a READ_RENDERED_VALUE
  // requestId). `value` is null when the selector matched nothing.
  | { type: "RENDERED_VALUE_READ"; payload: { value: string | null }; requestId: string }
  // Tier-2 edit verification P2 response (paired with a READ_MEASUREMENTS
  // requestId). `measurements` is null when the selector matched nothing.
  | { type: "MEASUREMENTS_READ"; payload: { measurements: Measurements | null }; requestId: string }
  // Style provenance response (paired with a GET_STYLE_PROVENANCE requestId).
  // `origins` is keyed by property; an entry's `winningRule` is null when no
  // stylesheet rule declares it. Empty object when the selector matched nothing.
  | {
      type: "STYLE_PROVENANCE_RESULT"
      payload: { selector: string; origins: Record<string, StyleOrigin> }
      requestId: string
    }
  // Every stylesheet the document has loaded, in DOCUMENT ORDER (paired with
  // a GET_STYLESHEET_TARGETS requestId). The shell maps these back to
  // first-party writable `.css` paths to pick where a `[data-desde-src="…"]`
  // override rule is written on a substrate with no `<style scoped>` (React).
  // Reachability, not existence: a `.css` file on disk that the app never
  // imports would make the rule inert. See tasks/dev-server-hosts.md § 9g.1.
  | {
      type: "STYLESHEET_TARGETS_CAPTURED"
      payload: { sheets: StyleStylesheetRef[] }
      requestId: string
    }
  | { type: "COMMENT_PIN_CLICKED"; payload: { commentId: string; pinRect: DOMRectJSON } }
  | {
      type: "NEW_COMMENT_POSITION"
      payload: { anchorSelector: string; page: string; anchorX: number; anchorY: number; elementRect: DOMRectJSON }
    }
  | {
      type: "PIN_POSITIONS_UPDATED"
      payload: { commentId: string; rect: DOMRectJSON }[]
    }
  | { type: "NOTE_PIN_CLICKED"; payload: { noteId: string; pinRect: DOMRectJSON } }
  | {
      type: "NOTE_ANCHOR_POSITIONS"
      payload: { noteId: string; rect: DOMRectJSON }[]
    }
  | {
      type: "NEW_NOTE_POSITION"
      payload: { anchorSelector: string; page: string; anchorX: number; anchorY: number; elementRect: DOMRectJSON }
    }
  | { type: "ROUTE_CHANGED"; payload: { url: string; sourceFile?: string } }
  /**
   * The colour the prototype's page is painted, as a resolved CSS colour
   * string (`rgb(…)` / `rgba(…)`), so a shell can carry its own chrome on the
   * same ground and lose the seam at the iframe edge.
   *
   * The shell CANNOT compute this itself. In the viewer's loopback and
   * subdomain origin modes the prototype is genuinely cross-origin, so
   * reaching into `iframe.contentDocument` throws, and a rendered pixel is
   * unreadable for the same reason (a cross-origin frame taints the canvas).
   * Only code running inside the document can answer it, which is the bridge.
   *
   * Sent unprompted at init and again on navigation, rather than
   * request/response: the shell wants it as early as possible, and it changes
   * when the page does. Deliberately NOT folded into `ROUTE_CHANGED`, whose
   * initial emission is gated on the prototype carrying a `data-page-source`
   * stamp — a substrate without one never sends it, and the background has to
   * work there too.
   */
  | { type: "PAGE_BACKGROUND_CHANGED"; payload: { color: string } }
  | { type: "DOM_MUTATED" }
  | { type: "ELEMENT_INSPECTED"; payload: InspectionData; requestId?: string }
  | { type: "ELEMENT_DESELECTED" }
  | { type: "STRUCTURE_CAPTURED"; payload: { roots: OutlineNode[] }; requestId: string }
  | { type: "ELEMENT_SCREENSHOT_CAPTURED"; payload: { png: string; width: number; height: number }; requestId: string }
  | { type: "PAGE_TOKENS_CAPTURED"; payload: { tokens: Record<string, { kind: string; value: string }> }; requestId: string }
  | { type: "ESCAPE_PRESSED" }
  // ── Editor extensions (BRIDGE_VERSION 2026-05-01a+) ────────────
  | { type: "HOVER_TARGET_CHANGED"; payload: HoverTarget | null }
  | {
      type: "ELEMENT_INSPECTION_UNRESOLVED"
      payload:
        | { targetId: string; reason: "not-found" }
        | { targetId: string; reason: "in-toolbar" }
        | { targetId: string; reason: "metadata-mismatch"; liveCandidate: InspectionData }
        | { targetId: string; reason: "ambiguous"; candidates: InspectionData[] }
      requestId?: string
    }
  | { type: "ELEMENTS_INSPECTED"; payload: InspectionData[]; requestId?: string }
  | {
      type: "SIBLINGS_INSPECTED"
      payload: { siblings: InspectionData[]; selectedIndex: number }
      requestId: string
    }
  // ── DOM-edit mode (BRIDGE_VERSION 2026-05-07a-dom+) ───────────────
  //
  // Bridge captures designer-driven DOM mutations and emits one of three
  // events per change. The shell accumulates a MutationLog by appending
  // each MUTATION_CAPTURED. AWAITING_DISAMBIGUATION pauses the change
  // until the shell resolves; RESOLUTION_FAILED is a non-blocking
  // notice that the change couldn't be safely mapped to source.
  // `DOM_EDIT_MODE_ENTERED` was removed 2026-08-06. It was doubly dead: its
  // only emitter (`enter()` in `dom-edit-mode.ts`) is unreachable because
  // nothing sends `ENTER_DOM_EDIT_MODE` any more, and it had no consumer — no
  // adapter switch case, no listener set. Re-add it together with its consumer
  // if the contentEditable affordance is ever re-enabled.
  | { type: "DOM_EDIT_MODE_EXITED" }
  | { type: "MUTATION_CAPTURED"; payload: BridgeMutation }
  | {
      type: "MUTATION_AWAITING_DISAMBIGUATION"
      payload: BridgePendingMutation
    }
  | {
      type: "MUTATION_RESOLUTION_FAILED"
      payload: { id: string; reason: string; selector: string }
    }
  // The live-preview half of a buffered prop/attr edit reporting whether it
  // landed. `ok: false` means the iframe shows NOTHING for this edit — the
  // buffered edit still dispatches to source on save, but the designer's
  // instant feedback is missing, so the shell has to say so (a silently
  // discarded `ok: false` was the same class of defect as the swallowed
  // MUTATION_RESOLUTION_FAILED). `reason` is present exactly when `ok` is
  // false and is the bridge's own explanation — it is the only side that
  // knows WHICH of the failure modes hit; `kind` is the machine-readable half
  // of that same answer, so the shell can DECIDE on it rather than parse prose.
  | {
      type: "PROP_OVERRIDE_RESULT"
      payload: {
        selector: string
        propName: string
        ok: boolean
        reason?: string
        kind?: PreviewFailureKind
      }
    }
  | {
      type: "ATTR_OVERRIDE_RESULT"
      payload: {
        selector: string
        attrName: string
        ok: boolean
        reason?: string
        kind?: PreviewFailureKind
      }
    }
  // ── Override-store closed loop (WS3, tasks/edit-pipeline-rearchitecture.md) ──
  // The bridge auto-registers an override for every text/attr/class mutation
  // it captures (override id === Mutation.id) and, when the shell passes an
  // `overrideId` on APPLY_PROP_OVERRIDE, for that prop preview too. Once the
  // shell learns the dispatched edit's outcome it sends RESOLVE_OVERRIDE; the
  // bridge releases (confirmed/ineffective) or has already restored the
  // pre-edit DOM value and reports it here (failed → OVERRIDE_REVERTED). A
  // pending override the bridge can't confirm within its own budget reports
  // OVERRIDE_UNVERIFIED instead — not a failure, just an unconfirmed write.
  | {
      type: "OVERRIDE_REVERTED"
      payload: { id: string; kind: string; selector: string; reason: string }
    }
  | {
      type: "OVERRIDE_UNVERIFIED"
      payload: { id: string; kind: string; selector: string }
    }
  // ── Table-edge menu (BRIDGE_VERSION 2026-05-17b+) ───────────────────
  | { type: "TABLE_EDGE_CONTEXT_MENU"; payload: TableEdgeContextMenuPayload }
  // ── Element context menu (BRIDGE_VERSION 2026-06-04a+) ──────────────
  | { type: "ELEMENT_CONTEXT_MENU"; payload: ElementContextMenuPayload }
  // ── Direct-manipulation drag-to-move (BRIDGE_VERSION 2026-06-11b+) ───
  // The DragMoveOverlay emits this on drop; the shell turns it into the same
  // `move` StructuralEdit the Layers-panel drag produces (apply-move-edit).
  | { type: "DRAG_MOVE_COMMITTED"; payload: DragMoveCommittedPayload }
  // ── Direct-manipulation insert-at-point (BRIDGE_VERSION 2026-06-11c+) ──
  // The InsertPlacementOverlay emits this on the placement click; the shell
  // inserts the pending snippet into the resolved container (apply-insert-edit).
  | { type: "INSERT_AT_POINT"; payload: InsertAtPointPayload }
  // ── Direct-manipulation drag-to-resize (BRIDGE_VERSION 2026-06-11d+) ───
  // The ResizeOverlay emits this when a width-handle drag is released; the
  // shell applies the quantized width class via the existing class-edit path.
  | { type: "RESIZE_COMMITTED"; payload: ResizeCommittedPayload }

/**
 * Right-click on any selectable element in editor mode. Carries the
 * same inspection payload as `ELEMENT_INSPECTED` (so the shell can use
 * the existing selection-state machinery) plus the iframe-local mouse
 * coordinates the menu should anchor at. The shell translates
 * `menuAnchor` to its own viewport via the iframe's bounding rect (same
 * pattern as table-edge-overlay).
 *
 * Used by the in-app code editor affordance: right-click → "Open in
 * editor" reads `inspection.authoredAt` to know which file/line to
 * open. The menu also exposes "Open in VS Code" (`vscode://file/...`).
 */
export interface ElementContextMenuPayload {
  inspection: InspectionData
  menuAnchor: { x: number; y: number }
}

/**
 * A direct-manipulation drag-to-move drop (Phase 2 of
 * tasks/editor-direct-manipulation.md). `*EditTarget` are the bridge's
 * `attributeElement` source locations for the dragged element and the
 * destination container; `destIndex` is the 0-based insertion index among the
 * container's editable children. The shell builds the same `move`
 * StructuralEdit the Layers-panel drag produces (apply-move-edit, same-file).
 */
export interface DragMoveCommittedPayload {
  sourceSelector: string
  sourceEditTarget: { file: string; line: number; column: number }
  destParentSelector: string
  destParentEditTarget: { file: string; line: number; column: number }
  destIndex: number
  /** True when the dragged element is v-for/map-rendered — the shell refuses
   *  (iterated moves go through the Layers panel's iteration-scope intercept). */
  sourceIsIterated: boolean
  /** True when the DESTINATION container is v-for/map-rendered — same refusal
   *  (dropping into one row would rewrite the loop template for every row). */
  destIsIterated: boolean
}

/**
 * A direct-manipulation insert-at-point placement click (Phase 3). The shell
 * inserts its pending palette snippet into `parentEditTarget` at `destIndex`.
 */
export interface InsertAtPointPayload {
  parentSelector: string
  parentEditTarget: { file: string; line: number; column: number }
  destIndex: number
  /** True when the resolved container is v-for/map-rendered — shell refuses. */
  parentIsIterated: boolean
}

/**
 * A direct-manipulation drag-to-resize release (Phase 4). The shell applies
 * `widthClass` (a quantized Tailwind width utility) to the element at
 * `editTarget` via the existing class-edit path.
 */
export interface ResizeCommittedPayload {
  selector: string
  editTarget: { file: string; line: number; column: number }
  widthClass: string
}

/**
 * Right-click on a row/column edge band. The shell renders a context
 * menu (Delete / Add above-below / Add left-right / Duplicate) anchored
 * at `menuAnchor` and dispatches the chosen action through Editor
 * chat.
 *
 * `editTarget` / `containerEditTarget` come from the bridge's
 * `attributeElement` walk and point at where the row/column edit
 * dispatches in source. `iterationContext` is undefined for substrates
 * the bridge doesn't (yet) extract iteration info from.
 * `cellFingerprints` is a capped, visible-text snapshot of the cells
 * in the band; the agent uses it to identify which rendered
 * row/column was targeted before reading source.
 */
export interface TableEdgeContextMenuPayload {
  kind: "row" | "column"
  index: number
  totalBands: number
  containerSelector: string
  targetSelector: string
  containerEditTarget?: { file: string; line: number; column: number }
  editTarget?: { file: string; line: number; column: number; fileHash?: string }
  iterationContext?: {
    source: "v-for" | "map" | "each" | "unknown"
    key: string | number
    index: number
    siblingCount: number
    expression: string | null
  }
  cellFingerprints: string[]
  cellCount: number
  menuAnchor: {
    x: number
    y: number
    bandRect: { top: number; left: number; width: number; height: number }
  }
}

// Shell → Bridge messages
export type ShellToBridgeMessage =
  | { type: "ENTER_COMMENT_MODE" }
  | { type: "EXIT_COMMENT_MODE" }
  | { type: "SET_COMMENTS"; payload: Comment[] }
  | { type: "SET_PINS_HIDDEN"; payload: boolean }
  | { type: "SET_SHOW_RESOLVED"; payload: boolean }
  | { type: "REQUEST_PIN_POSITIONS" }
  | { type: "HIGHLIGHT_COMMENT"; payload: { commentId: string } }
  | { type: "ENTER_NOTE_MODE" }
  | { type: "EXIT_NOTE_MODE" }
  | { type: "SET_NOTES"; payload: BridgeNote[] }
  | { type: "SET_NOTES_HIDDEN"; payload: boolean }
  | { type: "SET_SHOW_RESOLVED_NOTES"; payload: boolean }
  | { type: "HIGHLIGHT_NOTE"; payload: { noteId: string } }
  | { type: "NAVIGATE"; payload: { page: string } }
  | { type: "ACTIVATE_INSPECTOR" }
  | { type: "DEACTIVATE_INSPECTOR" }
  | { type: "HIGHLIGHT_COMPONENT"; payload: { selector: string } }
  | { type: "INSPECT_SELECTOR"; payload: { selector: string }; requestId: string }
  | { type: "GET_STRUCTURE"; payload?: { depth?: number }; requestId: string }
  | { type: "CAPTURE_ELEMENT_SCREENSHOT"; payload: { selector?: string }; requestId: string }
  | { type: "GET_PAGE_TOKENS"; requestId: string }
  // Tier-2 edit verification (BRIDGE_VERSION 2026-05-30a-verify+): read the
  // current rendered value at a selector to confirm an edit took effect.
  | {
      type: "READ_RENDERED_VALUE"
      payload: {
        selector: string
        accessor: { kind: "text" | "attr" | "style"; name?: string }
      }
      requestId: string
    }
  // Tier-2 edit verification P2 (BRIDGE_VERSION 2026-06-08e-measurements+):
  // read live geometry + a computed-style subset at a selector so the shell
  // can judge a fuzzy goal against a measurable predicate.
  | {
      type: "READ_MEASUREMENTS"
      payload: { selector: string }
      requestId: string
    }
  // Style provenance (BRIDGE_VERSION 2026-06-08a-style-provenance+): resolve
  // each property to its winning cascade rule + var(--token) chain.
  | {
      type: "GET_STYLE_PROVENANCE"
      payload: { selector: string; properties: string[] }
      requestId: string
    }
  // Override-destination discovery (BRIDGE_VERSION 2026-08-11b-css-targets+):
  // enumerate the document's loaded stylesheets so the shell can choose a
  // REACHABLE first-party `.css` to write a scoped override into.
  | { type: "GET_STYLESHEET_TARGETS"; requestId: string }
  // ── Editor extensions (BRIDGE_VERSION 2026-05-01a+) ────────────
  | { type: "INSPECT_POINT"; payload: { x: number; y: number }; requestId: string }
  | { type: "INSPECT_PARENT"; payload: { selector: string }; requestId: string }
  | {
      type: "INSPECT_CHILD"
      payload: { selector: string; childIndex: number; mode: "component" | "dom" }
      requestId: string
    }
  | { type: "INSPECT_SIBLINGS"; payload: { selector: string }; requestId: string }
  | { type: "INSPECT_MANY"; payload: { selectors: string[] }; requestId: string }
  | { type: "ENABLE_HOVER_EVENTS" }
  | { type: "DISABLE_HOVER_EVENTS" }
  | { type: "ENTER_EDITOR_MODE" }
  | { type: "EXIT_EDITOR_MODE" }
  | { type: "RELOAD_PROTOTYPE"; payload?: { reason?: string } }
  | { type: "CLEAR_SELECTION" }
  | { type: "PING" }
  /**
   * Non-committal hover preview. Unlike `HIGHLIGHT_COMPONENT`, this does NOT
   * dispatch `ELEMENT_INSPECTED` and does NOT mutate the bridge's
   * `selectedElement`. The bridge draws a transient hover overlay on the
   * matching element. `selector: null` clears any active preview.
   * Editor's layers panel uses this to mirror the iframe selection while
   * the user hovers tree rows.
   */
  | { type: "PREVIEW_HIGHLIGHT"; payload: { selector: string | null } }
  // ── DOM-edit mode (BRIDGE_VERSION 2026-05-07a-dom+) ───────────────
  | {
      type: "ENTER_DOM_EDIT_MODE"
      payload?: { experimental?: { styleEdits?: boolean } }
    }
  | { type: "EXIT_DOM_EDIT_MODE" }
  | {
      type: "RESOLVE_MUTATION_DISAMBIGUATION"
      payload: { pendingId: string; choice: "this-instance" | "all-instances" | "cancel" }
    }
  // ── Strict-buffer prop preview (BRIDGE_VERSION 2026-05-08a-prop-override+) ──
  // Editor sends APPLY_PROP_OVERRIDE per buffered prop edit so the
  // designer sees the change in the iframe before save. CLEAR_PROP_OVERRIDES
  // restores all originals on Discard.
  //
  // `overrideId` (WS3, optional): when present, the bridge registers this
  // preview in its override store under that id so a later RESOLVE_OVERRIDE
  // can release/revert it. Omitted ⇒ today's behavior (fire-and-forget,
  // untracked) — an older bridge that doesn't recognize the field ignores it.
  | {
      type: "APPLY_PROP_OVERRIDE"
      payload: {
        selector: string
        propName: string
        value: unknown
        overrideId?: string
      }
    }
  | { type: "CLEAR_PROP_OVERRIDES" }
  // ── Fallthrough-attr preview (BRIDGE_VERSION 2026-05-08e-fallthrough-attrs+) ──
  // Editor sends APPLY_ATTR_OVERRIDE per buffered attribute edit
  // (placeholder, data-testid, required, ...). Bridge walks the rendered
  // subtree and stamps the attribute on every descendant that has it,
  // falling back to the root if none do. CLEAR_ATTR_OVERRIDES restores.
  | {
      type: "APPLY_ATTR_OVERRIDE"
      payload: { selector: string; attrName: string; value: unknown }
    }
  | { type: "CLEAR_ATTR_OVERRIDES" }
  // ── Class-override live preview (BRIDGE_VERSION 2026-05-08j+) ──
  // SET_ELEMENT_CLASSES applies the new className AND layers the new
  // classes' declarations inline with !important so utility classes
  // visually win against high-specificity scoped library CSS (mirrors
  // what the Phase G save-time scoped-css-override produces).
  // CLEAR_CLASS_OVERRIDES restores the original className + style
  // attribute on Discard.
  | { type: "CLEAR_CLASS_OVERRIDES" }
  // ── Shell-initiated DOM edits (BRIDGE_VERSION 2026-05-08b-dom-edit+) ──
  // Right-rail inspector text + class inputs route through these. The
  // bridge mutates the DOM element directly; the existing DOM-edit-mode
  // MutationObserver captures the change as a regular Mutation and the
  // shell's existing Save path dispatches it as part of the llm-patch
  // bundle.
  | {
      type: "SET_ELEMENT_TEXT"
      payload: {
        selector: string
        value: string
        /**
         * 0-based index into the selector's `childNodes` for the specific
         * text node to mutate. Set when the editable text is a sibling of
         * element children (slot text alongside an icon/tooltip in
         * components like UiLabel). Omitted for pure text leaves — bridge
         * falls back to `el.textContent = value`.
         */
        textNodeIndex?: number
      }
    }
  | {
      type: "SET_ELEMENT_CLASSES"
      payload: {
        selector: string
        classes: string[]
        /**
         * Pre-resolved CSS declarations the shell wants applied as
         * inline `!important` styles for live preview. Lets the bridge
         * skip walking `document.styleSheets` (which fails when the
         * substrate has no Tailwind even though the shell emits
         * Tailwind class names — see `tailwind-declarations.ts`).
         * When omitted, the bridge falls back to its stylesheet
         * resolver for substrates that DO have the rules locally.
         */
        declarations?: Record<string, string>
      }
    }
  // ── Table-edge menu (BRIDGE_VERSION 2026-05-17b+) ───────────────────
  // Editor activates the bridge's hover-band affordance on tables /
  // grids / flex / list containers. The bridge emits TABLE_EDGE_CONTEXT_MENU
  // on right-click; the shell renders the menu and routes the chosen
  // action through Editor chat.
  | { type: "ACTIVATE_TABLE_EDGE_MENU" }
  | { type: "DEACTIVATE_TABLE_EDGE_MENU" }
  // Direct-manipulation insert-at-point placement mode (Phase 3). The shell
  // enters with the snippet's label; the bridge previews + commits on click.
  | { type: "ENTER_INSERT_PLACEMENT"; payload: { label: string } }
  | { type: "EXIT_INSERT_PLACEMENT" }
  // ── Override-store closed loop (WS3, tasks/edit-pipeline-rearchitecture.md) ──
  // The shell sends this once it learns how a dispatched edit resolved
  // (server response, thrown error, or Tier-2 render verification).
  // `id` matches a `Mutation.id` (auto-registered override) or the
  // `overrideId` passed on a prior APPLY_PROP_OVERRIDE. No-ops against an
  // id the bridge never registered (older bridge, or an untracked preview
  // that omitted `overrideId`) — always safe to send.
  | {
      type: "RESOLVE_OVERRIDE"
      payload: {
        id: string
        outcome: "confirmed" | "failed" | "ineffective"
        reason?: string
      }
    }

export type BridgeMessage = BridgeToShellMessage | ShellToBridgeMessage

/**
 * Wire-format mutation emitted by the bridge. Mirrors `Mutation` in
 * `src/editor/core/edit.ts` — duplicated here because `src/types/bridge.ts`
 * is the bridge ↔ shell wire schema and lives outside the editor's
 * module boundary. The shell normalizes the wire shape into the editor's
 * `Mutation` type before storing in the MutationLog.
 */
export interface BridgeMutation {
  id: string
  kind: "text" | "attr" | "class" | "style"
  sourceLoc: string | null
  /**
   * How many elements `[data-desde-src="<sourceLoc>"]` matched when the bridge
   * captured this. The styling lanes refuse a 0 rather than write a CSS rule
   * that matches nothing. Absent when there was no anchor to count.
   */
  anchorMatchCount?: number
  /** Per-file version hash (data-desde-v) paired with sourceLoc at capture
   *  time — the stale-target guard's input (WS1). */
  sourceVersion?: string | null
  resolutionKind: "direct" | "ancestor" | "none"
  scope: "definition" | "callsite" | "unknown"
  callsiteLoc: string | null
  /** Per-file version hash of callsiteLoc's FILE, same capture snapshot. */
  callsiteVersion?: string | null
  instancePath: string
  selector: string
  target?: string
  before: string
  after: string
  context?: {
    classListBefore: string[]
    classListAfter: string[]
    inlineStyleBefore: Record<string, string>
    inlineStyleAfter: Record<string, string>
    computedStyleDelta: Record<string, string>
    domSnippet: string
    siblingClasses: string[]
  }
}

/** Wire-format pending (awaiting-disambiguation) mutation. */
export interface BridgePendingMutation {
  pendingId: string
  draft: Omit<BridgeMutation, "instancePath">
  /**
   * V-for siblings sharing one `data-desde-src`, in document order. Exactly
   * one entry has `origin: true` — the one the designer actually edited.
   * The shell defaults the disambiguation UI to "this-instance" against
   * the origin candidate (codex round-1 P2 #3).
   */
  candidates: { instancePath: string; selector: string; origin: boolean }[]
}

export interface DOMRectJSON {
  x: number
  y: number
  width: number
  height: number
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * Live geometry + a small computed-style subset for one element, read off the
 * bridge via `READ_MEASUREMENTS`. The shape is deliberately minimal — exactly
 * what the six L3a verification predicates (`src/editor/verification/
 * predicates.ts`) need to judge a fuzzy goal deterministically, nothing more.
 *
 * Tier-2 edit verification P2 (goal → predicate). See
 * tasks/editor-edit-verification.md.
 */
export interface Measurements {
  /** `getBoundingClientRect()` of the element, viewport-relative. */
  bbox: DOMRectJSON
  /** `el.scrollWidth` — content width incl. overflow. */
  scrollWidth: number
  /** `el.clientWidth` — visible content-box width. */
  clientWidth: number
  /** `el.scrollHeight` — content height incl. overflow. */
  scrollHeight: number
  /** `el.clientHeight` — visible content-box height. */
  clientHeight: number
  /** Parent element's bbox (null when the element has no element parent). */
  parentBbox: DOMRectJSON | null
  /** The iframe's own viewport size (`innerWidth`/`innerHeight`). */
  viewport: { width: number; height: number }
  /** Resolved values for the small set of properties the predicates read. */
  computedStyle: {
    color: string
    backgroundColor: string
    fontSize: string
    display: string
    visibility: string
    opacity: string
    /**
     * CSS `text-transform`, applied by `textEquals` to BOTH the observed text
     * and the expected literal so a casing transform (source "save" rendered
     * "SAVE") doesn't false-fail regardless of how the goal is phrased.
     */
    textTransform: string
  }
  /**
   * The element's authored text for the `textEquals` predicate — `textContent`
   * (NOT innerText, which applies CSS text-transform and would false-fail a
   * correct content edit), or a form control's `.value` / selected-option label
   * (mirrors `READ_RENDERED_VALUE`, since their textContent is empty).
   */
  textContent: string
}
