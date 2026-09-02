/**
 * Unit coverage for `buildAttributionContext`. Stubs the framework
 * adapter and the live DOM. Pins context shape for the validation
 * cases that drive Phase 2e: UiLabel direct slot, UiInput-through-UiLabel
 * chain, library leaf with no source position, attribute-target clicks.
 */
import { describe, it, expect } from 'vitest'
import { buildAttributionContext } from './build-attribution-context'
import type { FrameworkRuntimeAdapter } from './leaf-prop-attribution'
import { NON_IDENTIFYING_COMPONENT_NAME } from '../editor/attribution/types'

// ──────────────── Fake DOM / instance helpers ────────────────

/** Minimal Element stub that satisfies the canonical-selector reader. */
function fakeEl(opts: {
  tagName: string
  classList?: string[]
  textContent?: string
  /**
   * Explicit child-node spec for `ownText` extraction. Each entry is a
   * direct child: `{ text }` → a text node (nodeType 3); `{ elementText }`
   * → an element node (nodeType 1) whose text is NOT part of ownText but
   * IS part of the (separately-specified) textContent. When omitted, a
   * single text node is synthesized from `textContent` so ownText equals
   * textContent (the common no-nesting case).
   */
  childNodes?: Array<{ text?: string; elementText?: string }>
  /**
   * Stub for `querySelectorAll`, used by the click-time selector-uniqueness
   * computation (Phase 5 Task 3). Defaults to a function returning an empty
   * NodeList-like array — tests that care about the uniqueness count pass
   * this explicitly.
   */
  querySelectorAll?: (selector: string) => ArrayLike<unknown>
}): Element {
  const classes = opts.classList ?? []
  const classList = {
    length: classes.length,
    item: (i: number) => classes[i] ?? null,
  }
  const childSpec = opts.childNodes ?? (opts.textContent != null ? [{ text: opts.textContent }] : [])
  const childNodes = childSpec.map((c) =>
    c.elementText !== undefined
      ? { nodeType: 1, textContent: c.elementText }
      : { nodeType: 3, textContent: c.text ?? '' },
  )
  return {
    tagName: opts.tagName.toUpperCase(),
    classList,
    textContent: opts.textContent ?? null,
    childNodes,
    querySelectorAll: opts.querySelectorAll ?? (() => []),
  } as unknown as Element
}

/**
 * Minimal instance chain: each entry is an opaque marker the stub
 * adapter recognizes. Walking up from `chain[0]` yields chain[1],
 * chain[2], ... until null.
 */
type FakeInstance = {
  __id: string
  __name?: string
  __file?: string
  stamp?: string
  vnodeProps?: Record<string, unknown>
  boundPropNames?: string[]
  boundPropStamps?: Record<string, string>
  mountRoot?: Element | null
  /**
   * Override for `getRenderOwnerInstance`. Omitted (the default): the
   * render owner equals the nesting parent (`parentMap`), matching the
   * ordinary "parent rendered its child" shape every other fixture in this
   * file models. Explicitly `null`: models an adapter that could not
   * determine the render owner at all (production build, unsupported
   * substrate) — `extractChainEntry` must then leave `renderedByParent`
   * UNDEFINED. Any other `FakeInstance`: models a component whose render
   * owner differs from its nesting parent (slot content) —
   * `extractChainEntry` must set `renderedByParent: false`.
   */
  renderOwner?: FakeInstance | null
}

function makeStubAdapter(
  chain: FakeInstance[],
  options: { owningEl?: Element } = {},
): FrameworkRuntimeAdapter {
  const owningEl = options.owningEl
  const parentMap = new Map<FakeInstance, FakeInstance | null>()
  for (let i = 0; i < chain.length; i++) {
    parentMap.set(chain[i], chain[i + 1] ?? null)
  }
  return {
    name: 'stub',
    getOwningInstance: (el) => (owningEl && el !== owningEl ? null : chain[0] ?? null),
    isLibraryInstance: (instance) => {
      const f = (instance as FakeInstance).__file
      return f === undefined || f.includes('/node_modules/')
    },
    getCallSiteStamp: (instance) => (instance as FakeInstance).stamp ?? null,
    // The stub plays a Vue runtime, so it answers from `type.__name` the way
    // the real Vue adapter does. Production code must go THROUGH this method
    // rather than reading `__name` itself — doing the latter resolved every
    // React component to `<anonymous>`.
    getComponentName: (instance) => {
      const type = (instance as unknown as Record<string, unknown>)?.type as
        | Record<string, unknown>
        | undefined
      const n = type?.__name
      return typeof n === 'string' && n.length > 0 ? n : null
    },
    hasOwnInstancePointer: (el) =>
      !!(el as unknown as Record<string, unknown>).__vueParentComponent,
    readDeclaredProps: () => ({}),
    wasRenderedByInstanceTemplate: () => true,
    getInstanceMountRoot: (instance) => (instance as FakeInstance).mountRoot ?? null,
    getParentInstance: (instance) => parentMap.get(instance as FakeInstance) ?? null,
    // By default these fixtures model a parent RENDERING its child (the
    // ordinary chain), so authorship and nesting coincide and this returns
    // the same instance as `getParentInstance`. A fixture that needs to
    // model the divergent case — a component handed in as slot content, or
    // an adapter that can't tell at all — sets `renderOwner` explicitly
    // (including to `null`, meaning "unknown"); see `FakeInstance.renderOwner`.
    getRenderOwnerInstance: (instance) => {
      const fake = instance as FakeInstance
      return Object.prototype.hasOwnProperty.call(fake, 'renderOwner')
        ? (fake.renderOwner ?? null)
        : (parentMap.get(fake) ?? null)
    },
    getInstanceFile: (instance) => (instance as FakeInstance).__file ?? null,
    getInstanceIterationKey: () => null,
    readConsumerVnodeProps: (instance) => {
      const fake = instance as FakeInstance
      if (!fake.vnodeProps) return null
      return {
        props: fake.vnodeProps,
        boundPropNames: new Set(fake.boundPropNames ?? []),
        boundPropStamps: fake.boundPropStamps,
      }
    },
  }
}

// ──────────────── Case 2: direct user-code <UiLabel>foo</UiLabel> ────────────────

describe('buildAttributionContext — direct user-code UiLabel slot', () => {
  it('takes the component name from the ADAPTER, not from a Vue-shaped property', () => {
    // The React regression. `readComponentName` used to read
    // `instance.type.__name` itself. React has no `__name` (it uses the
    // function's `displayName`/`name`) and its adapter's `getInstanceFile`
    // returns null by design, so BOTH fallbacks missed and every React
    // component in the chain came back `<anonymous>`.
    //
    // Manifest lookup is by NAME, so that silently switched manifest-first
    // attribution off for the entire React substrate — degrading to the
    // heuristic path with nothing reporting it. Nothing threw; the names were
    // just wrong.
    const el = fakeEl({ tagName: 'button', classList: [], textContent: 'Save' })
    const owning: FakeInstance = {
      __id: 'card',
      // Deliberately NO __name and NO __file — the React shape.
      stamp: 'src/App.tsx:8:4',
      mountRoot: el,
    }

    const adapter = makeStubAdapter([owning])
    const context = buildAttributionContext(el, {
      ...adapter,
      // A runtime that knows its own naming convention, as React's does.
      getComponentName: () => 'SaveButton',
    })

    expect(context?.componentChain[0]?.name).toBe('SaveButton')
  })

  it('still reports <anonymous> when the adapter genuinely has no name', () => {
    // The fallback must survive: an adapter returning null is a real state,
    // and the shell treats `<anonymous>` as "no rendering hints".
    const el = fakeEl({ tagName: 'div', classList: [], textContent: 'x' })
    const owning: FakeInstance = { __id: 'anon', stamp: 'src/App.tsx:1:1', mountRoot: el }
    const adapter = makeStubAdapter([owning])
    const context = buildAttributionContext(el, { ...adapter, getComponentName: () => null })

    expect(context?.componentChain[0]?.name).toBe('<anonymous>')
  })

  it('extracts a single-component chain with consumer source loc', () => {
    const el = fakeEl({
      tagName: 'label',
      classList: ['ui-label'],
      textContent: 'Additional base paths',
    })
    const owning: FakeInstance = {
      __id: 'klabel',
      __name: 'UiLabel',
      __file: '/abs/node_modules/@acme/design-system/dist/components/UiLabel/UiLabel.vue',
      stamp: 'src/views/AIGatewayModelCreate.vue:70:21',
      mountRoot: el,
    }
    const sfc: FakeInstance = {
      __id: 'page',
      __name: 'AIGatewayModelCreate',
      __file: 'src/views/AIGatewayModelCreate.vue',
    }

    const context = buildAttributionContext(el, makeStubAdapter([owning, sfc]))
    expect(context).not.toBeNull()
    if (!context) return

    expect(context.clickedElement.selectorWithinMountRoot).toBe(':root')
    expect(context.clickedElement.textContent).toBe('Additional base paths')

    expect(context.componentChain).toHaveLength(2)
    expect(context.componentChain[0]).toEqual({
      name: 'UiLabel',
      importPath: '@acme/design-system',
      consumerSourceLoc: {
        file: 'src/views/AIGatewayModelCreate.vue',
        line: 70,
        column: 21,
      },
      // The stub adapter's default renderOwner is the nesting parent (the
      // page SFC), same as getParentInstance — this fixture models the
      // ordinary "parent rendered its child" case.
      renderedByParent: true,
    })
    expect(context.componentChain[1].name).toBe('AIGatewayModelCreate')
    expect(context.componentChain[1].importPath).toBe(
      'src/views/AIGatewayModelCreate.vue',
    )
  })

  it('captures ownText (direct text nodes only) separately from over-captured textContent', () => {
    // `<UiLabel :info="…">Paths</UiLabel>` renders "Paths" as a direct
    // text node and the info tooltip as a sibling element inside the
    // same <label>. ownText must be just "Paths"; textContent is the
    // concatenation the slot-text applicator would choke on.
    const el = fakeEl({
      tagName: 'label',
      classList: ['ui-label'],
      textContent: 'PathsA list of paths that match this route.',
      childNodes: [
        { text: '' },
        { text: 'Paths' },
        { text: '' },
        { elementText: 'A list of paths that match this route.' },
      ],
    })
    const owning: FakeInstance = {
      __id: 'klabel',
      __name: 'UiLabel',
      __file: '/abs/node_modules/@acme/design-system/dist/components/UiLabel/UiLabel.vue',
      stamp: 'src/views/AIGatewayModelCreate.vue:313:17',
      mountRoot: el,
    }

    const context = buildAttributionContext(el, makeStubAdapter([owning]))
    expect(context).not.toBeNull()
    if (!context) return
    expect(context.clickedElement.textContent).toBe(
      'PathsA list of paths that match this route.',
    )
    expect(context.clickedElement.ownText).toBe('Paths')
  })
})

// ──────────────── Case 1: <UiInput label="Path"> chain extraction ────────────────

describe('buildAttributionContext — library chain (UiLabel inside UiInput)', () => {
  it('walks Vue parent chain, classifies literal props', () => {
    const klabelMountRoot = fakeEl({
      tagName: 'label',
      classList: ['ui-label'],
      textContent: 'Path',
    })
    const owningUiLabel: FakeInstance = {
      __id: 'klabel-internal',
      __name: 'UiLabel',
      __file: '/abs/node_modules/@acme/design-system/dist/components/UiLabel/UiLabel.vue',
      // No stamp: internal vnode, no user-authored call site.
      mountRoot: klabelMountRoot,
    }
    const parentUiInput: FakeInstance = {
      __id: 'kinput',
      __name: 'UiInput',
      __file: '/abs/node_modules/@acme/design-system/dist/components/UiInput/UiInput.vue',
      stamp: 'src/views/AIGatewayModelCreate.vue:55:11',
      vnodeProps: { label: 'Path' },
      boundPropNames: [],
    }
    const sfc: FakeInstance = {
      __id: 'page',
      __name: 'AIGatewayModelCreate',
      __file: 'src/views/AIGatewayModelCreate.vue',
    }

    const context = buildAttributionContext(
      klabelMountRoot,
      makeStubAdapter([owningUiLabel, parentUiInput, sfc]),
    )
    expect(context).not.toBeNull()
    if (!context) return

    // Owning component (UiLabel) has no consumer source loc — it's
    // library-internal. attribute() will walk past it via forward
    // hints to land at UiInput's stamp.
    expect(context.componentChain[0].name).toBe('UiLabel')
    expect(context.componentChain[0].consumerSourceLoc).toBeUndefined()

    expect(context.componentChain[1].name).toBe('UiInput')
    expect(context.componentChain[1].consumerSourceLoc).toEqual({
      file: 'src/views/AIGatewayModelCreate.vue',
      line: 55,
      column: 11,
    })
    expect(context.componentChain[1].consumerVnodeProps).toEqual({
      label: { kind: 'literal', value: 'Path' },
    })
  })

  it('classifies bound props as binding (no bindingLoc when no compile stamp)', () => {
    const mountRoot = fakeEl({ tagName: 'input', classList: ['ui-input'] })
    const owningUiInput: FakeInstance = {
      __id: 'kinput',
      __name: 'UiInput',
      __file: '/abs/node_modules/@acme/design-system/dist/components/UiInput/UiInput.vue',
      stamp: 'form.vue:14:3',
      vnodeProps: { placeholder: 'e.g. /api' },
      boundPropNames: ['placeholder'],
      mountRoot,
    }
    const sfc: FakeInstance = { __id: 'p', __name: 'Form', __file: 'form.vue' }

    const context = buildAttributionContext(
      mountRoot,
      makeStubAdapter([owningUiInput, sfc]),
    )
    expect(context?.componentChain[0].consumerVnodeProps).toEqual({
      placeholder: { kind: 'binding', value: 'e.g. /api' },
    })
  })
})

// ──────────────── renderedByParent extraction ────────────────

describe('buildAttributionContext — renderedByParent extraction', () => {
  it('leaves renderedByParent UNDEFINED (key absent) when the adapter cannot determine the render owner', () => {
    // `getRenderOwnerInstance` returning null means "the adapter genuinely
    // doesn't know" — a production Vue build, an unsupported substrate, or
    // an older bridge. `extractChainEntry` must not coerce that to `false`;
    // it must leave the field off the entry entirely.
    const el = fakeEl({ tagName: 'label', classList: ['ui-label'], textContent: 'Path' })
    const parent: FakeInstance = { __id: 'parent', __name: 'UiInput', __file: 'src/UiInput.vue' }
    const owning: FakeInstance = {
      __id: 'klabel',
      __name: 'UiLabel',
      __file: '/abs/node_modules/@acme/design-system/dist/components/UiLabel/UiLabel.vue',
      mountRoot: el,
      renderOwner: null,
    }
    const context = buildAttributionContext(el, makeStubAdapter([owning, parent]))
    expect(context).not.toBeNull()
    if (!context) return
    expect(context.componentChain[0].renderedByParent).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(context.componentChain[0], 'renderedByParent')).toBe(
      false,
    )
  })

  it('sets renderedByParent: false when the render owner differs from the nesting parent (slot content)', () => {
    // Models the KEmptyState/KButton shape: KButton's NESTING parent is
    // KEmptyState (it's mounted inside KEmptyState's subtree), but the
    // component that actually RENDERED the <KButton> tag is the user's own
    // SFC — a different instance from the nesting parent.
    const el = fakeEl({ tagName: 'button', textContent: 'New AI Gateway' })
    const userShell: FakeInstance = {
      __id: 'shell',
      __name: 'AIGatewayListEmptyState',
      __file: 'src/views/AIGatewayListEmptyState.vue',
    }
    const emptyState: FakeInstance = {
      __id: 'empty',
      __name: 'KEmptyState',
      __file: '/abs/node_modules/@kong/kongponents/dist/components/KEmptyState/KEmptyState.vue',
    }
    const owning: FakeInstance = {
      __id: 'kbutton',
      __name: 'KButton',
      __file: 'src/views/AIGatewayListEmptyState.vue',
      stamp: 'src/views/AIGatewayListEmptyState.vue:12:9',
      mountRoot: el,
      // Nesting parent (via the chain array order below) is KEmptyState,
      // but the render owner is the user's own shell — different.
      renderOwner: userShell,
    }
    // Chain order determines the nesting parent: owning's parent is
    // emptyState.
    const context = buildAttributionContext(el, makeStubAdapter([owning, emptyState]))
    expect(context).not.toBeNull()
    if (!context) return
    expect(context.componentChain[0].renderedByParent).toBe(false)
  })
})

// ──────────────── Phase 2c: data-desde-bind stamp decode ────────────────

/** Re-encode a (loc, expr) pair into the plugin's stamp format so the
 * test exercises the SAME encoding the source-tag plugin emits:
 * `"<file>:<line>:<col> <base64(expr)>"`. */
function encodeBindStamp(file: string, line: number, column: number, expr: string): string {
  const b64 = Buffer.from(expr, 'utf8').toString('base64')
  return `${file}:${line}:${column} ${b64}`
}

describe('buildAttributionContext — Phase 2c data-desde-bind decode', () => {
  it('populates bindingLoc + expression for a stamped binding', () => {
    const mountRoot = fakeEl({ tagName: 'input', classList: ['ui-input'] })
    const owning: FakeInstance = {
      __id: 'kinput',
      __name: 'UiInput',
      __file: '/abs/node_modules/@acme/design-system/dist/components/UiInput/UiInput.vue',
      stamp: 'src/views/AIGatewayProviderCreate.vue:18:11',
      vnodeProps: { placeholder: 'Enter a name' },
      boundPropNames: ['placeholder'],
      boundPropStamps: {
        placeholder: encodeBindStamp(
          'src/views/AIGatewayProviderCreate.vue',
          21,
          19,
          'providerNamePlaceholder',
        ),
      },
      mountRoot,
    }
    const context = buildAttributionContext(mountRoot, makeStubAdapter([owning]))
    expect(context?.componentChain[0].consumerVnodeProps).toEqual({
      placeholder: {
        kind: 'binding',
        value: 'Enter a name',
        bindingLoc: { file: 'src/views/AIGatewayProviderCreate.vue', line: 21, column: 19 },
        expression: 'providerNamePlaceholder',
      },
    })
  })

  it('round-trips an expression containing colons, quotes, and operators', () => {
    const mountRoot = fakeEl({ tagName: 'input', classList: ['ui-input'] })
    const expr = `index === 0 ? getPlaceholder('a:b') : "x y"`
    const owning: FakeInstance = {
      __id: 'kinput',
      __name: 'UiInput',
      __file: '/abs/node_modules/@acme/design-system/dist/components/UiInput/UiInput.vue',
      stamp: 'form.vue:14:3',
      vnodeProps: { placeholder: 'p' },
      boundPropNames: ['placeholder'],
      boundPropStamps: { placeholder: encodeBindStamp('form.vue', 15, 7, expr) },
      mountRoot,
    }
    const context = buildAttributionContext(mountRoot, makeStubAdapter([owning]))
    const pv = context?.componentChain[0].consumerVnodeProps?.placeholder
    expect(pv).toMatchObject({ kind: 'binding', expression: expr })
    expect(pv && 'bindingLoc' in pv ? pv.bindingLoc : undefined).toEqual({
      file: 'form.vue',
      line: 15,
      column: 7,
    })
  })

  it('leaves bindingLoc unset for a binding with no stamp (mixed with a stamped one)', () => {
    const mountRoot = fakeEl({ tagName: 'input', classList: ['ui-input'] })
    const owning: FakeInstance = {
      __id: 'kinput',
      __name: 'UiInput',
      __file: '/abs/node_modules/@acme/design-system/dist/components/UiInput/UiInput.vue',
      stamp: 'form.vue:14:3',
      vnodeProps: { placeholder: 'p', label: 'l' },
      boundPropNames: ['placeholder', 'label'],
      boundPropStamps: { placeholder: encodeBindStamp('form.vue', 15, 7, 'ph') },
      mountRoot,
    }
    const context = buildAttributionContext(mountRoot, makeStubAdapter([owning]))
    expect(context?.componentChain[0].consumerVnodeProps).toEqual({
      placeholder: {
        kind: 'binding',
        value: 'p',
        bindingLoc: { file: 'form.vue', line: 15, column: 7 },
        expression: 'ph',
      },
      label: { kind: 'binding', value: 'l' },
    })
  })

  it('decodes a stamp whose file path contains spaces (splits on last space)', () => {
    const mountRoot = fakeEl({ tagName: 'input', classList: ['ui-input'] })
    const owning: FakeInstance = {
      __id: 'kinput',
      __name: 'UiInput',
      __file: '/abs/node_modules/@acme/design-system/dist/components/UiInput/UiInput.vue',
      stamp: 'src/ui drafts/Form.vue:14:3',
      vnodeProps: { placeholder: 'p' },
      boundPropNames: ['placeholder'],
      boundPropStamps: { placeholder: encodeBindStamp('src/ui drafts/Form.vue', 15, 7, 'ph') },
      mountRoot,
    }
    const context = buildAttributionContext(mountRoot, makeStubAdapter([owning]))
    expect(context?.componentChain[0].consumerVnodeProps).toEqual({
      placeholder: {
        kind: 'binding',
        value: 'p',
        bindingLoc: { file: 'src/ui drafts/Form.vue', line: 15, column: 7 },
        expression: 'ph',
      },
    })
  })

  it('ignores a malformed stamp (no delimiter) and falls back to LLM-routed binding', () => {
    const mountRoot = fakeEl({ tagName: 'input', classList: ['ui-input'] })
    const owning: FakeInstance = {
      __id: 'kinput',
      __name: 'UiInput',
      __file: '/abs/node_modules/@acme/design-system/dist/components/UiInput/UiInput.vue',
      stamp: 'form.vue:14:3',
      vnodeProps: { placeholder: 'p' },
      boundPropNames: ['placeholder'],
      // No space delimiter → undecodable → treated as no stamp.
      boundPropStamps: { placeholder: 'form.vue:15:7-notbase64' },
      mountRoot,
    }
    const context = buildAttributionContext(mountRoot, makeStubAdapter([owning]))
    expect(context?.componentChain[0].consumerVnodeProps).toEqual({
      placeholder: { kind: 'binding', value: 'p' },
    })
  })
})

// ──────────────── Attribute clicks (placeholder editing) ────────────────

describe('buildAttributionContext — attribute clicks', () => {
  it('preserves attributeName/Value when supplied via options', () => {
    const mountRoot = fakeEl({ tagName: 'input', classList: ['ui-input'] })
    const owning: FakeInstance = {
      __id: 'kinput',
      __name: 'UiInput',
      __file: '/abs/node_modules/@acme/design-system/dist/components/UiInput/UiInput.vue',
      stamp: 'form.vue:14:3',
      vnodeProps: { placeholder: 'e.g. /api/v1' },
      mountRoot,
    }
    const context = buildAttributionContext(
      mountRoot,
      makeStubAdapter([owning]),
      { attribute: { attributeName: 'placeholder', attributeValue: 'e.g. /api/v1' } },
    )
    expect(context?.clickedElement.attributeName).toBe('placeholder')
    expect(context?.clickedElement.attributeValue).toBe('e.g. /api/v1')
    expect(context?.clickedElement.selectorWithinMountRoot).toBe(':root')
  })
})

// ──────────────── No owning instance / synthetic boundaries ────────────────

// ──────────────── Import path edge cases ────────────────

describe('buildAttributionContext — importPath extraction across package layouts', () => {
  it.each([
    // [layoutName, fileFromAdapter, expectedImportPath]
    [
      'npm/yarn scoped',
      '/repo/node_modules/@acme/design-system/dist/components/UiLabel/UiLabel.vue',
      '@acme/design-system',
    ],
    [
      'npm/yarn unscoped',
      '/repo/node_modules/lodash/lodash.js',
      'lodash',
    ],
    [
      // Regression for codex P1: pnpm's nested layout where the
      // real package sits past a synthetic .pnpm shim directory.
      // The OLD code would return ".pnpm" or the version-pinned
      // shim name; the fix splits on the LAST /node_modules/.
      'pnpm scoped (regression)',
      '/repo/node_modules/.pnpm/@acme+design-system@4.5.0_vue@3.4.0/node_modules/@acme/design-system/dist/components/UiLabel/UiLabel.vue',
      '@acme/design-system',
    ],
    [
      'pnpm unscoped (regression)',
      '/repo/node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/index.js',
      'lodash',
    ],
    [
      'first-party (no node_modules)',
      'src/components/MyCard.vue',
      'src/components/MyCard.vue',
    ],
  ])('extracts importPath correctly for %s layout', (_label, file, expected) => {
    const el = fakeEl({ tagName: 'div' })
    const owning: FakeInstance = {
      __id: 'c',
      __name: 'Test',
      __file: file,
      mountRoot: el,
    }
    const context = buildAttributionContext(el, makeStubAdapter([owning]))
    expect(context?.componentChain[0].importPath).toBe(expected)
  })
})

describe('buildAttributionContext — degraded cases', () => {
  it('returns null when no owning instance is found', () => {
    const el = fakeEl({ tagName: 'div' })
    const adapter = makeStubAdapter([], { owningEl: el })
    expect(buildAttributionContext(el, adapter)).toBeNull()
  })

  it('chain depth is bounded by maxChainDepth', () => {
    const el = fakeEl({ tagName: 'span' })
    const longChain: FakeInstance[] = Array.from({ length: 100 }, (_, i) => ({
      __id: `n${i}`,
      __name: `Comp${i}`,
    }))
    longChain[0].mountRoot = el
    const adapter = makeStubAdapter(longChain)
    const context = buildAttributionContext(el, adapter, { maxChainDepth: 5 })
    expect(context?.componentChain).toHaveLength(5)
  })

  it('coerces unsupported prop values (functions, objects) by dropping them', () => {
    const mountRoot = fakeEl({ tagName: 'div' })
    const owning: FakeInstance = {
      __id: 'c',
      __name: 'C',
      __file: 'src/C.vue',
      stamp: 'form.vue:1:1',
      vnodeProps: {
        text: 'hello',
        cb: () => undefined,
        obj: { nested: true },
        flag: true,
        n: 42,
      },
      mountRoot,
    }
    const context = buildAttributionContext(mountRoot, makeStubAdapter([owning]))
    const props = context?.componentChain[0].consumerVnodeProps
    expect(props).toEqual({
      text: { kind: 'literal', value: 'hello' },
      flag: { kind: 'literal', value: true },
      n: { kind: 'literal', value: 42 },
    })
  })

  it('selectorWithinMountRoot reflects tag + sorted classList when not the mount root', () => {
    const mountRoot = fakeEl({ tagName: 'section' })
    const clicked = fakeEl({ tagName: 'div', classList: ['kappa', 'alpha', 'beta'] })
    const owning: FakeInstance = {
      __id: 'c',
      __name: 'C',
      __file: 'src/C.vue',
      stamp: 'form.vue:1:1',
      mountRoot,
    }
    // Adapter resolves any element to the owning instance for this test.
    const adapter = makeStubAdapter([owning])
    const context = buildAttributionContext(clicked, adapter)
    expect(context?.clickedElement.selectorWithinMountRoot).toBe('div.alpha.beta.kappa')
  })
})

// ──────────────── Phase 5 Task 3: click-time selector uniqueness ────────────────

describe('buildAttributionContext — soleMatchWithinMountRoot', () => {
  it('is true when exactly one element within the mount root matches the selector', () => {
    const clicked = fakeEl({ tagName: 'div', classList: ['card-title'] })
    const querySelectorAll = (selector: string): ArrayLike<unknown> =>
      selector === 'div.card-title' ? [clicked] : []
    const mountRoot = fakeEl({ tagName: 'section', querySelectorAll })
    const owning: FakeInstance = {
      __id: 'c',
      __name: 'C',
      __file: 'src/C.vue',
      stamp: 'form.vue:1:1',
      mountRoot,
    }
    const context = buildAttributionContext(clicked, makeStubAdapter([owning]))
    expect(context?.clickedElement.soleMatchWithinMountRoot).toBe(true)
  })

  it('is false when the selector matches multiple elements within the mount root (ambiguous)', () => {
    const clicked = fakeEl({ tagName: 'div', classList: ['card-title'] })
    const other = fakeEl({ tagName: 'div', classList: ['card-title'] })
    const querySelectorAll = (selector: string): ArrayLike<unknown> =>
      selector === 'div.card-title' ? [clicked, other] : []
    const mountRoot = fakeEl({ tagName: 'section', querySelectorAll })
    const owning: FakeInstance = {
      __id: 'c',
      __name: 'C',
      __file: 'src/C.vue',
      stamp: 'form.vue:1:1',
      mountRoot,
    }
    const context = buildAttributionContext(clicked, makeStubAdapter([owning]))
    expect(context?.clickedElement.soleMatchWithinMountRoot).toBe(false)
  })

  it('is true (trivially) when the clicked element IS the mount root, without querying', () => {
    let called = false
    const mountRoot = fakeEl({
      tagName: 'section',
      querySelectorAll: () => {
        called = true
        return []
      },
    })
    const owning: FakeInstance = {
      __id: 'c',
      __name: 'C',
      __file: 'src/C.vue',
      stamp: 'form.vue:1:1',
      mountRoot,
    }
    const context = buildAttributionContext(mountRoot, makeStubAdapter([owning]))
    expect(context?.clickedElement.selectorWithinMountRoot).toBe(':root')
    expect(context?.clickedElement.soleMatchWithinMountRoot).toBe(true)
    expect(called).toBe(false)
  })

  it('is undefined when no mount root is resolvable', () => {
    const clicked = fakeEl({ tagName: 'div', classList: ['card-title'] })
    const owning: FakeInstance = {
      __id: 'c',
      __name: 'C',
      __file: 'src/C.vue',
      stamp: 'form.vue:1:1',
      mountRoot: null,
    }
    const context = buildAttributionContext(clicked, makeStubAdapter([owning]))
    expect(context?.clickedElement.soleMatchWithinMountRoot).toBeUndefined()
  })

  it('is undefined (never throws) when querySelectorAll itself throws', () => {
    const clicked = fakeEl({ tagName: 'div', classList: ['card-title'] })
    const mountRoot = fakeEl({
      tagName: 'section',
      querySelectorAll: () => {
        throw new Error('boom')
      },
    })
    const owning: FakeInstance = {
      __id: 'c',
      __name: 'C',
      __file: 'src/C.vue',
      stamp: 'form.vue:1:1',
      mountRoot,
    }
    expect(() => buildAttributionContext(clicked, makeStubAdapter([owning]))).not.toThrow()
    const context = buildAttributionContext(clicked, makeStubAdapter([owning]))
    expect(context?.clickedElement.soleMatchWithinMountRoot).toBeUndefined()
  })
})

/**
 * F9 pin. The shell guards its manifest lookups against the anonymous
 * placeholder so an unidentifiable component can't produce a guaranteed 404
 * (`GET /api/editor/manifest?name=<anonymous>`). That guard reads
 * `NON_IDENTIFYING_COMPONENT_NAME`; this asserts the bridge still PRODUCES it,
 * so changing one end without the other fails here instead of silently
 * resurrecting the console error.
 */
describe('buildAttributionContext — the anonymous placeholder', () => {
  it("names an unidentifiable component with the shell's shared constant", () => {
    const el = fakeEl({ tagName: 'div', textContent: 'x' })
    // No `type.__name` and no `__file` to derive a basename from — the case the
    // placeholder exists for.
    const owning: FakeInstance = { __id: 'anon', mountRoot: el }
    const context = buildAttributionContext(el, makeStubAdapter([owning]))
    expect(context?.componentChain[0]?.name).toBe(NON_IDENTIFYING_COMPONENT_NAME)
  })
})
