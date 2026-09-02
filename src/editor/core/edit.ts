/**
 * Edit operations dispatched by editor to the FrameworkAdapter.
 *
 * Two distinct concepts live in this file:
 *
 * 1. {@link StructuralEdit} — a discriminated union over `kind`.
 *    Most structural edits are deterministic operations on the prototype
 *    source: prop changes, variant swaps, token swaps, duplicate, delete,
 *    copy/paste/move, wrap/unwrap, off-system overrides, intent
 *    and data-binding attachments. {@link FrameworkAdapter.applyEdit}
 *    accepts these.
 *
 *    {@link LLMPatchEdit} is the one LLM-mediated exception inside this
 *    union. It bundles a list of {@link Mutation}s captured by the bridge
 *    in DOM-edit mode and asks an LLM to translate them into a source
 *    patch. It flows through the same `applyEdit` dispatch surface
 *    because, from the editor's perspective, it produces the same
 *    {@link EditResult} contract — `applied` / `failed` / `cancelled`.
 *    Non-determinism is constrained: V1 only accepts mutations whose
 *    `resolutionKind === 'direct'` and whose v-for ambiguity is resolved.
 *
 * 2. {@link AgentRequest} — a free-form prose request to the agent
 *    orchestrator. Lives outside the structural-edit pipeline. The
 *    orchestrator (a layer above the adapter) interprets the prompt,
 *    produces zero or more structural edits, and applies them via
 *    `applyEdit`. The adapter itself never sees `AgentRequest`s.
 *
 * `AgentRequest` and `LLMPatchEdit` are deliberately distinct: the
 * orchestrator path takes prose and produces edits; the LLM-patch path
 * takes a bridge-captured mutation list and produces source patches.
 * Both use LLMs; only the second is dispatched as a `StructuralEdit`.
 */

import type { DesignSystemId, ManifestValue } from './manifest'
import type { IterationContext, SelectionTarget, SourceLocation } from './selection'
import type { DataBinding, IntentRecord, OffSystemMarker } from './intent'

/**
 * Cross-cutting iteration scope, opted into by structural edits that can
 * resolve to either the data array entry ("this row") or the shared
 * template ("all rows"). Applied as a mixin on {@link DeleteEdit},
 * {@link PropEdit}, {@link VariantEdit}, {@link TokenEdit},
 * {@link DuplicateEdit}, {@link MoveEdit}, {@link InsertEdit},
 * {@link PasteEdit}.
 *
 * - `'this-row'` routes the edit through the iteration-data pipeline
 *   (adapter static resolver → server applicator, or LLM fallback when
 *   unresolved). Requires {@link iterationContext} to be populated.
 * - `'all-rows'` is today's behavior — rewrite the template position.
 * - `undefined` means the edit isn't iteration-aware (legacy callers, or
 *   the selection has no iteration context).
 *
 * v1 ships with no default: the shell pops a dialog every time on
 * iterated selections, captures the choice, and writes it here. See
 * `tasks/_archive/one-shot-tasks/iteration-aware-edits.md`.
 */
export interface IterationScopeChoice {
  iterationScope?: 'this-row' | 'all-rows'
  iterationContext?: IterationContext
}

/** Reference to a component in a design system (used by `WrapEdit`). */
export interface ComponentRef {
  designSystem: DesignSystemId
  componentName: string
}

/**
 * Where to insert content into the tree. Used by `PasteEdit` and
 * `MoveEdit` to express "this slot of this parent at this position."
 */
export interface InsertionTarget {
  /** Stable target id of the destination parent. */
  parentId: string
  /**
   * Slot name within the parent, when the parent has named slots. Omit
   * for the default slot or for parents without slot semantics.
   */
  slot?: string
  /**
   * Zero-based position among siblings within the slot. Negative values
   * mean "from the end" (-1 is "append at the tail").
   */
  index: number
  /**
   * Where the destination parent's start tag lives — required for
   * source-rewriting edit pipelines (`MoveEdit`, `PasteEdit`).
   * Editor's V1 same-file move applicator uses this
   * to locate the parent in the SFC; without it, the adapter cannot
   * dispatch the edit. Mirrors {@link SelectionTarget.editTarget} for
   * the destination parent.
   */
  parentEditTarget?: SourceLocation
}

/** Common fields on every {@link StructuralEdit}. */
export interface StructuralEditBase {
  /** Stable id for undo/redo correlation in the editor-shell history stack. */
  id: string
  /** Target this edit applies to. */
  target: SelectionTarget
}

export interface PropEdit extends StructuralEditBase, IterationScopeChoice {
  kind: 'prop'
  propName: string
  value: ManifestValue
}

export interface VariantEdit extends StructuralEditBase, IterationScopeChoice {
  kind: 'variant'
  /** Variant group name, matching {@link VariantGroupManifest.name}. */
  groupName: string
  value: ManifestValue
}

export interface TokenEdit extends StructuralEditBase, IterationScopeChoice {
  kind: 'token'
  /** Style property the token is bound to (e.g., 'padding-x', 'color', 'border-radius'). */
  styleProperty: string
  /** Token id (e.g., 'spacing.md', 'color.primary'). */
  tokenId: string
}

export interface DuplicateEdit extends StructuralEditBase, IterationScopeChoice {
  kind: 'duplicate'
}

export interface DeleteEdit extends StructuralEditBase, IterationScopeChoice {
  kind: 'delete'
  /**
   * Which source position the delete rewrites:
   * - `'definition'` (the default when omitted) — delete the element from its
   *   own SFC at `target.authoredAt`; affects every instance of the
   *   component that authors it.
   * - `'callsite'` — delete the whole component usage at
   *   `target.editTarget`; affects only that one usage. Distinct from
   *   `'definition'` only when `authoredAt.file !== editTarget.file`
   *   (i.e., the element was authored in a child SFC and used at a
   *   parent's call site).
   *
   * Collapsed into one field (rather than mirroring `Mutation`'s separate
   * `scope` + `disambiguationChoice`) because a `DeleteEdit` has no
   * detect-vs-choose split — the shell prompts the user for the scope up front.
   */
  scope?: 'definition' | 'callsite'
}

/**
 * Which delete scopes are *applicable* for a given target. A scope is
 * unavailable when its location is missing or points into `node_modules` —
 * editor never rewrites library source. The delete-scope modal and the
 * pending-edit toggle both gate their controls on this, and the adapter
 * refuses anything that slips through (defense in depth).
 */
export function deleteScopeAvailability(target: {
  authoredAt?: SourceLocation
  editTarget?: SourceLocation
}): { definition: boolean; callsite: boolean } {
  const editable = (file: string | undefined): boolean =>
    !!file && !file.split('/').includes('node_modules')
  // Callsite scope is only meaningful when `editTarget` lives in a
  // DIFFERENT file than `authoredAt`. For native elements and
  // component leafs the two are equal — offering both scopes would
  // produce identical edits with confusing UX. The bridge populates
  // both fields unconditionally now (post-attribution-consolidation),
  // so the same-file check moves here rather than living as a wire
  // shape filter.
  const distinct =
    !!target.authoredAt &&
    !!target.editTarget &&
    target.authoredAt.file !== target.editTarget.file
  return {
    definition: editable(target.authoredAt?.file),
    callsite: distinct && editable(target.editTarget?.file),
  }
}

/** Copy the target to editor's clipboard. */
export interface CopyEdit extends StructuralEditBase {
  kind: 'copy'
}

/** Paste editor's clipboard contents into a destination. */
export interface PasteEdit extends StructuralEditBase, IterationScopeChoice {
  kind: 'paste'
  destination: InsertionTarget
}

/**
 * Move the target to a new location, possibly across parents or slots.
 * Same-parent reorders are the degenerate case: pass the target's own
 * parent as `destination.parentEditTarget` and the new sibling index as
 * `destination.index`.
 */
export interface MoveEdit extends StructuralEditBase, IterationScopeChoice {
  kind: 'move'
  destination: InsertionTarget
  /**
   * Conditional-GROUP move (see `list-conditional-groups.ts` +
   * `apply-move-edit.ts`'s `moveGroup`). Set when `target` is a synthetic
   * layers-panel group row (`OutlineNode.conditionalGroup` populated) —
   * `target.editTarget` is the group's `<template v-if>`/`v-for` HEAD
   * wrapper's coordinates, and the applicator relocates the whole branch
   * chain (all paired `v-else-if`/`v-else` siblings) as one unit instead
   * of just the head element. Vue only.
   */
  moveGroup?: boolean
}

/**
 * Insert a NEW element into the prototype source. Distinct from
 * `PasteEdit` (which moves a clipboard-buffered element) — `InsertEdit`
 * adds new content from a palette / generator.
 *
 * `target` is the destination parent (mirrors `MoveEdit.destination`'s
 * parent semantics; we reuse `target` so `applyEdit` dispatch stays
 * uniform). The actual SFC line/column comes from
 * `target.editTarget`. The new content is supplied as a verbatim
 * Vue template snippet — UI may construct the snippet from a typed
 * spec (`<UiCard></UiCard>`, `<div class="..."></div>`) or pass through
 * a more elaborate one.
 */
export interface InsertEdit extends StructuralEditBase, IterationScopeChoice {
  kind: 'insert'
  /** Final 0-based index in the parent's element children. -1 = append. */
  destIndex: number
  /**
   * The payload to insert. For `contentKind:'element'` (default) a single
   * Vue template element; for `contentKind:'text'` a plain text node.
   */
  snippet: string
  /**
   * Whether `snippet` is a single element (default) or a bare text node.
   * Text mode lets a palette / agent drop plain text into a container.
   */
  contentKind?: 'element' | 'text'
}

export interface WrapEdit extends StructuralEditBase {
  kind: 'wrap'
  /** Layout primitive (or other component) to wrap the target in. */
  wrapper: ComponentRef
}

export interface UnwrapEdit extends StructuralEditBase {
  kind: 'unwrap'
}

/**
 * Tier 2 (LLM-assisted-repair) commit shape. After the user approves
 * an LLM-proposed full-file rewrite, the buffer entry transitions from
 * the original failed primitive edit to an `OverwriteEdit` carrying the
 * new source. Save then dispatches this through the same route; the
 * server compile-checks and writes verbatim.
 *
 * Intentionally NOT exposed to general adapter users — it bypasses the
 * deterministic-applicator layer. Created only by the repair-flow hook
 * after explicit user approval of an LLM rewrite.
 */
export interface OverwriteEdit extends StructuralEditBase {
  kind: 'overwrite'
  /** Repo-relative file path. */
  file: string
  /** New source. The server compile-checks and writes verbatim. */
  newSource: string
  /**
   * SHA-256 hex digest of the on-disk source AT THE TIME the LLM saw
   * it. The save endpoint re-hashes the current disk contents before
   * writing; mismatch → 409 conflict. Without this guard the LLM's
   * proposed rewrite would silently clobber any IDE-side or external
   * edits made between propose and approve. Codex review (May 2026)
   * caught the gap.
   *
   * Optional only for backwards compatibility / non-LLM-sourced
   * overwrites; the LLM proposal endpoints always populate it.
   */
  baseHash?: string
  /**
   * Phase 4 new-file path. When `true`, the save endpoint creates the
   * file if it doesn't exist (rather than rejecting with "file not
   * found"). Defaults to `false` — repair/Tier 3 overwrites must hit
   * an existing file. The chat orchestrator's `propose_new_file` tool
   * sets this to `true`; all other paths leave it off so accidental
   * file creation needs an explicit opt-in.
   */
  allowCreate?: boolean
}

/**
 * Collapse a Vue conditional chain (`v-if` / optional `v-else-if`s /
 * optional `v-else`) down to a single chosen branch. The applicator
 * deletes the non-chosen branches and unwraps the surviving wrapper —
 * children are hoisted up to the wrapper's former position.
 *
 * `target.editTarget` points at the `v-if` root element (the first
 * link in the chain). `branchToKeep` is an index into the chain:
 *   - 0 — the v-if branch
 *   - 1, 2, ... — the Nth v-else-if branch
 *   - "else" — the v-else branch (must exist on the chain)
 *
 * Refused if:
 *  - The element at editTarget has no v-if directive (chain root).
 *  - The chosen branch doesn't exist on the chain.
 *  - The chosen branch has no rendered children (collapsing to nothing —
 *    use Delete on the chain instead).
 *  - Collapsing would leave the template with multiple roots.
 */
export interface FlattenConditionalEdit extends StructuralEditBase {
  kind: 'flatten-conditional'
  branchToKeep: number | 'else'
}

/**
 * Detach a component instance into its underlying template — the Figma
 * "Detach instance" operation. Inlines the component's `<template>` at the
 * call site in the consumer SFC, substituting prop references with the
 * call-site values, splicing consumer slot content into matching `<slot>`
 * positions, and copying the component's scoped styles and any internal
 * sub-component imports.
 *
 * Refused for components with internal reactive state, scoped slot props,
 * lifecycle hooks affecting render, or pure-JS render functions (no
 * `<template>` to inline). The applicator surfaces a per-case reason.
 *
 * Affects only the consumer SFC. The component definition is untouched;
 * other usages of the component continue to work normally.
 */
export interface DetachEdit extends StructuralEditBase {
  kind: 'detach'
  /**
   * Source path of the component's SFC. The applicator reads this file to
   * inline its template. The consumer SFC path comes from `target.editTarget.file`.
   */
  componentFile: string
}

/**
 * Replace the component reference at `target.editTarget` with a
 * different component. The applicator rewrites the call-site tag,
 * remaps props by name, and updates the consumer's `<script setup>`
 * imports. Slot children pass through verbatim (V1 doesn't remap
 * named slots — that's V2 work alongside cross-file moves).
 */
export interface SwapEdit extends StructuralEditBase {
  kind: 'swap'
  /** PascalCase name of the existing component at the call-site. */
  fromComponentName: string
  /** PascalCase name of the replacement component. */
  toComponentName: string
  /**
   * Per-prop mapping. Keys are old-component prop names.
   *  - string: rename to that prop on the new component.
   *  - null: drop the prop with a `<!-- swap: dropped X="Y" -->` marker.
   *  - absent: pass through unchanged.
   */
  propMapping?: Readonly<Record<string, string | null>>
  /**
   * Required props the new component declares. The applicator refuses
   * if these aren't satisfied after mapping. Caller sources from the
   * F1 catalog; defaults to no check.
   */
  newComponentRequiredProps?: ReadonlyArray<string>
  /**
   * New component's import source. Provide one or the other.
   * `toPackageName`: bare-specifier package import (`@acme/...`).
   * `toFile`: relative path to first-party SFC (`./components/X.vue`).
   * Omit both to skip import injection (assumes auto-import).
   */
  toPackageName?: string
  toFile?: string
  /**
   * When true, the applicator removes the import for the old
   * component if no other call-sites reference it. Caller is
   * responsible for the "no other call-sites" check (cross-file walk
   * is V2); this just trusts the hint.
   */
  removeFromImport?: boolean
}

/**
 * Apply an explicit off-system override. Editor marks the element
 * structurally so the eng MCP can flag it during handoff.
 */
export interface OffSystemOverrideEdit extends StructuralEditBase {
  kind: 'off-system-override'
  marker: OffSystemMarker
}

/**
 * Restyle an element the designer does not own, by writing a CSS rule
 * anchored on its rendered `data-desde-src` coordinate. The polish-loop
 * capability: it reaches INSIDE a third-party component, where no source
 * edit can go.
 *
 * **Two things this edit names, and they are not the same thing.**
 *
 *  - `anchor` — the coordinate that goes in the rule HEAD. It must be a value
 *    literally present on an element in the rendered document, which means it
 *    comes from the bridge's `resolveDomAnchor` and NOTHING else. Not
 *    `authoredAt` (on a component root that is the `data-desde-own` rescue stamp,
 *    which no element carries), not `editTarget`. See
 *    `tasks/dev-server-hosts.md` §§ 9g.8-9g.9: anchoring this on the wrong
 *    field wrote rules that matched zero elements and reported `ok: true`.
 *  - `target.editTarget` — the DESTINATION file the rule is written into. On
 *    Vue that is the consumer SFC (`<style scoped>`, `:deep()` for the
 *    descendant form) and it happens to equal the anchor's file. On React it
 *    is a project `.css` the document actually loads, and it does not.
 *
 * They were one field until React needed the lane, and that conflation is
 * exactly what made the Vue code read as though `editTarget` were a valid
 * selector source. Both are written out explicitly now, on both substrates.
 *
 * Same anchor + same deep selector overwrites the prior rule on revisit
 * (idempotent — the rule head is the key).
 */
export interface ScopedCssOverrideEdit extends StructuralEditBase {
  kind: 'scoped-css-override'
  /**
   * The rendered `data-desde-src` coordinate the rule head is built from, plus
   * how many elements it matched when it was read. **Both fields must come
   * from the same `resolveDomAnchor` call** — the dead-anchor guard compares
   * the count against the anchor and is blind to a producer that computes
   * them from different places (§ 9g.9).
   */
  anchor: {
    file: string
    line: number
    column: number
    /** `data-desde-v` content version of the anchor's file, when stamped. */
    version?: string
  }
  /**
   * Selector for the styled element RELATIVE to the anchor (e.g.
   * `.card-header`). Optional: absent for the *direct* case where the anchor
   * IS the styled element. On Vue it is wrapped in `:deep()` to pierce the
   * scope boundary; React has no style scoping, so it is a plain descendant.
   */
  deepSelector?: string
  /** Tailwind utility classes to wrap in `@apply`. Vue destinations only —
   *  a plain `.css` may not be Tailwind-processed, and an uncompiled
   *  `@apply` is a rule that is present and inert. */
  applyClasses?: string[]
  /** Raw CSS declarations (property → value). */
  declarations?: Record<string, string>
}

/**
 * React/JSX inline styling edit — the `.tsx`/`.jsx` analog of
 * {@link ScopedCssOverrideEdit}. React has no universal `<style scoped>`
 * equivalent, so an inline restyle lands in the substrate's own idiom, chosen
 * by `mode` (the shell picks it from the detected styling system —
 * `editor-cli/src/server/styling-system-detection.ts`):
 *
 *   - `'classname'` — merge Tailwind utility classes into the element's
 *     `className` string (conflicts resolved by tailwind-merge).
 *   - `'inline'` — merge CSS declarations into a JSX `style={{ … }}` object.
 *
 * `target.editTarget` provides the styled element's own `data-desde-src`
 * (file + Babel coords). Applied by `apply-jsx-style-edit.ts`. Additive-first,
 * mirroring the Vue scoped-override lane.
 */
export interface JsxStyleEdit extends StructuralEditBase {
  kind: 'jsx-style'
  mode: 'classname' | 'inline'
  /** `classname` mode: Tailwind utility classes to add. */
  addClasses?: string[]
  /** `classname` mode: classes to remove. */
  removeClasses?: string[]
  /** `inline` mode: CSS declarations to set (kebab-case property → value). */
  declarations?: Record<string, string>
  /** `inline` mode: CSS properties to remove (kebab-case). */
  removeDeclarations?: string[]
}

/** Attach (or update) an intent record on the target. */
export interface IntentEdit extends StructuralEditBase {
  kind: 'intent'
  intent: IntentRecord
}

/** Attach (or update) a data binding on the target. */
export interface DataBindingEdit extends StructuralEditBase {
  kind: 'data-binding'
  binding: DataBinding
}

// ---------- DOM-edit + LLM-patch types ----------
//
// These types describe the bridge ↔ shell ↔ adapter contract for
// {@link LLMPatchEdit}. The bridge captures DOM-edit-mode mutations,
// resolves them against the rendered Vue component tree, and surfaces
// them to the shell. The shell accumulates the log; on save, dispatches
// {@link LLMPatchEdit} containing the bundle.

/**
 * How well a captured mutation could be mapped back to source.
 *
 * - `'direct'`: the edited DOM node carries `data-desde-src` *and* the Vue
 *   component-tree walk produced an unambiguous `instancePath`. V1 only
 *   patches `direct` mutations.
 * - `'ancestor'`: the edited node has no `data-desde-src` but a nearby
 *   ancestor does. Surfaced to the designer with explicit "cannot
 *   reliably map" — never silently retargeted (codex round-1 P1 #2).
 * - `'none'`: no `data-desde-src` ancestor within reasonable depth. Refused.
 */
export type MutationResolutionKind = 'direct' | 'ancestor' | 'none'

/**
 * Whether a mutation targets the host component's template definition or
 * a specific call-site.
 *
 * - `'definition'`: `sourceLoc` points at the host component's template
 *   line. This is the typical case — `data-desde-src` is injected on
 *   template elements, which render as the root of that component's DOM.
 * - `'callsite'`: the edit was disambiguated to apply to a specific
 *   call-site rather than the component definition (Phase F).
 * - `'unknown'`: capture happened before scope was determined.
 */
export type MutationScope = 'definition' | 'callsite' | 'unknown'

/**
 * Style/class capture context for richer LLM patching. Only present on
 * mutations of `kind: 'class' | 'style'`. Includes the project-local
 * cues a Tailwind-aware translation needs (codex round-2 NEW #4 / P1 #3):
 * what classes and inline styles were on the element before/after, what
 * the computed style change actually was, the immediate DOM neighborhood
 * for surrounding-class taxonomy, and what classes sibling elements use.
 */
export interface MutationContext {
  classListBefore: readonly string[]
  classListAfter: readonly string[]
  inlineStyleBefore: Readonly<Record<string, string>>
  inlineStyleAfter: Readonly<Record<string, string>>
  /** Only properties whose computed values changed. */
  computedStyleDelta: Readonly<Record<string, string>>
  /** outerHTML of the edited element + 2 levels of parent context. */
  domSnippet: string
  /** Class names used by sibling elements — taxonomy hint. */
  siblingClasses: readonly string[]
}

/**
 * The user's choice when bridge captures a mutation whose `instancePath`
 * collides with other v-for instances sharing one `sourceLoc`.
 */
export type DisambiguationChoice =
  | 'this-instance' // patch only the call-site that produced this DOM node
  | 'all-instances' // patch the v-for template (affects every iteration)

/**
 * A captured DOM mutation, anchored back to source via `data-desde-src`.
 * Bridge emits these once {@link PendingMutation}s have been resolved
 * (or skipped) by the shell. See `tasks/_archive/spikes/dom-edit-patch-spike.md` for the
 * full design rationale.
 */
export interface Mutation {
  /** Stable id for revert / verification correlation. */
  id: string
  kind: 'text' | 'attr' | 'class' | 'style'
  /** `data-desde-src` value on the edited node, or null when none. */
  sourceLoc: string | null
  /**
   * How many elements `[data-desde-src="<sourceLoc>"]` matched in the live
   * document at capture time. The bridge is the only place that can answer
   * this, and the styling lanes must refuse a 0 rather than write a CSS rule
   * that matches nothing (`tasks/dev-server-hosts.md` § 9g.8).
   *
   * Absent when the bridge supplied no count — nothing to check, so nothing
   * is refused; a fabricated count would be worse than none.
   */
  anchorMatchCount?: number
  /**
   * Per-file source-version hash (`data-desde-v` stamp) paired with
   * `sourceLoc` at capture time. The edit server compares it against the
   * current on-disk file and refuses the batch as stale-target when they
   * diverge — the coordinates provably predate the file's current bytes.
   * Null/absent when the source-tag plugin didn't stamp versions.
   */
  sourceVersion?: string | null
  resolutionKind: MutationResolutionKind
  scope: MutationScope
  /**
   * Where this instance is referenced. Resolved via Vue component-tree
   * walk (NOT DOM ancestry — codex round-2 P1 #1): ascend the parent
   * component chain to the first parent whose template file differs from
   * the edited node's host file; record that parent's call-site
   * position. Null when no such parent exists.
   */
  callsiteLoc: string | null
  /**
   * Per-file version hash (`data-desde-v`) of `callsiteLoc`'s FILE, captured in
   * the same DOM snapshot. Cross-file (callsite-targeted) mutations splice
   * against the callsite file, so the stale-target guard checks this hash
   * for them, not just `sourceVersion`.
   */
  callsiteVersion?: string | null
  /**
   * Unique path through the Vue component tree (e.g.,
   * `"App>HomePage>List[2]"`). Disambiguates v-for siblings that share a
   * single `sourceLoc`.
   */
  instancePath: string
  /** CSS selector for verification round-trips. */
  selector: string
  /** Attribute / class / style key. Absent for text edits. */
  target?: string
  before: string
  after: string
  /** Only present on `kind: 'class' | 'style'`. */
  context?: MutationContext
  /**
   * Set when `instancePath` collisions exist. Phase B's UI (or the
   * test-only resolver) writes this; Phase C's edit service reads it.
   */
  disambiguationChoice?: DisambiguationChoice
}

/**
 * Bridge → shell intermediate state when v-for ambiguity exists.
 * The bridge holds the captured change in a pending state, fires
 * `MUTATION_AWAITING_DISAMBIGUATION` with the candidates, and waits for
 * the shell to resolve via `resolveMutationDisambiguation`. Bridge then
 * promotes to a fully-formed {@link Mutation} and emits
 * `MUTATION_CAPTURED`.
 */
export interface PendingMutation {
  /** Distinct from the eventual `Mutation.id` — pending until resolved. */
  pendingId: string
  /** Almost-complete mutation; missing only the `instancePath` choice. */
  draft: Omit<Mutation, 'instancePath' | 'disambiguationChoice'>
  /**
   * v-for siblings sharing this `sourceLoc`, in document order. Exactly
   * one entry has `origin: true` — the one the designer actually edited.
   * UI defaults to "this-instance" against the origin so the most
   * common case is one click.
   */
  candidates: readonly { instancePath: string; selector: string; origin: boolean }[]
}

/**
 * LLM-mediated patch from a bundle of DOM-edit-mode mutations.
 *
 * Dispatched by the editor shell when the designer hits Save in DOM
 * edit mode. The adapter forwards the bundle to the edit-service, which
 * groups mutations by source file, calls the LLM per file with the
 * project's style context (Tailwind config / design tokens / class
 * taxonomy) inside the prompt cache window, and writes the patched
 * sources atomically.
 *
 * **Important — `target` is incidental, not authoritative.** Inherited
 * from {@link StructuralEditBase} only because the editor's edit
 * pipeline expects every edit to carry one. A `LLMPatchEdit` bundle
 * targets *many* DOM nodes across potentially many source files; the
 * single `target` field carries the designer's save-time selection so
 * editor can invalidate the right inspector scope after the patch
 * lands. **Do not consume `target` to scope which files get patched —
 * the authoritative scope is in `mutations`.**
 *
 * V1 hard-refuses any mutation whose `resolutionKind !== 'direct'` and
 * any mutation whose v-for ambiguity remains unresolved.
 */
export interface LLMPatchEdit extends StructuralEditBase {
  kind: 'llm-patch'
  /** Bundle of DOM-edit-mode mutations to translate into source patches. */
  mutations: readonly Mutation[]
  /**
   * Optional Phase E external-edit guard. SHA-256 hex hashes per file
   * (relative to prototype root) the shell expects to find unchanged
   * server-side. The route hashes each pre-write source and rejects with
   * 409 + `external-edit-conflict` if any expected hash doesn't match.
   * Absent → no guard (first save in a session, or testing).
   */
  baseHashes?: Readonly<Record<string, string>>
  /**
   * Per-dispatch fallback routing when the deterministic lane can't apply
   * a mutation:
   *  - `'chat'` — typing-time dispatch: the server returns `needsChat` so
   *    the shell QUEUES the fuzzy edit instead of running the LLM (no
   *    mid-edit interruption).
   *  - `'patch'` — commit/flush-time dispatch: run the LLM lane to APPLY
   *    the queued edits into the worktree.
   * Absent → the adapter defaults to `'chat'`.
   */
  llmFallback?: 'patch' | 'chat'
}

/**
 * The discriminated union over `kind`.
 *
 * `FrameworkAdapter.applyEdit` accepts only `StructuralEdit`. Agent
 * orchestration runs above the adapter — see {@link AgentRequest}.
 */
export type StructuralEdit =
  | PropEdit
  | VariantEdit
  | TokenEdit
  | DuplicateEdit
  | DeleteEdit
  | CopyEdit
  | PasteEdit
  | MoveEdit
  | InsertEdit
  | WrapEdit
  | UnwrapEdit
  | DetachEdit
  | SwapEdit
  | OffSystemOverrideEdit
  | ScopedCssOverrideEdit
  | JsxStyleEdit
  | TokenValueEdit
  | FlattenConditionalEdit
  | OverwriteEdit
  | IntentEdit
  | DataBindingEdit
  | LLMPatchEdit
  | TextBranchEdit

/**
 * Edit one branch of a `{{ test ? a : b }}` Vue interpolation. The
 * inspector's "two-field" UI for conditional text uses this to splice
 * the chosen branch's source bytes in place. Paired server-side with
 * `applyTextBranchEdit` (deterministic byte-splice — no LLM lane).
 *
 * `target.editTarget` is unused — the dispatch is fully described by
 * `byteStart` / `byteEnd` / `valueKind` / `file`. We still carry
 * `target` for parity with other StructuralEdits (id, undo bookkeeping,
 * label rendering in the pending-changes panel).
 */
export interface TextBranchEdit extends StructuralEditBase {
  kind: 'text-branch'
  /** SFC the branch lives in. Same shape as other applicators' `file` arg. */
  file: string
  /** SFC-absolute byte range for the branch (incl. quotes for literals). */
  byteStart: number
  byteEnd: number
  /** Drives quote-wrapping behavior — see `applyTextBranchEdit`. */
  valueKind: 'literal' | 'bound'
  /**
   * New content. For `"literal"`, unquoted user input (we re-wrap).
   * For `"bound"`, raw JS source spliced verbatim.
   */
  newValue: string
}

/**
 * Patch a CSS custom-property (design-token) VALUE at its definition — §6 Phase
 * 3 "The token" scope. Distinct from {@link TokenEdit} (which BINDS a property
 * to a token id); this changes the token's value so every consumer updates.
 * The applicator is `apply-token-edit.ts` (pure, by-name within the winning
 * selector). The CLI handler refuses when `file` resolves into `node_modules`
 * (library tokens aren't writable).
 */
export interface TokenValueEdit extends StructuralEditBase {
  kind: 'token-value'
  /** Token file (first-party), prototype-root-relative. */
  file: string
  /** Custom property name, e.g. `--acme-color-background-disabled`. */
  tokenName: string
  /** New value (resolved CSS value, e.g. `#3b82f6`). */
  newValue: string
  /** Winning definition selector (e.g. `:root`) — disambiguates theming defs. */
  selector?: string
}

/**
 * Free-form prose request to the agent orchestrator. The orchestrator
 * interprets the prompt and produces zero or more `StructuralEdit`s,
 * which then flow through `FrameworkAdapter.applyEdit` like any other
 * structural edit.
 *
 * Lives intentionally outside `StructuralEdit` — `applyEdit` does not
 * accept `AgentRequest`. This keeps the adapter pipeline deterministic
 * and pushes interpretive logic to a higher layer.
 */
export interface AgentRequest {
  /** Stable id for tracking the request through the orchestrator. */
  id: string
  /** Optional target the request is scoped to. Some prompts are global ("create a new screen"). */
  target?: SelectionTarget
  /** Prose description of the desired change. */
  prompt: string
}
