/**
 * Unit coverage for the JSX rendering-hint inferrer. Mirrors the Vue inferrer:
 * infers `dom` hints for the "bare prop rendered as an element's text" pattern,
 * with the same canonical selector form and bounded scope.
 */
import { describe, it, expect } from "vitest"
import { inferJsxRenderingHints } from "./infer-jsx-rendering-hints"
import type { RenderingHint } from "../../core"

function hints(source: string, propNames: string[]): RenderingHint[] | undefined {
  return inferJsxRenderingHints({ source, propNames })
}

describe("inferJsxRenderingHints — happy path", () => {
  it("infers dom hints for props rendered as element text (tag.class selector)", () => {
    const src = `function Card({ title, step }: { title: string; step: string }) {
      return (
        <div className="card">
          <h2 className="header-title">{title}</h2>
          <div className="step">{step}</div>
        </div>
      )
    }`
    const out = hints(src, ["title", "step"])
    expect(out).toContainEqual({
      kind: "dom",
      source: { kind: "prop", name: "title" },
      domTarget: { selector: "h2.header-title", field: "textContent" },
      editability: "literal",
    })
    expect(out).toContainEqual({
      kind: "dom",
      source: { kind: "prop", name: "step" },
      domTarget: { selector: "div.step", field: "textContent" },
      editability: "literal",
    })
  })

  it("uses :root when the rendering element is the single render root", () => {
    const src = `function Label({ text }: { text: string }) {
      return <span className="lbl">{text}</span>
    }`
    const out = hints(src, ["text"])
    expect(out).toEqual([
      {
        kind: "dom",
        source: { kind: "prop", name: "text" },
        domTarget: { selector: ":root", field: "textContent" },
        editability: "literal",
      },
    ])
  })

  it("sorts className tokens to match the bridge's canonical selector", () => {
    const src = `function C({ t }: any) {
      return (<div className="card"><h2 className="zeta alpha">{t}</h2></div>)
    }`
    const out = hints(src, ["t"])
    const h = out?.[0]
    expect(h?.kind).toBe("dom")
    if (h?.kind === "dom") expect(h.domTarget.selector).toBe("h2.alpha.zeta")
  })
})

describe("inferJsxRenderingHints — bounded scope (refusals)", () => {
  it("does not infer member-access expressions ({props.title})", () => {
    const src = `function C({ user }: any) { return <div className="x">{user.name}</div> }`
    expect(hints(src, ["user"])).toBeUndefined()
  })

  it("does not infer when the prop is mixed with other text", () => {
    const src = `function C({ title }: any) { return <div className="x">Hi {title}</div> }`
    expect(hints(src, ["title"])).toBeUndefined()
  })

  it("does not claim a non-prop identifier", () => {
    const src = `function C() { const local = "y"; return <div className="z">{local}</div> }`
    expect(hints(src, ["title"])).toBeUndefined()
  })

  it("drops colliding props rendered into the same selector", () => {
    const src = `function C({ a, b }: any) {
      return (<div><span className="dup">{a}</span><span className="dup">{b}</span></div>)
    }`
    expect(hints(src, ["a", "b"])).toBeUndefined()
  })

  it("skips a class-less non-root element (bare-tag selector too ambiguous)", () => {
    const src = `function C({ title }: any) { return (<div className="card"><h2>{title}</h2></div>) }`
    expect(hints(src, ["title"])).toBeUndefined()
  })

  it("skips component tags (capitalized) — that would be a forward hint", () => {
    const src = `function C({ title }: any) { return <Foo className="x">{title}</Foo> }`
    expect(hints(src, ["title"])).toBeUndefined()
  })

  it("returns undefined when there are no declared props", () => {
    const src = `function C() { return <div className="x">{whatever}</div> }`
    expect(hints(src, [])).toBeUndefined()
  })
})
