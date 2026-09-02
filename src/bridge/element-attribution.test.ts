/**
 * Unit coverage for the extracted element-attribution engine
 * (`element-attribution.ts`, audit Task 22).
 *
 * The module's whole reason for existing outside `comment-bridge.ts` is
 * that it reads the framework runtime ONLY through an injected
 * `FrameworkRuntimeAdapter` — so the source-resolution rules that used to
 * require booting a Vite app + an iframe + Playwright can be pinned here
 * against a stub adapter and jsdom's real DOM.
 *
 * WHAT IS COVERED
 *   · the configure gate (unconfigured use throws, not silently no-ops)
 *   · `findSourceAnchorElement` — the stamped-ancestor walk
 *   · `isComponentMountRoot` / `isAuthoredUnitBoundary` — the walk
 *     boundary that decides which text belongs to the selection
 *   · `attributeElement` — stamp parsing, the cross-instance (slot-wrapper
 *     leak) guard, component-root vs. native-element editTarget priority,
 *     the node_modules fallback, `isLibrary`, transparent-wrapper
 *     `editableComponent` resolution, and the adopted-static suppression
 *     of instance-derived fields
 *   · `computeCallsiteLocation` / `computeIterationContext` — the thin
 *     wrappers' filtering + iteration math (v-for sibling grouping,
 *     per-instance key)
 *   · `findSlotTextLeaves` — pure leaf vs. text-with-element-siblings
 *     (`textNodeIndex`) and the authored-unit boundary stop
 *   · `findEditableTextFields` — dom-text emission + the prop/slot-text
 *     dedupe
 *
 * WHAT IS NOT, AND WHY
 *   · `inspectElement`'s style/token/box-model payload — those read
 *     `getComputedStyle`, which jsdom stubs with defaults; assertions
 *     would pin jsdom quirks rather than bridge logic. Exercised live by
 *     `tasks/scripts/bridge-smoke.mts` (ELEMENT_INSPECTED round-trip).
 *   · `findEditTargetComponent` — delegates to
 *     `framework-component-detection`, which reads real Vue instance
 *     shapes (`subTree`, `type.__file`); stubbing it would test the stub.
 *   · The Vue 3 / React `FrameworkRuntimeAdapter` impls themselves — they
 *     live in `comment-bridge.ts` precisely because they read live runtime
 *     conventions (`__vueParentComponent`, `__reactFiber$…`). bridge-smoke
 *     is their gate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  configureElementAttribution,
  attributeElement,
  computeCallsiteLocation,
  computeIterationContext,
  findSourceAnchorElement,
  isComponentMountRoot,
  isAuthoredUnitBoundary,
  findSlotTextLeaves,
  findEditableTextFields,
} from "./element-attribution"
import type { FrameworkRuntimeAdapter } from "./leaf-prop-attribution"

// ──────────────── Stub adapter ────────────────

/**
 * A fake component instance. `mountRoot` is the element the instance
 * rendered as its own root; `stamp` is the consumer's `<Tag>` position
 * (what `getCallSiteStamp` returns).
 */
interface FakeInstance {
  name: string
  file: string | null
  stamp: string | null
  mountRoot?: Element | null
  parent?: FakeInstance | null
  key?: string | number | null
  props?: Record<string, unknown>
}

/**
 * Ownership is declared per-element via a `data-owner` attribute naming a
 * registered instance — mirroring what Vue's `__vueParentComponent`
 * pointer does at runtime, without needing Vue.
 */
const instances = new Map<string, FakeInstance>()

function register(inst: FakeInstance): FakeInstance {
  instances.set(inst.name, inst)
  return inst
}

const stubAdapter: FrameworkRuntimeAdapter = {
  name: "stub",
  // Mirrors what `own(el, inst, direct)` models below: the DIRECT pointer,
  // not the `data-owner` attribute that the ancestor walk follows. Reading
  // `__vueParentComponent` is correct HERE — the stub is deliberately playing
  // a Vue runtime. What was wrong was production code reading it, which made
  // the answer permanently false on React.
  hasOwnInstancePointer(el) {
    return !!(el as unknown as Record<string, unknown>).__vueParentComponent
  },
  getOwningInstance(el) {
    let cur: Element | null = el
    while (cur) {
      const owner = cur.getAttribute("data-owner")
      if (owner) return instances.get(owner) ?? null
      cur = cur.parentElement
    }
    return null
  },
  isLibraryInstance(instance) {
    const file = (instance as FakeInstance).file
    return file === null || file.split("/").includes("node_modules")
  },
  getCallSiteStamp(instance) {
    return (instance as FakeInstance).stamp
  },
  getInstanceMountRoot(instance) {
    return (instance as FakeInstance).mountRoot ?? null
  },
  getParentInstance(instance) {
    return (instance as FakeInstance).parent ?? null
  },
  getInstanceFile(instance) {
    return (instance as FakeInstance).file
  },
  getInstanceIterationKey(instance) {
    return (instance as FakeInstance).key ?? null
  },
  readDeclaredProps(instance) {
    return (instance as FakeInstance).props ?? {}
  },
  wasRenderedByInstanceTemplate() {
    return true
  },
  readConsumerVnodeProps(instance) {
    return { props: (instance as FakeInstance).props ?? {}, boundPropNames: new Set() }
  },
}

/**
 * Mark `el` as directly owned by `inst`. `attributeElement` gates the
 * instance-derived fields on the element carrying its OWN framework
 * pointer (see the adopted-static case), which for the Vue convention is
 * `__vueParentComponent`.
 */
function own(el: Element, inst: FakeInstance, direct = true): Element {
  el.setAttribute("data-owner", inst.name)
  if (direct) {
    ;(el as unknown as Record<string, unknown>).__vueParentComponent = inst
  }
  return el
}

function html(markup: string): HTMLElement {
  document.body.innerHTML = markup
  return document.body
}

beforeEach(() => {
  instances.clear()
  document.body.innerHTML = ""
  configureElementAttribution(stubAdapter)
})

afterEach(() => {
  document.body.innerHTML = ""
})

// ──────────────── configure gate ────────────────

describe("configureElementAttribution", () => {
  it("throws on use before configuration rather than silently returning nothing", async () => {
    // A fresh module registry gives us an UNCONFIGURED copy of the module
    // (the statically-imported one at the top of this file stays configured
    // by `beforeEach`, so the rest of the suite is unaffected).
    //
    // Why a throw and not a null: a silently-unconfigured adapter surfaces
    // as "attribution returns nothing, everywhere" — the hardest bridge
    // symptom to trace back to a wiring bug.
    vi.resetModules()
    const fresh = await import("./element-attribution")
    const el = html(`<div id="a">x</div>`).querySelector("#a")!
    expect(() => fresh.isComponentMountRoot(el)).toThrow(
      /used before configureElementAttribution/,
    )
  })
})

// ──────────────── findSourceAnchorElement ────────────────

describe("findSourceAnchorElement", () => {
  it("returns the element itself when it carries data-desde-src", () => {
    const root = html(`<div data-desde-src="src/App.vue:3:2"><span id="t">hi</span></div>`)
    const el = root.querySelector("div")!
    expect(findSourceAnchorElement(el)).toBe(el)
  })

  it("walks up to the nearest stamped ancestor for unstamped internals", () => {
    const root = html(
      `<div id="outer" data-desde-src="src/App.vue:3:2"><i><span id="t">hi</span></i></div>`,
    )
    expect(findSourceAnchorElement(root.querySelector("#t")!)).toBe(
      root.querySelector("#outer"),
    )
  })

  it("falls back to the element when nothing in the chain is stamped", () => {
    const root = html(`<div><span id="t">hi</span></div>`)
    const el = root.querySelector("#t")!
    expect(findSourceAnchorElement(el)).toBe(el)
  })
})

// ──────────────── boundary rules ────────────────

describe("isComponentMountRoot / isAuthoredUnitBoundary", () => {
  it("recognizes the owning instance's own render root", () => {
    const root = html(`<div id="card"><span id="inner">x</span></div>`)
    const card = root.querySelector("#card")!
    const inst = register({ name: "UiCard", file: null, stamp: "src/App.vue:4:2", mountRoot: card })
    own(card, inst)

    expect(isComponentMountRoot(card)).toBe(true)
    expect(isComponentMountRoot(root.querySelector("#inner")!)).toBe(false)
  })

  it("treats an unowned element as no boundary", () => {
    const root = html(`<div id="plain">x</div>`)
    expect(isComponentMountRoot(root.querySelector("#plain")!)).toBe(false)
    expect(isAuthoredUnitBoundary(root.querySelector("#plain")!)).toBe(false)
  })

  it("treats any element with its own data-desde-src as a boundary, owned or not", () => {
    const root = html(`<div id="sib" data-desde-src="src/App.vue:9:4">x</div>`)
    // No instance registered — presence-based, not ownership-based, so
    // slotted-in content (owned by a different instance) still stops the walk.
    expect(isAuthoredUnitBoundary(root.querySelector("#sib")!)).toBe(true)
  })
})

// ──────────────── attributeElement ────────────────

describe("attributeElement", () => {
  it("returns undefined when the element has no owning instance", () => {
    const root = html(`<div id="a" data-desde-src="src/App.vue:1:1">x</div>`)
    expect(attributeElement(root.querySelector("#a")!)).toBeUndefined()
  })

  it("parses the element's own stamp into authoredAt/editTarget for a native element", () => {
    const root = html(
      `<div id="host"><p id="native" data-desde-src="src/views/Home.vue:12:6">hi</p></div>`,
    )
    const host = root.querySelector("#host")!
    const inst = register({
      name: "Home",
      file: "src/views/Home.vue",
      // The CONSUMER's callsite for Home lives in a different file — using it
      // as editTarget would make every edit a cross-file write.
      stamp: "src/App.vue:3:2",
      mountRoot: host,
    })
    own(host, inst)
    const native = root.querySelector("#native")!
    own(native, inst)

    const attr = attributeElement(native)
    expect(attr?.authoredAt).toEqual({ file: "src/views/Home.vue", line: 12, column: 6 })
    expect(attr?.editTarget).toMatchObject({
      file: "src/views/Home.vue",
      line: 12,
      column: 6,
    })
    expect(attr?.isLibrary).toBe(false)
  })

  it("prefers the consumer callsite stamp when the element IS the component root", () => {
    const root = html(`<div id="card" data-desde-src="src/App.vue:5:4">x</div>`)
    const card = root.querySelector("#card")!
    const inst = register({
      name: "UiCard",
      file: null,
      stamp: "src/App.vue:5:4",
      mountRoot: card,
    })
    own(card, inst)

    const attr = attributeElement(card)
    expect(attr?.editTarget).toMatchObject({ file: "src/App.vue", line: 5, column: 4 })
  })

  it("ignores a stamp owned by a DIFFERENT instance (slot-wrapper leak guard)", () => {
    // The stamped ancestor belongs to the consumer; the leaf belongs to the
    // library component. Adopting the ancestor's stamp as the leaf's
    // authoredAt is the over-attribution bug the guard exists for.
    const root = html(
      `<div id="wrap" data-desde-src="src/App.vue:7:2"><span id="leaf">Email</span></div>`,
    )
    const consumer = register({ name: "App", file: "src/App.vue", stamp: null })
    const lib = register({ name: "UiLabel", file: null, stamp: null })
    own(root.querySelector("#wrap")!, consumer)
    own(root.querySelector("#leaf")!, lib)

    // No stamp adoptable and no callsite stamp on the library instance ⇒
    // nothing to edit.
    expect(attributeElement(root.querySelector("#leaf")!)).toBeUndefined()
  })

  it("falls back to the consumer callsite when the element's own stamp is in node_modules", () => {
    const root = html(
      `<div id="lib" data-desde-src="node_modules/@acme/design-system/UiCard.vue:2:0">x</div>`,
    )
    const libRoot = root.querySelector("#lib")!
    const inst = register({
      name: "UiCard",
      file: "node_modules/@acme/design-system/UiCard.vue",
      stamp: "src/App.vue:5:4",
      // NOT the mount root, so this exercises the native-element branch's
      // authoredInLibrary fallback rather than the component-root branch.
      mountRoot: null,
    })
    own(libRoot, inst)

    const attr = attributeElement(libRoot)
    expect(attr?.authoredAt.file).toBe("node_modules/@acme/design-system/UiCard.vue")
    expect(attr?.editTarget).toMatchObject({ file: "src/App.vue", line: 5, column: 4 })
    expect(attr?.isLibrary).toBe(false)
  })

  it("flags isLibrary when the resolved edit target is inside node_modules", () => {
    const root = html(
      `<div id="lib" data-desde-src="node_modules/pkg/Thing.vue:2:0">x</div>`,
    )
    const el = root.querySelector("#lib")!
    const inst = register({
      name: "Thing",
      file: "node_modules/pkg/Thing.vue",
      stamp: null,
      mountRoot: el,
    })
    own(el, inst)

    expect(attributeElement(el)?.isLibrary).toBe(true)
  })

  it("resolves a transparent wrapper to the OUTERMOST instance sharing the stamp", () => {
    // MyCard wraps <UiLabel/> as its sole root — both carry App.vue:5:4.
    // The consumer-written prop lives on MyCard, so editableComponent must
    // walk up past UiLabel.
    const root = html(`<div id="el" data-desde-src="src/App.vue:5:4">x</div>`)
    const el = root.querySelector("#el")!
    const outer = register({ name: "MyCard", file: "src/MyCard.vue", stamp: "src/App.vue:5:4" })
    const inner = register({
      name: "UiLabel",
      file: null,
      stamp: "src/App.vue:5:4",
      mountRoot: el,
      parent: outer,
    })
    own(el, inner)

    expect((attributeElement(el)?.editableComponent as unknown as FakeInstance).name).toBe(
      "MyCard",
    )
  })

  it("suppresses instance-derived fields for an adopted static element", () => {
    // Vue's stringifyStatic bulk-inserts a static subtree without per-element
    // `__vueParentComponent`. The stamp is still the element's own (safe), but
    // the instance we recovered by walking up is an ancestor's — so
    // editableComponent / iteration must NOT be reported.
    const root = html(
      `<div id="host"><p id="static" data-desde-src="src/views/Home.vue:12:6">hi</p></div>`,
    )
    const host = root.querySelector("#host")!
    const inst = register({
      name: "Home",
      file: "src/views/Home.vue",
      stamp: "src/App.vue:3:2",
      mountRoot: host,
    })
    own(host, inst)
    // data-owner without the direct pointer = adopted by the ancestor walk.
    own(root.querySelector("#static")!, inst, false)

    const attr = attributeElement(root.querySelector("#static")!)
    expect(attr?.authoredAt).toEqual({ file: "src/views/Home.vue", line: 12, column: 6 })
    expect(attr?.editableComponent).toEqual({})
    expect(attr?.leafVnodeStampRaw).toBeUndefined()
    expect(attr?.iteration).toBeUndefined()
  })

  it("KEEPS instance-derived fields on a substrate that does not use __vueParentComponent", () => {
    // The React regression, in miniature.
    //
    // `hasDirectInstance` used to be `!!el.__vueParentComponent`, read
    // directly in shared code. React never sets that property — it stamps
    // `__reactFiber$<suffix>` — so the check was permanently false on React
    // and every selection came back with `editableComponent: {}`,
    // `leafVnodeStampRaw: undefined`, `iteration: undefined`. Prop and
    // iteration targeting were silently disabled for a framework the adapter
    // fully implements, and nothing failed: the fields were merely empty.
    //
    // This adapter reports the direct pointer by a DIFFERENT mechanism, the
    // way a non-Vue runtime does. If shared code ever reaches for a
    // Vue-specific property again, this test goes red.
    const root = html(`<p id="leaf" data-desde-src="src/App.tsx:8:4">hi</p>`)
    const leaf = root.querySelector("#leaf")!
    const inst = register({
      name: "Card",
      file: "src/Card.tsx",
      stamp: "src/App.tsx:8:4",
      mountRoot: leaf,
      props: { title: "Hello" },
      key: "row-1",
    })
    leaf.setAttribute("data-owner", inst.name)
    // NOT `__vueParentComponent` — a marker only this adapter understands.
    ;(leaf as unknown as Record<string, unknown>).__fakeReactFiber = inst

    configureElementAttribution({
      ...stubAdapter,
      name: "fake-react",
      hasOwnInstancePointer: (el) =>
        !!(el as unknown as Record<string, unknown>).__fakeReactFiber,
    })

    const withPointer = attributeElement(leaf)
    expect(withPointer?.editableComponent, "React selections must not be blanked").not.toEqual({})

    // The other half of the proof: the guard still WORKS on this substrate.
    // Same element, same adapter, only `hasOwnInstancePointer` flipped — so a
    // populated result above cannot be the guard having been disabled.
    configureElementAttribution({
      ...stubAdapter,
      name: "fake-react",
      hasOwnInstancePointer: () => false,
    })
    expect(attributeElement(leaf)?.editableComponent).toEqual({})
  })

  it("pairs editTarget with the file version stamped in the DOM", () => {
    const root = html(
      `<div id="a" data-desde-src="src/App.vue:4:2" data-desde-v="v7">x</div>`,
    )
    const el = root.querySelector("#a")!
    const inst = register({ name: "App", file: "src/App.vue", stamp: null, mountRoot: el })
    own(el, inst)

    expect(attributeElement(el)?.editTarget.fileHash).toBe("v7")
  })
})

// ──────────────── data-desde-own (fallthrough-proof own coordinate) ────────────────

/**
 * Vue applies a single-root child component's inherited attrs to its ROOT
 * vnode LAST, so a parent's `<Child data-desde-src="Parent.vue:11:5">`
 * OVERWRITES the root element's own `data-desde-src`. That is not an edge
 * case — it is every single-root child component in a project. MEASURED on
 * the sakai-vue substrate: `FloatingConfigurator.vue`'s own root `<div>`
 * (its coordinate 9:5) rendered carrying `src/views/pages/auth/Login.vue:11:5`,
 * so a click resolved to a self-closing component tag with nothing editable.
 *
 * The source-tag plugin therefore publishes the root's own coordinate a
 * second time under `data-desde-own` — a name it never writes onto a component
 * tag, so fallthrough cannot reach it. These pin the bridge's half: prefer
 * it, and keep the callsite where it is still the right answer.
 */
describe("attributeElement — data-desde-own beats an inherited data-desde-src", () => {
  /** A child component root polluted by its parent's fallthrough stamp. */
  function pollutedRoot(ownStamp: string) {
    const root = html(
      `<div id="child-root" data-desde-src="src/views/pages/auth/Login.vue:11:5"` +
        ` data-desde-v="parentver" data-desde-own="${ownStamp}">x</div>`,
    )
    const el = root.querySelector("#child-root")!
    const inst = register({
      name: "FloatingConfigurator",
      file: "src/components/FloatingConfigurator.vue",
      // The consumer's `<FloatingConfigurator />` tag — a real callsite, and
      // what the element reported before the rescue stamp existed.
      stamp: "src/views/pages/auth/Login.vue:11:5",
      mountRoot: el,
    })
    own(el, inst)
    return el
  }

  it("resolves a component root to its OWN file, not the parent's callsite", () => {
    const el = pollutedRoot("src/components/FloatingConfigurator.vue:9:5 childver")
    const attr = attributeElement(el)
    expect(attr?.authoredAt).toEqual({
      file: "src/components/FloatingConfigurator.vue",
      line: 9,
      column: 5,
    })
    expect(attr?.editTarget).toMatchObject({
      file: "src/components/FloatingConfigurator.vue",
      line: 9,
      column: 5,
    })
  })

  it("carries the CHILD's file version — the sibling data-desde-v is the parent's", () => {
    // `fileVersionFor` finds nothing for a component whose whole template is
    // one element: that element's data-desde-src names the parent's file. Pairing
    // the child's coordinates with the parent's hash would hand the server's
    // stale-target guard a version for the wrong file.
    const el = pollutedRoot("src/components/FloatingConfigurator.vue:9:5 childver")
    expect(attributeElement(el)?.editTarget.fileHash).toBe("childver")
  })

  it("prefers a data-desde-src-derived version when the DOM has one for that file", () => {
    // The own stamp is the fallback, not the primary: a real `data-desde-src`
    // hit is the same value and covers every file, not just this one.
    const root = html(
      `<div id="child-root" data-desde-src="src/App.vue:11:5" data-desde-v="parentver"` +
        ` data-desde-own="src/Child.vue:2:3 ownver">` +
        `<span data-desde-src="src/Child.vue:3:5" data-desde-v="domver">y</span></div>`,
    )
    const el = root.querySelector("#child-root")!
    const inst = register({
      name: "Child",
      file: "src/Child.vue",
      stamp: "src/App.vue:11:5",
      mountRoot: el,
    })
    own(el, inst)
    expect(attributeElement(el)?.editTarget.fileHash).toBe("domver")
  })

  it("accepts a bare loc with no version (older plugin) instead of failing to parse", () => {
    const el = pollutedRoot("src/components/FloatingConfigurator.vue:9:5")
    const attr = attributeElement(el)
    expect(attr?.editTarget).toMatchObject({ line: 9, column: 5 })
    expect(attr?.editTarget.fileHash).toBeUndefined()
  })

  it("splits the value on the LAST space so a path with spaces survives", () => {
    const el = pollutedRoot("src/ui drafts/Card.vue:9:5 childver")
    expect(attributeElement(el)?.authoredAt).toEqual({
      file: "src/ui drafts/Card.vue",
      line: 9,
      column: 5,
    })
  })

  it("falls back to the inherited data-desde-src when the own stamp is unparseable", () => {
    const el = pollutedRoot("not-a-loc")
    expect(attributeElement(el)?.editTarget).toMatchObject({
      file: "src/views/pages/auth/Login.vue",
      line: 11,
      column: 5,
    })
  })

  it("still prefers the callsite for a LIBRARY root — node_modules isn't editable", () => {
    // A library component's root never carries data-desde-own (the plugin skips
    // node_modules), but if a vendored/copied one ever did, the existing
    // node_modules rule must still win.
    const root = html(
      `<div id="lib" data-desde-src="src/App.vue:5:4"` +
        ` data-desde-own="node_modules/pkg/Thing.vue:2:0 v1">x</div>`,
    )
    const el = root.querySelector("#lib")!
    const inst = register({
      name: "Thing",
      file: "node_modules/pkg/Thing.vue",
      stamp: "src/App.vue:5:4",
      mountRoot: el,
    })
    own(el, inst)
    const attr = attributeElement(el)
    expect(attr?.editTarget).toMatchObject({ file: "src/App.vue", line: 5, column: 4 })
    expect(attr?.isLibrary).toBe(false)
  })

  it("leaves a NON-root element alone — an ancestor's own stamp is not its own", () => {
    // The rescue only re-points the element that carries the stamp. A
    // descendant keeps resolving through the normal walk.
    const root = html(
      `<div id="child-root" data-desde-src="src/App.vue:11:5"` +
        ` data-desde-own="src/Child.vue:2:3 ownver">` +
        `<span id="inner" data-desde-src="src/Child.vue:3:5">y</span></div>`,
    )
    const el = root.querySelector("#child-root")!
    const inner = root.querySelector("#inner")!
    const inst = register({
      name: "Child",
      file: "src/Child.vue",
      stamp: "src/App.vue:11:5",
      mountRoot: el,
    })
    own(el, inst)
    own(inner, inst)
    expect(attributeElement(inner)?.editTarget).toMatchObject({
      file: "src/Child.vue",
      line: 3,
      column: 5,
    })
  })

  it("keeps the cross-instance guard — a foreign own stamp is not adopted", () => {
    // Same slot-wrapper leak the data-desde-src walk guards against: the stamped
    // ancestor belongs to the consumer, the leaf to a library component.
    const root = html(
      `<div id="wrap" data-desde-src="src/App.vue:7:2" data-desde-own="src/App.vue:7:2 v1">` +
        `<span id="leaf">Email</span></div>`,
    )
    const consumer = register({ name: "App", file: "src/App.vue", stamp: null })
    const lib = register({ name: "UiLabel", file: null, stamp: null })
    own(root.querySelector("#wrap")!, consumer)
    own(root.querySelector("#leaf")!, lib)
    expect(attributeElement(root.querySelector("#leaf")!)).toBeUndefined()
  })

  it("is a no-op where nothing was overwritten (own stamp == src stamp)", () => {
    // The unpolluted case: the plugin emits both from the same AST node, so
    // preferring data-desde-own changes nothing.
    const root = html(
      `<div id="a" data-desde-src="src/App.vue:4:2" data-desde-v="v7"` +
        ` data-desde-own="src/App.vue:4:2 v7">x</div>`,
    )
    const el = root.querySelector("#a")!
    const inst = register({ name: "App", file: "src/App.vue", stamp: null, mountRoot: el })
    own(el, inst)
    const attr = attributeElement(el)
    expect(attr?.editTarget).toMatchObject({ file: "src/App.vue", line: 4, column: 2 })
    expect(attr?.editTarget.fileHash).toBe("v7")
  })
})

// ──────────────── domAnchor (CSS rule anchor) ────────────────

/**
 * `domAnchor` is the coordinate a `[data-desde-src="…"]` CSS rule may be
 * anchored on. It is a DIFFERENT question from `authoredAt` — "which
 * attribute value is literally in this document?" rather than "where do this
 * element's bytes live?" — and the two answers diverge on every single-root
 * child component, because Vue's fallthrough overwrites the root's own
 * `data-desde-src` with the parent's callsite (see the describe above).
 *
 * The scoped-css-override lane read `authoredAt`, so on a rescued root it
 * emitted a rule head naming the rescue stamp — a coordinate carried by NO
 * element — and reported success. Measured end to end in
 * `tasks/dev-server-hosts.md` § 9g.8.
 *
 * The fixtures below mirror that measurement's DOM exactly.
 */
describe("attributeElement — domAnchor", () => {
  /** The § 9g.8 fixture: two `<Plain/>` instances, each a rescued root. */
  function twoRescuedRoots(): { first: Element; second: Element } {
    const root = html(
      `<div id="app" data-desde-src="src/App.vue:1:1" data-desde-v="appver">` +
        `<div id="p1" class="plain-root" data-desde-src="src/App.vue:14:7"` +
        ` data-desde-v="appver" data-desde-own="src/Plain.vue:2:3 plainver">a</div>` +
        `<div id="p2" class="plain-root" data-desde-src="src/App.vue:17:7"` +
        ` data-desde-v="appver" data-desde-own="src/Plain.vue:2:3 plainver">b</div>` +
        `</div>`,
    )
    const first = root.querySelector("#p1")!
    const second = root.querySelector("#p2")!
    own(
      first,
      register({
        name: "Plain#1",
        file: "src/Plain.vue",
        stamp: "src/App.vue:14:7",
        mountRoot: first,
      }),
    )
    own(
      second,
      register({
        name: "Plain#2",
        file: "src/Plain.vue",
        stamp: "src/App.vue:17:7",
        mountRoot: second,
      }),
    )
    return { first, second }
  }

  it("reports the literal data-desde-src on a rescued root, not the rescue stamp", () => {
    const { first } = twoRescuedRoots()
    const attr = attributeElement(first)
    // The measured defect: `authoredAt` names a coordinate no element carries.
    expect(attr?.authoredAt).toEqual({
      file: "src/Plain.vue",
      line: 2,
      column: 3,
    })
    expect(
      document.querySelectorAll(`[data-desde-src="src/Plain.vue:2:3"]`),
    ).toHaveLength(0)
    // …and what a CSS rule must be anchored on instead.
    expect(attr?.domAnchor).toEqual({
      file: "src/App.vue",
      line: 14,
      column: 7,
      matchCount: 1,
      resolution: "direct",
    })
  })

  it("keeps two instances of the same component distinct", () => {
    // Per-callsite precision: `authoredAt` collapses both onto the component
    // definition, so one rule head served two elements and the second edit
    // overwrote the first (§ 9g.8 blast-radius note).
    const { first, second } = twoRescuedRoots()
    expect(attributeElement(first)?.domAnchor).toMatchObject({ line: 14 })
    expect(attributeElement(second)?.domAnchor).toMatchObject({ line: 17 })
  })

  it("walks up to the nearest stamped ancestor for an unstamped element", () => {
    // The `:deep()` case: a v-html subtree (or any markup the stamper never
    // walked) inside a component whose root is rescued.
    const root = html(
      `<div id="host" data-desde-src="src/App.vue:23:7" data-desde-v="appver"` +
        ` data-desde-own="src/HtmlRoot.vue:6:3 htmlver">` +
        `<b id="inner" class="pt-probe">deep</b></div>`,
    )
    const host = root.querySelector("#host")!
    const inner = root.querySelector("#inner")!
    const inst = register({
      name: "HtmlRoot",
      file: "src/HtmlRoot.vue",
      stamp: "src/App.vue:23:7",
      mountRoot: host,
    })
    own(host, inst)
    own(inner, inst)
    expect(attributeElement(inner)?.domAnchor).toEqual({
      file: "src/App.vue",
      line: 23,
      column: 7,
      matchCount: 1,
      resolution: "ancestor",
    })
  })

  it("counts every element sharing the anchor so a v-for rule can say N", () => {
    const root = html(
      `<ul data-desde-src="src/App.vue:5:3" data-desde-v="v1">` +
        `<li id="r1" data-desde-src="src/App.vue:6:5" data-desde-v="v1">a</li>` +
        `<li id="r2" data-desde-src="src/App.vue:6:5" data-desde-v="v1">b</li>` +
        `<li id="r3" data-desde-src="src/App.vue:6:5" data-desde-v="v1">c</li>` +
        `</ul>`,
    )
    const row = root.querySelector("#r1")!
    const inst = register({ name: "App", file: "src/App.vue", stamp: null })
    own(row, inst)
    expect(attributeElement(row)?.domAnchor?.matchCount).toBe(3)
  })

  it("is absent when nothing in the ancestry carries a data-desde-src", () => {
    const root = html(`<div id="bare"><span id="leaf">x</span></div>`)
    const leaf = root.querySelector("#leaf")!
    const inst = register({
      name: "App",
      file: "src/App.vue",
      stamp: "src/main.ts:3:1",
    })
    own(leaf, inst)
    expect(attributeElement(leaf)?.domAnchor).toBeUndefined()
  })
})

// ──────────────── computeCallsiteLocation ────────────────

describe("computeCallsiteLocation", () => {
  it("returns undefined without an authoredAt", () => {
    const root = html(`<div id="a" data-desde-src="src/App.vue:1:1">x</div>`)
    expect(computeCallsiteLocation(root.querySelector("#a")!, undefined)).toBeUndefined()
  })

  it("filters out a same-file callsite (not a distinct call site)", () => {
    const root = html(`<div id="a" data-desde-src="src/App.vue:4:2">x</div>`)
    const el = root.querySelector("#a")!
    const inst = register({ name: "App", file: "src/App.vue", stamp: null, mountRoot: el })
    own(el, inst)

    expect(
      computeCallsiteLocation(el, { file: "src/App.vue", line: 4, column: 2 }),
    ).toBeUndefined()
  })

  it("returns the consumer's tag position for a cross-file callsite", () => {
    const root = html(`<div id="card" data-desde-src="src/App.vue:5:4">x</div>`)
    const el = root.querySelector("#card")!
    const inst = register({
      name: "UiCard",
      file: null,
      stamp: "src/App.vue:5:4",
      mountRoot: el,
    })
    own(el, inst)

    expect(
      computeCallsiteLocation(el, { file: "src/MyCard.vue", line: 1, column: 0 }),
    ).toMatchObject({ file: "src/App.vue", line: 5, column: 4 })
  })
})

// ──────────────── computeIterationContext ────────────────

describe("computeIterationContext", () => {
  it("groups DOM siblings sharing one stamp into a v-for iteration", () => {
    const root = html(`
      <ul id="host">
        <li id="r0" data-desde-src="src/App.vue:8:6">a</li>
        <li id="r1" data-desde-src="src/App.vue:8:6">b</li>
        <li id="r2" data-desde-src="src/App.vue:8:6">c</li>
      </ul>
    `)
    const host = root.querySelector("#host")!
    const inst = register({ name: "App", file: "src/App.vue", stamp: null, mountRoot: host })
    own(host, inst)
    for (const id of ["#r0", "#r1", "#r2"]) own(root.querySelector(id)!, inst)

    const it1 = computeIterationContext(root.querySelector("#r1")!)
    expect(it1).toMatchObject({ source: "v-for", index: 1, siblingCount: 3, expression: null })
  })

  it("reports no iteration for a unique stamp", () => {
    const root = html(`<div id="host"><p id="only" data-desde-src="src/App.vue:8:6">a</p></div>`)
    const host = root.querySelector("#host")!
    const inst = register({ name: "App", file: "src/App.vue", stamp: null, mountRoot: host })
    own(host, inst)
    own(root.querySelector("#only")!, inst)

    expect(computeIterationContext(root.querySelector("#only")!)).toBeUndefined()
  })

  it("prefers the per-instance key over the positional index", () => {
    const root = html(`
      <ul id="host">
        <li id="r0" data-desde-src="src/App.vue:8:6">a</li>
        <li id="r1" data-desde-src="src/App.vue:8:6">b</li>
      </ul>
    `)
    const host = root.querySelector("#host")!
    const app = register({ name: "App", file: "src/App.vue", stamp: null, mountRoot: host })
    own(host, app)
    const r1 = root.querySelector("#r1")!
    // The row instance's callsite stamp matches the row's stamp, so its
    // framework-recorded key is the iteration key.
    const rowInst = register({
      name: "Row1",
      file: "src/Row.vue",
      stamp: "src/App.vue:8:6",
      mountRoot: r1,
      key: "user-42",
      parent: app,
    })
    own(root.querySelector("#r0")!, app)
    own(r1, rowInst)

    expect(computeIterationContext(r1)).toMatchObject({ key: "user-42", index: 1, siblingCount: 2 })
  })
})

// ──────────────── findSlotTextLeaves ────────────────

describe("findSlotTextLeaves", () => {
  it("omits textNodeIndex for a pure text leaf", () => {
    const root = html(`<div id="host"><span id="s">Default ACL</span></div>`)
    const leaves = findSlotTextLeaves(root.querySelector("#host")!)
    const leaf = leaves.find((l) => l.text === "Default ACL")
    expect(leaf).toBeDefined()
    expect(leaf!.textNodeIndex).toBeUndefined()
  })

  it("sets textNodeIndex when the text has element siblings", () => {
    const root = html(`<label id="l">Default ACL<i id="tip"></i></label>`)
    const leaves = findSlotTextLeaves(root.querySelector("#l")!)
    const leaf = leaves.find((l) => l.text === "Default ACL")
    expect(leaf?.textNodeIndex).toBe(0)
  })

  it("skips whitespace-only text nodes", () => {
    const root = html(`<div id="host">   <span id="s">Real</span></div>`)
    const texts = findSlotTextLeaves(root.querySelector("#host")!).map((l) => l.text)
    expect(texts).toEqual(["Real"])
  })

  it("stops descending at a child that begins a different authored unit", () => {
    const root = html(
      `<div id="host">Mine<section id="other" data-desde-src="src/App.vue:20:2">Theirs</section></div>`,
    )
    const texts = findSlotTextLeaves(root.querySelector("#host")!).map((l) => l.text)
    expect(texts).toContain("Mine")
    expect(texts).not.toContain("Theirs")
  })

  it("still descends into a selected library component's own render tree", () => {
    // Library-internal DOM is never stamped and is not a mount root, so the
    // walk must reach the prop-rendered text inside it.
    const root = html(
      `<div id="host" data-desde-src="src/App.vue:5:4"><div class="ui-card-title"><span>Policy</span></div></div>`,
    )
    const texts = findSlotTextLeaves(root.querySelector("#host")!).map((l) => l.text)
    expect(texts).toContain("Policy")
  })

  it("never returns script/style content", () => {
    const root = html(`<div id="host"><style id="st">.a{color:red}</style><b>Keep</b></div>`)
    const texts = findSlotTextLeaves(root.querySelector("#host")!).map((l) => l.text)
    expect(texts).toEqual(["Keep"])
  })
})

// ──────────────── findEditableTextFields ────────────────

describe("findEditableTextFields", () => {
  it("emits the dom-text field first when a leaf text value is supplied", () => {
    const root = html(`<div id="host" data-desde-src="src/App.vue:5:4">Hello</div>`)
    const el = root.querySelector("#host")!
    const inst = register({ name: "App", file: "src/App.vue", stamp: null, mountRoot: el })
    own(el, inst)

    const fields = findEditableTextFields(el, "Hello")
    expect(fields[0]).toMatchObject({ id: "dom-text", kind: "dom-text", label: "Text" })
  })

  it("returns only the dom-text field when the element has no attribution", () => {
    const root = html(`<div id="host">Hello</div>`)
    // No owner registered ⇒ attributeElement returns undefined and the walk
    // is skipped entirely.
    const fields = findEditableTextFields(root.querySelector("#host")!, "Hello")
    expect(fields).toHaveLength(1)
    expect(fields[0].id).toBe("dom-text")
  })

  it("labels multiple slot-text leaves distinctly and dedupes the dom-text value", () => {
    const root = html(
      `<div id="host" data-desde-src="src/App.vue:5:4"><span>Alpha</span><span>Beta</span></div>`,
    )
    const el = root.querySelector("#host")!
    const inst = register({ name: "App", file: "src/App.vue", stamp: null, mountRoot: el })
    own(el, inst)

    const fields = findEditableTextFields(el, null)
    const labels = fields.map((f) => f.label)
    expect(labels).toEqual(["Text (1)", "Text (2)"])
    expect(fields.every((f) => f.kind === "dom-text")).toBe(true)
    expect(fields.map((f) => f.value)).toEqual(["Alpha", "Beta"])
  })

  it("surfaces a named-prop field for library-rendered slot text, targeting the consumer callsite", () => {
    // UiLabel renders `label="Email"` as <span>Email</span>. The rendered
    // text isn't editable where it appears — the edit has to land on the
    // consumer's `<UiLabel label="…">` tag, which is what `editTarget`
    // carries. (`domTextValue` is null here because the host has an element
    // child, matching what `inspectElement`'s leaf-text probe would pass.)
    const root = html(
      `<div id="host" data-desde-src="src/App.vue:5:4"><span id="leaf">Email</span></div>`,
    )
    const host = root.querySelector("#host")!
    const app = register({ name: "App", file: "src/App.vue", stamp: null, mountRoot: host })
    own(host, app)
    const kLabel = register({
      name: "UiLabel",
      file: null, // library ⇒ isLibraryInstance
      stamp: "src/App.vue:5:4",
      props: { label: "Email" },
    })
    own(root.querySelector("#leaf")!, kLabel)

    const fields = findEditableTextFields(host, null)
    const propField = fields.find((f) => f.kind === "prop")
    expect(propField).toMatchObject({
      propName: "label",
      label: "label",
      value: "Email",
      valueType: "string",
    })
    expect(propField!.editTarget).toMatchObject({ file: "src/App.vue", line: 5, column: 4 })
    // Prop wins: no raw slot-text entry for the same string alongside it.
    expect(fields.filter((f) => f.value === "Email")).toHaveLength(1)
  })

  it("keeps the slot-text lane when the leaf's text matches no single prop", () => {
    const root = html(
      `<div id="host" data-desde-src="src/App.vue:5:4"><span id="leaf">Email</span></div>`,
    )
    const host = root.querySelector("#host")!
    const app = register({ name: "App", file: "src/App.vue", stamp: null, mountRoot: host })
    own(host, app)
    // Two props carry the same value ⇒ ambiguous ⇒ the prop lane refuses and
    // the leaf falls back to a dom-text slot entry.
    const kLabel = register({
      name: "UiLabel",
      file: null,
      stamp: "src/App.vue:5:4",
      props: { label: "Email", tooltip: "Email" },
    })
    own(root.querySelector("#leaf")!, kLabel)

    const fields = findEditableTextFields(host, null)
    expect(fields.every((f) => f.kind === "dom-text")).toBe(true)
    expect(fields[0]).toMatchObject({ label: "Text", value: "Email" })
    expect(fields[0].selector).toBeTruthy()
  })
})
