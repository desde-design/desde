/**
 * First tests for `inspection-extractors` — specifically `buildRawValueMap`,
 * which supplies the "authored value" the inspector shows next to the computed
 * one.
 *
 * It used to keep the FIRST matching declaration per property. The CSS cascade
 * gives the LATER declaration priority at equal specificity, so the inspector
 * could show a losing declaration as the source of a value it did not produce.
 * Wrong, quietly — the computed column stayed correct, so nothing looked
 * broken.
 *
 * Document order is an approximation, not full cascade resolution: an earlier
 * rule with higher specificity legitimately wins and this does not model that.
 * `style-provenance.ts` is the specificity-aware path. These tests pin the
 * approximation deliberately, including its known limit.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildRawValueMap } from "./inspection-extractors"

let styleEl: HTMLStyleElement | null = null

function withCss(css: string, markup: string): Element {
  styleEl = document.createElement("style")
  styleEl.textContent = css
  document.head.appendChild(styleEl)
  document.body.innerHTML = markup
  return document.body.firstElementChild!
}

beforeEach(() => {
  document.body.innerHTML = ""
})

afterEach(() => {
  styleEl?.remove()
  styleEl = null
  document.body.innerHTML = ""
})

describe("buildRawValueMap — cascade order", () => {
  it("reports the LATER declaration when two rules of equal specificity match", () => {
    // The regression. First-match reported `red` while the element actually
    // renders blue.
    const el = withCss(
      `.btn { color: red; } .primary { color: blue; }`,
      `<button class="btn primary">x</button>`,
    )
    expect(buildRawValueMap(el).get("color")).toBe("blue")
  })

  it("keeps the authored form, which is the whole point of showing it", () => {
    // `1rem` is what the author wrote; `computed` would say `16px`. The pair
    // is only useful if the authored side is the winning declaration.
    const el = withCss(
      `.a { padding: 0.5rem; } .b { padding: 1rem; }`,
      `<div class="a b">x</div>`,
    )
    expect(buildRawValueMap(el).get("padding")).toBe("1rem")
  })

  it("does not confuse properties across rules", () => {
    const el = withCss(
      `.a { color: red; margin: 4px; } .b { color: green; }`,
      `<div class="a b">x</div>`,
    )
    const map = buildRawValueMap(el)
    expect(map.get("color")).toBe("green")
    expect(map.get("margin")).toBe("4px")
  })

  it("ignores rules that do not match the element", () => {
    const el = withCss(
      `.other { color: orange; } .a { color: teal; }`,
      `<div class="a">x</div>`,
    )
    expect(buildRawValueMap(el).get("color")).toBe("teal")
  })

  it("KNOWN LIMIT: an earlier higher-specificity rule still wins in real CSS", () => {
    // Documented, not asserted as correct. `#id` beats `.cls` regardless of
    // order, so the real winning declaration here is `purple`, and document
    // order reports `pink`. Pinning it makes the limitation visible rather
    // than letting a future reader assume full cascade resolution — reach for
    // style-provenance.ts when the exact source rule matters.
    const el = withCss(
      `#target { color: purple; } .cls { color: pink; }`,
      `<div id="target" class="cls">x</div>`,
    )
    expect(buildRawValueMap(el).get("color")).toBe("pink")
  })
})
