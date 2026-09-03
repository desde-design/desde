// @vitest-environment jsdom
/**
 * `findOutermostInstanceRootedAt` is a pure walk over instance-shaped
 * objects (`parent`, `subTree.el`), so unlike the rest of the detection
 * module it needs no live Vue runtime to test — fabricated chains pin the
 * contract the F-08 review asked to see proven rather than argued:
 * which instance the walk names for each of the shapes the fix's doc
 * comment claims (direct use / wrapper chain / plain markup), and that the
 * `owner` break can never null out a library-root click (the reviewed
 * candidate A2), because a library element's owner is always first-party
 * and therefore never the innermost instance at a library root.
 */
import { describe, it, expect } from "vitest"
import {
  buildReactComponentTree,
  detectOutlineComponent,
  detectReactOutlineComponent,
  findOutermostInstanceRootedAt,
  getReactComponentMountRoot,
} from "./framework-component-detection"
import { generateSelector } from "./selector-engine"

type FakeInstance = {
  parent: FakeInstance | null
  subTree: { el: Element | null }
  type: { __name: string }
}

function instance(name: string, rootEl: Element | null, parent: FakeInstance | null): FakeInstance {
  return { parent, subTree: { el: rootEl }, type: { __name: name } }
}

function attach(el: Element, inst: FakeInstance): Element {
  ;(el as unknown as Record<string, unknown>).__vueParentComponent = inst
  return el
}

describe("findOutermostInstanceRootedAt", () => {
  it("wrapper chain, stamp owned by the wrapper: names the callsite component the wrapper's template wrote (KDropdown), not the wrapper", () => {
    // The measured F-08 shape: ProtoAIGatewayActionMenu's template root is
    // <KDropdown>, so menu.subTree.el === KDropdown's root div.
    const div = document.createElement("div")
    const details = instance("AIGatewayDetails", document.createElement("main"), null)
    const menu = instance("ProtoAIGatewayActionMenu", div, details)
    const kDropdown = instance("KDropdown", div, menu)
    attach(div, kDropdown)

    const found = findOutermostInstanceRootedAt(div, menu as unknown as Record<string, unknown>)
    expect((found as FakeInstance | null)?.type.__name).toBe("KDropdown")
  })

  it("wrapper chain, stamp owned by the outer page (fallthrough): names the outermost non-owner rooted there (the wrapper itself)", () => {
    const div = document.createElement("div")
    const details = instance("AIGatewayDetails", document.createElement("main"), null)
    const menu = instance("ProtoAIGatewayActionMenu", div, details)
    const kDropdown = instance("KDropdown", div, menu)
    attach(div, kDropdown)

    const found = findOutermostInstanceRootedAt(div, details as unknown as Record<string, unknown>)
    expect((found as FakeInstance | null)?.type.__name).toBe("ProtoAIGatewayActionMenu")
  })

  it("direct use: a library component's own root names that component", () => {
    const button = document.createElement("button")
    const shell = instance("AIGatewayListShell", document.createElement("div"), null)
    const kButton = instance("KButton", button, shell)
    attach(button, kButton)

    const found = findOutermostInstanceRootedAt(button, shell as unknown as Record<string, unknown>)
    expect((found as FakeInstance | null)?.type.__name).toBe("KButton")
  })

  it("plain markup in the owner's own template: no instance is rooted at the node, so the walk returns null", () => {
    // An <h2> inside AppAboutSection: the innermost instance owning the node
    // IS the owner, so the walk breaks before recording anything.
    const h2 = document.createElement("h2")
    const section = instance("AppAboutSection", document.createElement("section"), null)
    attach(h2, section)

    const found = findOutermostInstanceRootedAt(h2, section as unknown as Record<string, unknown>)
    expect(found).toBeNull()
  })

  it("a first-party component's own root with an own-stamp owner degrades to null (the caller's tree-leaf fallback decides, unchanged)", () => {
    const root = document.createElement("div")
    const switcher = instance("StateSwitcher", root, null)
    attach(root, switcher)

    const found = findOutermostInstanceRootedAt(root, switcher as unknown as Record<string, unknown>)
    expect(found).toBeNull()
  })

  it("no Vue runtime on the element (React fiber, plain DOM): null", () => {
    const el = document.createElement("div")
    expect(findOutermostInstanceRootedAt(el, null)).toBeNull()
  })

  it("a null owner does not break the walk: the outermost instance rooted at the node still wins", () => {
    const div = document.createElement("div")
    const wrapper = instance("Wrapper", div, null)
    const inner = instance("KCard", div, wrapper)
    attach(div, inner)

    const found = findOutermostInstanceRootedAt(div, null)
    expect((found as FakeInstance | null)?.type.__name).toBe("Wrapper")
  })
})

/**
 * React mount roots are the same kind of pure walk, over fiber-shaped
 * objects (`tag`, `child`, `sibling`, `return`, `stateNode`), so fabricated
 * fibers pin the contract without a React runtime. The shape is the
 * Northwind demo's Overview page as React 19 lays it out — a host fiber
 * per element, a component fiber above its mount root, and a HostRoot at
 * the top — because that is the page on which the defect was measured:
 * `buildReactComponentTree` reported `elementSelector: ""` for every
 * component, so the shell demoted a click on `Button`'s root to a plain
 * `<a>` and the Structure panel showed nothing but tag names.
 */
type FakeFiber = {
  tag: number
  type?: unknown
  stateNode?: unknown
  child?: FakeFiber | null
  sibling?: FakeFiber | null
  return?: FakeFiber | null
  memoizedProps?: Record<string, unknown>
}

function hostFiber(el: Element): FakeFiber {
  const fiber: FakeFiber = { tag: 5, type: el.tagName.toLowerCase(), stateNode: el, child: null, sibling: null, return: null }
  ;(el as unknown as Record<string, unknown>).__reactFiber$test = fiber
  return fiber
}

function componentFiber(name: string, props: Record<string, unknown> = {}): FakeFiber {
  // A computed key gives the function a real `.name`, which is all React
  // exposes for a plain function component.
  const fn = { [name]: function () {} }[name]
  return { tag: 0, type: fn, stateNode: null, child: null, sibling: null, return: null, memoizedProps: props }
}

/** Parent → first child. Returns the child so chains read top-down. */
function under(parent: FakeFiber, child: FakeFiber): FakeFiber {
  parent.child = child
  child.return = parent
  return child
}

function el(tag: string, className?: string): Element {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

describe("React mount roots", () => {
  // body > div#app > main > section > div.actions > a.button > span
  // HostRoot > App(div#app) > main > Overview(section) > div > Button(a) > span
  function northwind() {
    const app = el("div"); app.id = "app"
    const main = el("main"); const section = el("section"); const actions = el("div", "actions")
    const a = el("a", "button"); const span = el("span")
    document.body.replaceChildren(app); app.append(main); main.append(section); section.append(actions); actions.append(a); a.append(span)

    const root: FakeFiber = { tag: 3, type: null, stateNode: null, child: null, sibling: null, return: null }
    const App = under(root, componentFiber("App"))
    const hostMain = under(under(App, hostFiber(app)), hostFiber(main))
    const Overview = under(hostMain, componentFiber("Overview", { navigate: () => {} }))
    const hostActions = under(under(Overview, hostFiber(section)), hostFiber(actions))
    const Button = under(hostActions, componentFiber("Button", { variant: "secondary", href: "/workspaces", children: "View all" }))
    under(under(Button, hostFiber(a)), hostFiber(span))
    return { app, section, actions, a, span, App, Overview, Button }
  }

  it("a component's mount root is the first host element in its subtree, not its (null) stateNode", () => {
    const t = northwind()
    expect(getReactComponentMountRoot(t.Button)).toBe(t.a)
    expect(getReactComponentMountRoot(t.Overview)).toBe(t.section)
    expect(getReactComponentMountRoot(t.App)).toBe(t.app)
  })

  it("buildReactComponentTree: every node carries its mount root's selector, root-first", () => {
    const t = northwind()
    const tree = buildReactComponentTree(t.a)
    expect(tree.map((n) => n.name)).toEqual(["App", "Overview", "Button"])
    const selectors = tree.map((n) => n.elementSelector)
    expect(selectors).toEqual([generateSelector(t.app), generateSelector(t.section), generateSelector(t.a)])
    for (const s of selectors) expect(s).not.toBe("")
    // The shell's component-vs-element test is selector equality with the
    // clicked element, so the leaf's selector must be the clicked root's.
    expect(tree[2].elementSelector).toBe(generateSelector(t.a))
    expect(tree[2].props).toEqual({ variant: "secondary", href: "/workspaces" })
  })

  it("detectOutlineComponent labels a mount root with its component and leaves inner markup as an element", () => {
    const t = northwind()
    expect(detectOutlineComponent(t.a)).toMatchObject({ framework: "react", name: "Button", props: { variant: "secondary" } })
    expect(detectOutlineComponent(t.section)?.name).toBe("Overview")
    expect(detectOutlineComponent(t.app)?.name).toBe("App")
    // Inside Button, and the div Overview renders around it: elements.
    expect(detectOutlineComponent(t.span)).toBeNull()
    expect(detectOutlineComponent(t.actions)).toBeNull()
  })

  it("transparent wrappers: the outermost component rooted at the element wins", () => {
    // Card renders <Panel/>, Panel renders <div>: both mount as the div.
    const div = el("div", "panel"); document.body.replaceChildren(div)
    const Card = componentFiber("Card")
    const Panel = under(Card, componentFiber("Panel"))
    under(Panel, hostFiber(div))
    expect(detectReactOutlineComponent(div)?.name).toBe("Card")
  })

  it("a parent whose first host is a sibling element is not rooted here, and neither is anything above it", () => {
    // Page renders <><span/><Child/></>, Child renders <a>. Page's mount
    // root is the span, so a click on the <a> is Child's alone.
    const span = el("span"); const a = el("a"); document.body.replaceChildren(span, a)
    const Layout = componentFiber("Layout")
    const Page = under(Layout, componentFiber("Page"))
    const hostSpan = under(Page, hostFiber(span))
    const Child = componentFiber("Child"); hostSpan.sibling = Child; Child.return = Page
    under(Child, hostFiber(a))
    expect(getReactComponentMountRoot(Page)).toBe(span)
    expect(detectReactOutlineComponent(a)?.name).toBe("Child")
    expect(detectReactOutlineComponent(span)?.name).toBe("Layout")
  })

  it("internal and anonymous wrappers are skipped, not reported", () => {
    const div = el("div"); document.body.replaceChildren(div)
    const Named = componentFiber("Named")
    const fragment = under(Named, componentFiber("Fragment"))
    const anonymous: FakeFiber = { tag: 0, type: function () {}, stateNode: null, child: null, sibling: null, return: null }
    under(fragment, anonymous)
    under(anonymous, hostFiber(div))
    expect(detectReactOutlineComponent(div)?.name).toBe("Named")
  })
})
