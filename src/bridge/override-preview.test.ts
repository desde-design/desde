/**
 * Colocated unit tests for the class-override preview's *stamp record* — the
 * `stampedProperties` set behind `isPreviewStampedProperty`, which is what fills
 * `StyleOrigin.inline.fromPreview` (`src/bridge/style-provenance.ts`).
 *
 * Why this seam needs jsdom coverage at all: it is a positive OWNERSHIP claim
 * ("this exact inline declaration is editor's shim, not the prototype's"), and
 * Phase 2 will let `excludePreviewInline` act on it. A record that over-claims
 * therefore strips an authored declaration from the scope gate — strictly worse
 * than the property-name guess it replaces. The browser harness
 * (`tasks/scripts/style-provenance-smoke.mts` §5) only exercises the happy path;
 * every rejection branch below is ungated without these.
 *
 * No fakes needed, contrary to the Phase 1 report's claim: the
 * `preResolvedDeclarations` branch of `applyClassOverride` never touches
 * `document.styleSheets`, and `sendToShell` defaults to a no-op
 * (`bridge-runtime.ts`), so `createOverridePreview()` is directly constructible.
 *
 * jsdom fidelity note. jsdom's cssstyle records the `!important` PRIORITY even
 * for a value it rejects (Chromium leaves the priority alone), so the one
 * scenario jsdom cannot express is "the author already declared this property
 * inline at normal weight and our stamp for it is rejected" — there the value
 * check below is satisfied by the author's value and jsdom's spurious priority
 * passes the second check. That exact scenario is gated in Chromium instead, by
 * `style-provenance-smoke.mts` §5. Everything here holds in both engines.
 */

import { afterEach, describe, expect, it } from "vitest"
import { createOverridePreview } from "./override-preview"
import { configureBridgeRuntime } from "./bridge-runtime"

function el(inlineStyle = ""): HTMLElement {
  const node = document.createElement("div")
  if (inlineStyle) node.setAttribute("style", inlineStyle)
  document.body.appendChild(node)
  return node
}

/** Capture what the bridge posts to the shell for one test. */
function captureSends(): Record<string, unknown>[] {
  const sent: Record<string, unknown>[] = []
  configureBridgeRuntime({
    sendToShell: (message) => {
      sent.push(message)
    },
    inspectElement: () => ({}),
    attributeElement: () => undefined,
  })
  return sent
}

afterEach(() => {
  // `sendToShell` is a live module binding — leaving a test's capture installed
  // would have later suites pushing into a dead array.
  configureBridgeRuntime({
    sendToShell: () => {},
    inspectElement: () => ({}),
    attributeElement: () => undefined,
  })
  document.body.innerHTML = ""
})

describe("override-preview — preview stamp record", () => {
  it("records a declaration the engine accepted", () => {
    const preview = createOverridePreview()
    const node = el()

    preview.applyClassOverride(node, ["bg-blue-500"], {
      "background-color": "#3b82f6",
    })

    expect(preview.isPreviewStampedProperty(node, "background-color")).toBe(true)
    // …and the stamp really landed, at `!important`.
    expect(node.style.getPropertyPriority("background-color")).toBe("important")
  })

  it("does NOT record a value the engine rejected", () => {
    const preview = createOverridePreview()
    const node = el()

    preview.applyClassOverride(node, ["bogus"], {
      "background-color": "not-a-color",
    })

    // The declaration never landed, so nothing on the element for this property
    // is ours. A `try/catch` around setProperty cannot tell — setProperty does
    // not throw here, it silently no-ops.
    expect(node.style.getPropertyValue("background-color")).toBe("")
    expect(preview.isPreviewStampedProperty(node, "background-color")).toBe(false)
  })

  it("does NOT record a camelCase property name", () => {
    const preview = createOverridePreview()
    const node = el()

    preview.applyClassOverride(node, ["bogus"], { backgroundColor: "blue" })

    expect(node.style.getPropertyValue("background-color")).toBe("")
    expect(preview.isPreviewStampedProperty(node, "backgroundColor")).toBe(false)
    expect(preview.isPreviewStampedProperty(node, "background-color")).toBe(false)
  })

  it("does NOT record an unknown property", () => {
    const preview = createOverridePreview()
    const node = el()

    preview.applyClassOverride(node, ["bogus"], { "totally-bogus-prop": "blue" })

    expect(preview.isPreviewStampedProperty(node, "totally-bogus-prop")).toBe(false)
  })

  it("records only the accepted half of a mixed batch", () => {
    const preview = createOverridePreview()
    const node = el()

    preview.applyClassOverride(node, ["mixed"], {
      color: "rgb(1, 2, 3)",
      "totally-bogus-prop": "blue",
    })

    expect(preview.isPreviewStampedProperty(node, "color")).toBe(true)
    expect(preview.isPreviewStampedProperty(node, "totally-bogus-prop")).toBe(false)
  })

  it("clears the prior record in lockstep with the cssText reset on re-stamp", () => {
    const preview = createOverridePreview()
    const node = el()

    preview.applyClassOverride(node, ["a"], { color: "rgb(1, 2, 3)" })
    expect(preview.isPreviewStampedProperty(node, "color")).toBe(true)

    // Second edit drops `color` and adds `border-width`. applyClassOverride
    // resets cssText to the snapshot, which wipes the previous stamp off the
    // element — the record has to be wiped with it, or `color` would keep
    // reporting fromPreview while nothing of ours is on the element.
    preview.applyClassOverride(node, ["b"], { "border-width": "1px" })
    expect(node.style.getPropertyValue("color")).toBe("")
    expect(preview.isPreviewStampedProperty(node, "color")).toBe(false)
    expect(preview.isPreviewStampedProperty(node, "border-width")).toBe(true)
  })

  it("drops the record on clearClassOverrideFor", () => {
    const preview = createOverridePreview()
    const node = el()

    preview.applyClassOverride(node, ["a"], { color: "rgb(1, 2, 3)" })
    preview.clearClassOverrideFor(node)

    expect(preview.isPreviewStampedProperty(node, "color")).toBe(false)
    expect(node.getAttribute("style")).toBeNull()
  })

  it("drops the record on releaseClassStyleSnapshot", () => {
    const preview = createOverridePreview()
    const node = el("color: rgb(9, 9, 9)")

    preview.applyClassOverride(node, ["a"], { color: "rgb(1, 2, 3)" })
    expect(preview.isPreviewStampedProperty(node, "color")).toBe(true)

    preview.releaseClassStyleSnapshot(node)

    // The author's own declaration is back, and it must NOT be claimed as ours —
    // a stale `fromPreview: true` over a re-authored declaration is worse than
    // the guess the flag replaces.
    expect(node.style.getPropertyValue("color")).toBe("rgb(9, 9, 9)")
    expect(preview.isPreviewStampedProperty(node, "color")).toBe(false)
  })

  it("is per-element, not global", () => {
    const preview = createOverridePreview()
    const stamped = el()
    const untouched = el("color: rgb(9, 9, 9)")

    preview.applyClassOverride(stamped, ["a"], { color: "rgb(1, 2, 3)" })

    expect(preview.isPreviewStampedProperty(stamped, "color")).toBe(true)
    expect(preview.isPreviewStampedProperty(untouched, "color")).toBe(false)
  })

  it("matches ordinary property names case-insensitively", () => {
    const preview = createOverridePreview()
    const node = el()

    preview.applyClassOverride(node, ["a"], { "Background-Color": "#3b82f6" })

    expect(preview.isPreviewStampedProperty(node, "background-color")).toBe(true)
    expect(preview.isPreviewStampedProperty(node, "BACKGROUND-COLOR")).toBe(true)
  })

  it("keeps case-differing custom properties distinct", () => {
    const preview = createOverridePreview()
    const node = el()

    // Custom properties ARE case-sensitive in CSS: `--Brand` and `--brand` are
    // two different properties, so folding the record key to lower case would
    // make a stamp on one claim the other.
    preview.applyClassOverride(node, ["a"], { "--Brand": "red" })

    expect(preview.isPreviewStampedProperty(node, "--Brand")).toBe(true)
    expect(preview.isPreviewStampedProperty(node, "--brand")).toBe(false)
  })
})

/**
 * The prop/attr preview RESULT messages.
 *
 * These used to carry a bare `ok` and the shell had no case for either one, so
 * `ok: false` was discarded and a poke that applied nothing looked like a dead
 * control. The reason now travels with the failure, and it is built in exactly
 * one place (`findPreviewInstance`) so the "which failure was it" answer can't
 * drift away from the lookup that produced it.
 *
 * `kind` is the load-bearing half: the shell suppresses exactly
 * `unsupported-substrate` (a React substrate would otherwise warn on every prop
 * edit that actually reached source), so a case classified wrongly here is either
 * a false alarm or a swallowed failure. Every branch asserts its kind, not just
 * its prose.
 */
describe("override-preview — prop/attr poke results", () => {
  function propResult(sent: Record<string, unknown>[]): {
    selector: string
    propName: string
    ok: boolean
    reason?: string
    kind?: string
  } {
    const message = sent.find((m) => m.type === "PROP_OVERRIDE_RESULT")
    expect(message, "expected a PROP_OVERRIDE_RESULT").toBeDefined()
    return message!.payload as {
      selector: string
      propName: string
      ok: boolean
      reason?: string
      kind?: string
    }
  }

  function attrResult(sent: Record<string, unknown>[]): {
    selector: string
    attrName: string
    ok: boolean
    reason?: string
    kind?: string
  } {
    const message = sent.find((m) => m.type === "ATTR_OVERRIDE_RESULT")
    expect(message, "expected an ATTR_OVERRIDE_RESULT").toBeDefined()
    return message!.payload as {
      selector: string
      attrName: string
      ok: boolean
      reason?: string
      kind?: string
    }
  }

  /** Minimal stand-in for what the bridge reads off a Vue-rendered element. */
  function withVueInstance(
    node: HTMLElement,
    props: Record<string, unknown>,
  ): void {
    ;(node as unknown as Record<string, unknown>).__vueParentComponent = {
      props,
      update: () => {},
      vnode: { el: node },
    }
  }

  it("reports ok with no reason when the prop poke lands", () => {
    const sent = captureSends()
    const preview = createOverridePreview()
    const node = el()
    node.id = "btn"
    withVueInstance(node, { appearance: "primary" })

    preview.handleApplyPropOverride({
      selector: "#btn",
      propName: "appearance",
      value: "danger",
    })

    const payload = propResult(sent)
    expect(payload.ok).toBe(true)
    expect(payload.reason).toBeUndefined()
    // …and it really applied.
    expect(
      (
        (node as unknown as { __vueParentComponent: { props: Record<string, unknown> } })
          .__vueParentComponent.props
      ).appearance,
    ).toBe("danger")
  })

  it("calls a page with no instance data anywhere a SUBSTRATE gap, not a failure", () => {
    const sent = captureSends()
    const preview = createOverridePreview()
    const node = el()
    node.id = "plain"
    // No __vueParentComponent on this element OR anywhere in the document —
    // i.e. React, Svelte, plain HTML, or a Vue production build. The preview
    // write path can never work here, so EVERY poke lands in this branch while
    // the source write beside it succeeds. Classifying it as a real failure is
    // what made the shell warn on every edit that worked.
    preview.handleApplyPropOverride({
      selector: "#plain",
      propName: "appearance",
      value: "danger",
    })

    const payload = propResult(sent)
    expect(payload.ok).toBe(false)
    expect(payload.kind).toBe("unsupported-substrate")
    expect(payload.propName).toBe("appearance")
    expect(payload.selector).toBe("#plain")
  })

  it("still calls a per-element miss a real failure when the substrate CAN preview", () => {
    const sent = captureSends()
    const preview = createOverridePreview()
    // Instance data exists on this page — just not on the element clicked. This
    // is the genuine, actionable case (raw markup outside the app, a portal),
    // and it must NOT be filtered along with the substrate gap.
    withVueInstance(el(), { appearance: "primary" })
    const node = el()
    node.id = "outside"

    preview.handleApplyPropOverride({
      selector: "#outside",
      propName: "appearance",
      value: "danger",
    })

    const payload = propResult(sent)
    expect(payload.ok).toBe(false)
    expect(payload.kind).toBe("no-component-instance")
    expect(payload.reason).toMatch(/no component instance/i)
  })

  it("explains a prop poke whose selector no longer resolves", () => {
    const sent = captureSends()
    const preview = createOverridePreview()

    preview.handleApplyPropOverride({
      selector: "#gone",
      propName: "title",
      value: "x",
    })

    const payload = propResult(sent)
    expect(payload.ok).toBe(false)
    // Distinct from the no-instance case: this one is actionable by re-selecting.
    expect(payload.reason).toMatch(/no longer on the page/i)
    // A missing element is NOT a substrate gap even on a substrate that has one —
    // it never reaches the capability probe, so it always surfaces.
    expect(payload.kind).toBe("selector-unresolvable")
  })

  it("explains an invalid selector rather than reporting a bare failure", () => {
    const sent = captureSends()
    const preview = createOverridePreview()

    preview.handleApplyPropOverride({
      selector: ">>> not a selector",
      propName: "title",
      value: "x",
    })

    const payload = propResult(sent)
    expect(payload.ok).toBe(false)
    expect(payload.reason).toMatch(/invalid selector/i)
    expect(payload.kind).toBe("selector-unresolvable")
  })

  it("explains a component that exposes no props object", () => {
    const sent = captureSends()
    const preview = createOverridePreview()
    const node = el()
    node.id = "propless"
    ;(node as unknown as Record<string, unknown>).__vueParentComponent = {
      update: () => {},
    }

    preview.handleApplyPropOverride({
      selector: "#propless",
      propName: "title",
      value: "x",
    })

    const payload = propResult(sent)
    expect(payload.ok).toBe(false)
    expect(payload.reason).toMatch(/no props object/i)
    // An instance WAS found, so this is a per-component miss, not a substrate gap.
    expect(payload.kind).toBe("no-component-instance")
  })

  it("names the prop when the component refuses the assignment", () => {
    const sent = captureSends()
    const preview = createOverridePreview()
    const node = el()
    node.id = "frozen"
    withVueInstance(node, Object.freeze({ title: "before" }))

    preview.handleApplyPropOverride({
      selector: "#frozen",
      propName: "title",
      value: "after",
    })

    const payload = propResult(sent)
    expect(payload.ok).toBe(false)
    expect(payload.reason).toContain('"title"')
    expect(payload.kind).toBe("assignment-refused")
  })

  it("reports the same failure shape for a fallthrough attr poke", () => {
    const sent = captureSends()
    const preview = createOverridePreview()
    withVueInstance(el(), { placeholder: "before" })
    const node = el()
    node.id = "plain-attr"

    preview.handleApplyAttrOverride({
      selector: "#plain-attr",
      attrName: "placeholder",
      value: "Search…",
    })

    const payload = attrResult(sent)
    expect(payload.ok).toBe(false)
    expect(payload.attrName).toBe("placeholder")
    expect(payload.reason).toMatch(/no component instance/i)
    expect(payload.kind).toBe("no-component-instance")
  })

  it("folds the substrate gap identically on the attr half", () => {
    // The two halves share `findPreviewInstance`, so the classification cannot
    // diverge — asserted rather than assumed, because a React user editing a
    // fallthrough attr is the same false alarm as editing a prop.
    const sent = captureSends()
    const preview = createOverridePreview()
    const node = el()
    node.id = "plain-attr-2"

    preview.handleApplyAttrOverride({
      selector: "#plain-attr-2",
      attrName: "placeholder",
      value: "Search…",
    })

    const payload = attrResult(sent)
    expect(payload.ok).toBe(false)
    expect(payload.kind).toBe("unsupported-substrate")
  })

  it("leaves nothing behind when a poke fails — no shim, no store entry", () => {
    const sent = captureSends()
    const preview = createOverridePreview()
    const node = el()
    node.id = "plain2"
    const beforeHtml = node.outerHTML

    preview.handleApplyPropOverride({
      selector: "#plain2",
      propName: "appearance",
      value: "danger",
      overrideId: "edit-1",
    })

    // A failed poke applies NOTHING, so — unlike the refused-resolution case
    // that stranded a class shim — there is no preview to release here. Both
    // halves matter: the DOM is untouched, and the store never registered the
    // id (a registration with nothing applied would have the re-assert loop
    // fighting to apply a preview the substrate already refused).
    expect(node.outerHTML).toBe(beforeHtml)
    expect(preview.store.get("edit-1")).toBeUndefined()
    expect(preview.retireHooks.has("edit-1")).toBe(false)
    // …and no OVERRIDE_* traffic was generated for an override that never existed.
    expect(sent.filter((m) => String(m.type).startsWith("OVERRIDE_"))).toEqual([])
    expect(propResult(sent).ok).toBe(false)
  })
})
