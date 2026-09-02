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
import { findOutermostInstanceRootedAt } from "./framework-component-detection"

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
