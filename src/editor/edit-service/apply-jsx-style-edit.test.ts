import { describe, it, expect } from "vitest"
import { applyJsxStyleEdit, isJsxStyleFallbackHint } from "./apply-jsx-style-edit"

// Babel coords: 1-based line, 0-based column of the JSXOpeningElement.
const sample = `export function App() {
  return (
    <div className="row gap-2">
      <button className="border-b-2 px-4">Save</button>
    </div>
  )
}
`

describe("applyJsxStyleEdit — classname mode", () => {
  it("merges a new utility into an existing className", () => {
    const r = applyJsxStyleEdit({
      source: sample,
      line: 4,
      column: 6,
      mode: "classname",
      addClasses: ["rounded-md"],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain('className="border-b-2 px-4 rounded-md"')
    }
  })

  it("replaces a conflicting utility via tailwind-merge (change a value)", () => {
    const r = applyJsxStyleEdit({
      source: sample,
      line: 4,
      column: 6,
      mode: "classname",
      addClasses: ["border-b-4"],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // border-b-2 and border-b-4 conflict on the same property → only b-4 wins.
      expect(r.source).toContain('className="px-4 border-b-4"')
      expect(r.source).not.toContain("border-b-2")
    }
  })

  it("honors an explicit removeClasses set", () => {
    const r = applyJsxStyleEdit({
      source: sample,
      line: 4,
      column: 6,
      mode: "classname",
      removeClasses: ["border-b-2"],
      addClasses: ["border-t-2"],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain('className="px-4 border-t-2"')
    }
  })

  it("creates className when absent", () => {
    const src = `export const A = () => <button>Go</button>\n`
    const r = applyJsxStyleEdit({
      source: src,
      line: 1,
      column: 23,
      mode: "classname",
      addClasses: ["px-2"],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toContain('<button className="px-2">Go</button>')
  })

  it("supports arbitrary-value utilities", () => {
    const r = applyJsxStyleEdit({
      source: sample,
      line: 4,
      column: 6,
      mode: "classname",
      addClasses: ["border-b-[3px]"],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toContain("border-b-[3px]")
  })

  it("refuses a bound className (cn(...)) with a bound-binding fallback", () => {
    const src = `export const A = (p) => <div className={cn("row", p.x)}>x</div>\n`
    const r = applyJsxStyleEdit({
      source: src,
      line: 1,
      column: 24,
      mode: "classname",
      addClasses: ["px-2"],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.fallback?.kind).toBe("bound-binding")
  })

  it("refuses a no-op (class already present, nothing changes)", () => {
    const r = applyJsxStyleEdit({
      source: sample,
      line: 4,
      column: 6,
      mode: "classname",
      addClasses: ["px-4"],
    })
    expect(r.ok).toBe(false)
  })

  it("refuses a static set when a {...spread} is present", () => {
    const src = `export const A = (p) => <div {...p}>x</div>\n`
    const r = applyJsxStyleEdit({
      source: src,
      line: 1,
      column: 24,
      mode: "classname",
      addClasses: ["px-2"],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.fallback?.kind).toBe("dynamic-vbind")
  })

  it("refuses editing an existing className when a spread comes AFTER it", () => {
    const src = `export const A = (p) => <div className="a" {...p}>x</div>\n`
    const r = applyJsxStyleEdit({
      source: src,
      line: 1,
      column: 24,
      mode: "classname",
      addClasses: ["px-2"],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.fallback?.kind).toBe("dynamic-vbind")
  })

  it("allows editing an existing className when the spread comes BEFORE it", () => {
    const src = `export const A = (p) => <div {...p} className="a">x</div>\n`
    const r = applyJsxStyleEdit({
      source: src,
      line: 1,
      column: 24,
      mode: "classname",
      addClasses: ["px-2"],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toContain('className="a px-2"')
  })
})

describe("applyJsxStyleEdit — inline mode", () => {
  it("creates a style object when absent (kebab→camel)", () => {
    const src = `export const A = () => <button>Go</button>\n`
    const r = applyJsxStyleEdit({
      source: src,
      line: 1,
      column: 23,
      mode: "inline",
      declarations: { "border-bottom-width": "2px" },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain('style={{ borderBottomWidth: "2px" }}')
    }
  })

  it("merges into an existing style object, updating and adding keys", () => {
    const src = `export const A = () => <div style={{ color: "red" }}>x</div>\n`
    const r = applyJsxStyleEdit({
      source: src,
      line: 1,
      column: 23,
      mode: "inline",
      declarations: { color: "blue", "font-size": "14px" },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain('color: "blue"')
      expect(r.source).toContain('fontSize: "14px"')
    }
  })

  it("removes a property via removeDeclarations", () => {
    const src = `export const A = () => <div style={{ color: "red", margin: "4px" }}>x</div>\n`
    const r = applyJsxStyleEdit({
      source: src,
      line: 1,
      column: 23,
      mode: "inline",
      removeDeclarations: ["margin"],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain('style={{ color: "red" }}')
      expect(r.source).not.toContain("margin")
    }
  })

  it("preserves an unrelated existing key verbatim", () => {
    const src = `export const A = () => <div style={{ display: "flex" }}>x</div>\n`
    const r = applyJsxStyleEdit({
      source: src,
      line: 1,
      column: 23,
      mode: "inline",
      declarations: { "border-width": "1px" },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain('display: "flex"')
      expect(r.source).toContain('borderWidth: "1px"')
    }
  })

  it("removes the style attribute entirely when the last property is cleared", () => {
    const src = `export const A = () => <div style={{ color: "red" }}>x</div>\n`
    const r = applyJsxStyleEdit({
      source: src,
      line: 1,
      column: 23,
      mode: "inline",
      removeDeclarations: ["color"],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain("<div>x</div>")
      expect(r.source).not.toContain("style=")
    }
  })

  it("refuses a non-object style binding with bound-binding fallback", () => {
    const src = `export const A = (p) => <div style={p.style}>x</div>\n`
    const r = applyJsxStyleEdit({
      source: src,
      line: 1,
      column: 24,
      mode: "inline",
      declarations: { color: "blue" },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.fallback?.kind).toBe("bound-binding")
  })

  it("refuses a style object with a spread", () => {
    const src = `export const A = (p) => <div style={{ ...p.s, color: "red" }}>x</div>\n`
    const r = applyJsxStyleEdit({
      source: src,
      line: 1,
      column: 24,
      mode: "inline",
      declarations: { color: "blue" },
    })
    expect(r.ok).toBe(false)
  })

  it("refuses editing an existing style when a spread comes AFTER it", () => {
    const src = `export const A = (p) => <div style={{ color: "red" }} {...p}>x</div>\n`
    const r = applyJsxStyleEdit({
      source: src,
      line: 1,
      column: 24,
      mode: "inline",
      declarations: { color: "blue" },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.fallback?.kind).toBe("dynamic-vbind")
  })

  it("refuses a no-op (value unchanged)", () => {
    const src = `export const A = () => <div style={{ color: "red" }}>x</div>\n`
    const r = applyJsxStyleEdit({
      source: src,
      line: 1,
      column: 23,
      mode: "inline",
      declarations: { color: "red" },
    })
    expect(r.ok).toBe(false)
  })
})

describe("applyJsxStyleEdit — guards", () => {
  it("refuses when no element matches the coord", () => {
    const r = applyJsxStyleEdit({
      source: sample,
      line: 99,
      column: 0,
      mode: "classname",
      addClasses: ["px-2"],
    })
    expect(r.ok).toBe(false)
  })

  it("rejects an unsafe class name", () => {
    const r = applyJsxStyleEdit({
      source: sample,
      line: 4,
      column: 6,
      mode: "classname",
      addClasses: ['"><script>'],
    })
    expect(r.ok).toBe(false)
  })
})

/**
 * Audit Task 23 — the jsx-style lane emits its OWN typed refusal hint
 * (`JsxStyleFallbackHint`) rather than borrowing `PropEditFallbackHint`. The
 * `lane` discriminator is what the CLI dispatcher routes on: a prop hint
 * engages the agent mini-turn, a jsx-style hint surfaces "adjust it via chat".
 * Mixing them up would send a className composition to a prompt shaped for
 * string-literal prop edits, so the tag is load-bearing.
 */
describe("applyJsxStyleEdit — typed fallback hint", () => {
  it("tags a bound className refusal with lane + attribute + expression", () => {
    const src = `export const A = (p) => <div className={cn("row", p.x)}>x</div>\n`
    const r = applyJsxStyleEdit({
      source: src,
      line: 1,
      column: 24,
      mode: "classname",
      addClasses: ["px-2"],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.fallback).toEqual({
        lane: "jsx-style",
        kind: "bound-binding",
        attribute: "className",
        expression: 'cn("row", p.x)',
      })
      expect(isJsxStyleFallbackHint(r.fallback)).toBe(true)
    }
  })

  it("tags a bound style refusal with attribute: style", () => {
    const src = `export const A = (p) => <div style={p.style}>x</div>\n`
    const r = applyJsxStyleEdit({
      source: src,
      line: 1,
      column: 24,
      mode: "inline",
      declarations: { color: "blue" },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.fallback).toEqual({
        lane: "jsx-style",
        kind: "bound-binding",
        attribute: "style",
        expression: "p.style",
      })
    }
  })

  it("tags every spread refusal with lane + the attribute it could not set", () => {
    const cases: Array<{ src: string; mode: "classname" | "inline"; attribute: string }> = [
      // spread AFTER an existing className — may override the edit.
      {
        src: `export const A = (p) => <div className="a" {...p}>x</div>\n`,
        mode: "classname",
        attribute: "className",
      },
      // spread with NO className — may supply it.
      {
        src: `export const A = (p) => <div {...p}>x</div>\n`,
        mode: "classname",
        attribute: "className",
      },
      // spread AFTER an existing style.
      {
        src: `export const A = (p) => <div style={{ color: "red" }} {...p}>x</div>\n`,
        mode: "inline",
        attribute: "style",
      },
      // spread with NO style — may supply it.
      {
        src: `export const A = (p) => <div {...p}>x</div>\n`,
        mode: "inline",
        attribute: "style",
      },
    ]
    for (const c of cases) {
      const r = applyJsxStyleEdit({
        source: c.src,
        line: 1,
        column: 24,
        mode: c.mode,
        ...(c.mode === "classname"
          ? { addClasses: ["px-2"] }
          : { declarations: { color: "blue" } }),
      })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.fallback).toEqual({
          lane: "jsx-style",
          kind: "dynamic-vbind",
          attribute: c.attribute,
        })
      }
    }
  })

  it("isJsxStyleFallbackHint rejects a prop-lane hint and undefined", () => {
    // A PropEditFallbackHint carries no `lane` — it must NOT be routed to the
    // jsx-style refusal arm (it belongs to the agent mini-turn).
    expect(isJsxStyleFallbackHint({ kind: "bound-binding" })).toBe(false)
    expect(isJsxStyleFallbackHint({ kind: "v-model" })).toBe(false)
    expect(isJsxStyleFallbackHint(undefined)).toBe(false)
  })
})
