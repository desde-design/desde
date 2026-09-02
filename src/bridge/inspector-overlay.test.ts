/**
 * Unit tests for the text-editable-leaf predicate that gates double-click-to-
 * edit + the Phase 0 hover cursor cue.
 */
import { afterEach, describe, expect, it } from "vitest"
import {
  buildInspectTag,
  InspectorOverlayManager,
  isTextEditableLeaf,
} from "./inspector-overlay"

function el(html: string): Element {
  const host = document.createElement("div")
  host.innerHTML = html
  return host.firstElementChild!
}

describe("isTextEditableLeaf", () => {
  it("is true for a single-text-node leaf", () => {
    expect(isTextEditableLeaf(el("<span>Hello</span>"))).toBe(true)
    expect(isTextEditableLeaf(el("<button>Save</button>"))).toBe(true)
  })

  it("is false for an element with element children", () => {
    expect(isTextEditableLeaf(el("<div><span>x</span></div>"))).toBe(false)
  })

  it("is false for mixed content (text + element)", () => {
    const node = el("<p>Hello <b>world</b></p>")
    expect(isTextEditableLeaf(node)).toBe(false)
  })

  it("is false for an empty element", () => {
    expect(isTextEditableLeaf(el("<div></div>"))).toBe(false)
  })

  it("accepts text alongside a Vue anchor comment", () => {
    // Vue emits <!--v-if--> / <!--v-for--> / fragment anchors as siblings of
    // the text. Before this was handled, adding a v-if to an element silently
    // made its text un-editable — the regression behind "we lost double-click
    // to edit".
    expect(isTextEditableLeaf(el("<h2>Anchored heading<!--v-if--></h2>"))).toBe(
      true,
    )
    expect(isTextEditableLeaf(el("<span>Label<!----></span>"))).toBe(true)
  })

  it("still refuses split text runs (ambiguous source attribution)", () => {
    // `Hello {{ msg }}` renders as a static run plus an interpolated run. An
    // edit to the merged string can't be attributed to one source span, so it
    // stays refused — ambiguity loses.
    expect(isTextEditableLeaf(el("<p>Hello <!---->world</p>"))).toBe(false)
  })

  it("still refuses element children even when a comment is present", () => {
    expect(isTextEditableLeaf(el("<div><span>x</span><!----></div>"))).toBe(
      false,
    )
  })

  it("is false for a comment-only element", () => {
    expect(isTextEditableLeaf(el("<div><!----></div>"))).toBe(false)
  })

  it("is false when the single child is not a text node (e.g. a comment)", () => {
    const node = document.createElement("div")
    node.appendChild(document.createComment("only a comment"))
    expect(isTextEditableLeaf(node)).toBe(false)
  })
})

/**
 * Audit S16. The inspect label interpolates prototype-authored `id`, `class`
 * and component-name values. It used to build an HTML string and assign it to
 * `innerHTML`, which made hovering a hostile element script execution inside
 * the iframe the shell trusts as the bridge.
 */
describe("buildInspectTag — prototype-authored values are escaped", () => {
  function elWith(attrs: Record<string, string>, tagName = "div"): Element {
    const node = document.createElement(tagName)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
    return node
  }

  it("does not create elements from an injected id", () => {
    const node = elWith({ id: `<img src=x onerror="globalThis.__pwned=1">` })
    const tag = buildInspectTag(node)

    // No IMG anywhere: the payload is text, not markup.
    expect(tag.querySelector("img")).toBeNull()
    // The literal characters survive as visible text — the label still tells
    // the user what the id actually is.
    expect(tag.textContent).toContain("<img src=x")
    // And the only elements present are our own spans.
    for (const child of Array.from(tag.querySelectorAll("*"))) {
      expect(child.tagName).toBe("SPAN")
    }
  })

  it("does not create elements from an injected class name", () => {
    const node = document.createElement("div")
    // setAttribute keeps the payload as ONE class token; classList would split
    // on whitespace, so this is the shape that actually reaches the label.
    node.setAttribute("class", `<script>globalThis.__pwned=1</script>`)
    const tag = buildInspectTag(node)

    expect(tag.querySelector("script")).toBeNull()
    expect(tag.textContent).toContain("<script>")
  })

  it("does not create elements from an injected component name", () => {
    const tag = buildInspectTag(
      document.createElement("div"),
      `X<img src=y onerror="globalThis.__pwned=1">`,
    )

    expect(tag.querySelector("img")).toBeNull()
    expect(tag.textContent).toContain("<X<img src=y")
  })

  it("still renders the ordinary case readably", () => {
    const node = elWith({ id: "hero", class: "card card--wide is-active" }, "section")
    const tag = buildInspectTag(node)

    expect(tag.textContent).toBe("section#hero.card.card--wide.is-active")
    expect(tag.querySelector(".pt-id")?.textContent).toBe("#hero")
    expect(tag.querySelector(".pt-class")?.textContent).toBe(".card.card--wide.is-active")
  })

  it("caps the class list at three, as before", () => {
    const node = elWith({ class: "a b c d e" })
    expect(buildInspectTag(node).textContent).toBe("div.a.b.c")
  })

  it("prefers the component name over tag/id/class when present", () => {
    const node = elWith({ id: "x", class: "y" })
    expect(buildInspectTag(node, "KButton").textContent).toBe("<KButton>")
  })
})

/**
 * The overlay chrome is `position: fixed` and its coordinates come from
 * `getBoundingClientRect()` — viewport space. Written once at draw time, those
 * coordinates are only correct until the page scrolls: the element moves, the
 * fixed box does not, and the highlight detaches from what it is highlighting.
 *
 * The hover layer used to hide this because it redraws on the next mousemove,
 * so any pointer movement after a scroll snapped it back. The selection layer
 * has no such self-heal — it stayed stale until the next click, which is the
 * "sometimes the highlight scrolls away" Mo reported.
 */
describe("overlay tracks the element across scroll", () => {
  const managers: InspectorOverlayManager[] = []

  afterEach(() => {
    for (const m of managers) m.deactivate()
    managers.length = 0
    document.body.innerHTML = ""
  })

  function makeManager(): InspectorOverlayManager {
    const m = new InspectorOverlayManager()
    managers.push(m)
    return m
  }

  /** Reach the closed shadow root the manager draws into. */
  function shadowOf(m: InspectorOverlayManager): ShadowRoot {
    return (m as unknown as { shadow: ShadowRoot }).shadow
  }

  /** An element whose viewport rect we can move, as a scroll would. */
  function movableTarget(parent: Node = document.body): {
    el: HTMLElement
    setTop: (t: number) => void
  } {
    const el = document.createElement("div")
    parent.appendChild(el)
    let top = 500
    el.getBoundingClientRect = () =>
      ({
        top,
        left: 10,
        width: 100,
        height: 40,
        bottom: top + 40,
        right: 110,
        x: 10,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect
    return {
      el,
      setTop: (t: number) => {
        top = t
      },
    }
  }

  /** Let the rAF-debounced reposition run. */
  function flushFrames(): Promise<void> {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  }

  it("repositions the selection box when the page scrolls", async () => {
    const { el, setTop } = movableTarget()
    const mgr = makeManager()
    mgr.highlightElement(el)

    const box = () =>
      shadowOf(mgr).querySelector<HTMLElement>(".pt-inspect-overlay--selected")
    expect(box()?.style.top).toBe("500px")

    // Scroll down 300px: the element rises in the viewport.
    setTop(200)
    document.dispatchEvent(new Event("scroll"))
    await flushFrames()

    expect(box()?.style.top).toBe("200px")
  })

  it("repositions on a NESTED scroll container, not just the page", async () => {
    // `scroll` does not bubble. A document-level listener without capture
    // never sees an inner container scroll — the common case in a real app,
    // where the prototype scrolls a pane rather than the document.
    const pane = document.createElement("div")
    document.body.appendChild(pane)
    const { el, setTop } = movableTarget(pane)
    const mgr = makeManager()
    mgr.highlightElement(el)

    setTop(120)
    pane.dispatchEvent(new Event("scroll"))
    await flushFrames()

    expect(
      shadowOf(mgr).querySelector<HTMLElement>(".pt-inspect-overlay--selected")
        ?.style.top,
    ).toBe("120px")
  })

  it("repositions the tag label too", async () => {
    const { el, setTop } = movableTarget()
    const mgr = makeManager()
    mgr.highlightElement(el)

    setTop(300)
    document.dispatchEvent(new Event("scroll"))
    await flushFrames()

    // The tag sits above the box.
    expect(
      shadowOf(mgr).querySelector<HTMLElement>(".pt-inspect-tag")?.style.top,
    ).toBe("280px")
  })

  it("draws no size readout under the box", () => {
    // Removed 2026-08-14. A pixel size that changes on every hover, pinned to
    // the bottom edge where it collides with whatever is below, read as chrome
    // rather than as information, and the Inspector panel reports the box
    // model properly. Asserted so it cannot come back by accident.
    const { el } = movableTarget()
    const mgr = makeManager()
    mgr.highlightElement(el)

    expect(shadowOf(mgr).querySelector(".pt-inspect-dimensions")).toBeNull()
  })

  it("styles the tag on the primary teal, matching the selection outline", () => {
    // The bridge runs in the prototype's document and cannot read the shell's
    // custom properties, so these literals ARE the contract. If they drift
    // from `--primary` / `--primary-foreground` the label stops looking like
    // the product.
    const mgr = makeManager()
    const css = shadowOf(mgr).querySelector("style")?.textContent ?? ""
    expect(css).toContain("background: oklch(0.575 0.135 190)")
    expect(css).toContain("color: oklch(0.99 0.006 190)")
    expect(css).not.toContain("#3D1F30")
    expect(css).not.toContain("#F0B4D8")
  })

  it("repositions on resize", async () => {
    const { el, setTop } = movableTarget()
    const mgr = makeManager()
    mgr.highlightElement(el)

    setTop(60)
    window.dispatchEvent(new Event("resize"))
    await flushFrames()

    expect(
      shadowOf(mgr).querySelector<HTMLElement>(".pt-inspect-overlay--selected")
        ?.style.top,
    ).toBe("60px")
  })

  it("drops the chrome when the highlighted element leaves the DOM", async () => {
    const { el } = movableTarget()
    const mgr = makeManager()
    mgr.highlightElement(el)
    expect(
      shadowOf(mgr).querySelector(".pt-inspect-overlay--selected"),
    ).not.toBeNull()

    el.remove()
    document.dispatchEvent(new Event("scroll"))
    await flushFrames()

    // A box left behind at the old coordinates would point at nothing.
    expect(
      shadowOf(mgr).querySelector(".pt-inspect-overlay--selected"),
    ).toBeNull()
  })

  it("does nothing when no overlay is drawn", async () => {
    const mgr = makeManager()
    document.dispatchEvent(new Event("scroll"))
    await flushFrames()

    expect(shadowOf(mgr).querySelector(".pt-inspect-overlay")).toBeNull()
  })
})
