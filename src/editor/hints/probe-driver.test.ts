/**
 * Unit coverage for the Phase 4 probe driver. Three layers, per the
 * task-2 brief:
 *
 *  1. URL construction — round-trips against the compose-isolation
 *     plugin's OWN decoder (`decodeConfigSegment`), not a hand-copied
 *     re-derivation of its encoding contract.
 *  2. Selector-synthesis / DOM-walk logic — exercised directly against
 *     jsdom fixtures (fast, readable; this vitest project's environment is
 *     jsdom, so real `Element`/`document` APIs are available with no
 *     browser).
 *  3. Parity — `buildInPageScript`'s assembled STRING (what a real
 *     Playwright page would `evaluate`) is executed via `new Function`
 *     against the SAME jsdom fixtures and asserted to produce identical
 *     output to calling the exported functions directly. This is the test
 *     that actually de-risks the `.toString()`-splicing technique: if the
 *     compiled function source ever fails to serialize cleanly (a stray
 *     external free variable, a keepNames wrapper, etc.), this is where it
 *     would surface.
 *
 * `probeComponent` itself is covered with a fake `ProbePage` — no browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildInPageScript,
  buildProbeUrl,
  buildSentinelList,
  findSentinelMatches,
  locateMountRoot,
  probeComponent,
  probeSelectorFor,
  type ProbeMountSpec,
  type ProbeObservationMatch,
  type ProbeOwnerResolver,
  type ProbeOwnership,
  type ProbePage,
} from './probe-driver'
import { decodeConfigSegment } from '../substrate-plugins/vite-plugin-compose-isolation'
import { resolveMatch } from './derive-hints'

// ──────────────── URL construction ────────────────

describe('buildProbeUrl', () => {
  it('round-trips against the compose-isolation plugin\'s own decoder', () => {
    const spec: ProbeMountSpec = {
      importPath: '@acme/design-system',
      exportName: 'UiButton',
      props: { label: 'PROBE_SENTINEL_abc123' },
    }
    const url = buildProbeUrl('http://127.0.0.1:5173', spec)
    expect(url.startsWith('http://127.0.0.1:5173/__compose/component/')).toBe(true)

    const rest = url.slice('http://127.0.0.1:5173/__compose/component/'.length)
    const segments = rest.split('/')
    expect(segments).toHaveLength(2)
    expect(decodeURIComponent(segments[0])).toBe('@acme/design-system')

    const decoded = decodeConfigSegment(segments[1])
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error('unreachable')
    expect(decoded.value).toEqual({
      name: 'UiButton',
      variants: [{ label: 'probe', props: { label: 'PROBE_SENTINEL_abc123' } }],
    })
  })

  it('includes slotText as the single variant cell\'s children', () => {
    const spec: ProbeMountSpec = {
      importPath: '@acme/design-system',
      exportName: 'UiBadge',
      props: {},
      slotText: 'PROBE_SLOT_xyz',
    }
    const url = buildProbeUrl('http://127.0.0.1:5173', spec)
    const segments = url.slice('http://127.0.0.1:5173/__compose/component/'.length).split('/')
    const decoded = decodeConfigSegment(segments[1])
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error('unreachable')
    expect(decoded.value).toEqual({
      name: 'UiBadge',
      variants: [{ label: 'probe', props: {}, children: 'PROBE_SLOT_xyz' }],
    })
  })

  it('strips a trailing slash from baseUrl', () => {
    const spec: ProbeMountSpec = { importPath: 'vue', exportName: 'Foo', props: {} }
    const url = buildProbeUrl('http://127.0.0.1:5173/', spec)
    expect(url.startsWith('http://127.0.0.1:5173/__compose/component/')).toBe(true)
    expect(url).not.toContain('5173//__compose')
  })
})

describe('buildSentinelList', () => {
  it('lists each prop as its own sentinel entry', () => {
    const spec: ProbeMountSpec = {
      importPath: 'vue',
      exportName: 'Foo',
      props: { label: 'S1', helpText: 'S2' },
    }
    expect(buildSentinelList(spec)).toEqual([
      { sentinel: 'S1', kind: 'prop', name: 'label' },
      { sentinel: 'S2', kind: 'prop', name: 'helpText' },
    ])
  })

  it('appends a slot entry when slotText is present', () => {
    const spec: ProbeMountSpec = {
      importPath: 'vue',
      exportName: 'Foo',
      props: { label: 'S1' },
      slotText: 'S2',
    }
    expect(buildSentinelList(spec)).toEqual([
      { sentinel: 'S1', kind: 'prop', name: 'label' },
      { sentinel: 'S2', kind: 'slot', name: 'default' },
    ])
  })

  it('omits the slot entry when slotText is absent', () => {
    const spec: ProbeMountSpec = { importPath: 'vue', exportName: 'Foo', props: {} }
    expect(buildSentinelList(spec)).toEqual([])
  })
})

// ──────────────── DOM helpers ────────────────

/** Builds `.variant-cell-mount > (component root)` matching the isolation
 * plugin's variant-grid markup, and returns the mount root. */
function renderMount(rootHtml: string): { container: HTMLElement; mountRoot: Element } {
  const container = document.createElement('div')
  container.className = 'variant-cell-mount'
  container.innerHTML = rootHtml
  document.body.appendChild(container)
  const mountRoot = container.firstElementChild
  if (!mountRoot) throw new Error('test fixture produced no mount root')
  return { container, mountRoot }
}

afterEach(() => {
  document.body.innerHTML = ''
})

// ──────────────── locateMountRoot ────────────────

describe('locateMountRoot', () => {
  it('fails when .variant-cell-mount is missing', () => {
    const result = locateMountRoot(document)
    expect(result).toEqual({ ok: false, reason: 'mount container (.variant-cell-mount) not found' })
  })

  it('fails with the error message when the plugin reported a mount error', () => {
    const container = document.createElement('div')
    container.className = 'variant-cell-mount'
    container.innerHTML = '<div class="variant-cell-error">Cell failed to mount: boom</div>'
    document.body.appendChild(container)
    const result = locateMountRoot(document)
    expect(result).toEqual({ ok: false, reason: 'Cell failed to mount: boom' })
  })

  it('fails when the mount container rendered no DOM', () => {
    const container = document.createElement('div')
    container.className = 'variant-cell-mount'
    document.body.appendChild(container)
    const result = locateMountRoot(document)
    expect(result).toEqual({ ok: false, reason: 'component rendered no DOM (empty mount)' })
  })

  it('succeeds and returns the first element child as the mount root', () => {
    const { mountRoot } = renderMount('<button class="ui-button">Click</button>')
    const result = locateMountRoot(document)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.mountRoot).toBe(mountRoot)
  })
})

// ──────────────── findSentinelMatches ────────────────

/** Bind `probeSelectorFor` to a mount root, matching what `buildInPageScript`'s inline glue does. */
function selectorForMount(mountRoot: Element): (el: Element) => string | null {
  return (el) => probeSelectorFor(el, mountRoot)
}

describe('findSentinelMatches', () => {
  it('matches the mount root itself as :root', () => {
    const { mountRoot } = renderMount('<button>PROBE_S1</button>')
    const findings = findSentinelMatches(
      mountRoot,
      [{ sentinel: 'PROBE_S1', kind: 'slot', name: 'default' }],
      selectorForMount(mountRoot),
    )
    expect(findings).toEqual([
      {
        sentinel: 'PROBE_S1',
        kind: 'slot',
        name: 'default',
        matches: [{ selector: ':root', field: 'textContent' }],
      },
    ])
  })

  it('synthesizes tag + sorted-class selectors for non-root matches', () => {
    // The root carries a SIBLING too, so its own rolled-up textContent
    // ("PROBE_S1footer") does not equal the sentinel — isolates the
    // leaf-only match (the ancestor-rollup case is covered separately below).
    const { mountRoot } = renderMount(
      '<div class="ui-card"><span class="kappa alpha">PROBE_S1</span><span class="footer">footer</span></div>',
    )
    const findings = findSentinelMatches(
      mountRoot,
      [{ sentinel: 'PROBE_S1', kind: 'prop', name: 'label' }],
      selectorForMount(mountRoot),
    )
    expect(findings[0].matches).toEqual([{ selector: 'span.alpha.kappa', field: 'textContent' }])
  })

  it('matches ONLY the leaf when a single-child wrapper rolls up to the sentinel via textContent (own-text, not rollup)', () => {
    // A single-child wrapper's full `textContent` equals its only child's
    // text, but the wrapper owns NO direct text node itself — comparing
    // own-text (not rollup) means only the leaf that actually contains the
    // sentinel as its own text is reported, not every ancestor whose rolled-up
    // textContent happens to equal it too. See probe-driver.ts's
    // `findSentinelMatches` doc comment for why this is the fix, not
    // incidental: nested wrappers previously produced multiple distinct
    // non-root matches for the SAME sentinel, which `resolveMatch` then
    // treated as ambiguous and silently dropped.
    const { mountRoot } = renderMount(
      '<div class="ui-card"><span class="kappa alpha">PROBE_S1</span></div>',
    )
    const findings = findSentinelMatches(
      mountRoot,
      [{ sentinel: 'PROBE_S1', kind: 'prop', name: 'label' }],
      selectorForMount(mountRoot),
    )
    expect(findings[0].matches).toEqual([{ selector: 'span.alpha.kappa', field: 'textContent' }])
  })

  it('matches ONLY the leaf across multiple levels of classed wrappers (the reported bug case)', () => {
    // Two levels of wrapping between the mount root and the leaf: with
    // rollup-based matching, the mount root, the intermediate wrapper, AND
    // the leaf would all "contain" the sentinel via textContent, producing
    // 2+ distinct non-root selectors and getting the whole finding dropped
    // as ambiguous. Own-text matching means only the leaf — the element that
    // actually owns the sentinel as a direct text node — matches.
    const { mountRoot } = renderMount(
      '<div class="outer"><div class="inner"><span class="label">PROBE_S1</span></div></div>',
    )
    const findings = findSentinelMatches(
      mountRoot,
      [{ sentinel: 'PROBE_S1', kind: 'prop', name: 'label' }],
      selectorForMount(mountRoot),
    )
    expect(findings[0].matches).toEqual([{ selector: 'span.label', field: 'textContent' }])
  })

  it('still matches :root when the mount root itself owns the sentinel as direct text (no wrapper in between)', () => {
    const { mountRoot } = renderMount('<div class="ui-card">PROBE_S1</div>')
    const findings = findSentinelMatches(
      mountRoot,
      [{ sentinel: 'PROBE_S1', kind: 'prop', name: 'label' }],
      selectorForMount(mountRoot),
    )
    expect(findings[0].matches).toEqual([{ selector: ':root', field: 'textContent' }])
  })

  it('remains ambiguous (drops the match) when two SIBLING elements each own the sentinel as their own text', () => {
    // The safety guard must survive: this isn't a rollup artifact — two
    // genuinely distinct elements each independently own the sentinel text.
    const { mountRoot } = renderMount(
      '<div class="ui-card"><span class="a">PROBE_S1</span><span class="b">PROBE_S1</span></div>',
    )
    const findings = findSentinelMatches(
      mountRoot,
      [{ sentinel: 'PROBE_S1', kind: 'prop', name: 'label' }],
      selectorForMount(mountRoot),
    )
    expect(findings[0].matches).toEqual([
      { selector: 'span.a', field: 'textContent' },
      { selector: 'span.b', field: 'textContent' },
    ])
  })

  it('end-to-end: resolveMatch now emits a hint for nested classed wrappers (previously dropped as ambiguous)', () => {
    const { mountRoot } = renderMount(
      '<div class="outer"><div class="inner"><span class="label">PROBE_S1</span></div></div>',
    )
    const findings = findSentinelMatches(
      mountRoot,
      [{ sentinel: 'PROBE_S1', kind: 'prop', name: 'label' }],
      selectorForMount(mountRoot),
    )
    const resolved = resolveMatch(findings[0].matches)
    expect(resolved).toEqual({ selector: 'span.label', field: 'textContent' })
  })

  it('end-to-end: resolveMatch still drops the sibling case as ambiguous', () => {
    const { mountRoot } = renderMount(
      '<div class="ui-card"><span class="a">PROBE_S1</span><span class="b">PROBE_S1</span></div>',
    )
    const findings = findSentinelMatches(
      mountRoot,
      [{ sentinel: 'PROBE_S1', kind: 'prop', name: 'label' }],
      selectorForMount(mountRoot),
    )
    expect(resolveMatch(findings[0].matches)).toBeNull()
  })

  it('omits a match with no stable class on a non-root element (too ambiguous)', () => {
    const { mountRoot } = renderMount(
      '<div class="ui-card"><span>PROBE_S1</span><span class="footer">footer</span></div>',
    )
    const findings = findSentinelMatches(
      mountRoot,
      [{ sentinel: 'PROBE_S1', kind: 'prop', name: 'label' }],
      selectorForMount(mountRoot),
    )
    expect(findings[0].matches).toEqual([])
  })

  it('matches an attribute value that CONTAINS the sentinel (not just equals)', () => {
    const { mountRoot } = renderMount(
      '<div class="ui-input"><input class="ui-input__field" placeholder="Search PROBE_S1 here" /></div>',
    )
    const findings = findSentinelMatches(
      mountRoot,
      [{ sentinel: 'PROBE_S1', kind: 'prop', name: 'placeholder' }],
      selectorForMount(mountRoot),
    )
    expect(findings[0].matches).toEqual([
      { selector: 'input.ui-input__field', field: 'attribute', attribute: 'placeholder' },
    ])
  })

  it('requires an EXACT (trimmed) textContent match, not substring', () => {
    const { mountRoot } = renderMount('<div class="ui-card"><span class="title">PROBE_S1 extra</span></div>')
    const findings = findSentinelMatches(
      mountRoot,
      [{ sentinel: 'PROBE_S1', kind: 'prop', name: 'label' }],
      selectorForMount(mountRoot),
    )
    expect(findings[0].matches).toEqual([])
  })

  it('reports an empty matches array (not a missing finding) when a sentinel is not found', () => {
    const { mountRoot } = renderMount('<button>nothing relevant</button>')
    const findings = findSentinelMatches(
      mountRoot,
      [{ sentinel: 'PROBE_MISSING', kind: 'prop', name: 'label' }],
      selectorForMount(mountRoot),
    )
    expect(findings).toEqual([{ sentinel: 'PROBE_MISSING', kind: 'prop', name: 'label', matches: [] }])
  })

  it('handles multiple sentinels independently in one pass', () => {
    const { mountRoot } = renderMount(
      '<div class="ui-card"><span class="title">PROBE_TITLE</span><span class="body">PROBE_BODY</span></div>',
    )
    const findings = findSentinelMatches(
      mountRoot,
      [
        { sentinel: 'PROBE_TITLE', kind: 'prop', name: 'title' },
        { sentinel: 'PROBE_BODY', kind: 'prop', name: 'body' },
      ],
      selectorForMount(mountRoot),
    )
    expect(findings.map((f) => f.matches)).toEqual([
      [{ selector: 'span.title', field: 'textContent' }],
      [{ selector: 'span.body', field: 'textContent' }],
    ])
  })

  // ── ownerFor: the injected Vue-ownership hook (kind:'forward' source) ──
  //
  // `ownerFor` is how a caller tells `findSentinelMatches` that a match was
  // rendered by a CHILD component rather than by the probed component's own
  // template — see `ProbeOwnership`'s doc comment in this module for why
  // that distinction matters (it's the difference between a `dom` hint and a
  // `forward` hint). The resolver itself is framework-specific and lives in
  // `buildInPageScript`'s inline `resolveOwner` (parity-tested below); here
  // we only need to prove `findSentinelMatches` plumbs whatever it's given
  // onto the match correctly, and stays optional for callers that don't care.

  it('attaches ownedByChild to a match when the injected ownerFor returns ownership', () => {
    const { mountRoot } = renderMount(
      '<div class="ui-card"><span class="kappa alpha">PROBE_S1</span></div>',
    )
    const ownership: ProbeOwnership = { component: 'KLabel', childSlot: 'default' }
    const ownerFor: ProbeOwnerResolver = vi.fn(() => ownership)
    const findings = findSentinelMatches(
      mountRoot,
      [{ sentinel: 'PROBE_S1', kind: 'prop', name: 'label' }],
      selectorForMount(mountRoot),
      ownerFor,
    )
    expect(findings[0].matches).toEqual([
      { selector: 'span.alpha.kappa', field: 'textContent', ownedByChild: ownership },
    ])
    // The resolver gets exactly the (element, sentinel, field) triple its
    // type promises — not the match object, not the selector.
    expect(ownerFor).toHaveBeenCalledWith(expect.anything(), 'PROBE_S1', 'textContent')
  })

  it('omits ownedByChild entirely (not as an undefined key) when ownerFor returns null', () => {
    const { mountRoot } = renderMount(
      '<div class="ui-card"><span class="kappa alpha">PROBE_S1</span></div>',
    )
    const ownerFor: ProbeOwnerResolver = vi.fn(() => null)
    const findings = findSentinelMatches(
      mountRoot,
      [{ sentinel: 'PROBE_S1', kind: 'prop', name: 'label' }],
      selectorForMount(mountRoot),
      ownerFor,
    )
    expect(findings[0].matches).toEqual([{ selector: 'span.alpha.kappa', field: 'textContent' }])
    expect(findings[0].matches[0]).not.toHaveProperty('ownedByChild')
  })

  it('behaves identically whether ownerFor is omitted or explicitly returns null (optional param, backward compatible)', () => {
    const { mountRoot } = renderMount(
      '<div class="ui-card"><span class="kappa alpha">PROBE_S1</span></div>',
    )
    const sentinels = [{ sentinel: 'PROBE_S1', kind: 'prop' as const, name: 'label' }]
    const withoutOwnerFor = findSentinelMatches(mountRoot, sentinels, selectorForMount(mountRoot))
    const withNullOwnerFor = findSentinelMatches(
      mountRoot,
      sentinels,
      selectorForMount(mountRoot),
      () => null,
    )
    expect(withoutOwnerFor).toEqual(withNullOwnerFor)
    expect(withoutOwnerFor[0].matches[0]).not.toHaveProperty('ownedByChild')
  })
})

// ──────────────── parity: assembled in-page script vs direct call ────────────────

describe('buildInPageScript parity', () => {
  it('produces the same output as calling findSentinelMatches directly, for a success case', () => {
    renderMount('<div class="ui-card"><span class="kappa alpha">PROBE_S1</span></div>')
    const sentinels = [{ sentinel: 'PROBE_S1', kind: 'prop' as const, name: 'label' }]

    const direct = (() => {
      const located = locateMountRoot(document)
      if (!located.ok) throw new Error('unreachable')
      return {
        ok: true,
        findings: findSentinelMatches(located.mountRoot, sentinels, selectorForMount(located.mountRoot)),
      }
    })()

    // No __vueParentComponent is attached anywhere in this fixture, so the
    // exportName argument is inert here (probed can only ever resolve to
    // null) — 'UiCard' just names the fixture for a reader.
    const script = buildInPageScript(sentinels, 'UiCard')
    // Constructed from a trusted, locally-built string (not user input) to
    // execute the SAME script a real Playwright page would evaluate,
    // against jsdom.
    const viaScript = new Function(`return ${script}`)()

    expect(viaScript).toEqual(direct)
  })

  it('produces the same failure reason as locateMountRoot when the mount errored', () => {
    const container = document.createElement('div')
    container.className = 'variant-cell-mount'
    container.innerHTML = '<div class="variant-cell-error">Cell failed to mount: boom</div>'
    document.body.appendChild(container)

    const script = buildInPageScript([], 'UiCard')
    const viaScript = new Function(`return ${script}`)()
    expect(viaScript).toEqual({ ok: false, reason: 'Cell failed to mount: boom' })
  })

  it('agrees on attribute-contains matches through the assembled script', () => {
    renderMount(
      '<div class="ui-input"><input class="ui-input__field" placeholder="Search PROBE_S1 here" /></div>',
    )
    const sentinels = [{ sentinel: 'PROBE_S1', kind: 'prop' as const, name: 'placeholder' }]
    // No instance attached here either — see the note on the first test above.
    const script = buildInPageScript(sentinels, 'UiInput')
    const viaScript = new Function(`return ${script}`)()
    expect(viaScript.ok).toBe(true)
    expect(viaScript.findings[0].matches).toEqual([
      { selector: 'input.ui-input__field', field: 'attribute', attribute: 'placeholder' },
    ])
  })
})

// ──────────────── buildInPageScript parity: ownership (kind:'forward' hints) ────────────────

/**
 * Fakes just enough of a Vue 3 component instance for the assembled script's
 * inline `resolveOwner` to read — `type.__name` (or `.name`) for the
 * component's display name, `props` for the childProp search, `slots` for
 * the slot-origin walk, and `parent` for the one-hop ownership check. A real
 * `ComponentInternalInstance` carries dozens of other fields; `resolveOwner`
 * never reads any of them, so faking the rest would just be noise. See
 * `resolveOwner` inside `buildInPageScript` (`probe-driver.ts`) for the
 * algorithm these tests exercise.
 *
 * `slots` is a record of zero-arg functions, matching Vue's own
 * `ComponentInternalInstance.slots` shape (`Record<string, Slot | undefined>`
 * where a `Slot` is called with no props in the no-scoped-slot case
 * `resolveOwner` cares about). Each function returns a vnode-ish value —
 * a string, a nested array/object tree, or anything `vnodeTreeHasText` can
 * walk — so a fixture can shape it to whatever depth or nesting a given test
 * needs to exercise.
 */
interface FakeVueInstance {
  type: { __name?: string; name?: string }
  props: Record<string, unknown>
  subTree: Record<string, unknown>
  parent?: FakeVueInstance
  slots?: Record<string, () => unknown>
}

function fakeVueInstance(
  over: {
    name?: string
    props?: Record<string, unknown>
    parent?: FakeVueInstance
    slots?: Record<string, () => unknown>
  } = {},
): FakeVueInstance {
  return {
    type: over.name ? { __name: over.name } : {},
    props: over.props ?? {},
    subTree: {},
    parent: over.parent,
    slots: over.slots,
  }
}

/** `__vueParentComponent` is how Vue 3 stamps a mounted component's root DOM
 * node with its instance — not a real DOM property, so attaching one to a
 * jsdom `Element` needs a cast. */
function attachInstance(el: Element, instance: FakeVueInstance): void {
  ;(el as unknown as { __vueParentComponent?: FakeVueInstance }).__vueParentComponent = instance
}

/**
 * Builds a REALISTIC probed-component instance — parented under a fake
 * isolation-harness "app root" wrapper whose `subTree.el` is the SAME DOM
 * element as the probed component's own root.
 *
 * This is not incidental detail: it is the ACTUAL compose-isolation page
 * topology. The harness's own render is nothing but `<component
 * :is="Probed" v-bind="props" />` — no wrapping DOM of its own — so its
 * `subTree.el` legitimately equals the probed component's root element. That
 * shared-root relationship is exactly what the OLD `probed` computation (walk
 * UP from `mountRoot.__vueParentComponent` while `parent.subTree.el ===
 * mountRoot`) could not tell apart from the OTHER shared-root case it was
 * written for (a probed component whose OWN root is another component). It
 * climbed past the component we mounted and landed on this wrapper. A
 * fixture that omits the wrapper (the earlier, simpler shape of these tests)
 * cannot exercise that bug at all — every one of the tests below WOULD have
 * passed against the broken code, because bare `fakeVueInstance({ name })`
 * with no `.parent` gives the old walk nothing to overshoot onto. See the
 * REGRESSION test in this describe block for the failure this fixes.
 */
function probedInstance(name: string, mountRoot: Element): FakeVueInstance {
  const appRootInstance = fakeVueInstance({ name: 'ComposeIsolationCell' })
  const inst = fakeVueInstance({ name, parent: appRootInstance })
  appRootInstance.subTree = { el: mountRoot }
  return inst
}

describe("buildInPageScript parity — ownership (kind:'forward' hints)", () => {
  it('produces ownedByChild for an element rendered by a genuine child component (textContent match)', () => {
    // KInput (probed) renders <KLabel>PROBE_S1</KLabel> internally — the
    // sentinel lands on KLabel's own DOM, one component boundary below the
    // probed component. This is the measured KInput/KLabel case from the
    // module doc comment: a `dom` hint here would point at DOM the probed
    // component doesn't own.
    //
    // GROUND TRUTH (measured 2026-08-16 against @kong/kongponents 9.52.9,
    // live compose-isolation page): KLabel's props are exactly info,
    // required, tooltipAttributes, help — none of them ever hold the
    // sentinel — and its `slots` object has exactly one key, `default`,
    // whose vnode tree contains the sentinel. So this fixture's KLabel
    // carries NO matching prop and a real `slots.default` whose rendered
    // tree contains the sentinel nested two levels deep (an array of one
    // vnode-ish object whose `children` is another such object) — deep
    // enough to genuinely exercise `vnodeTreeHasText`'s recursion rather
    // than a bare string return, which a shallower fixture would let pass
    // even if the walk only checked one level.
    const { mountRoot } = renderMount(
      '<div class="ki-input"><label class="k-label">PROBE_S1</label></div>',
    )
    const rootInstance = probedInstance('KInput', mountRoot)
    attachInstance(mountRoot, rootInstance)
    const labelEl = mountRoot.querySelector('label.k-label')
    if (!labelEl) throw new Error('test fixture missing label.k-label')
    attachInstance(
      labelEl,
      fakeVueInstance({
        name: 'KLabel',
        parent: rootInstance,
        slots: { default: () => [{ children: [{ children: 'PROBE_S1' }] }] },
      }),
    )

    const sentinels = [{ sentinel: 'PROBE_S1', kind: 'prop' as const, name: 'label' }]
    const script = buildInPageScript(sentinels, 'KInput')
    const result = new Function(`return ${script}`)()

    expect(result.ok).toBe(true)
    expect(result.findings[0].matches).toEqual([
      {
        selector: 'label.k-label',
        field: 'textContent',
        ownedByChild: { component: 'KLabel', childSlot: 'default' },
      },
    ])
  })

  it('refuses ownership across TWO component boundaries (a grandchild, not a direct child)', () => {
    // walkForward hops exactly one component boundary per hint (see
    // resolveOwner's own comment in probe-driver.ts). An element whose
    // instance's `.parent` is an INTERMEDIATE component — not the probed
    // instance itself — must NOT produce ownership: a hint naming the
    // grandchild would be matched against the wrong parent-child boundary at
    // attribution time.
    const { mountRoot } = renderMount(
      '<div class="ki-input"><span class="deep">PROBE_S2</span></div>',
    )
    const rootInstance = probedInstance('KInput', mountRoot)
    attachInstance(mountRoot, rootInstance)
    const intermediateInstance = fakeVueInstance({ name: 'KWrapper', parent: rootInstance })
    const grandchildInstance = fakeVueInstance({ name: 'KLabel', parent: intermediateInstance })
    const spanEl = mountRoot.querySelector('span.deep')
    if (!spanEl) throw new Error('test fixture missing span.deep')
    attachInstance(spanEl, grandchildInstance)

    const sentinels = [{ sentinel: 'PROBE_S2', kind: 'prop' as const, name: 'label' }]
    const script = buildInPageScript(sentinels, 'KInput')
    const result = new Function(`return ${script}`)()

    expect(result.findings[0].matches).toEqual([{ selector: 'span.deep', field: 'textContent' }])
    expect(result.findings[0].matches[0]).not.toHaveProperty('ownedByChild')
  })

  it('refuses ownership for an attribute-field match with no matching child prop (no slot fallback for attributes)', () => {
    // Slot content only ever surfaces via textContent — an attribute value
    // can never carry slot children — so resolveOwner's fallback to
    // childSlot is gated on `field === 'textContent'`. A child that owns the
    // matched attribute but whose props don't contain the sentinel must
    // refuse rather than invent a childSlot relationship that couldn't exist.
    const { mountRoot } = renderMount(
      '<div class="ki-input"><input class="k-input__el" placeholder="Search PROBE_S3 here" /></div>',
    )
    const rootInstance = probedInstance('KInput', mountRoot)
    attachInstance(mountRoot, rootInstance)
    const inputEl = mountRoot.querySelector('input.k-input__el')
    if (!inputEl) throw new Error('test fixture missing input.k-input__el')
    attachInstance(inputEl, fakeVueInstance({ name: 'KIcon', parent: rootInstance }))

    const sentinels = [{ sentinel: 'PROBE_S3', kind: 'prop' as const, name: 'placeholder' }]
    const script = buildInPageScript(sentinels, 'KInput')
    const result = new Function(`return ${script}`)()

    expect(result.findings[0].matches).toEqual([
      { selector: 'input.k-input__el', field: 'attribute', attribute: 'placeholder' },
    ])
    expect(result.findings[0].matches[0]).not.toHaveProperty('ownedByChild')
  })

  it("reports childProp (not a slot) when the child instance's OWN props contain the sentinel", () => {
    // A child that received the sentinel as a PROP (not slot content) must
    // be reported as such — childProp, not childSlot — even though the
    // match itself is a textContent match (the child rendered the prop as
    // its own text). resolveOwner's props loop runs BEFORE the textContent
    // fallback, so a prop match always wins.
    const { mountRoot } = renderMount(
      '<div class="ki-input"><span class="chip">PROBE_S4</span></div>',
    )
    const rootInstance = probedInstance('KInput', mountRoot)
    attachInstance(mountRoot, rootInstance)
    const chipEl = mountRoot.querySelector('span.chip')
    if (!chipEl) throw new Error('test fixture missing span.chip')
    attachInstance(
      chipEl,
      fakeVueInstance({ name: 'KChip', parent: rootInstance, props: { text: 'PROBE_S4' } }),
    )

    const sentinels = [{ sentinel: 'PROBE_S4', kind: 'prop' as const, name: 'label' }]
    const script = buildInPageScript(sentinels, 'KInput')
    const result = new Function(`return ${script}`)()

    expect(result.findings[0].matches).toEqual([
      {
        selector: 'span.chip',
        field: 'textContent',
        ownedByChild: { component: 'KChip', childProp: 'text' },
      },
    ])
  })

  it('refuses ownership when TWO child props hold the SAME sentinel value (ambiguous prop destination)', () => {
    // THE CODEX FINDING. A parent authoring a component might bind the same
    // value to two different child props at once — `:text="label"` AND
    // `:aria-label="label"` on the same child. Before this guard, the old
    // loop walked `props` with `for...in` and returned the FIRST key whose
    // value matched, i.e. whichever prop happened to enumerate first — an
    // accident of object-key order, not a fact about which prop the click
    // actually renders through. That guess was then stamped
    // `verified: true`, a hint that looks measured but is really a coin
    // flip: `walkForward` would route every future edit to `text` and never
    // to `aria-label`, silently making one of the two props permanently
    // unreachable through this hint while looking authoritative. Ambiguity
    // here must produce NO hint, matching `resolveMatch`'s own posture on
    // ambiguous DOM matches.
    const { mountRoot } = renderMount(
      '<div class="ki-input"><span class="dual">PROBE_S8</span></div>',
    )
    const rootInstance = probedInstance('KInput', mountRoot)
    attachInstance(mountRoot, rootInstance)
    const dualEl = mountRoot.querySelector('span.dual')
    if (!dualEl) throw new Error('test fixture missing span.dual')
    attachInstance(
      dualEl,
      fakeVueInstance({
        name: 'KDual',
        parent: rootInstance,
        props: { text: 'PROBE_S8', ariaLabel: 'PROBE_S8' },
      }),
    )

    const sentinels = [{ sentinel: 'PROBE_S8', kind: 'prop' as const, name: 'label' }]
    const script = buildInPageScript(sentinels, 'KInput')
    const result = new Function(`return ${script}`)()

    // The DOM match itself still stands (findSentinelMatches found the text)
    // — only the forwarding relationship is refused.
    expect(result.findings[0].matches).toEqual([{ selector: 'span.dual', field: 'textContent' }])
    expect(result.findings[0].matches[0]).not.toHaveProperty('ownedByChild')
  })

  it('REFUSES when a prop AND a slot both carry the sentinel — conflicting evidence is not a tiebreak', () => {
    // The prop walk deliberately does NOT short-circuit. A parent can hand the
    // same value to a child's prop and its slot at once, and the child renders
    // exactly one of them; nothing observable from out here says which. An
    // earlier version of this file asserted the opposite — that the prop wins
    // and the slot walk is never consulted — which is what the implementation
    // did at the time. That made the answer a coin-flip decided by evaluation
    // order, and then stamped it `verified: true`, which is the one label that
    // buys deterministic routing through `isTrustedHint`. Refusing costs this
    // one hint. Guessing costs an edit landing on the wrong prop.
    const { mountRoot } = renderMount(
      '<div class="ki-input"><span class="chip">PROBE_S9</span></div>',
    )
    const rootInstance = probedInstance('KInput', mountRoot)
    attachInstance(mountRoot, rootInstance)
    const chipEl = mountRoot.querySelector('span.chip')
    if (!chipEl) throw new Error('test fixture missing span.chip')
    attachInstance(
      chipEl,
      fakeVueInstance({
        name: 'KChip',
        parent: rootInstance,
        props: { text: 'PROBE_S9' },
        slots: { default: () => 'PROBE_S9' },
      }),
    )

    const sentinels = [{ sentinel: 'PROBE_S9', kind: 'prop' as const, name: 'label' }]
    const script = buildInPageScript(sentinels, 'KInput')
    const result = new Function(`return ${script}`)()

    // The match still exists — it just carries no ownership, so the caller
    // emits a plain `dom` hint instead of a guessed `forward` one.
    expect(result.findings[0].matches).toEqual([
      { selector: 'span.chip', field: 'textContent' },
    ])
  })

  it('a single matching prop with NO competing slot yields childProp', () => {
    // The unambiguous prop case, which the rule above must not have broken:
    // one prop carries the sentinel, no slot does, so there is exactly one
    // source of evidence and it earns the hint.
    const { mountRoot } = renderMount(
      '<div class="ki-input"><span class="chip">PROBE_S9</span></div>',
    )
    const rootInstance = probedInstance('KInput', mountRoot)
    attachInstance(mountRoot, rootInstance)
    const chipEl = mountRoot.querySelector('span.chip')
    if (!chipEl) throw new Error('test fixture missing span.chip')
    attachInstance(
      chipEl,
      fakeVueInstance({
        name: 'KChip',
        parent: rootInstance,
        props: { text: 'PROBE_S9' },
        slots: { default: () => 'something else entirely' },
      }),
    )

    const sentinels = [{ sentinel: 'PROBE_S9', kind: 'prop' as const, name: 'label' }]
    const script = buildInPageScript(sentinels, 'KInput')
    const result = new Function(`return ${script}`)()

    expect(result.findings[0].matches).toEqual([
      {
        selector: 'span.chip',
        field: 'textContent',
        ownedByChild: { component: 'KChip', childProp: 'text' },
      },
    ])
  })

  it('names the REAL slot the sentinel came through — a named slot resolves to that name, not to a hardcoded "default"', () => {
    // This is the second half of the "SLOT destination is now ESTABLISHED,
    // not assumed" change (see the module's resolveOwner doc comment). The
    // old code hardcoded `childSlot: 'default'` for any textContent match
    // with no prop hit — a claim it never checked. A child receiving a
    // NAMED slot (e.g. `#header`) would have been reported as if it
    // received the default slot instead. Naming slot generation only ever
    // probes a component's default slot today, so a WRONG slot name here is
    // inert until named-slot probing exists — but it is still a false
    // statement about where the content came from, and this test is what
    // pins the fix in place before that becomes reachable.
    const { mountRoot } = renderMount(
      '<div class="ki-input"><div class="banner">PROBE_S10</div></div>',
    )
    const rootInstance = probedInstance('KInput', mountRoot)
    attachInstance(mountRoot, rootInstance)
    const bannerEl = mountRoot.querySelector('div.banner')
    if (!bannerEl) throw new Error('test fixture missing div.banner')
    attachInstance(
      bannerEl,
      fakeVueInstance({
        name: 'KBanner',
        parent: rootInstance,
        slots: { header: () => 'PROBE_S10' },
      }),
    )

    const sentinels = [{ sentinel: 'PROBE_S10', kind: 'prop' as const, name: 'label' }]
    const script = buildInPageScript(sentinels, 'KInput')
    const result = new Function(`return ${script}`)()

    expect(result.findings[0].matches).toEqual([
      {
        selector: 'div.banner',
        field: 'textContent',
        ownedByChild: { component: 'KBanner', childSlot: 'header' },
      },
    ])
  })

  it('refuses ownership when the sentinel appears in TWO different slots (ambiguous slot destination)', () => {
    // Same ambiguity guard as the prop case, applied to slots: if BOTH
    // `default` and `header` render the sentinel, there is no single true
    // answer for which slot the click's content came through. Picking
    // either one by enumeration order would be the exact mistake the prop
    // guard exists to prevent, just moved one branch over. Refuse rather
    // than guess.
    const { mountRoot } = renderMount(
      '<div class="ki-input"><div class="banner">PROBE_S11</div></div>',
    )
    const rootInstance = probedInstance('KInput', mountRoot)
    attachInstance(mountRoot, rootInstance)
    const bannerEl = mountRoot.querySelector('div.banner')
    if (!bannerEl) throw new Error('test fixture missing div.banner')
    attachInstance(
      bannerEl,
      fakeVueInstance({
        name: 'KBanner',
        parent: rootInstance,
        slots: { default: () => 'PROBE_S11', header: () => 'PROBE_S11' },
      }),
    )

    const sentinels = [{ sentinel: 'PROBE_S11', kind: 'prop' as const, name: 'label' }]
    const script = buildInPageScript(sentinels, 'KInput')
    const result = new Function(`return ${script}`)()

    expect(result.findings[0].matches).toEqual([{ selector: 'div.banner', field: 'textContent' }])
    expect(result.findings[0].matches[0]).not.toHaveProperty('ownedByChild')
  })

  it('refuses ownership when the child HAS slots but none of them render the sentinel', () => {
    // Distinguishes "no slots at all" (the old, now-invalid assumption) from
    // "slots exist, none of them are the source." Reporting `childSlot:
    // 'default'` here — the old behaviour — would point a future edit at
    // slot content that does not actually contain what the user clicked,
    // silently landing the edit on the wrong markup while looking
    // successful.
    const { mountRoot } = renderMount(
      '<div class="ki-input"><div class="banner">PROBE_S12</div></div>',
    )
    const rootInstance = probedInstance('KInput', mountRoot)
    attachInstance(mountRoot, rootInstance)
    const bannerEl = mountRoot.querySelector('div.banner')
    if (!bannerEl) throw new Error('test fixture missing div.banner')
    attachInstance(
      bannerEl,
      fakeVueInstance({
        name: 'KBanner',
        parent: rootInstance,
        slots: { default: () => 'unrelated content', footer: () => 'also unrelated' },
      }),
    )

    const sentinels = [{ sentinel: 'PROBE_S12', kind: 'prop' as const, name: 'label' }]
    const script = buildInPageScript(sentinels, 'KInput')
    const result = new Function(`return ${script}`)()

    expect(result.findings[0].matches).toEqual([{ selector: 'div.banner', field: 'textContent' }])
    expect(result.findings[0].matches[0]).not.toHaveProperty('ownedByChild')
  })

  it('refuses ownership when a slot function THROWS, without crashing the probe — other sentinels still resolve', () => {
    // A slot function is arbitrary user render logic; some genuinely can't
    // run outside their real render context (a composable that reads
    // injected state only available mid-render, for example) and throw when
    // invoked cold like this. The cost of getting this wrong runs both
    // ways: if the throw propagated, ONE hostile/fragile slot would abort
    // hint generation for the component's ENTIRE probe run — every other
    // sentinel's finding lost over one component's quirk. If the throw were
    // silently treated as "no match" for THIS slot but iteration continued
    // to other slots, a later slot might wrongly appear to be the sole
    // match. The correct behaviour is narrower than either: catch, refuse
    // ownership for THIS match only, and let every other sentinel in the
    // same probe run resolve normally — proven here by asserting a SECOND,
    // healthy sentinel in the same script run still gets its ownership.
    const { mountRoot } = renderMount(
      '<div class="ki-input"><div class="throws">PROBE_S13</div><span class="ok">PROBE_S14</span></div>',
    )
    const rootInstance = probedInstance('KInput', mountRoot)
    attachInstance(mountRoot, rootInstance)
    const throwsEl = mountRoot.querySelector('div.throws')
    const okEl = mountRoot.querySelector('span.ok')
    if (!throwsEl || !okEl) throw new Error('test fixture missing throws/ok elements')
    attachInstance(
      throwsEl,
      fakeVueInstance({
        name: 'KFragile',
        parent: rootInstance,
        slots: {
          default: () => {
            throw new Error('cannot render outside owning component')
          },
        },
      }),
    )
    attachInstance(
      okEl,
      fakeVueInstance({ name: 'KChip', parent: rootInstance, props: { text: 'PROBE_S14' } }),
    )

    const sentinels = [
      { sentinel: 'PROBE_S13', kind: 'prop' as const, name: 'a' },
      { sentinel: 'PROBE_S14', kind: 'prop' as const, name: 'b' },
    ]
    const script = buildInPageScript(sentinels, 'KInput')
    const result = new Function(`return ${script}`)()

    // The probe as a whole did not crash.
    expect(result.ok).toBe(true)
    // The throwing slot's match stands, unowned.
    expect(result.findings[0].matches).toEqual([{ selector: 'div.throws', field: 'textContent' }])
    expect(result.findings[0].matches[0]).not.toHaveProperty('ownedByChild')
    // The second, unrelated sentinel resolved normally in the SAME run.
    expect(result.findings[1].matches).toEqual([
      {
        selector: 'span.ok',
        field: 'textContent',
        ownedByChild: { component: 'KChip', childProp: 'text' },
      },
    ])
  })

  it('does not match a sentinel nested deeper than the depth cap (12) inside a slot vnode tree', () => {
    // `vnodeTreeHasText` bounds its recursion because a slot function
    // returns arbitrary user-authored vnode structure, not a shape this
    // driver controls. Without a cap, a pathological or cyclical-looking
    // tree could hang or blow the stack; WITH the cap, a genuinely deep
    // render tree stops being searched partway through. Getting the cap
    // wrong in the permissive direction (too high) re-opens the hang risk
    // the cap exists to close; getting it wrong in the strict direction (as
    // tested here, confirming the cap actually bites) means a hint that
    // COULD have been established correctly is silently dropped instead —
    // acceptable (a missing hint costs only routing, never a wrong one) but
    // worth pinning so a future change to the constant is a deliberate
    // decision, not an accident.
    const { mountRoot } = renderMount(
      '<div class="ki-input"><div class="deep">PROBE_S15</div></div>',
    )
    const rootInstance = probedInstance('KInput', mountRoot)
    attachInstance(mountRoot, rootInstance)
    const deepEl = mountRoot.querySelector('div.deep')
    if (!deepEl) throw new Error('test fixture missing div.deep')
    // 15 levels of {children: …} wrapping puts the leaf string's recursive
    // check at depth 15 — past the depth > 12 cutoff.
    let nested: unknown = 'PROBE_S15'
    for (let i = 0; i < 15; i++) nested = { children: nested }
    attachInstance(
      deepEl,
      fakeVueInstance({ name: 'KDeep', parent: rootInstance, slots: { default: () => nested } }),
    )

    const sentinels = [{ sentinel: 'PROBE_S15', kind: 'prop' as const, name: 'label' }]
    const script = buildInPageScript(sentinels, 'KInput')
    const result = new Function(`return ${script}`)()

    expect(result.findings[0].matches).toEqual([{ selector: 'div.deep', field: 'textContent' }])
    expect(result.findings[0].matches[0]).not.toHaveProperty('ownedByChild')
  })

  it('DOES match a sentinel nested a modest ~3 levels inside a slot vnode tree (well under the depth cap)', () => {
    // The counterpart to the depth-cap test above: ordinary nesting (a
    // handful of wrapper elements between the slot's return value and the
    // text) must still resolve. This is the realistic shape — the failing
    // test earlier in this file (KInput/KLabel) already nests a couple of
    // levels; this test isolates JUST the depth behaviour with a
    // purpose-built shallow chain, independent of the KInput/KLabel fixture.
    const { mountRoot } = renderMount(
      '<div class="ki-input"><div class="shallow">PROBE_S16</div></div>',
    )
    const rootInstance = probedInstance('KInput', mountRoot)
    attachInstance(mountRoot, rootInstance)
    const shallowEl = mountRoot.querySelector('div.shallow')
    if (!shallowEl) throw new Error('test fixture missing div.shallow')
    let nested: unknown = 'PROBE_S16'
    for (let i = 0; i < 3; i++) nested = { children: nested }
    attachInstance(
      shallowEl,
      fakeVueInstance({ name: 'KShallow', parent: rootInstance, slots: { default: () => nested } }),
    )

    const sentinels = [{ sentinel: 'PROBE_S16', kind: 'prop' as const, name: 'label' }]
    const script = buildInPageScript(sentinels, 'KInput')
    const result = new Function(`return ${script}`)()

    expect(result.findings[0].matches).toEqual([
      {
        selector: 'div.shallow',
        field: 'textContent',
        ownedByChild: { component: 'KShallow', childSlot: 'default' },
      },
    ])
  })

  it('refuses ownership when the matched element carries no __vueParentComponent at all', () => {
    // No instance data on the matched element — a non-Vue substrate, or a
    // production build with dev-mode metadata stripped. resolveOwner must
    // refuse rather than throw or misreport; the caller's dom-hint behaviour
    // stays unchanged in this case.
    const { mountRoot } = renderMount(
      '<div class="ki-input"><span class="plain">PROBE_S5</span></div>',
    )
    attachInstance(mountRoot, probedInstance('KInput', mountRoot))
    // spanEl deliberately gets NO __vueParentComponent.

    const sentinels = [{ sentinel: 'PROBE_S5', kind: 'prop' as const, name: 'label' }]
    const script = buildInPageScript(sentinels, 'KInput')
    const result = new Function(`return ${script}`)()

    expect(result.findings[0].matches).toEqual([{ selector: 'span.plain', field: 'textContent' }])
    expect(result.findings[0].matches[0]).not.toHaveProperty('ownedByChild')
  })

  it("REGRESSION: identifies the probed component BY NAME, not by walking to the isolation harness's own shared-root wrapper — a match on the probed component's OWN root must never forward to itself", () => {
    // MEASURED (2026-08-16, @kong/kongponents): the compose-isolation page's
    // own app-root wrapper ALSO has the probed component's root element as
    // its `subTree.el` (see `probedInstance`'s doc comment above for why
    // that's the REAL topology, not a contrived one). The OLD `probed`
    // computation walked UP from `mountRoot.__vueParentComponent` while
    // `parent.subTree.el === mountRoot` — a condition that's just as true of
    // the isolation wrapper as of any other shared-root case, so it didn't
    // stop at the component we mounted. It climbed past KInput/KButton/KCard
    // onto the wrapper and returned THAT as `probed`. Every component then
    // satisfied its OWN `inst.parent === probed` check for its own root
    // match and emitted a self-referential forward hint: KButton -> KButton,
    // KCard -> KCard, on the ENTIRE design system. `walkForward`
    // (`src/editor/attribution/attribute.ts`) would chase a hint like that
    // until `MAX_FORWARD_DEPTH` on every click.
    //
    // This assertion is what must hold against the CURRENT, fixed
    // `resolveOwner`, which finds `probed` by NAME and so never needs to
    // climb onto the wrapper at all. (Verified against the OLD walk-up logic
    // in a throwaway harness before writing this: this exact fixture DOES
    // produce `ownedByChild: { component: 'KButton', childSlot: 'default' }`
    // there — the failure this test guards against is real, not theoretical.)
    const { mountRoot } = renderMount('<div class="ki-button">PROBE_S6</div>')
    const rootInstance = probedInstance('KButton', mountRoot)
    attachInstance(mountRoot, rootInstance)

    const sentinels = [{ sentinel: 'PROBE_S6', kind: 'prop' as const, name: 'label' }]
    const script = buildInPageScript(sentinels, 'KButton')
    const result = new Function(`return ${script}`)()

    expect(result.ok).toBe(true)
    // The ONLY match is KButton's own root — no ownedByChild at all.
    expect(result.findings[0].matches).toEqual([{ selector: ':root', field: 'textContent' }])
    // THE regression assertion, stated so it can't be missed: nothing this
    // script returns may name the probed component as its own forwarding
    // target. (Not a redundant restatement of the assertion above — that one
    // checks the exact match shape; this one checks the specific failure
    // mode by name, so it stays meaningful even if the match shape above is
    // ever relaxed.)
    const allMatches: ProbeObservationMatch[] = result.findings.flatMap(
      (f: { matches: ProbeObservationMatch[] }) => f.matches,
    )
    const selfReferential = allMatches.some((m) => m.ownedByChild?.component === 'KButton')
    expect(selfReferential).toBe(false)
  })

  it('emits no ownership at all when exportName matches NO instance anywhere in the chain (conservative refusal, not a guess)', () => {
    // If the manifest's exportName and the runtime's __name/.name ever
    // drift — a renamed export, a build that strips __name in production —
    // `probed` must come back null rather than guessing at SOME instance in
    // the chain. A wrong guess misattributes an edit; a null `probed` only
    // costs this one component's forward hints, and the dom hint still
    // stands. See `resolveOwner`'s doc comment in probe-driver.ts.
    const { mountRoot } = renderMount(
      '<div class="ki-input"><label class="k-label">PROBE_S7</label></div>',
    )
    const rootInstance = probedInstance('KInput', mountRoot)
    attachInstance(mountRoot, rootInstance)
    const labelEl = mountRoot.querySelector('label.k-label')
    if (!labelEl) throw new Error('test fixture missing label.k-label')
    attachInstance(labelEl, fakeVueInstance({ name: 'KLabel', parent: rootInstance }))

    const sentinels = [{ sentinel: 'PROBE_S7', kind: 'prop' as const, name: 'label' }]
    // 'KTextField' names neither KInput, KLabel, nor the isolation wrapper —
    // nothing anywhere in the __vueParentComponent.parent chain matches it.
    const script = buildInPageScript(sentinels, 'KTextField')
    const result = new Function(`return ${script}`)()

    expect(result.findings[0].matches).toEqual([{ selector: 'label.k-label', field: 'textContent' }])
    expect(result.findings[0].matches[0]).not.toHaveProperty('ownedByChild')
  })
})

// ──────────────── probeComponent (fake ProbePage — no browser) ────────────────

function fakePage(overrides: Partial<ProbePage> = {}): ProbePage & {
  gotoCalls: string[]
  evaluateCalls: string[]
} {
  const gotoCalls: string[] = []
  const evaluateCalls: string[] = []
  return {
    gotoCalls,
    evaluateCalls,
    async goto(url: string) {
      gotoCalls.push(url)
    },
    async evaluate<T>(fn: string): Promise<T> {
      evaluateCalls.push(fn)
      return undefined as unknown as T
    },
    async close() {},
    ...overrides,
  }
}

describe('probeComponent', () => {
  const spec: ProbeMountSpec = {
    importPath: '@acme/design-system',
    exportName: 'UiButton',
    props: { label: 'PROBE_S1' },
  }

  it('navigates to the built URL and returns mapped findings on success', async () => {
    const page = fakePage({
      evaluate: vi.fn(async () => ({
        ok: true,
        findings: [
          {
            sentinel: 'PROBE_S1',
            kind: 'prop',
            name: 'label',
            matches: [{ selector: ':root', field: 'textContent' }],
          },
        ],
      })) as ProbePage['evaluate'],
    })

    const result = await probeComponent({ baseUrl: 'http://127.0.0.1:5173', spec, page })

    expect(page.gotoCalls).toHaveLength(1)
    expect(page.gotoCalls[0]).toBe(buildProbeUrl('http://127.0.0.1:5173', spec))
    expect(result).toEqual({
      ok: true,
      findings: [
        {
          sentinel: 'PROBE_S1',
          propOrSlot: { kind: 'prop', name: 'label' },
          matches: [{ selector: ':root', field: 'textContent' }],
        },
      ],
    })
  })

  it('never calls page.close() — lifecycle stays with the caller', async () => {
    const closeSpy = vi.fn(async () => {})
    const page = fakePage({ close: closeSpy })
    await probeComponent({ baseUrl: 'http://127.0.0.1:5173', spec, page })
    expect(closeSpy).not.toHaveBeenCalled()
  })

  it('reports ok:false with the reason when the in-page script reports a mount failure', async () => {
    const page = fakePage({
      evaluate: vi.fn(async () => ({ ok: false, reason: 'component failed to mount' })) as ProbePage['evaluate'],
    })
    const result = await probeComponent({ baseUrl: 'http://127.0.0.1:5173', spec, page })
    expect(result).toEqual({ ok: false, reason: 'component failed to mount', findings: [] })
  })

  it('reports ok:false when page.goto rejects', async () => {
    const page = fakePage({
      goto: vi.fn(async () => {
        throw new Error('net::ERR_CONNECTION_REFUSED')
      }),
    })
    const result = await probeComponent({ baseUrl: 'http://127.0.0.1:5173', spec, page })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/probe navigation failed/)
    expect(result.reason).toMatch(/ERR_CONNECTION_REFUSED/)
  })

  it('reports ok:false when page.evaluate rejects (e.g. page crashed)', async () => {
    const page = fakePage({
      evaluate: vi.fn(async () => {
        throw new Error('Target closed')
      }) as ProbePage['evaluate'],
    })
    const result = await probeComponent({ baseUrl: 'http://127.0.0.1:5173', spec, page })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/probe evaluation failed/)
    expect(result.reason).toMatch(/Target closed/)
  })

  it('times out a hung evaluate() instead of waiting forever', async () => {
    const page = fakePage({
      evaluate: (() => new Promise(() => {})) as ProbePage['evaluate'], // never resolves
    })
    const result = await probeComponent({
      baseUrl: 'http://127.0.0.1:5173',
      spec,
      page,
      timeoutMs: 10,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/probe evaluation failed/)
    expect(result.reason).toMatch(/timed out/)
  })
})
