/**
 * Pure conversion helpers between the bridge's wire shapes
 * (`InspectionData`, `BridgeMutation`, `BridgePendingMutation` — all defined in
 * `@/types/bridge`) and editor-core's neutral types (`Selection`, `Mutation`,
 * `PendingMutation`). Extracted from `index.ts` (share-readiness Phase 2) — no
 * behavior change, just a module boundary; `BridgeFrameworkAdapter` imports
 * these back in.
 *
 * `hoverTargetToSelectionTarget` lived here until 2026-08-06. It converted the
 * `HOVER_TARGET_CHANGED` payload and had zero callers repo-wide — the hover
 * stream never acquired a consumer, and the adapter has stopped enabling it.
 * Deleted rather than kept as a seam: it is internal to this adapter (no
 * package boundary crosses it), and a future hover feature would rewrite it
 * against whatever shape that feature needs anyway.
 */

import type {
  DisambiguationChoice,
  Mutation,
  PendingMutation,
  Selection,
  SelectionAncestor,
  SourceLocation,
} from '../../core'
import type {
  BridgeMutation,
  BridgePendingMutation,
  ComponentTreeNode,
  InspectionData,
} from '@/types/bridge'

export function inspectionDataToSelection(data: InspectionData): Selection {
  const componentTree = data.componentTree ?? []
  // Prefer the edit-target component (the one whose source declaration
  // carries the resolved data-desde-src) over the leaf of the Vue parent
  // chain. The leaf is often a library internal — e.g. UiButton inside a
  // UiDropdown — that has no source location of its own; editing it would
  // silently rewrite the wrapper's source and surface the wrong manifest.
  // When the bridge supplies editTargetComponent (BRIDGE_VERSION
  // 2026-05-06a+), align the inspector display, manifest lookup, and
  // edit-dispatch on the same component.
  const editTarget = data.editTargetComponent
  let primaryIndex = componentTree.length - 1
  let primaryEditTarget: SourceLocation | undefined
  if (editTarget) {
    const matchIdx = componentTree.findIndex(
      (n) => n.name === editTarget.name && n.file === editTarget.file,
    )
    if (matchIdx >= 0) primaryIndex = matchIdx
  } else {
    // No edit-target component (React: the bridge resolves one through Vue
    // instances only). The tree is root-first, and every node whose
    // elementSelector is the clicked selector is rooted at the clicked
    // element: a transparent-wrapper stack. The innermost of those is the
    // library internal or the inner half of a wrapper; the OUTERMOST that
    // carries a callsite stamp is the tag the user wrote, which is what
    // the Structure panel labels the element with (`detectOutlineComponent`
    // picks the outermost) and what the Vue lane's editTargetComponent
    // means. Measured on the bundled Acme demo: `[App, Button, Button]`
    // with the last being base-ui's internal. Prefer a stamped match, then
    // any match, then the old last-node default.
    const rootedHere = (n: ComponentTreeNode) =>
      n.elementSelector.length > 0 && n.elementSelector === data.selector
    const outermostStamped = componentTree.findIndex((n) => rootedHere(n) && !!n.callsite)
    const outermost = outermostStamped >= 0 ? outermostStamped : componentTree.findIndex(rootedHere)
    if (outermost >= 0) primaryIndex = outermost
    // The edit target follows the component the rail shows. The bridge's
    // `editTarget` is the callsite of the INNERMOST owning instance; for a
    // first-party wrapper over a library component that is the library
    // tag inside the wrapper's own file (Acme demo, measured: the rail
    // showed Button at App.tsx:26 while editTarget said
    // components/ui/button.tsx:50, the <ButtonPrimitive> tag). A prop edit
    // on the shown component belongs at that component's own tag, which
    // is exactly what its callsite stamp records.
    if (outermostStamped >= 0) {
      primaryEditTarget = parseCallsite(componentTree[outermostStamped])
    }
  }
  const primary = primaryIndex >= 0 ? componentTree[primaryIndex] : null
  // Distinguish "user clicked the component's render root" from "user
  // clicked an internal DOM element of that component". The componentTree
  // entry's `elementSelector` is the component's render root; if the
  // selected element's selector matches, it's a component-level selection,
  // otherwise the layers panel's element-row was the user's intent and the
  // inspector should reflect THAT element (not the enclosing component).
  //
  // One carve-out (F-08): an element with NO stamp of its own is
  // library-internal markup — there are no bytes to element-edit, so an
  // element view would be a dead end (and was: every library component under
  // a first-party wrapper demoted here, with Variants & Props unreachable
  // from both the canvas and the tree). When the bridge says
  // `selfStamped: false`, keep the component-level view of the edit-target
  // component. Bundles older than 2026-09-01a omit the field; `!== false`
  // preserves their selector-equality behavior.
  const selectedAsElement =
    !!primary && primary.elementSelector !== data.selector && data.selfStamped !== false

  const computedStyles = flattenStyleCategories(data.styles)

  if (selectedAsElement) {
    // Element-level selection: show the element identity and treat the
    // enclosing component as ancestry. Skip componentName/componentFile so
    // the manifest pipeline doesn't load a component manifest for what is
    // really an internal element (no Variants & Props, no Detach).
    const ancestry: SelectionAncestor[] = componentTree
      .slice(0, primaryIndex + 1)
      .reverse()
      .map((node) => ({
        targetId: node.elementSelector,
        componentName: node.name,
        componentFile: node.file,
      }))

    return {
      targetId: data.selector,
      selector: data.selector,
      tagName: data.tagName,
      selectedAsElement: true,
      authoredAt: data.authoredAt,
      editTarget: data.editTarget,
      domAnchor: data.domAnchor,
      isLibrary: data.isLibrary,
      iterationContext: data.iterationContext,
      classes: data.classes,
      editableTexts: data.editableTexts,
      attributionContext: data.attributionContext,
      computedStyles,
      ancestry,
      // Fallthrough attrs from the enclosing component (e.g. `placeholder`
      // on `<UiInput>`, which Acme DS doesn't type-declare as a prop).
      // Surfacing these here lets the inspector's Attributes section render
      // even when the user's click lands on an internal DOM node — the
      // attr-edit dispatch already follows `editTarget` to the parent
      // callsite, so routing is unchanged.
      currentAttrs: primary?.attrs,
    }
  }

  const ancestryNodes = componentTree.slice(0, primaryIndex)
  // componentTree is root-first; reverse so ancestry is leaf-first (parent
  // at index 0) per the Selection.ancestry contract.
  const ancestry: SelectionAncestor[] = ancestryNodes
    .slice()
    .reverse()
    .map((node) => ({
      targetId: node.elementSelector,
      componentName: node.name,
      componentFile: node.file,
    }))

  return {
    targetId: data.selector,
    selector: data.selector,
    tagName: data.tagName,
    componentName: primary?.name ?? data.component?.name,
    componentFile: primary?.file ?? data.component?.file,
    componentLine: primary?.line ?? data.component?.line,
    packageName: primary?.packageName,
    authoredAt: data.authoredAt,
    editTarget: primaryEditTarget ?? data.editTarget,
    domAnchor: data.domAnchor,
    isLibrary: data.isLibrary,
    iterationContext: data.iterationContext,
    // Live prop values from the primary component instance. Without this,
    // after a manual page reload the inspector renders manifest defaults
    // that disagree with the already-rendered iframe.
    currentProps: primary?.props,
    // Fallthrough attributes (`instance.attrs`) — what the parent template
    // passed that the design system didn't typed-declare. Surfaced as a
    // separate map so the inspector can render an Attributes section.
    currentAttrs: primary?.attrs,
    classes: data.classes,
    editableTexts: data.editableTexts,
    attributionContext: data.attributionContext,
    computedStyles,
    ancestry,
  }
}

/**
 * Flatten the bridge's categorized `StyleCategory[]` into a flat
 * `property → value` map for the right-rail's computed-style fallback.
 * The bridge already filters out browser-default values, so the resulting
 * map contains only declarations that actually differ from the UA
 * default — an Acme DS button with `padding: 12px 24px` shows up; a
 * plain `<div>` with no styling produces an empty map.
 *
 * Stays in this file rather than `core/` because the wire-shape input
 * (`StyleCategory`) is bridge-owned; only the adapter is allowed to
 * touch it. Editor-core consumers see the flat map.
 */
export function flattenStyleCategories(
  categories: InspectionData['styles'],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const category of categories ?? []) {
    for (const property of category.properties ?? []) {
      if (!property.name || !property.value) continue
      out[property.name] = property.value
    }
  }
  return out
}

/**
 * Convert the wire-shape `BridgeMutation` (defined in `src/types/bridge.ts`,
 * lives outside the editor module boundary) into the editor's
 * `Mutation` type. This is a structural mirror — the two shapes match by
 * design, but keeping a converter makes any future divergence loud.
 */
export function bridgeMutationToCore(payload: BridgeMutation): Mutation {
  return {
    id: payload.id,
    kind: payload.kind,
    sourceLoc: payload.sourceLoc,
    // The live match count for `sourceLoc` as a CSS anchor. Dropping it
    // here is silent in the worst way: the styling lanes read `undefined`
    // as "no count to check" and write the dead rule anyway, so a lost
    // ZERO looks exactly like a healthy anchor (§ 9g.8).
    anchorMatchCount: payload.anchorMatchCount,
    // Version stamps must survive this mapping or the server's
    // stale-target guard receives null for every llm-patch mutation —
    // exactly the stale-coordinate case it exists to catch (codex final
    // round P2).
    sourceVersion: payload.sourceVersion ?? null,
    resolutionKind: payload.resolutionKind,
    scope: payload.scope,
    callsiteLoc: payload.callsiteLoc,
    callsiteVersion: payload.callsiteVersion ?? null,
    instancePath: payload.instancePath,
    selector: payload.selector,
    target: payload.target,
    before: payload.before,
    after: payload.after,
    context: payload.context
      ? {
          classListBefore: payload.context.classListBefore.slice(),
          classListAfter: payload.context.classListAfter.slice(),
          inlineStyleBefore: { ...payload.context.inlineStyleBefore },
          inlineStyleAfter: { ...payload.context.inlineStyleAfter },
          computedStyleDelta: { ...payload.context.computedStyleDelta },
          domSnippet: payload.context.domSnippet,
          siblingClasses: payload.context.siblingClasses.slice(),
        }
      : undefined,
    disambiguationChoice: (payload as { disambiguationChoice?: DisambiguationChoice })
      .disambiguationChoice,
  }
}

/** Convert the wire draft (no `instancePath`) into the editor's draft. */
export function bridgeMutationDraftToCore(
  payload: BridgePendingMutation['draft'],
): PendingMutation['draft'] {
  return {
    id: payload.id,
    kind: payload.kind,
    sourceLoc: payload.sourceLoc,
    anchorMatchCount: payload.anchorMatchCount,
    // Same stamp-preservation rule as bridgeMutationToCore: a v-for
    // disambiguation can pend for minutes — the version pairing matters
    // MORE here, not less.
    sourceVersion: payload.sourceVersion ?? null,
    resolutionKind: payload.resolutionKind,
    scope: payload.scope,
    callsiteLoc: payload.callsiteLoc,
    callsiteVersion: payload.callsiteVersion ?? null,
    selector: payload.selector,
    target: payload.target,
    before: payload.before,
    after: payload.after,
    context: payload.context
      ? {
          classListBefore: payload.context.classListBefore.slice(),
          classListAfter: payload.context.classListAfter.slice(),
          inlineStyleBefore: { ...payload.context.inlineStyleBefore },
          inlineStyleAfter: { ...payload.context.inlineStyleAfter },
          computedStyleDelta: { ...payload.context.computedStyleDelta },
          domSnippet: payload.context.domSnippet,
          siblingClasses: payload.context.siblingClasses.slice(),
        }
      : undefined,
  }
}

/**
 * A tree node's callsite stamp (`file:line:col`, the column as the stamp
 * carries it, which is what the bridge's own `editTarget` passes through)
 * as a {@link SourceLocation}, with the paired file version as `fileHash`
 * so the stale-target guard still applies.
 */
function parseCallsite(node: ComponentTreeNode): SourceLocation | undefined {
  const raw = node.callsite
  if (!raw) return undefined
  const match = /^(.+):(\d+):(\d+)$/.exec(raw)
  if (!match) return undefined
  return {
    file: match[1],
    line: Number(match[2]),
    column: Number(match[3]),
    fileHash: node.callsiteVersion,
  }
}
