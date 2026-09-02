/**
 * Manifest-first attribution. See `tasks/attribution-rewrite.md` for the
 * architecture; this file is the load-bearing function the inspector
 * uses to decide "what did the user click and where does the edit go."
 *
 * The function is pure: it consumes an {@link AttributionContext} (built
 * by the bridge from live runtime state) and a {@link ManifestLookup}
 * (provided by the shell) and produces an {@link AttributionResult}.
 * No DOM access, no Vue introspection, no I/O — that makes it cheap to
 * unit-test against synthetic contexts before any bridge wiring exists.
 *
 * Algorithm (high level):
 *
 *   1. Identify which prop/slot of the OWNING component (innermost) the
 *      clicked element corresponds to, by matching the clicked element's
 *      selector against the owning component manifest's `dom` rendering
 *      hints.
 *
 *   2. Walk UP the component chain looking for ancestors whose `forward`
 *      hints target the current (component, prop/slot) pair. Forwards
 *      come in two flavors:
 *        - `forwardTo.childProp` — ancestor's prop feeds the child's prop
 *          (e.g., `<MyCard title="x">` wraps `<UiInput :label="title">`)
 *        - `forwardTo.childSlot` — ancestor's prop or slot feeds the
 *          child's slot (e.g., `<UiInput label="x">` renders `<UiLabel>{{ label }}</UiLabel>`)
 *      Each forward hop can re-target as either a prop or slot on the
 *      ancestor; the walk continues until no further forward claims it.
 *
 *   3. When the walk terminates with no further forward, resolve at the
 *      terminating component's call site:
 *        - prop terminal: edit the prop value at the consumer's tag
 *        - slot terminal: edit the slot text inside the consumer's tag
 *
 *   4. If no manifest match at any level: return `refuse` with a useful
 *      reason. The inspector surfaces this as an explanatory descriptor
 *      ("library-internal — set X at the call site instead") rather
 *      than silently dropping the field.
 *
 * Depth safety: the upward walk bounds total forward hops with
 * `MAX_FORWARD_DEPTH`. The chain itself is monotonically increasing
 * (each recursion starts past the previous ancestor's index), so the
 * algorithm cannot loop on a fixed chain. Malformed manifests that
 * self-reference terminate at the depth bound with a `refuse` result.
 */

import type { RenderingHint } from '../core'
import type {
  AttributionContext,
  AttributionResult,
  ClickedElementContext,
  ComponentChainEntry,
  ConsumerPropValue,
  ManifestLookup,
  SourceLoc,
} from './types'

/**
 * Defense-in-depth bound on forward-hint recursion. With the strict
 * one-hop-per-recursion walk in `walkForward`, `chainIndex` advances
 * by exactly 1 per hop, so the chain length itself naturally bounds
 * the walk — this cap only fires if a future change accidentally
 * breaks the monotonic-advance invariant. Set well above realistic
 * Vue component-tree depth (typical apps: 10-25; pathological
 * provider/HOC stacks: 30-50) so legitimate chains never hit it.
 *
 * Exported so the regression test for the cap can derive its chain
 * length from this constant — keeping the test exercise the cap
 * automatically if a future change raises the cap further.
 */
export const MAX_FORWARD_DEPTH = 64

/**
 * Trust gate for the deterministic attribution lane. A hint routes
 * deterministically ONLY when it's hand-authored (no `provenance` field
 * at all is the legacy convention for a hint authored directly in source,
 * predating this schema) or has been probe-verified. There is currently no
 * hand-authored hint anywhere in the tree — the one example that used to
 * exist, a bundled-JSON manifest source at
 * `src/editor/adapters/acme-ds/rendering-hints.ts`, was deleted 2026-08-10
 * (see `src/editor/adapters/README.md` § "No vendor adapters"); every hint
 * in the tree today is `generated` (probe-derived, `Generate hints`) or
 * `inferred` (source-inferred). The `hand-authored` convention stays
 * supported because the schema still allows it and existing callers rely on
 * the absent-provenance default — it just has no current producer.
 * Generated/inferred-but-unverified hints are filtered out wherever
 * `rendering` is consulted, so an all-untrusted set behaves EXACTLY like
 * `rendering` being absent — same refuse reasons, same fallback behavior.
 * A wrong trusted hint would silently produce a wrong deterministic edit,
 * which is worse than falling back to the LLM lane; this is the one
 * function every rendering-hint consumer must route through.
 *
 * Exported so drift detection (`detect-drift.ts`) can reuse the exact same
 * trust gate `attribute()` uses when deciding whether a manifest "has hints"
 * for the `hint-miss` structural check — reimplementing the predicate there
 * would risk the two definitions drifting apart, silently misclassifying a
 * no-hints-authored refusal as a hint-miss (or vice versa).
 */
export function isTrustedHint(hint: RenderingHint): boolean {
  return (hint.provenance ?? 'hand-authored') === 'hand-authored' || hint.verified === true
}

export function attribute(
  context: AttributionContext,
  registry: ManifestLookup,
): AttributionResult {
  const chain = context.componentChain
  if (chain.length === 0) {
    return {
      kind: 'refuse',
      reason: 'No owning component identified for the clicked element.',
    }
  }

  const owning = chain[0]
  const owningManifest = registry.getByName(owning.name, owning.importPath)
  const trustedRendering = owningManifest?.rendering?.filter(isTrustedHint)

  if (!owningManifest || !trustedRendering || trustedRendering.length === 0) {
    return {
      kind: 'refuse',
      reason: `No rendering hints for ${owning.name}; cannot attribute deterministically. Add a manifest with rendering hints to enable editing.`,
    }
  }

  // Step 1: match the clicked element against the owning component's
  // dom hints. The matching policy is exact selector equality for V1;
  // future versions may want CSS containment / specificity.
  const domHit = findDomHit(trustedRendering, context.clickedElement)
  if (!domHit) {
    return {
      kind: 'refuse',
      reason: `No rendering hint matched the clicked element (selector "${context.clickedElement.selectorWithinMountRoot}") inside ${owning.name}. The element may be rendered by library-internal markup; add a hint to ${owning.name}'s manifest if it should be editable.`,
    }
  }

  // Honor explicit uneditable hints up front — these communicate
  // "this surface exists but the library or convention says don't edit
  // it." The inspector renders the reason as the field descriptor.
  //
  // Checked BEFORE the selector-ambiguity refusal below (deliberately —
  // codex review, Task 3 adjudication): `editability: 'uneditable'` is a
  // static, manifest-authored policy on this (component, selector) pair —
  // it holds regardless of how many DOM elements currently match. Leading
  // with the ambiguity message when the target is ALSO uneditable would
  // tell the user "add a more specific dom hint to disambiguate," falsely
  // implying that would unlock editing; leading with `uneditable` gives
  // the truthful, actionable reason instead. Both orders still refuse (no
  // edit-risk regression either way), and `detectDrift`'s
  // `selector-ambiguous` rule is computed independently of `attribute()`'s
  // result kind, so this ordering doesn't drop that drift signal.
  if (domHit.editability === 'uneditable') {
    return {
      kind: 'refuse',
      reason: domHit.uneditableReason ?? `${domHit.source.name} is marked uneditable in ${owning.name}'s manifest.`,
    }
  }

  // Phase 5 Task 3 (click-time selector uniqueness): a trusted dom hit
  // matched, but the bridge determined the selector matches MORE THAN ONE
  // element within this mount root — the hint may be pointing at the
  // wrong instance (e.g. a manifest authored against a since-changed
  // template, or a repeated element with no disambiguating class/id).
  // Refuse rather than risk a wrong deterministic edit. `undefined`
  // (unknown — no mount root resolvable, older bridge, unsupported
  // substrate) and `true` (unique) both fall through unchanged — this
  // must not regress substrates that can't compute the signal.
  if (context.clickedElement.soleMatchWithinMountRoot === false) {
    return {
      kind: 'refuse',
      reason: `The clicked element's selector ("${context.clickedElement.selectorWithinMountRoot}") matches multiple elements within ${owning.name}'s mount root, so this hint may be stale; refusing rather than risk editing the wrong instance. Add a more specific dom hint to disambiguate.`,
    }
  }

  // Step 2: walk the forward chain. The walk handles both prop and
  // slot sources uniformly — at each ancestor we look for a forward
  // hint that targets the current (component, kind, name) tuple; if
  // found, we hop to the ancestor's source (which may itself be a
  // prop or slot) and continue. The walk terminates when no further
  // forward claims it, and we resolve at the terminating call site.
  const result = walkForward({
    chain,
    chainIndex: 0,
    currentKind: domHit.source.kind,
    currentName: domHit.source.name,
    registry,
    clicked: context.clickedElement,
    depth: 0,
  })

  // Attach the render site (the dom hint that matched the clicked element)
  // to deterministic results. This is the prop→DOM map run forward — the
  // read-back target for Tier-2 edit verification (the "oracle for free").
  // `domHit.domTarget` is relative to the owning component's mount root; the
  // shell composes the absolute selector from the clicked element's selector.
  if (result.kind === 'direct' || result.kind === 'cross-file') {
    return {
      ...result,
      renders: {
        selector: domHit.domTarget.selector,
        field: domHit.domTarget.field,
        ...(domHit.domTarget.attribute !== undefined
          ? { attribute: domHit.domTarget.attribute }
          : {}),
      },
    }
  }
  return result
}

// ──────────────── helpers ────────────────

/**
 * Exported alongside {@link isTrustedHint} for the same reason: drift
 * detection's `hint-miss` rule needs to know structurally whether Step 1
 * (matching the clicked element against the owning component's dom hints)
 * found nothing — reusing this function is the only way to guarantee that
 * check stays in lockstep with what `attribute()` itself just did, rather
 * than a parallel reimplementation that could silently diverge.
 */
export function findDomHit(
  hints: RenderingHint[],
  clicked: ClickedElementContext,
): Extract<RenderingHint, { kind: 'dom' }> | null {
  for (const hint of hints) {
    if (hint.kind !== 'dom') continue
    if (hint.domTarget.selector !== clicked.selectorWithinMountRoot) continue
    // For attribute targets, also require the attribute name matches.
    if (hint.domTarget.field === 'attribute') {
      if (hint.domTarget.attribute !== clicked.attributeName) continue
    }
    return hint
  }
  return null
}

interface WalkForwardArgs {
  chain: ComponentChainEntry[]
  /** Index in `chain` whose component currently "owns" the prop/slot. */
  chainIndex: number
  /** What kind of source we're currently resolving (prop or slot). */
  currentKind: 'prop' | 'slot'
  /** Name of the prop or slot we're currently resolving. */
  currentName: string
  registry: ManifestLookup
  clicked: ClickedElementContext
  /** Recursion depth — bounded by MAX_FORWARD_DEPTH. */
  depth: number
}

function walkForward(args: WalkForwardArgs): AttributionResult {
  if (args.depth > MAX_FORWARD_DEPTH) {
    return {
      kind: 'refuse',
      reason: `Forward-hint chain exceeded max depth (${MAX_FORWARD_DEPTH}); the manifests may self-reference. Check rendering-hints definitions for ${args.chain[args.chainIndex]?.name ?? 'unknown'}.`,
    }
  }

  const here = args.chain[args.chainIndex]

  // Forward hints describe ONE parent-child hop (each manifest knows
  // only its own immediate child relationships). To walk multi-level
  // chains, we hop one level at a time via recursion — NEVER iterate
  // through multiple ancestors here, because chain[chainIndex+2]'s
  // forwards describe its relationship to chain[chainIndex+1] (a
  // DIFFERENT child), not its relationship to `here`. Iterating past
  // a missing-manifest intermediate would silently misattribute by
  // matching against the wrong parent-child boundary.
  const immediateParent = args.chain[args.chainIndex + 1]
  if (!immediateParent) {
    // Top of chain — no further forward possible. Resolve at here.
    return resolveTerminal(here, args.currentKind, args.currentName, args.clicked, {
      reason: 'top-of-chain',
    })
  }

  const parentManifest = immediateParent.name
    ? args.registry.getByName(immediateParent.name, immediateParent.importPath)
    : null
  const trustedParentRendering = parentManifest?.rendering?.filter(isTrustedHint)
  if (!trustedParentRendering || trustedParentRendering.length === 0) {
    // Parent has no manifest (or no rendering hints) — we cannot see
    // its forward semantics, so we terminate at `here`. This is
    // conservative on purpose: walking past the unmanifested parent
    // and matching a higher ancestor's forward against `here.name`
    // would falsely claim attribution when the unmanifested parent
    // is actually doing arbitrary rewrapping (slot rename, prop
    // transform). Without a manifest we cannot tell transparent
    // wrappers (HOC, provider, Suspense) from rewrapping ones.
    //
    // Known limitation: in real Vue apps the "unmanifested transparent
    // wrapper" case is common (providers, layout shells, route
    // components) and stopping here means attribution refuses for any
    // click whose meaningful ancestor sits past such a wrapper. The
    // long-term answer is an explicit `transparent: true` (or
    // `kind: 'passthrough'` hint) on the wrapper's manifest, opted
    // into by the wrapper author. Until that exists, the unblock is:
    // add a minimal manifest for the wrapper with forward hints for
    // whatever slots/props it actually passes through.
    //
    // Surface this reason on any downstream refuse so debugging
    // points the user at the real fix (add a manifest for the
    // unmanifested intermediate) rather than at a misleading
    // "vnode has no source position" message.
    return resolveTerminal(here, args.currentKind, args.currentName, args.clicked, {
      reason: 'unmanifested-parent',
      parentName: immediateParent.name,
    })
  }

  // Did the parent actually RENDER this child, or was it merely HANDED it?
  //
  // Both frameworks report the NESTING parent as `.parent`, so a component
  // the user passed as slot/children content looks identical to one the
  // parent rendered itself. Only the second licenses the parent's manifest to
  // describe what this component displays. `renderedByParent` carries the
  // answer, read at runtime by the framework adapter (Vue `vnode.ctx`, React
  // `fiber._debugOwner`).
  //
  // Without this a generated hint hijacks the user's own component. The live
  // case: `KEmptyState.actionButtonText -> KButton.default` is a verified
  // hint, and `AIGatewayListEmptyState.vue` puts a user `<KButton>` in
  // KEmptyState's `#action` slot. Clicking that button's text would retarget
  // the edit onto `action-button-text` on the surrounding `<KEmptyState>`
  // tag, leaving the button the user actually clicked untouched. This is a
  // REGRESSION guard: before forward hints existed the walk terminated here
  // and `resolveTerminal` wrote at the user's own tag, which is right.
  //
  // UNKNOWN (undefined) refuses, same as false. The asymmetry is deliberate:
  // refusing costs a hint and degrades to the heuristic/LLM lane, while
  // allowing a hop we cannot justify edits the wrong source. An earlier cut
  // of this guard inferred authorship from source paths instead and was
  // wrong twice — a `data-desde-src` stamp can be INHERITED through Vue's
  // attribute fallthrough onto a component that did not author it, and the
  // definition-file path it compared against is absent on React entirely, so
  // it refused every stamped React child.
  if (here.renderedByParent !== true) {
    return resolveTerminal(here, args.currentKind, args.currentName, args.clicked, {
      reason: 'child-authored-elsewhere',
      parentName: immediateParent.name,
    })
  }

  const forwardHint = findForwardHint(
    trustedParentRendering,
    here.name,
    args.currentKind,
    args.currentName,
  )
  if (!forwardHint) {
    // Parent has manifest but no forward claims this prop/slot — the
    // surface is authored at `here`'s call site. Terminate.
    return resolveTerminal(here, args.currentKind, args.currentName, args.clicked, {
      reason: 'no-matching-forward',
      parentName: immediateParent.name,
    })
  }

  // Hop up exactly one level. The new owner is the immediate parent;
  // re-target as the ancestor's source (which may itself be a prop or
  // slot that recurses up another level). chainIndex monotonically
  // advances; MAX_FORWARD_DEPTH bounds malformed self-referencing
  // manifests.
  return walkForward({
    ...args,
    chainIndex: args.chainIndex + 1,
    currentKind: forwardHint.source.kind,
    currentName: forwardHint.source.name,
    depth: args.depth + 1,
  })
}

function findForwardHint(
  hints: RenderingHint[],
  childComponentName: string,
  childKind: 'prop' | 'slot',
  childName: string,
): Extract<RenderingHint, { kind: 'forward' }> | null {
  for (const hint of hints) {
    if (hint.kind !== 'forward') continue
    if (hint.forwardTo.component !== childComponentName) continue
    if (childKind === 'slot') {
      if (hint.forwardTo.childSlot !== childName) continue
    } else {
      if (hint.forwardTo.childProp !== childName) continue
    }
    return hint
  }
  return null
}

/**
 * Why the forward walk terminated at this consumer. Threaded into
 * `resolveTerminal` so any downstream `refuse` carries actionable
 * context — particularly the `unmanifested-parent` case, where the
 * actual fix is "add a manifest for the intermediate wrapper" and
 * the user should not be led to look at `consumer`'s source position
 * for the explanation.
 */
interface TerminationReason {
  reason:
    | 'top-of-chain'
    | 'unmanifested-parent'
    | 'no-matching-forward'
    | 'child-authored-elsewhere'
  parentName?: string
}


function resolveTerminal(
  consumer: ComponentChainEntry,
  kind: 'prop' | 'slot',
  name: string,
  clicked: ClickedElementContext,
  termination: TerminationReason,
): AttributionResult {
  if (!consumer.consumerSourceLoc) {
    // Tailor the refusal message based on WHY the walk stopped.
    // The `unmanifested-parent` case is the high-frequency "transparent
    // wrapper" debugging trap; surface the real fix (manifest authoring)
    // rather than blame `consumer`'s missing source position.
    if (termination.reason === 'unmanifested-parent') {
      return {
        kind: 'refuse',
        reason: `Cannot attribute deterministically: the immediate parent component${termination.parentName ? ` (${termination.parentName})` : ''} has no rendering manifest, so the forward chain breaks here. ${consumer.name} itself has no source position (likely library-internal). To fix, add a manifest with rendering hints for ${termination.parentName ?? 'the intermediate wrapper'} so attribution can walk through it.`,
      }
    }
    return {
      kind: 'refuse',
      reason: `${consumer.name}'s vnode has no source position; cannot locate the call site. This usually means the component was mounted by framework code (router, Suspense) rather than by user template.`,
    }
  }

  if (kind === 'slot') {
    // Slot text is authored between the open/close tags at the
    // consumer's call site. Pass the raw text through verbatim (no
    // trimming) so intentional padding survives to the inspector
    // display. applySlotTextEdit is whitespace-preserving on rewrite
    // (matches via trimmed compare, splices via source's preserved
    // leading/trailing whitespace), so trimming here doesn't affect
    // edit correctness — only display faithfulness, which matters.
    //
    // Prefer `ownText` (direct text-node children only) over
    // `textContent` (whole subtree). A library component that renders
    // slot text alongside a nested element — e.g.
    // `<UiLabel :info="…">Paths</UiLabel>` puts an `:info` tooltip
    // `<div>` inside the same `<label>` — would otherwise yield
    // `textContent` = "PathsA list of paths that match…", which never
    // matches the source slot text ("Paths"). When `ownText` is
    // undefined (legacy contexts / pre-bridge tests), fall back to
    // `textContent`. When `ownText` IS defined but empty, do NOT fall
    // back: an empty ownText means the slot content is entirely nested
    // elements (no literal text to edit) and we should refuse rather
    // than re-capture the nested text.
    const raw = clicked.ownText !== undefined ? clicked.ownText : (clicked.textContent ?? '')
    if (raw.trim().length === 0) {
      return {
        kind: 'refuse',
        reason: `Slot "${name}" on ${consumer.name} has empty rendered text; cannot use this click as a slot-text edit anchor.`,
      }
    }
    return {
      kind: 'direct',
      targetFile: consumer.consumerSourceLoc.file,
      sourceLoc: consumer.consumerSourceLoc,
      editKind: 'slot',
      slotName: name,
      currentValue: raw,
      valueType: 'string',
    }
  }

  // kind === 'prop' — resolve the consumer's literal/binding for this prop.
  const propValue = consumer.consumerVnodeProps?.[name]
  if (propValue === undefined) {
    return {
      kind: 'refuse',
      reason: `${consumer.name}.${name} is not currently set at the call site. To edit, add the prop to the <${consumer.name}> tag.`,
    }
  }
  return classifyPropValue(consumer.consumerSourceLoc, name, propValue)
}

function classifyPropValue(
  callSite: SourceLoc,
  propName: string,
  propValue: ConsumerPropValue,
): AttributionResult {
  if (propValue.kind === 'literal') {
    return {
      kind: 'direct',
      targetFile: callSite.file,
      sourceLoc: callSite,
      editKind: 'prop',
      propName,
      currentValue: String(propValue.value),
      valueType: typeOf(propValue.value),
    }
  }

  // Binding — would route cross-file if we had the bound expression's
  // source. V1 of the compile-time `:prop` source stamp isn't in yet;
  // until then, bindings without `bindingLoc` route to LLM.
  if (!propValue.bindingLoc) {
    return {
      kind: 'llm',
      estimatedSeconds: 30,
      reason: `${propName} is a bound expression and the binding source location is not yet captured by the compile plugin. AI fallback will attempt the edit.`,
    }
  }

  // With bindingLoc + expression: try to classify into a deterministic
  // cross-file pattern. V1 handles only the simple-identifier case.
  // Complex expressions (function calls, indexing, conditionals,
  // optional chaining, nullish coalescing) fall through to LLM.
  const expr = propValue.expression?.trim() ?? ''

  // v-for guard (case 6): a binding whose ROOT identifier is a v-for
  // iteration variable (e.g. `option.label` inside `v-for="option in
  // options"`) looks like a simple member-access to `isSimpleIdentifier`,
  // but `option` has no standalone definition — it's an array element.
  // Routing it to `cross-file: ref` would point the edit at a
  // non-existent `option` declaration (a wrong deterministic edit). Keep
  // it off the deterministic path: send it to the LLM lane until the
  // `cross-file: v-for-data` path (per-row vs all-rows) exists. The
  // `user.name`/`user.profile.x` cross-file:ref cases are unaffected —
  // they only route here when `loopVariableRoots` does NOT contain the
  // root, which is the default when the bridge can't see a v-for scope.
  const exprRoot = expr.split(/[.[(?]/, 1)[0]?.trim()
  if (exprRoot && propValue.loopVariableRoots?.includes(exprRoot)) {
    return {
      kind: 'llm',
      estimatedSeconds: 30,
      reason: `${propName} is bound to v-for iteration variable \`${exprRoot}\` (expression \`${expr}\`); per-row vs all-rows editing isn't deterministically supported yet, so this can't be a cross-file:ref edit. AI fallback will attempt it. (Future: cross-file:v-for-data editing the iterated array.)`,
    }
  }

  if (isSimpleIdentifier(expr)) {
    return {
      kind: 'cross-file',
      targetFile: propValue.bindingLoc.file,
      sourceLoc: propValue.bindingLoc,
      pattern: 'ref',
      currentValue: String(propValue.value ?? ''),
      meta: { identifier: expr },
    }
  }

  return {
    kind: 'llm',
    estimatedSeconds: 30,
    reason: `${propName} is bound to expression \`${expr}\` which is not a simple identifier; AI fallback required.`,
  }
}

function isSimpleIdentifier(expr: string): boolean {
  // Matches `someName`, `someName.foo`, `someName.foo.bar` — single
  // identifier with optional plain member-access chain. Explicitly
  // rejects optional chaining (`?.`), nullish coalescing (`??`),
  // function calls, indexing, computed access, ternaries, template
  // literals, and any arithmetic. The regex itself is anchored and
  // disallows `?` and other operators by construction; the explicit
  // exclusion checks below catch cases the regex would silently
  // permit if it ever loosens.
  if (expr.length === 0) return false
  if (/[?:!()[\]{}+\-*/%&|^~`,]/.test(expr)) return false
  if (expr.includes('??')) return false
  if (expr.includes('?.')) return false
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(expr)
}

function typeOf(value: string | number | boolean): 'string' | 'number' | 'boolean' {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return 'string'
}
