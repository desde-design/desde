/**
 * `selector-engine` had no colocated tests despite being the module every
 * selection, comment anchor and edit target ultimately flows through.
 *
 * THE FAILURE MODE THAT MATTERS. A selector that throws is loud and harmless.
 * A selector that silently matches the WRONG element is not: it becomes a
 * persisted comment anchor or an edit target, so the user's next change lands
 * on a node they never clicked. The uniqueness check in `generateSelector`
 * exists because exactly that happened once already — its own comment says so.
 *
 * Page content is attacker-controlled from the bridge's point of view: class
 * names, ids and data attributes all come from the prototype being reviewed.
 */
import { describe, expect, it, beforeEach } from "vitest"
import { generateSelector, isUnique, looksGenerated } from "./selector-engine"

function mount(html: string): void {
  document.body.innerHTML = html
}

/** Resolves a selector the way the shell later will, and reports the match. */
function resolves(selector: string): Element | null {
  return document.querySelector(selector)
}

beforeEach(() => {
  document.body.innerHTML = ""
})

describe("generateSelector — the returned selector must actually find the element back", () => {
  it("round-trips a unique data-flow-id", () => {
    mount(`<div data-flow-id="hero"></div>`)
    const el = document.querySelector("[data-flow-id=hero]")!
    expect(resolves(generateSelector(el))).toBe(el)
  })

  it("does not hand back a DUPLICATED data-flow-id that resolves to a different element", () => {
    // Duplicated ids are not exotic: a v-for over a list whose author stamped
    // a constant `data-flow-id`, or two instances of the same component.
    mount(`<div data-flow-id="row" id="first"></div><div data-flow-id="row" id="second"></div>`)
    const second = document.getElementById("second")!

    const selector = generateSelector(second)
    expect(resolves(selector), `"${selector}" resolves to the wrong element`).toBe(second)
  })

  it("does not hand back a DUPLICATED id that resolves to a different element", () => {
    // Duplicate ids are invalid HTML and extremely common in real pages.
    mount(`<section id="dupe"><span>a</span></section><section id="dupe"><span>b</span></section>`)
    const second = document.querySelectorAll("section")[1]!

    const selector = generateSelector(second)
    expect(resolves(selector), `"${selector}" resolves to the wrong element`).toBe(second)
  })

  it("survives a data-flow-id containing a quote without producing a broken selector", () => {
    // An unescaped `"` closes the attribute-value string and the whole
    // selector becomes a syntax error — `querySelector` THROWS, taking out
    // whatever was iterating over selections.
    mount(`<div data-flow-id='he said "hi"'></div>`)
    const el = document.querySelector("div")!

    const selector = generateSelector(el)
    expect(() => resolves(selector), `"${selector}" is not parseable`).not.toThrow()
    expect(resolves(selector)).toBe(el)
  })

  it("survives a data-flow-id containing selector metacharacters", () => {
    mount(`<div data-flow-id="a]:hover,body"></div>`)
    const el = document.querySelector("div")!

    const selector = generateSelector(el)
    expect(() => resolves(selector), `"${selector}" is not parseable`).not.toThrow()
    // The dangerous outcome is not a throw but a MATCH on something else —
    // an injected `,body` would select the document body.
    expect(resolves(selector)).toBe(el)
  })

  it("survives an id containing a quote", () => {
    mount(`<div id='we"ird'></div>`)
    const el = document.querySelector("div")!
    const selector = generateSelector(el)
    expect(() => resolves(selector)).not.toThrow()
    expect(resolves(selector)).toBe(el)
  })

  it("falls back to a positional path when nothing else is unique", () => {
    mount(`<ul><li>a</li><li>b</li><li>c</li></ul>`)
    const third = document.querySelectorAll("li")[2]!
    expect(resolves(generateSelector(third))).toBe(third)
  })
})

describe("supporting predicates", () => {
  it("isUnique is what the engine should be gating every candidate on", () => {
    mount(`<div class="one"></div><div class="two"></div><div class="two"></div>`)
    expect(isUnique(".one")).toBe(true)
    expect(isUnique(".two")).toBe(false)
  })

  it("looksGenerated rejects hashes and long ids, keeps human names", () => {
    expect(looksGenerated("a1b2c3d4")).toBe(true)
    expect(looksGenerated("e5")).toBe(true)
    expect(looksGenerated("x".repeat(41))).toBe(true)
    expect(looksGenerated("submit-button")).toBe(false)
  })
})
