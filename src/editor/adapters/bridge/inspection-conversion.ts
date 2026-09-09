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
  IterationContext,
  OutlineNode,
} from '@/types/bridge'
import { iterationTextProblem } from '@/editor/edit-service/iteration-text-limits'

const ITERATION_SOURCES: readonly IterationContext['source'][] = [
  'v-for',
  'map',
  'each',
  'unknown',
]

/**
 * The iframe's messages are cast, not parsed, so `iterationContext` arrives
 * as whatever the page put on the wire. It is not decoration: `index` and
 * `siblingCount` are rendered into the hand-off prompt's own sentences ("The
 * page shows N elements ...", "item N of M"), which sit OUTSIDE the fenced
 * fact block. A hostile prototype sending `siblingCount` as a string with
 * newlines and an instruction paragraph would write into the request half of
 * a message to the agent.
 *
 * So the shape is checked at the boundary and a context that fails is
 * DROPPED, not repaired. `siblingCount` must be at least 2 because the whole
 * question the context unlocks is "this one or all of them", which needs more
 * than one. The returned object is rebuilt field by field, so nothing else the
 * page attached rides along.
 *
 * **The result is TAGGED, and the tag is the point.** It used to return
 * `null`, and every caller read "no context" as "not an iteration" — which
 * routed a malformed context to the ORDINARY edit path. For a Layers-panel
 * delete on a real loop row that means a definition-scope delete of the shared
 * template: every row gone, from a message the page got wrong. Refusing is the
 * only safe answer, and a caller cannot refuse what it cannot distinguish from
 * "there is no loop here". `reason` is for logs and tests, never for a prompt.
 */
export type IterationContextCheck =
  | { ok: true; value: IterationContext }
  | { ok: false; reason: string }

export function validateIterationContext(value: unknown): IterationContextCheck {
  const fail = (reason: string): IterationContextCheck => ({ ok: false, reason })
  if (!value || typeof value !== 'object') return fail('not an object')
  const c = value as Record<string, unknown>
  if (typeof c.key !== 'string' && typeof c.key !== 'number') return fail('key is not a string or number')
  if (typeof c.key === 'string') {
    const problem = iterationTextProblem('key', c.key)
    if (problem) return fail(problem)
  }
  if (!Number.isInteger(c.index) || (c.index as number) < 0) return fail('index is not a non-negative integer')
  if (!Number.isInteger(c.siblingCount) || (c.siblingCount as number) < 2) {
    return fail('siblingCount is not an integer of at least 2')
  }
  if (!ITERATION_SOURCES.includes(c.source as IterationContext['source'])) return fail('source is not a known kind')
  // `expression` is optional in practice (every emitter writes it, most of
  // them as null) but must never be a non-string when present: it reaches the
  // dialog's copy.
  if (c.expression !== null && c.expression !== undefined && typeof c.expression !== 'string') {
    return fail('expression is neither a string nor null')
  }
  if (typeof c.expression === 'string') {
    const problem = iterationTextProblem('expression', c.expression)
    if (problem) return fail(problem)
  }
  return {
    ok: true,
    value: {
      source: c.source as IterationContext['source'],
      key: c.key,
      index: c.index as number,
      siblingCount: c.siblingCount as number,
      expression: typeof c.expression === 'string' ? c.expression : null,
    },
  }
}

/**
 * The same gate for the OTHER wire path that carries iteration contexts: the
 * layers tree, whose nodes reach `useEditorEditing` straight off
 * `STRUCTURE_CAPTURED` with no conversion step to hang this on. A delete from
 * the Layers panel reads its context from the node, so leaving this path
 * unchecked would leave the hand-off prompt reachable with page-controlled
 * numbers. Mutates in place: these nodes are our own structured-clone of the
 * message, and rebuilding the tree to drop a field would be a copy for
 * nothing.
 *
 * A node whose context FAILS keeps no context and gains
 * `iterationContextMalformed`, so the delete path can refuse rather than treat
 * it as an ordinary element. See {@link validateIterationContext}.
 */
export function sanitizeOutlineIterationContexts(roots: readonly OutlineNode[]): void {
  for (const node of roots) {
    if (node.iterationContext !== undefined) {
      const checked = validateIterationContext(node.iterationContext)
      if (checked.ok) {
        node.iterationContext = checked.value
        delete node.iterationContextMalformed
      } else {
        delete node.iterationContext
        node.iterationContextMalformed = true
      }
    }
    if (node.children) sanitizeOutlineIterationContexts(node.children)
  }
}

export function inspectionDataToSelection(data: InspectionData): Selection {
  // Validated once, used by both returns below. `undefined`, not `null`: the
  // field is optional on `Selection`. A page that SENT a context we could not
  // read is not the same as a page that sent none, so the failure is recorded
  // as well: every edit entry point refuses on the flag instead of quietly
  // taking the shared-template path. An ABSENT context sets neither field.
  const checked =
    data.iterationContext === undefined ? null : validateIterationContext(data.iterationContext)
  const iterationContext = checked?.ok ? checked.value : undefined
  const malformed = checked !== null && !checked.ok
  const iterationFields = malformed
    ? ({ iterationContextMalformed: true } as const)
    : ({ iterationContext } as const)
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
      ...iterationFields,
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
    ...iterationFields,
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
