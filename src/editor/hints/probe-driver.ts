/**
 * Probe driver — Phase 4 "rendering hints at scale" (Task 2).
 *
 * Mounts a single design-system component in the supervised Vite dev
 * server's compose-isolation route (`vite-plugin-compose-isolation.ts`)
 * with sentinel string values in place of its props/default-slot, then
 * inspects the rendered DOM to find where each sentinel surfaced. The
 * result feeds Task 3's hint-derivation engine, which turns each match
 * into a probe-generated `RenderingHint` (`provenance: 'generated',
 * verified: true` — the probe IS the verification).
 *
 * ── Why this is THE correctness crux ──
 *
 * A generated hint's `domTarget.selector` is only useful if it
 * string-matches what the bridge computes for `selectorWithinMountRoot` at
 * real click time (`src/bridge/build-attribution-context.ts`). This module
 * does not hand-copy that algorithm: `canonicalSelectorOf`/`sortedClasses`
 * live in `../core/canonical-selector.ts`, imported by BOTH the bridge and
 * this driver. Because the driver runs its selector logic INSIDE a
 * Playwright page (via `page.evaluate(string)`, which cannot `import` a
 * module), it splices the shared functions' own source
 * (`fn.toString()`) into the injected in-page script — so the exact same
 * code executes in-browser as executes in the bridge. There is nothing to
 * keep "in lockstep" by hand; see `probe-driver.test.ts`'s parity suite for
 * the test that exercises the assembled script end-to-end against a real
 * (jsdom) DOM and asserts it agrees with calling the algorithm directly.
 *
 * ── Ambiguity guard (probe-specific, NOT shared with the bridge) ──
 *
 * Unlike the bridge (which must always produce SOME selector for whatever
 * was clicked, ambiguous or not — the shell decides whether it matches a
 * hint), a hint the probe GENERATES must be conservative: a bare-tag
 * selector with no stable class (and not the mount root) could match
 * multiple unrelated elements. This mirrors the same policy
 * `src/editor/adapters/local-vue/infer-rendering-hints.ts` documents for
 * SFC-inferred hints — we reject (omit) a match whose element has no
 * class and isn't the mount root, rather than emit an ambiguous hint.
 *
 * ── Browser lifecycle ──
 *
 * This module owns none of it. `ProbePage` is an injected interface;
 * `probeComponent` never calls `close()` — the caller (Task 3's
 * `generate-hints-run.ts`) reuses ONE page across a whole design system's
 * worth of sequential probes (concurrency 1, one page, one mount at a
 * time). The concrete `ProbePage` implementation for the CLI lives at
 * `editor-cli/src/server/probe-page.ts`.
 */

import { canonicalSelectorOf, sortedClasses } from '../core/canonical-selector'

/** Route prefix the compose-isolation Vite plugin serves (must match `vite-plugin-compose-isolation.ts`'s `ROUTE_PREFIX` exactly). */
const ROUTE_PREFIX = '/__compose/component/'

/** Bounds a single component probe's in-page evaluation. Generous — a
 * single-component mount + DOM walk is sub-100ms in practice; this guards
 * against a genuinely hung page (crashed renderer, infinite loop in the
 * mounted component) rather than normal variance. */
const DEFAULT_TIMEOUT_MS = 5_000

// ──────────────── public contract (per task-2-brief.md) ────────────────

/**
 * What to mount and which sentinel values to probe with. `props` maps prop
 * name → the sentinel STRING value to mount it with (string-typed props
 * only — Task 3's engine decides which props are eligible). `slotText`,
 * when present, is the sentinel value rendered as the component's default
 * slot content.
 */
export interface ProbeMountSpec {
  /** npm-style package specifier (e.g. `@acme/design-system`). */
  importPath: string
  /** Named export from `importPath` (e.g. `UiButton`). */
  exportName: string
  /** propName → sentinel value. */
  props: Record<string, string>
  /** Sentinel value for the component's default slot, if probing it. */
  slotText?: string
}

/**
 * Where a sentinel landed when the element carrying it is rendered by a CHILD
 * component rather than by the probed component itself.
 *
 * This is the difference between a `dom` hint and a `forward` hint, and it is
 * not cosmetic. `attribute()` matches a `dom` hint against
 * `clicked.selectorWithinMountRoot` — the selector relative to the element's
 * OWNING component's mount root — so a `dom` hint is only ever consulted for
 * clicks the component owns. A click that lands on a child's DOM resolves at
 * the CHILD, and the only mechanism that then crosses back up to the parent's
 * authored prop is `walkForward`, which reads `forward` hints exclusively.
 *
 * MEASURED (2026-08-16, `@kong/kongponents` 9.52.9): every one of the 48
 * generated hints was `dom`, because the probe matched by DOM text alone and
 * never asked who rendered the match. KInput's `label` hint pointed at
 * `label.k-label` — factually true, and permanently unreachable, because that
 * element is KLabel's root. `walkForward` had zero forward hints to walk on
 * the entire design system.
 */
export interface ProbeOwnership {
  /** The child component's name, as `attribute()`'s registry would resolve it. */
  component: string
  /**
   * Where the sentinel arrived on the child. Exactly one is set, mirroring
   * `RenderingHint`'s `forwardTo` — `findForwardHint` matches on whichever
   * one is populated.
   */
  childProp?: string
  childSlot?: string
}

/**
 * Resolves which component rendered `el`, and how the sentinel reached it.
 * Returns null when `el` belongs to the probed component's OWN render (the
 * ordinary case — caller emits a `dom` hint) or when ownership can't be
 * established confidently enough to forward.
 *
 * Injected rather than implemented here for the same reason `selectorFor` is:
 * reading a component instance off a DOM node is framework-specific (Vue's
 * `__vueParentComponent`), and `findSentinelMatches` must stay free of both
 * framework knowledge and cross-module references so it can be
 * `.toString()`-embedded into the in-page script. `buildInPageScript` supplies
 * the Vue implementation inline.
 */
export type ProbeOwnerResolver = (
  el: Element,
  sentinel: string,
  field: 'textContent' | 'attribute',
) => ProbeOwnership | null

export interface ProbeObservationMatch {
  /** Canonical single-token selector, rooted at the mounted component — see module doc comment. */
  selector: string
  field: 'textContent' | 'attribute'
  /** Set when `field === 'attribute'`. */
  attribute?: string
  /**
   * Set ONLY when the matched element is rendered by a child component. Its
   * presence is what makes {@link ProbeObservationMatch} derive a `forward`
   * hint instead of a `dom` one — see {@link ProbeOwnership}.
   */
  ownedByChild?: ProbeOwnership
}

export interface ProbeObservationFinding {
  /** The sentinel value that was searched for. */
  sentinel: string
  propOrSlot: { kind: 'prop' | 'slot'; name: string }
  matches: ProbeObservationMatch[]
}

export interface ProbeObservation {
  ok: boolean
  /** Set when `ok` is false: mount failed / timeout / crashed. */
  reason?: string
  /** For each sentinel: where it surfaced (empty array on failure). */
  findings: ProbeObservationFinding[]
}

/**
 * Host-neutral page handle the driver needs. Deliberately minimal (three
 * methods) so unit tests can fake it without a real browser, and so a
 * future non-Playwright host (VS Code webview, Electron) could implement it
 * too. The CLI's concrete impl lives at `editor-cli/src/server/probe-page.ts`.
 */
export interface ProbePage {
  goto(url: string): Promise<void>
  /** `fn` is a complete JS expression string (an IIFE) — see `buildInPageScript`. */
  evaluate<T>(fn: string): Promise<T>
  close(): Promise<void>
}

/**
 * Probe one component: mount it in the isolation route with sentinel
 * prop/slot values, then report where each sentinel surfaced in the
 * rendered DOM. Never throws — failures (navigation, evaluation, mount
 * errors, timeouts) all resolve to `{ ok: false, reason, findings: [] }`.
 */
export async function probeComponent(opts: {
  /** Origin of the supervised Vite dev server (e.g. `http://127.0.0.1:5173`). */
  baseUrl: string
  spec: ProbeMountSpec
  page: ProbePage
  /** Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number
}): Promise<ProbeObservation> {
  const sentinels = buildSentinelList(opts.spec)
  const url = buildProbeUrl(opts.baseUrl, opts.spec)

  try {
    await opts.page.goto(url)
  } catch (err) {
    return { ok: false, reason: `probe navigation failed: ${errMessage(err)}`, findings: [] }
  }

  const script = buildInPageScript(sentinels, opts.spec.exportName)
  let raw: RawProbeResult
  try {
    raw = await withTimeout(
      opts.page.evaluate<RawProbeResult>(script),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
  } catch (err) {
    return { ok: false, reason: `probe evaluation failed: ${errMessage(err)}`, findings: [] }
  }

  if (!raw || raw.ok !== true) {
    return { ok: false, reason: raw?.reason ?? 'component failed to mount', findings: [] }
  }

  return {
    ok: true,
    findings: (raw.findings ?? []).map((f) => ({
      sentinel: f.sentinel,
      propOrSlot: { kind: f.kind, name: f.name },
      matches: f.matches,
    })),
  }
}

// ──────────────── URL construction ────────────────

/**
 * Build the compose-isolation route URL for a mount spec. ALWAYS routes
 * through the plugin's `config.variants` shape (a single-cell array), even
 * though there's only ever one mount — the plugin's plain
 * `config.props` single-mount path has no way to pass slot content
 * (`children`), and probing a component's default slot is a first-class
 * case here, so using ONE code path (variants) for both prop-only and
 * slot-bearing probes keeps this simpler than branching on
 * `spec.slotText`'s presence.
 *
 * Mirrors `vite-plugin-compose-isolation.ts`'s route layout EXACTLY:
 *   `/__compose/component/<encodeURIComponent(importPath)>/<base64url(JSON.stringify(config))>`
 * See that file's `decodeConfigSegment` — `probe-driver.test.ts` round-trips
 * against it directly rather than re-deriving the contract by hand.
 */
export function buildProbeUrl(baseUrl: string, spec: ProbeMountSpec): string {
  const origin = baseUrl.replace(/\/+$/, '')
  const encodedSpec = encodeURIComponent(spec.importPath)
  const config: {
    name: string
    variants: Array<{ label: string; props: Record<string, string>; children?: string }>
  } = {
    name: spec.exportName,
    variants: [{ label: 'probe', props: spec.props, children: spec.slotText }],
  }
  const encodedConfig = encodeConfigSegment(config)
  return `${origin}${ROUTE_PREFIX}${encodedSpec}/${encodedConfig}`
}

/** base64url encode (RFC 4648 §5) — same transform as the plugin's own test helper. */
function encodeConfigSegment(config: unknown): string {
  return Buffer.from(JSON.stringify(config))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// ──────────────── sentinel list ────────────────

interface SentinelSpec {
  sentinel: string
  kind: 'prop' | 'slot'
  name: string
}

/** Exported for testing — not part of the public probe contract. */
export function buildSentinelList(spec: ProbeMountSpec): SentinelSpec[] {
  const sentinels: SentinelSpec[] = []
  for (const [name, sentinel] of Object.entries(spec.props)) {
    sentinels.push({ sentinel, kind: 'prop', name })
  }
  if (spec.slotText !== undefined) {
    sentinels.push({ sentinel: spec.slotText, kind: 'slot', name: 'default' })
  }
  return sentinels
}

// ──────────────── in-page DOM walk (runs in TWO places — see module doc) ────────────────

/**
 * Locate the compose-isolation page's rendered mount root, or a failure
 * reason. The isolation route (in its `config.variants` shape, which this
 * driver always uses — see `buildProbeUrl`) mounts the component into a
 * `.variant-cell-mount` div; on a render/mount error the plugin's own
 * error handler replaces that div's content with a `.variant-cell-error`
 * message instead of throwing to the console, so we check for it
 * explicitly rather than treating "no error thrown" as success.
 *
 * Exported so `probe-driver.test.ts` can call it directly against jsdom
 * fixtures; also `.toString()`-embedded into the in-page script (see
 * `buildInPageScript`) so the SAME code runs in the real browser.
 */
export function locateMountRoot(
  doc: Document,
): { ok: true; mountRoot: Element } | { ok: false; reason: string } {
  const mountCell = doc.querySelector('.variant-cell-mount')
  if (!mountCell) {
    return { ok: false, reason: 'mount container (.variant-cell-mount) not found' }
  }
  const errorEl = mountCell.querySelector('.variant-cell-error')
  if (errorEl) {
    return { ok: false, reason: errorEl.textContent || 'component failed to mount' }
  }
  const mountRoot = mountCell.firstElementChild
  if (!mountRoot) {
    return { ok: false, reason: 'component rendered no DOM (empty mount)' }
  }
  return { ok: true, mountRoot }
}

/**
 * Probe-specific selector policy, layered ON TOP of the shared
 * `canonicalSelectorOf`/`sortedClasses` (imported above): `:root` for the
 * mount root itself, otherwise the canonical tag+class form — UNLESS the
 * element has no stable class, in which case we omit the match entirely
 * rather than emit an ambiguous bare-tag selector. This mirrors the same
 * caution `src/editor/adapters/local-vue/infer-rendering-hints.ts`
 * documents for SFC-inferred hints (a class-less, non-root element's
 * selector is "too ambiguous to match safely").
 *
 * NOT embedded via `.toString()` into the in-page script (see
 * `buildInPageScript`): because this function calls the IMPORTED
 * `sortedClasses`/`canonicalSelectorOf` by name, a compiled build (Vite
 * SSR in tests, esbuild/tsx in the CLI) rewrites those calls into a
 * module-namespace reference (e.g. `__vite_ssr_import_0__.sortedClasses`)
 * that doesn't exist in the injected script's standalone scope —
 * `.toString()` would ship a broken reference. `buildInPageScript` instead
 * hand-mirrors this same four-line policy inline, calling the (safely
 * embedded) `sortedClasses`/`canonicalSelectorOf` declarations directly.
 * The parity test in `probe-driver.test.ts` asserts the two agree.
 */
export function probeSelectorFor(el: Element, mountRoot: Element): string | null {
  if (el === mountRoot) return ':root'
  const classes = sortedClasses(el)
  if (classes.length === 0) return null
  return canonicalSelectorOf(el)
}

/**
 * An element's OWN text, ignoring descendants: the concatenation of its
 * direct `childNodes` that are text nodes (`nodeType === 3`), trimmed.
 * Unlike `el.textContent` (which rolls up the ENTIRE subtree), this treats a
 * wrapper whose text lives entirely inside a child element as having no own
 * text at all — which is exactly what keeps a nested sentinel from matching
 * every ancestor on the way up. Free of cross-module references, like
 * `findSentinelMatches`, so it's safe to `.toString()`-embed alongside it.
 */
function ownText(el: Element): string {
  let text = ''
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) text += node.textContent ?? ''
  }
  return text.trim()
}

/**
 * The pure "find sentinels in the mounted DOM" algorithm. For each
 * sentinel: walk every element in the mount root's subtree (inclusive),
 * and record a match when the element's OWN text (its direct text-node
 * children only, trimmed — see `ownText`) EXACTLY equals the sentinel, or
 * any of its attribute VALUES CONTAINS the sentinel (attributes like
 * `id="btn-<sentinel>"` embed rather than equal it). Matches with no
 * synthesizable selector (see `selectorFor`) are omitted, not returned with
 * a null selector — an unusable match is the same as no match for
 * hint-generation purposes.
 *
 * Own-text rather than full `textContent` is deliberate: `textContent`
 * rolls up every descendant's text, so a sentinel nested inside classed
 * wrappers (e.g. `<div class="a"><span class="b">SENTINEL</span></div>`)
 * would match the leaf AND every ancestor whose rolled-up text happens to
 * equal the sentinel too — `resolveMatch` (`derive-hints.ts`) then sees
 * multiple DISTINCT non-root selectors and treats the whole finding as
 * ambiguous, silently dropping a hint for completely ordinary nested
 * markup. Comparing only direct text-node children fixes this: an ancestor
 * whose own text nodes don't contain the sentinel is no longer reported as
 * a match at all, leaving only the one element that actually OWNS the text
 * (plus `:root` itself, when the mount root's own direct text IS the
 * sentinel — no wrapper in between). Two distinct elements that each own
 * the sentinel text in their own right (e.g. two sibling elements, each
 * with the sentinel as their sole direct text) are still genuinely
 * ambiguous and still produce two distinct non-root matches, which
 * `resolveMatch` still refuses — this narrows what counts as "the sentinel
 * text lives here," it doesn't relax the ambiguity guard itself.
 *
 * Takes `selectorFor` as an explicit parameter rather than closing over
 * `probeSelectorFor` directly — this keeps the function's body free of any
 * cross-module reference, which is exactly what makes it (unlike
 * `probeSelectorFor`) safe to `.toString()`-embed into the in-page script
 * (see `buildInPageScript`): a plain parameter call compiles to itself
 * under every toolchain, nothing to rewrite into a module-namespace lookup.
 *
 * Exported so `probe-driver.test.ts` can call it directly against jsdom
 * fixtures (the readable, primary test surface); also `.toString()`-embedded
 * into the in-page script so the browser runs the IDENTICAL algorithm — see
 * the module doc comment for why that matters.
 */
export function findSentinelMatches(
  mountRoot: Element,
  sentinels: SentinelSpec[],
  selectorFor: (el: Element) => string | null,
  ownerFor?: ProbeOwnerResolver,
): Array<{
  sentinel: string
  kind: 'prop' | 'slot'
  name: string
  matches: ProbeObservationMatch[]
}> {
  const all: Element[] = [mountRoot, ...Array.from(mountRoot.querySelectorAll('*'))]

  return sentinels.map((s) => {
    const matches: ProbeObservationMatch[] = []
    for (const el of all) {
      const text = ownText(el)
      if (text.length > 0 && text === s.sentinel) {
        const selector = selectorFor(el)
        if (selector) {
          const owner = ownerFor ? ownerFor(el, s.sentinel, 'textContent') : null
          matches.push({
            selector,
            field: 'textContent',
            ...(owner ? { ownedByChild: owner } : {}),
          })
        }
      }
      for (const attr of Array.from(el.attributes)) {
        if (attr.value && attr.value.includes(s.sentinel)) {
          const selector = selectorFor(el)
          if (selector) {
            const owner = ownerFor ? ownerFor(el, s.sentinel, 'attribute') : null
            matches.push({
              selector,
              field: 'attribute',
              attribute: attr.name,
              ...(owner ? { ownedByChild: owner } : {}),
            })
          }
        }
      }
    }
    return { sentinel: s.sentinel, kind: s.kind, name: s.name, matches }
  })
}

/** Shape the in-page script returns (before `probeComponent` reshapes it into `ProbeObservation`). */
interface RawProbeResult {
  ok: boolean
  reason?: string
  findings?: Array<{
    sentinel: string
    kind: 'prop' | 'slot'
    name: string
    matches: ProbeObservationMatch[]
  }>
}

/**
 * Assemble the complete in-page script: an IIFE expression string, suitable
 * for `ProbePage.evaluate(string)` (Playwright treats a string argument as
 * a raw expression to evaluate, not a function to call — see
 * `page.evaluate`'s string-overload semantics — so the whole thing must be
 * one self-invoking expression, not a bare function declaration).
 *
 * Splices `sortedClasses`, `canonicalSelectorOf` (the shared bridge/probe
 * selector algorithm), `locateMountRoot`, `ownText`, and
 * `findSentinelMatches`'s own SOURCE (via `.toString()`) into the script, in
 * dependency order — each of those five is written to have NO cross-module
 * references (see their doc comments), so their compiled source runs
 * unmodified once declared in the injected script's scope. `probeSelectorFor`'s
 * glue is the one exception
 * (it calls the imported `sortedClasses`/`canonicalSelectorOf` by name,
 * which a bundler rewrites into a module-namespace reference that
 * `.toString()` would ship broken) — it's hand-mirrored inline instead,
 * four lines, identical logic. `probe-driver.test.ts`'s parity suite
 * evaluates this exact function against a constructed DOM and asserts it
 * agrees with calling `findSentinelMatches` (with `probeSelectorFor`)
 * directly, which is what actually guards the two from drifting apart.
 */
export function buildInPageScript(sentinels: SentinelSpec[], exportName: string): string {
  return `(function () {
  ${sortedClasses.toString()}
  ${canonicalSelectorOf.toString()}
  ${locateMountRoot.toString()}
  ${ownText.toString()}
  ${findSentinelMatches.toString()}
  var located = locateMountRoot(document)
  if (!located.ok) return { ok: false, reason: located.reason }
  var mountRoot = located.mountRoot
  function probeSelectorFor(el) {
    if (el === mountRoot) return ':root'
    var classes = sortedClasses(el)
    if (classes.length === 0) return null
    return canonicalSelectorOf(el)
  }
  // The probed component's own instance, found BY NAME.
  //
  // Two wrong ways to get this, both measured on @kong/kongponents:
  //  - mountRoot.__vueParentComponent alone. When a component's root element
  //    IS another component, Vue stamps that element with the INNERMOST
  //    instance, so the probed component's own DOM looks like a child's.
  //  - Walking up while parent.subTree.el === mountRoot. This overshoots: the
  //    isolation page's own app-root component also has mountRoot as its
  //    subtree element, so the walk climbs past the component we mounted and
  //    lands on the wrapper. Every component then appeared to be its own
  //    child and emitted a self-referential forward hint (KButton → KButton,
  //    KCard → KCard), which walkForward would chase until MAX_FORWARD_DEPTH.
  //
  // The name is unambiguous because it is the same name the manifest registry
  // resolves, which is what forwardTo.component is matched against. If no
  // instance in the chain carries it we emit NO forward hints rather than
  // guessing — a missing forward hint costs one component's deterministic
  // routing, a wrong one misattributes an edit.
  var probedName = ${JSON.stringify(exportName)}
  var probed = (function () {
    var inst = mountRoot.__vueParentComponent
    while (inst) {
      var t = inst.type || {}
      if ((t.__name || t.name) === probedName) return inst
      inst = inst.parent
    }
    return null
  })()
  // See ProbeOwnerResolver. Deliberately refuses more than it accepts:
  //  - no instance data (production build / non-Vue) => no forward hints, the
  //    dom-hint behaviour is unchanged rather than degraded.
  //  - inst.parent !== probed => the element sits more than ONE component
  //    boundary below us. walkForward hops one level per hint by design, and
  //    a hint naming a grandchild would be matched against the wrong
  //    parent-child boundary, so we emit nothing and let the dom hint stand.
  //  - an attribute match with no matching child prop => slot content cannot
  //    produce an attribute, so guessing 'default' there would be inventing a
  //    relationship. Only textContent falls through to the slot inference.
  // Does a slot's rendered vnode tree contain this exact text? Depth-capped
  // because a slot function returns arbitrary user structure and a component
  // vnode's children field is a slots RECORD, not a list — the cap bounds it
  // rather than trusting the shape.
  function vnodeTreeHasText(node, needle, depth) {
    if (node == null || depth > 12) return false
    if (typeof node === 'string') return node.indexOf(needle) !== -1
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) {
        if (vnodeTreeHasText(node[i], needle, depth + 1)) return true
      }
      return false
    }
    if (typeof node === 'object') return vnodeTreeHasText(node.children, needle, depth + 1)
    return false
  }
  function resolveOwner(el, sentinel, field) {
    if (!probed) return null
    var inst = el.__vueParentComponent
    if (!inst || inst === probed) return null
    if (inst.parent !== probed) return null
    var type = inst.type || {}
    var name = type.__name || type.name || null
    if (!name) return null

    // Prop destination. EXACTLY ONE match, because a parent may hand the same
    // value to two child props (:text="label" plus :aria-label="label") and
    // both then equal the sentinel. Taking the first is picking by enumeration
    // order, and the hint would still be stamped verified:true — a guess
    // wearing a measurement's label. Two matches is ambiguity, and ambiguity
    // produces no hint, per resolveMatch's posture.
    var props = inst.props || {}
    var propHits = []
    for (var key in props) {
      if (props[key] === sentinel) propHits.push(key)
    }
    // Two or more REFUSES OUTRIGHT, and must not fall through to the slot walk
    // below: the slot walk could still "find" the value there, turning an
    // ambiguous prop into a confidently wrong slot hint.
    if (propHits.length > 1) return null
    // Slot content cannot produce an attribute, so for an attribute match the
    // prop evidence is the only evidence that exists.
    if (field !== 'textContent') {
      return propHits.length === 1 ? { component: name, childProp: propHits[0] } : null
    }

    // Slot destination. Which slot the text ACTUALLY came through is
    // established, not assumed: each slot function is invoked and its vnode
    // tree searched for the sentinel. Assuming 'default' was wrong twice over
    // — a child receiving a NAMED slot got a hint claiming its default slot,
    // and content arriving by some other route got one too. Both were stamped
    // verified.
    //
    // Naming the real slot beats refusing it. A named-slot hint cannot match
    // today (child hint generation only probes default slots, so a child never
    // resolves to a named slot at click time), which makes it inert rather
    // than harmful — and correct the day named-slot probing lands. A hint that
    // says 'default' when it means 'header' is neither.
    var slots = inst.slots || {}
    var slotHits = []
    for (var slotName in slots) {
      if (typeof slots[slotName] !== 'function') continue
      try {
        if (vnodeTreeHasText(slots[slotName](), sentinel, 0)) slotHits.push(slotName)
      } catch (e) {
        // A slot that refuses to render outside its own render context tells
        // us nothing about origin. Refuse the whole match rather than fall
        // back to the assumption this branch exists to remove.
        return null
      }
    }
    // The prop and slot walks are weighed TOGETHER, and the prop walk
    // deliberately does not short-circuit. A parent can hand the same value to
    // a child's prop AND its slot — the child renders one of them, and nothing
    // observable here says which. Letting the prop walk win by running first
    // would resolve that coin-flip silently, and stamp the result verified.
    // One source of evidence and only one is what earns a hint.
    if (propHits.length === 1 && slotHits.length === 0) {
      return { component: name, childProp: propHits[0] }
    }
    if (propHits.length === 0 && slotHits.length === 1) {
      return { component: name, childSlot: slotHits[0] }
    }
    return null
  }
  var sentinels = ${JSON.stringify(sentinels)}
  var findings = findSentinelMatches(mountRoot, sentinels, probeSelectorFor, resolveOwner)
  return { ok: true, findings: findings }
})()`
}

// ──────────────── misc ────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
