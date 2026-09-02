/**
 * Unit coverage for the JSX move/reorder applicator. Coordinates are Babel
 * coords (1-based line, 0-based column) — the same convention the JSX
 * source-tag plugin stamps. Mirrors apply-move-edit.test.ts.
 */
import { describe, it, expect } from "vitest"
import { applyJsxMoveEdit } from "./apply-jsx-move-edit"

// A small component with three element children in a wrapper. Lines/cols below
// are 1-based / 0-based to match Babel.
//   1 const C = () => (
//   2   <ul>
//   3     <li>A</li>
//   4     <li>B</li>
//   5     <li>C</li>
//   6   </ul>
//   7 )
const LIST = `const C = () => (
  <ul>
    <li>A</li>
    <li>B</li>
    <li>C</li>
  </ul>
)
`

describe("applyJsxMoveEdit — reorder within the same parent", () => {
  it("moves the first child to the end (append, -1)", () => {
    // <li>A</li> opening tag at line 3, col 4; <ul> at line 2, col 2.
    const r = applyJsxMoveEdit({
      source: LIST,
      sourceLine: 3,
      sourceColumn: 4,
      destParentLine: 2,
      destParentColumn: 2,
      destIndex: -1,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // A now follows C.
      const idxA = r.source.indexOf(">A<")
      const idxC = r.source.indexOf(">C<")
      expect(idxA).toBeGreaterThan(idxC)
    }
  })

  it("moves the last child to index 0 (front)", () => {
    // <li>C</li> at line 5, col 4.
    const r = applyJsxMoveEdit({
      source: LIST,
      sourceLine: 5,
      sourceColumn: 4,
      destParentLine: 2,
      destParentColumn: 2,
      destIndex: 0,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const idxC = r.source.indexOf(">C<")
      const idxA = r.source.indexOf(">A<")
      expect(idxC).toBeLessThan(idxA)
    }
  })

  it("refuses a same-position no-op", () => {
    const r = applyJsxMoveEdit({
      source: LIST,
      sourceLine: 3,
      sourceColumn: 4,
      destParentLine: 2,
      destParentColumn: 2,
      destIndex: 0,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/already at the requested position/)
  })
})

describe("applyJsxMoveEdit — cross-parent move (same file)", () => {
  const SRC = `const C = () => (
  <div>
    <section>
      <span>moveme</span>
    </section>
    <aside></aside>
  </div>
)
`
  it("moves a child into a different parent", () => {
    // <span> at line 4, col 6; <aside> at line 6, col 4.
    const r = applyJsxMoveEdit({
      source: SRC,
      sourceLine: 4,
      sourceColumn: 6,
      destParentLine: 6,
      destParentColumn: 4,
      destIndex: -1,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // span now lives inside <aside>.
      expect(r.source).toMatch(/<aside>[\s\S]*moveme[\s\S]*<\/aside>/)
      // and is gone from <section>.
      expect(r.source).toMatch(/<section>\s*<\/section>/)
    }
  })
})

describe("applyJsxMoveEdit — refusals", () => {
  it("refuses when the source element isn't found", () => {
    const r = applyJsxMoveEdit({
      source: LIST,
      sourceLine: 99,
      sourceColumn: 0,
      destParentLine: 2,
      destParentColumn: 2,
      destIndex: 0,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/No JSX element/)
  })

  it("refuses when the destination parent isn't found", () => {
    const r = applyJsxMoveEdit({
      source: LIST,
      sourceLine: 3,
      sourceColumn: 4,
      destParentLine: 99,
      destParentColumn: 0,
      destIndex: 0,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/No destination parent/)
  })

  it("refuses moving an element into its own descendant (cycle)", () => {
    // <div> is nested in <main> (so it passes the root guard); its own <span>
    // descendant is the move destination → cycle.
    const SRC = `const C = () => (
  <main>
    <div>
      <span></span>
    </div>
  </main>
)
`
    // source = <div> (line 3 col 4), dest = <span> inside it (line 4 col 6).
    const r = applyJsxMoveEdit({
      source: SRC,
      sourceLine: 3,
      sourceColumn: 4,
      destParentLine: 4,
      destParentColumn: 6,
      destIndex: 0,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/descendant|cycle/)
  })

  it("refuses moving a returned-root element (would leave `return;`)", () => {
    const SRC = `const C = () => <div><span>x</span></div>
const Other = () => <aside></aside>
`
    // source = the returned root <div> (line 1, col 16); dest = <aside> (line 2, col 20).
    const r = applyJsxMoveEdit({
      source: SRC,
      sourceLine: 1,
      sourceColumn: 16,
      destParentLine: 2,
      destParentColumn: 20,
      destIndex: -1,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/root or expression-embedded/)
  })

  it("refuses a self-closing destination", () => {
    const SRC = `const C = () => (
  <div>
    <span>x</span>
    <br />
  </div>
)
`
    // source = <span> (line 3 col 4), dest = <br /> (line 4 col 4).
    const r = applyJsxMoveEdit({
      source: SRC,
      sourceLine: 3,
      sourceColumn: 4,
      destParentLine: 4,
      destParentColumn: 4,
      destIndex: 0,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/self-closing/)
  })
})

// WS2 (tasks/edit-pipeline-rearchitecture.md) — semantic-closure guard. The
// JSX analog of the Vue lane's "invisible <template v-if> wrapper": a
// JSXExpressionContainer (`{cond && …}`, `{cond ? … : …}`, `{items.map(fn)}`)
// renders no DOM of its own, so moving an element out of it used to silently
// drop the gating condition (or, for `.map`, strand references to the
// callback's item-scoped variables). Repro'd pre-fix: all three shapes below
// returned `ok: true` and silently produced unconditional / scope-broken JSX.
describe("applyJsxMoveEdit — semantic-closure guard (expression containers)", () => {
  it("refuses moving out of a `{cond && <div>...}}` container", () => {
    const SRC = `const C = ({ cond }) => (
  <section>
    {cond && (
      <div>
        <span>keep</span>
        <button>target</button>
      </div>
    )}
    <footer></footer>
  </section>
)
`
    // <button>target</button> at line 6, col 8; dest <footer> at line 9, col 4.
    const r = applyJsxMoveEdit({
      source: SRC,
      sourceLine: 6,
      sourceColumn: 8,
      destParentLine: 9,
      destParentColumn: 4,
      destIndex: 0,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/enclosing \{cond && …\}/)
      expect(r.reason).toMatch(/stop being conditional/)
    }
  })

  it("refuses moving out of a `{cond ? <A/> : <B/>}` ternary branch", () => {
    const SRC = `const C = ({ cond }) => (
  <section>
    {cond ? (
      <div>
        <button>target</button>
      </div>
    ) : (
      <span>else</span>
    )}
    <footer></footer>
  </section>
)
`
    // <button>target</button> at line 5, col 8; dest <footer> at line 10, col 4.
    const r = applyJsxMoveEdit({
      source: SRC,
      sourceLine: 5,
      sourceColumn: 8,
      destParentLine: 10,
      destParentColumn: 4,
      destIndex: 0,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/enclosing \{cond \? … : …\}/)
      expect(r.reason).toMatch(/stop being conditional/)
    }
  })

  it("refuses moving out of a `.map` callback (item-scoped variable hazard)", () => {
    const SRC = `const C = ({ items }) => (
  <ul>
    {items.map((item) => (
      <li key={item.id}>
        <Row item={item} />
      </li>
    ))}
    <li className="footer">footer</li>
  </ul>
)
`
    // <Row item={item} /> at line 5, col 8; dest the footer <li> at line 8, col 4.
    const r = applyJsxMoveEdit({
      source: SRC,
      sourceLine: 5,
      sourceColumn: 8,
      destParentLine: 8,
      destParentColumn: 4,
      destIndex: 0,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/enclosing \{items\.map\(…\)\}/)
      expect(r.reason).toMatch(/item-scoped variables/)
    }
  })

  it("allows a move WITHIN the same expression container", () => {
    const SRC = `const C = ({ cond }) => (
  <section>
    {cond && (
      <div>
        <span>keep</span>
        <button>target</button>
        <em>tail</em>
      </div>
    )}
  </section>
)
`
    // <button>target</button> at line 6, col 8 -> front of the same <div> (line 4, col 6).
    const r = applyJsxMoveEdit({
      source: SRC,
      sourceLine: 6,
      sourceColumn: 8,
      destParentLine: 4,
      destParentColumn: 6,
      destIndex: 0,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const idxButton = r.source.indexOf("<button>target</button>")
      const idxSpan = r.source.indexOf("<span>keep</span>")
      expect(idxButton).toBeLessThan(idxSpan)
      // Still inside the same `cond &&` container.
      expect(r.source).toMatch(/\{cond && \(\s*<div>\s*<button>target<\/button>/)
    }
  })

  it("does not regress the existing expression-position-source refusal", () => {
    // The element directly under `cond && (...)` has no JSXElement/Fragment
    // parent (its parent is the JSXExpressionContainer) — already refused by
    // the root/expression-embedded guard, before the new container guard
    // even runs. Confirms the two guards don't conflict.
    const SRC = `const C = ({ cond }) => (
  <section>
    {cond && (
      <div>
        <span>x</span>
      </div>
    )}
    <footer></footer>
  </section>
)
`
    // <div> at line 4, col 6 (the direct expression content) -> <footer> at line 8, col 4.
    const r = applyJsxMoveEdit({
      source: SRC,
      sourceLine: 4,
      sourceColumn: 6,
      destParentLine: 8,
      destParentColumn: 4,
      destIndex: 0,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/root or expression-embedded/)
  })
})

// Boundary regression (codex WS2 P1): with no whitespace between the
// expression container and the next element (`}<footer/>`), an insertion
// before that next element has insertOffset === container.end — one past
// the closing brace, i.e. OUTSIDE the container. Must refuse.
describe("applyJsxMoveEdit — expression-container boundary (codex P1)", () => {
  it("refuses dropping immediately AFTER the container's closing brace", () => {
    const source = [
      "export function C({ cond }: { cond: boolean }) {",
      "  return (",
      "    <section>",
      "      {cond && <div><button className=\"b\">go</button></div>}<footer />",
      "    </section>",
      "  )",
      "}",
      "",
    ].join("\n")
    // Move <button> (inside the conditional) to <section> right where
    // <footer/> sits — insertion offset lands exactly at container.end.
    const result = applyJsxMoveEdit({
      source,
      sourceLine: 4,
      sourceColumn: 20,
      destParentLine: 3,
      destParentColumn: 4,
      destIndex: 0,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/cond &&|conditional/i)
  })
})
