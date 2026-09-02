/**
 * Desde Bridge — Override Preview (editor strict-buffer live preview)
 *
 * Extracted from `comment-bridge.ts` (share-readiness Phase 2, second
 * decomposition pass). Mechanical move — no behavior change. Bundles:
 *
 *  - The OverrideStore-chain bookkeeping (WS3, tasks/edit-pipeline-
 *    rearchitecture.md): `chainRegister`/`chainOnResolve` supersede
 *    same-target overrides registered under fresh per-keystroke ids, and
 *    `retireHooks` lets a terminal RESOLVE_OVERRIDE retire the right
 *    per-kind bookkeeping (prop stash / attr stash / class style shim).
 *  - The prop-override, attr-override, and class-override live-preview
 *    implementations (editor's strict-buffer model: mutate the live
 *    instance/DOM so the iframe shows an edit before it's written to
 *    source).
 *  - The six RESOLVE_OVERRIDE / APPLY_*_OVERRIDE / CLEAR_*_OVERRIDES
 *    postMessage handlers, as thin `handle*` methods the main switch in
 *    `comment-bridge.ts` delegates to.
 *
 * NOTE (write-path scope): the prop- and attr-override halves are
 * Vue-only BY CURRENT SCOPE — they read `el.__vueParentComponent` /
 * `getVueInstanceRootElement` directly, the same runtime convention the
 * rest of the pre-FrameworkRuntimeAdapter bridge code used. Generalizing
 * this write path behind `FrameworkRuntimeAdapter` (so a React substrate
 * gets the same live-preview closed loop) is deferred React-parity work,
 * not done here — this extraction preserves the Vue-only behavior
 * verbatim.
 *
 * Instantiated once in `init()` via `createOverridePreview()` and passed
 * explicitly to `createDomEditMode(inspector, overridePreview)` — replacing
 * the previous mutable IIFE-scope ref (`clearClassOverrideForFn`) that let
 * a sibling top-level function reach into init()-local state.
 */
import { sendToShell } from "./bridge-runtime"
import { OverrideStore } from "./override-store"
import { getVueInstanceRootElement } from "./framework-component-detection"
import type { ResolveOverridePayload, ApplyPropOverridePayload } from "./bridge-types"
// Wire type: shared with the shell (same rule as the style-provenance types) so
// the discriminator the shell DECIDES on has one definition, not two.
import type { PreviewFailureKind } from "../types/bridge"

export type { PreviewFailureKind }

/**
 * Outcome of a live-preview poke (prop or fallthrough attr).
 *
 * Was a bare `boolean`. It carries a reason now because the shell reports
 * `ok: false` to the designer, and only the bridge can tell WHICH failure it
 * was — a selector that no longer resolves, a substrate with no Vue instance,
 * a component with no props, or an assignment the component refused all look
 * identical from the shell. The old boolean's whole information content was
 * "something didn't work", which is what let the shell drop it silently.
 *
 * `kind` accompanies the prose because one of those four is not a user-facing
 * failure at all (see {@link PreviewFailureKind}), and "which one is it" must be
 * a field the shell can branch on rather than a string it has to match.
 */
export type PreviewApplyResult =
  | { ok: true }
  | { ok: false; kind: PreviewFailureKind; reason: string }

export interface OverridePreview {
  readonly store: OverrideStore
  /**
   * Register `id` as the live entry for `chainKey`, superseding any live
   * prior (released silently — no revert). Returns the chain's shared
   * revert-target box for the caller's closures.
   */
  chainRegister(
    chainKey: string,
    id: string,
    before: unknown,
    after: unknown,
  ): { value: unknown }
  /** Shell resolved override `id` — rebase/cleanup the chains. */
  chainOnResolve(id: string, outcome: string): "live-retired" | "superseded" | "none"
  /** Per-override retire hooks (WS3, codex round-10) — see comment-bridge.ts's
   *  registerMutationOverride for the "classOv" producer. */
  readonly retireHooks: Map<string, { kind: "prop" | "attrOv" | "classOv"; retire: () => void }>
  /** Class-override live preview: layers resolved declarations (or shell-
   *  supplied ones) inline with `!important` so utility classes beat scoped
   *  library CSS. */
  applyClassOverride(
    el: HTMLElement,
    afterClasses: string[],
    preResolvedDeclarations?: Record<string, string>,
  ): void
  /**
   * Was `el`'s CURRENT inline declaration for `property` stamped by
   * {@link applyClassOverride} rather than authored by the prototype?
   *
   * The narrow, read-only seam the provenance walker consults to fill
   * `StyleOrigin.inline.fromPreview` (`src/bridge/style-provenance.ts`), so the
   * shell can identify editor's own shim exactly instead of inferring it from
   * "an inline `!important` on a property we recently previewed" (which also
   * catches an author's own inline `!important`). Deliberately a QUERY, not
   * shared mutable state: the walker stays a pure function over a passed
   * element, and gets this injected by `comment-bridge.ts`'s
   * GET_STYLE_PROVENANCE handler.
   *
   * Exact by construction — the answer comes from the set of properties the
   * engine actually ACCEPTED on the most recent stamp for this element (read
   * back off the declaration afterwards, because `setProperty` silently no-ops
   * rather than throwing on a value/name it rejects), cleared in lockstep with
   * the inline-style snapshot it belongs to. Returns false for an element with
   * no live class override, for a stamp that did not land (illegal value,
   * camelCase property name, unknown property), and for anything the prototype
   * authored itself.
   */
  isPreviewStampedProperty(el: Element, property: string): boolean
  /** Targeted restore for ONE element: className + inline-style snapshot. */
  clearClassOverrideFor(el: Element): void
  /** Restore only the inline-style shim from the snapshot and drop it,
   *  leaving className assignment to the caller (SET_ELEMENT_CLASSES'
   *  revert closure sets className to the chain's revert-target value,
   *  not necessarily the original snapshot). */
  releaseClassStyleSnapshot(el: Element): void
  handleResolveOverride(payload: ResolveOverridePayload | undefined): void
  handleApplyPropOverride(payload: ApplyPropOverridePayload | undefined): void
  handleClearPropOverrides(): void
  handleApplyAttrOverride(
    payload: { selector?: string; attrName?: string; value?: unknown; overrideId?: string } | undefined,
  ): void
  handleClearAttrOverrides(): void
  handleClearClassOverrides(): void
}

/**
 * The key a stamped property is recorded and looked up under.
 *
 * Ordinary CSS property names are case-INsensitive, so folding them to lower
 * case keeps the write and read sides agreeing (`Background-Color` vs
 * `background-color`). Custom properties are case-SENSITIVE — `--Brand` and
 * `--brand` are two different properties — so they pass through verbatim;
 * lowercasing them would collide two distinct declarations on one element into
 * a single record.
 */
function stampKey(property: string): string {
  return property.startsWith("--") ? property : property.toLowerCase()
}

export function createOverridePreview(): OverridePreview {
  // WS3 override store — default timing options (300ms re-assert /
  // 5s unverified / 20s give-up, see override-store.ts).
  const store = new OverrideStore({ sendToShell })

  // ── Chain bookkeeping (WS3) ─────────────────────────────────────────
  // Supersede chains: repeated captures/pokes on the same target
  // register under FRESH ids (edit ids are per-keystroke). Without
  // supersede, two live store entries would fight — the older one
  // re-asserting its stale `after` on every tick. Keyed by
  // `${kind}|${selector}|${target}`; registering a successor releases the
  // prior entry silently (no revert), and the successor's revert target is
  // a SHARED MUTABLE BOX that starts at the chain's original before.
  //
  // The box matters for the rapid-edit race (codex WS3 P2 ×2): capture1
  // (A→B) dispatches, capture2 (B→C) supersedes it, THEN dispatch1
  // SUCCEEDS — source now holds B. If dispatch2 later fails, the survivor
  // must revert to B (the landed value), not A. `chainOnResolve` rebases
  // the box when a superseded id resolves confirmed/ineffective; `failed`
  // resolutions of superseded ids leave the box alone (source unchanged).
  interface OverrideChain {
    id: string
    /** The value this entry's dispatch would land in source on success. */
    after: unknown
    /** Shared revert target for every closure in this chain. */
    revertTarget: { value: unknown }
    /** Superseded ids still awaiting resolution → the `after` each landed. */
    priorAfters: Map<string, unknown>
  }
  const overrideChains = new Map<string, OverrideChain>()

  function chainRegister(
    chainKey: string,
    id: string,
    before: unknown,
    after: unknown,
  ): { value: unknown } {
    const prior = overrideChains.get(chainKey)
    const priorLive = prior && store.get(prior.id) ? prior : undefined
    if (priorLive) {
      store.resolve(priorLive.id, "confirmed")
      priorLive.priorAfters.set(priorLive.id, priorLive.after)
    }
    const chain: OverrideChain = priorLive
      ? { id, after, revertTarget: priorLive.revertTarget, priorAfters: priorLive.priorAfters }
      : { id, after, revertTarget: { value: before }, priorAfters: new Map() }
    overrideChains.set(chainKey, chain)
    return chain.revertTarget
  }

  function chainOnResolve(id: string, outcome: string): "live-retired" | "superseded" | "none" {
    for (const [key, chain] of overrideChains) {
      if (chain.id === id) {
        overrideChains.delete(key)
        return "live-retired"
      }
      if (chain.priorAfters.has(id)) {
        if (outcome === "confirmed" || outcome === "ineffective") {
          chain.revertTarget.value = chain.priorAfters.get(id)
        }
        chain.priorAfters.delete(id)
        return "superseded"
      }
    }
    return "none"
  }

  // Per-override retire hooks (WS3, codex round-10): a prop chain's revert
  // baseline lives in the `propOverrides` first-poke stash. Once the LIVE
  // chain id terminally resolves via RESOLVE_OVERRIDE, that stash entry is
  // STALE — the DOM now shows source truth (confirmed) or the restored
  // original (failed) — and must be dropped so the NEXT chain on the same
  // selector/prop re-stashes from the current rendered value instead of
  // reverting to a pre-previous-edit value. Keyed by override id; only
  // populated for prop registrations. Internal supersede resolves bypass
  // this map (chain continues; the stash must persist for it).
  const retireHooks = new Map<string, { kind: "prop" | "attrOv" | "classOv"; retire: () => void }>()

  // ─── Prop override (editor strict-buffer preview) ───────────────────
  //
  // The editor's strict-buffer model needs to show prop edits in the
  // iframe before they're written to source files. The shell sends
  // APPLY_PROP_OVERRIDE; we mutate `instance.props[propName]` and force
  // a re-render. Originals are stashed so CLEAR_PROP_OVERRIDES (sent on
  // discard) can restore them.
  //
  // Caveats:
  //   - Vue 3 emits a "Set operation on key 'X' failed: target is
  //     readonly" warning when we mutate props. The mutation still
  //     succeeds — Vue only protects child-side writes by convention,
  //     not by freezing.
  //   - If the parent re-renders for an unrelated reason, it'll pass
  //     the original prop value down again and clobber our override.
  //     The user's UI flow (don't navigate during a buffered edit
  //     session) avoids this. We could re-apply on each parent render
  //     if it becomes a problem.
  //   - Only handles props bound to a Vue 3 component instance found
  //     via `__vueParentComponent` on the selector's element. Vue 2 is
  //     not yet covered.
  interface BridgePropOverride {
    selector: string
    propName: string
    originalValue: unknown
  }
  const propOverrides: BridgePropOverride[] = []

  /**
   * Does this page expose the component-instance data the prop/attr preview
   * write path reads at all?
   *
   * The DISCRIMINATOR between a capability gap and a real failure, and
   * deliberately a page-wide question rather than a framework-name one. The
   * write path needs `__vueParentComponent`, which only a Vue **development**
   * build sets. So "absent everywhere" is exactly the set of substrates where
   * every poke fails no matter what the user clicks — React, Svelte, plain HTML,
   * *and* a Vue production build — while "present somewhere but not on this
   * element" is a genuine per-element miss. Asking the framework's NAME instead
   * would get the Vue-prod case wrong, and `detectFrameworkAdapter` defaults to
   * Vue when detection is inconclusive, so a name check would classify that
   * always-fires case as a real failure — reintroducing the false alarm this
   * distinction exists to remove.
   *
   * Bounded like `detectFrameworkAdapter`'s scan (framework metadata is uniform
   * across its subtree, so a constant-size walk discriminates without going
   * O(n)), and only ever run on a failure path — the happy path never pays for
   * it. A positive answer is memoized (a substrate cannot stop being Vue
   * mid-session); a negative one is NOT, because the bridge can outlive a
   * not-yet-mounted app.
   */
  let vuePreviewSupportSeen = false
  function hasVuePreviewSupport(): boolean {
    if (vuePreviewSupportSeen) return true
    const body = typeof document === "undefined" ? null : document.body
    if (!body) return false
    const queue: Element[] = [body]
    let budget = 64
    while (queue.length > 0 && budget-- > 0) {
      const el = queue.shift()!
      if ((el as unknown as Record<string, unknown>).__vueParentComponent) {
        vuePreviewSupportSeen = true
        return true
      }
      for (const child of Array.from(el.children)) queue.push(child)
    }
    return false
  }

  /**
   * One console line per session for the suppressed capability gap.
   *
   * The shell deliberately shows nothing for `unsupported-substrate` (the edit
   * still lands in source and HMR renders it, so there is no user-visible
   * symptom to explain), but "we decided not to tell you" must not mean "we
   * threw the fact away". The iframe console is where a designer who DOES wonder
   * why edits aren't instant can find it, it costs no UI surface, and once per
   * session means it can't become the per-poke spam the toast was.
   */
  let loggedSubstrateGap = false
  function noteSubstrateGap(reason: string): void {
    if (loggedSubstrateGap) return
    loggedSubstrateGap = true
    console.debug(
      "[Desde] live prop/attribute preview is unavailable on this substrate;",
      "edits still write to source and appear on reload.",
      reason,
    )
  }

  /**
   * Instance lookup that also owns the CLASSIFICATION and the WORDING for every
   * way it can fail.
   *
   * One source of truth on purpose: `PROP_OVERRIDE_RESULT` /
   * `ATTR_OVERRIDE_RESULT` carry a `kind` the shell branches on plus a `reason`
   * it shows verbatim, and the failures below are indistinguishable from the
   * shell (a stale selector, a non-Vue substrate, and a component with no props
   * all arrive as "no preview"). Computing either anywhere other than here —
   * e.g. re-deriving it at the send site from a bare `false` — is how the
   * revert/report halves of `MUTATION_RESOLUTION_FAILED` drifted apart, so
   * the lookup, the kind, and the explanation stay in the same function.
   */
  type InstanceLookup =
    | { instance: Record<string, unknown>; kind?: undefined; reason?: undefined }
    | { instance: null; kind: PreviewFailureKind; reason: string }

  function findPreviewInstance(selector: string): InstanceLookup {
    let el: Element | null
    try {
      el = document.querySelector(selector) as Element | null
    } catch {
      return {
        instance: null,
        kind: "selector-unresolvable",
        reason: `The prototype couldn't look up this element (invalid selector "${selector}"), so nothing could be previewed.`,
      }
    }
    if (!el) {
      return {
        instance: null,
        kind: "selector-unresolvable",
        reason:
          "This element is no longer on the page, so there was nothing to show the change on. It may have re-rendered — re-select it to preview again.",
      }
    }
    const inst = (el as unknown as Record<string, unknown>).__vueParentComponent as
      | Record<string, unknown>
      | undefined
    if (!inst) {
      // Capability gap vs genuine miss — the split that decides whether the
      // shell says anything. See hasVuePreviewSupport.
      if (!hasVuePreviewSupport()) {
        const reason =
          "Live prop and attribute preview needs the component-instance data a Vue development build exposes, and this prototype doesn't expose any — so the new value couldn't be shown instantly."
        noteSubstrateGap(reason)
        return { instance: null, kind: "unsupported-substrate", reason }
      }
      return {
        instance: null,
        kind: "no-component-instance",
        reason:
          "The prototype exposes no component instance for this element, so the value couldn't be previewed live. Select the component itself rather than markup outside it.",
      }
    }
    return { instance: inst }
  }

  function findVueInstanceForSelector(selector: string): Record<string, unknown> | null {
    return findPreviewInstance(selector).instance
  }

  function triggerInstanceRerender(instance: Record<string, unknown>): void {
    const update = instance.update as (() => void) | undefined
    if (typeof update === "function") {
      update()
      return
    }
    const proxy = instance.proxy as { $forceUpdate?: () => void } | undefined
    proxy?.$forceUpdate?.()
  }

  function applyPropOverride(
    selector: string,
    propName: string,
    value: unknown,
  ): PreviewApplyResult {
    const lookup = findPreviewInstance(selector)
    const instance = lookup.instance
    if (!instance) return { ok: false, kind: lookup.kind, reason: lookup.reason }
    const props = instance.props as Record<string, unknown> | undefined
    if (!props) {
      return {
        ok: false,
        kind: "no-component-instance",
        reason:
          "The component for this element exposes no props object, so there was nothing to preview the new value on.",
      }
    }
    const alreadyTracked = propOverrides.some(
      (o) => o.selector === selector && o.propName === propName,
    )
    if (!alreadyTracked) {
      propOverrides.push({
        selector,
        propName,
        originalValue: props[propName],
      })
    }
    try {
      ;(props as Record<string, unknown>)[propName] = value
    } catch (err) {
      return {
        ok: false,
        kind: "assignment-refused",
        reason: `The component refused the "${propName}" assignment (${(err as Error).message}), so the change couldn't be previewed.`,
      }
    }
    triggerInstanceRerender(instance)
    return { ok: true }
  }

  function clearPropOverrides(): void {
    // Restore in reverse order so multiple overrides on the same prop
    // converge on the earliest captured original.
    for (let i = propOverrides.length - 1; i >= 0; i--) {
      const override = propOverrides[i]
      const instance = findVueInstanceForSelector(override.selector)
      if (!instance) continue
      const props = instance.props as Record<string, unknown> | undefined
      if (!props) continue
      try {
        ;(props as Record<string, unknown>)[override.propName] = override.originalValue
      } catch {
        // Original may have been removed entirely; ignore.
      }
      triggerInstanceRerender(instance)
    }
    propOverrides.length = 0
  }

  // ─── Attribute override (editor fallthrough-attr live preview) ──────
  //
  // Fallthrough attributes (Vue's `instance.attrs`) can't be live-
  // previewed through `instance.props` mutation — `$attrs` is computed
  // from the parent's vnode bindings, not directly mutable. Instead we
  // walk the rendered subtree and mutate the actual DOM attribute on
  // every descendant that already has it, falling back to the root if
  // none do (mimicking Vue's fallthrough-to-root behavior).
  //
  // What this handles:
  //   - `<KInput placeholder="x">` — the rendered template forwards
  //     placeholder to an inner `<input placeholder="x">`. We find the
  //     `<input>` and set its placeholder.
  //   - `<KCard data-testid="...">` — the template applies the attr to
  //     the root via $attrs. We find the root and set it there.
  //
  // What this doesn't handle:
  //   - Attrs the source doesn't currently render but the user adds.
  //     The live preview shows nothing; on Save the source change
  //     triggers HMR with the new attribute. Acceptable for V1.
  //   - Boolean attribute semantics (`required="false"` is still
  //     truthy in HTML). We pass-through whatever string the user
  //     typed; on Save the source captures it verbatim.
  interface BridgeAttrOverride {
    element: Element
    attrName: string
    // null = the attribute was absent before override; revert means
    // removeAttribute. Otherwise setAttribute back to this string.
    originalValue: string | null
  }
  const attrOverrides: BridgeAttrOverride[] = []

  function findAttrTargets(
    instance: Record<string, unknown>,
    attrName: string,
  ): Element[] {
    const root = getVueInstanceRootElement(instance)
    if (!root) return []
    const matches: Element[] = []
    if (root.hasAttribute(attrName)) matches.push(root)
    const descendants = root.querySelectorAll(`[${CSS.escape(attrName)}]`)
    for (const el of descendants) matches.push(el)
    // No descendant has it yet — Vue's fallthrough default is the
    // root, so stamp it there.
    if (matches.length === 0) matches.push(root)
    return matches
  }

  function applyAttrOverride(
    selector: string,
    attrName: string,
    value: unknown,
  ): PreviewApplyResult {
    const lookup = findPreviewInstance(selector)
    const instance = lookup.instance
    if (!instance) return { ok: false, kind: lookup.kind, reason: lookup.reason }
    const targets = findAttrTargets(instance, attrName)
    if (targets.length === 0) {
      return {
        ok: false,
        kind: "no-component-instance",
        reason: `The component for this element has no rendered element to carry "${attrName}", so the change couldn't be previewed.`,
      }
    }
    const stringValue = value === null || value === undefined ? "" : String(value)
    for (const el of targets) {
      const alreadyTracked = attrOverrides.some(
        (o) => o.element === el && o.attrName === attrName,
      )
      if (!alreadyTracked) {
        attrOverrides.push({
          element: el,
          attrName,
          originalValue: el.hasAttribute(attrName)
            ? el.getAttribute(attrName)
            : null,
        })
      }
      try {
        el.setAttribute(attrName, stringValue)
      } catch {
        // Some attrs reject malformed values (e.g. invalid namespace);
        // skip silently. The save path will still succeed.
      }
    }
    return { ok: true }
  }

  function clearAttrOverrides(): void {
    for (let i = attrOverrides.length - 1; i >= 0; i--) {
      const override = attrOverrides[i]
      try {
        if (override.originalValue === null) {
          override.element.removeAttribute(override.attrName)
        } else {
          override.element.setAttribute(
            override.attrName,
            override.originalValue,
          )
        }
      } catch {
        // Element may have been removed from the DOM; ignore.
      }
    }
    attrOverrides.length = 0
  }

  // ── Class-override live preview (BRIDGE_VERSION 2026-05-08j+) ─────────
  // Setting `el.className = after` shows the new utility class names in
  // the DOM, but a low-specificity utility class (`.bg-emerald-800`,
  // 0,1,0) loses the cascade against a library's scoped rule like
  // `.ui-button.primary[data-v-XXX]` (0,3,0). To make live preview match
  // what the Phase G save-time scoped-css-override produces, we ALSO
  // resolve the added classes to declarations from existing stylesheets
  // and stamp them inline with `!important` priority. The original
  // className + style are snapshotted on first edit per element so a
  // subsequent class change diffs cleanly against the original (not
  // against the prior override).
  interface ClassOverrideSnapshot {
    className: string
    styleCssText: string
    /**
     * The CSS properties the most recent {@link applyClassOverride} stamped
     * inline on this element — keyed by {@link stampKey}, and only the ones the
     * engine actually accepted.
     * Lives ON the snapshot rather than in a parallel map so it is created,
     * replaced and deleted in exact lockstep with the inline style it describes
     * — a separate map could outlive a restore and claim an authored
     * declaration is ours. Read via `isPreviewStampedProperty`, which the
     * provenance walker uses to fill `StyleOrigin.inline.fromPreview`.
     */
    stampedProperties: Set<string>
  }
  const classOverrideOriginal = new Map<Element, ClassOverrideSnapshot>()

  function isPreviewStampedProperty(el: Element, property: string): boolean {
    const snapshot = classOverrideOriginal.get(el)
    return snapshot ? snapshot.stampedProperties.has(stampKey(property)) : false
  }

  function resolveClassDeclarations(
    className: string,
  ): { property: string; value: string }[] {
    const target = `.${CSS.escape(className)}`
    const out: { property: string; value: string }[] = []
    // Walk same-origin sheets only — accessing cssRules on cross-origin
    // sheets throws a SecurityError. We accept the V1 limitation that
    // utility classes living in cross-origin sheets won't get the
    // specificity boost (Tailwind output normally ships same-origin).
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | null = null
      try {
        rules = sheet.cssRules
      } catch {
        continue
      }
      if (!rules) continue
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSStyleRule)) continue
        // Only top-level rules whose selector list contains exactly
        // `.className` — skip pseudo-classes (`:hover`, `:focus`),
        // descendant selectors, and `@media`/`@supports` wrappers.
        // Pseudo-class declarations would always-on if applied inline.
        const selectors = rule.selectorText
          .split(",")
          .map((s) => s.trim())
        if (!selectors.includes(target)) continue
        const decl = rule.style
        for (let i = 0; i < decl.length; i++) {
          const property = decl.item(i)
          out.push({
            property,
            value: decl.getPropertyValue(property),
          })
        }
      }
    }
    return out
  }

  function applyClassOverride(
    el: HTMLElement,
    afterClasses: string[],
    preResolvedDeclarations?: Record<string, string>,
  ): void {
    if (!classOverrideOriginal.has(el)) {
      classOverrideOriginal.set(el, {
        className: el.className,
        styleCssText: el.style.cssText,
        stampedProperties: new Set<string>(),
      })
    }
    const snapshot = classOverrideOriginal.get(el)!
    // Reset inline style to the original snapshot before re-layering —
    // otherwise prior-edit overrides leak when the user removes a class.
    el.style.cssText = snapshot.styleCssText
    // The reset just wiped the previous stamp off the element, so the record of
    // what we stamped has to be wiped with it — otherwise a property dropped by
    // this edit would keep reporting `fromPreview` while the visible inline
    // declaration is the prototype's own again.
    snapshot.stampedProperties.clear()
    /**
     * Stamp one declaration, recording it as ours only if the engine took it.
     *
     * `setProperty` NEVER throws on a value it rejects, a camelCase property
     * name, or an unknown property — it silently no-ops (measured in Chromium:
     * `('background-color', 'not-a-color')` left the existing declaration
     * untouched, `('backgroundColor', 'blue')` and `('totally-bogus-prop',
     * 'blue')` did nothing, and none of the three threw). So a `try/catch` here
     * is dead code that records every property whether it landed or not — which
     * would let the shim claim the prototype's OWN inline declaration on a
     * property whose stamp was rejected. Read the declaration back instead: it
     * carries our `!important` stamp only when the engine accepted it.
     *
     * Deliberately not compared against `value`: the engine canonicalizes
     * (`#3b82f6` → `rgb(59, 130, 246)`), which is the same reason the flag
     * itself must stay value-independent.
     *
     * One residual, accepted: a rejected stamp on a property the author already
     * declared `!important` still reads back as important, so it would be
     * recorded.
     *
     * The name is normalized through {@link stampKey} on the way IN, not just on
     * the way into the record, so the write, the read-back, and
     * `isPreviewStampedProperty` all address the same declaration regardless of
     * how the caller cased it (lowercasing a non-custom property name is
     * identity per CSSOM; custom properties keep their case).
     */
    const stamp = (rawProperty: string, value: string): void => {
      const property = stampKey(rawProperty)
      el.style.setProperty(property, value, "important")
      if (
        el.style.getPropertyValue(property) !== "" &&
        el.style.getPropertyPriority(property) === "important"
      ) {
        snapshot.stampedProperties.add(property)
      }
    }
    // Prefer shell-supplied declarations: they're authoritative for the
    // inspector's known utilities (colors, border widths/styles/radii)
    // and don't require the substrate to ship Tailwind in the iframe.
    // Fall back to the stylesheet walker for substrates that DO have
    // matching rules locally (so non-V1 utility classes still work).
    if (
      preResolvedDeclarations &&
      Object.keys(preResolvedDeclarations).length > 0
    ) {
      for (const [property, value] of Object.entries(preResolvedDeclarations)) {
        stamp(property, value)
      }
      return
    }
    const originalSet = new Set(
      snapshot.className.split(/\s+/).filter(Boolean),
    )
    for (const cls of afterClasses) {
      if (!cls) continue
      if (originalSet.has(cls)) continue
      const decls = resolveClassDeclarations(cls)
      for (const d of decls) {
        stamp(d.property, d.value)
      }
    }
  }

  /**
   * Targeted restore for ONE element (WS3): resets its className + style
   * attribute back to the classOverrideOriginal snapshot and drops the
   * snapshot entry. Used by the OverrideStore "classOv" retire hook
   * (single element, on confirmed/failed resolution) as well as the
   * global `clearClassOverrides` below (all elements, on
   * CLEAR_CLASS_OVERRIDES) — same restore semantics, different scope.
   */
  function clearClassOverrideFor(el: Element): void {
    const snapshot = classOverrideOriginal.get(el)
    if (!snapshot) return
    try {
      el.className = snapshot.className
      el.setAttribute("style", snapshot.styleCssText)
      if (snapshot.styleCssText === "") el.removeAttribute("style")
    } catch {
      // Element may have been removed; skip.
    }
    classOverrideOriginal.delete(el)
  }

  function releaseClassStyleSnapshot(el: Element): void {
    const snapshot = classOverrideOriginal.get(el)
    if (!snapshot) return
    try {
      el.setAttribute("style", snapshot.styleCssText)
      if (snapshot.styleCssText === "") el.removeAttribute("style")
    } catch {
      // Element may have been removed; skip.
    }
    classOverrideOriginal.delete(el)
  }

  function clearClassOverrides(): void {
    for (const el of Array.from(classOverrideOriginal.keys())) {
      clearClassOverrideFor(el)
    }
  }

  // ── Shell → bridge handlers (thin; the main switch delegates here) ────

  function handleResolveOverride(payload: ResolveOverridePayload | undefined): void {
    // Shell-driven resolution of a pending OverrideStore entry (WS3):
    // 'confirmed' releases it, 'failed' reverts the DOM to `before`
    // and emits OVERRIDE_REVERTED, 'ineffective' releases without
    // reverting (post-HMR DOM is already the truth). Unknown/already-
    // resolved ids are a no-op (store.resolve guards internally).
    if (!payload?.id || !payload.outcome) return
    store.resolve(payload.id, payload.outcome, payload.reason)
    // Chain bookkeeping: rebase the surviving entry's revert target
    // when a SUPERSEDED id's dispatch landed; retire the chain when
    // the LIVE id resolved terminally. See chainOnResolve.
    const chainOutcome = chainOnResolve(payload.id, payload.outcome)
    if (chainOutcome === "live-retired") {
      retireHooks.get(payload.id)?.retire()
    }
    retireHooks.delete(payload.id)
  }

  function handleApplyPropOverride(payload: ApplyPropOverridePayload | undefined): void {
    // Editor strict-buffer preview: mutate the live Vue instance's
    // prop so the iframe shows the new value without writing source.
    // Originals are stashed for CLEAR_PROP_OVERRIDES.
    //
    // `overrideId` (optional, WS3): when present, also register the
    // poke with the OverrideStore under that id, so a failed/refused
    // save reverts it and a successful one releases it — closing the
    // loop the raw instance.props poke doesn't own by itself. Omitting
    // overrideId preserves exactly today's fire-and-forget behavior.
    if (!payload?.selector || !payload.propName) return
    const selector = payload.selector
    const propName = payload.propName
    const value = payload.value
    const result = applyPropOverride(selector, propName, value)
    if (result.ok && payload.overrideId) {
      // applyPropOverride already stashed the pre-override value in
      // `propOverrides` the first time this selector+propName pair
      // was touched — that IS the authoritative revert target (read
      // before any poke, not just this one).
      const tracked = propOverrides.find(
        (o) => o.selector === selector && o.propName === propName,
      )
      const originalValue = tracked ? tracked.originalValue : undefined
      // Supersede any live prior entry for this prop (each keystroke
      // arrives under a fresh overrideId — see overrideChains). The
      // shared revert-target box starts at the first-poke original
      // and rebases to whatever a superseded dispatch LANDS (codex
      // WS3 P2: A→B superseded by B→C, then A→B succeeds and B→C
      // fails → revert to B, not A).
      const revertTarget = chainRegister(
        `prop|${selector}|${propName}`,
        payload.overrideId,
        originalValue,
        value,
      )
      retireHooks.set(payload.overrideId, {
        kind: "prop",
        retire: () => {
          const idx = propOverrides.findIndex(
            (o) => o.selector === selector && o.propName === propName,
          )
          if (idx >= 0) propOverrides.splice(idx, 1)
        },
      })
      store.register({
        id: payload.overrideId,
        kind: "prop",
        selector,
        apply: () => {
          applyPropOverride(selector, propName, value)
        },
        revert: () => {
          applyPropOverride(selector, propName, revertTarget.value)
        },
        isApplied: () => {
          const instance = findVueInstanceForSelector(selector)
          const props = instance?.props as Record<string, unknown> | undefined
          return !!props && props[propName] === value
        },
      })
    }
    // Nothing was applied when `ok` is false, so there is no preview to
    // release here (the store registration above is gated on `ok`) — the
    // failure is a MISSING preview, not a stranded one. The shell still has to
    // hear about it: the buffered edit keeps going to source, but the designer
    // got no instant feedback and would otherwise re-click a control that
    // "does nothing". Reporting is unconditional; whether it's worth SAYING is
    // the shell's call off `kind` — an `unsupported-substrate` gap fires on
    // every poke and is not a failure the user can act on.
    sendToShell({
      type: "PROP_OVERRIDE_RESULT",
      payload: {
        selector,
        propName,
        ok: result.ok,
        ...(result.ok ? {} : { kind: result.kind, reason: result.reason }),
      },
    })
  }

  function handleClearPropOverrides(): void {
    // Release tracked store entries FIRST (silent — no revert, no
    // events): clearPropOverrides() restores the original values
    // itself, and without the release the store's re-assert loop
    // would see the preview "missing" and re-apply discarded edits
    // until timeout (codex round-13). retireHooks is
    // populated only for prop registrations, so it doubles as the
    // live-prop-override id index.
    for (const [id, hook] of retireHooks) {
      if (hook.kind !== "prop") continue
      store.resolve(id, "confirmed")
      chainOnResolve(id, "confirmed")
      retireHooks.delete(id)
    }
    clearPropOverrides()
  }

  function handleApplyAttrOverride(
    payload: { selector?: string; attrName?: string; value?: unknown; overrideId?: string } | undefined,
  ): void {
    // Editor strict-buffer preview for fallthrough attrs
    // (placeholder, data-testid, required, ...). Walks the
    // rendered subtree and updates DOM attributes; originals
    // stashed for CLEAR_ATTR_OVERRIDES.
    if (!payload?.selector || !payload.attrName) return
    const result = applyAttrOverride(
      payload.selector,
      payload.attrName,
      payload.value,
    )
    // WS3 (codex round-16): when the shell supplies an overrideId,
    // register the fallthrough-attr preview with the OverrideStore —
    // same closed loop as prop pokes, so a refused/failed save
    // reverts the visible attribute instead of leaving it lying.
    if (result.ok && payload.overrideId) {
      const selector = payload.selector
      const attrName = payload.attrName
      const value = payload.value
      const stringValue = value === null || value === undefined ? "" : String(value)
      // Scope to THIS selector's rendered elements — two concurrent
      // edits of the same-named attr on different components must not
      // borrow each other's originals (codex round-17).
      const ownInstance = findVueInstanceForSelector(selector)
      const ownTargets = new Set(ownInstance ? findAttrTargets(ownInstance, attrName) : [])
      const tracked = attrOverrides.find(
        (o) => o.attrName === attrName && ownTargets.has(o.element),
      )
      const originalValue = tracked ? tracked.originalValue : null
      const revertTarget = chainRegister(
        `attrOv|${selector}|${attrName}`,
        payload.overrideId,
        originalValue,
        stringValue,
      )
      const readCurrent = (): string | null => {
        const instance = findVueInstanceForSelector(selector)
        if (!instance) return null
        const targets = findAttrTargets(instance, attrName)
        return targets.length > 0 ? targets[0].getAttribute(attrName) : null
      }
      store.register({
        id: payload.overrideId,
        kind: "attr",
        selector,
        apply: () => {
          applyAttrOverride(selector, attrName, value)
        },
        revert: () => {
          const v = revertTarget.value
          if (v === null || v === undefined) {
            // Original was ABSENT — applyAttrOverride would collapse
            // null to setAttribute("") and leave an empty attribute
            // lying (codex round-18). Remove it instead.
            const inst = findVueInstanceForSelector(selector)
            const targets = inst ? findAttrTargets(inst, attrName) : []
            for (const el of targets) {
              try {
                el.removeAttribute(attrName)
              } catch {
                // Some attrs reject removal in exotic namespaces; ignore.
              }
            }
            return
          }
          applyAttrOverride(selector, attrName, v)
        },
        isApplied: () => readCurrent() === stringValue,
      })
      retireHooks.set(payload.overrideId, {
        kind: "attrOv",
        retire: () => {
          // Only this registration's elements — same scoping rule as
          // the originals lookup above.
          for (let i = attrOverrides.length - 1; i >= 0; i--) {
            const o = attrOverrides[i]
            if (o.attrName === attrName && ownTargets.has(o.element)) {
              attrOverrides.splice(i, 1)
            }
          }
        },
      })
    }
    // Same rule as the prop half: `ok: false` means nothing was stamped and
    // nothing was registered, so there is no shim to release — only a failure
    // to report.
    sendToShell({
      type: "ATTR_OVERRIDE_RESULT",
      payload: {
        selector: payload.selector,
        attrName: payload.attrName,
        ok: result.ok,
        ...(result.ok ? {} : { kind: result.kind, reason: result.reason }),
      },
    })
  }

  function handleClearAttrOverrides(): void {
    // Same release-before-clear as CLEAR_PROP_OVERRIDES (round-13):
    // without it the store re-applies discarded attr previews.
    for (const [id, hook] of retireHooks) {
      if (hook.kind !== "attrOv") continue
      store.resolve(id, "confirmed")
      chainOnResolve(id, "confirmed")
      retireHooks.delete(id)
    }
    clearAttrOverrides()
  }

  function handleClearClassOverrides(): void {
    // Same release-before-clear as CLEAR_PROP_OVERRIDES / CLEAR_
    // ATTR_OVERRIDES (round-13): without it the store's re-assert
    // loop would see the class preview "missing" post-clear and
    // re-apply it until timeout. Mirrors those cases in skipping
    // `.retire()` here too — `clearClassOverrides()` below already
    // does the full multi-element restore (className + style shim);
    // running the "classOv" retire hook as well would be redundant
    // (and, for elements a subsequent edit already re-snapshotted,
    // would restore the WRONG baseline).
    for (const [id, hook] of retireHooks) {
      if (hook.kind !== "classOv") continue
      store.resolve(id, "confirmed")
      chainOnResolve(id, "confirmed")
      retireHooks.delete(id)
    }
    clearClassOverrides()
  }

  return {
    store,
    chainRegister,
    chainOnResolve,
    retireHooks,
    applyClassOverride,
    isPreviewStampedProperty,
    clearClassOverrideFor,
    releaseClassStyleSnapshot,
    handleResolveOverride,
    handleApplyPropOverride,
    handleClearPropOverrides,
    handleApplyAttrOverride,
    handleClearAttrOverrides,
    handleClearClassOverrides,
  }
}
