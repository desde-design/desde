/**
 * Unit coverage for the JSX source-tag plugin's `transform`: every
 * JSXOpeningElement gets a `data-desde-src="<file>:<line>:<col>"` stamp at the
 * right Babel coordinates (1-based line, 0-based column), inserted right after
 * the tag name; component / member / self-closing elements and fragments are
 * handled; attribute values containing `>` survive (the failure mode that
 * killed the regex approach); the transform is idempotent and bails on
 * non-JSX / node_modules. Each element also gets a `data-desde-v="<12-hex-hash>"`
 * version stamp.
 */
import { describe, it, expect } from "vitest"
import { jsxSourceTagPlugin } from "./jsx-source-tag-plugin"
// Deliberately from `./source-version`, not `./source-tag-plugin`: importing it
// from the Vue stamper would pull `@vue/compiler-sfc` into the React lane's
// module graph, which is exactly the coupling this file's subject must not have.
import { sourceVersionOf } from "./source-version"

const REPO_ROOT = "/repo"

/** Run the plugin's transform on `code` for a synthetic file. */
function transform(code: string, file = "src/Test.tsx"): string {
  const plugin = jsxSourceTagPlugin({ repoRoot: REPO_ROOT })
  const t = plugin.transform as (
    this: unknown,
    code: string,
    id: string,
  ) => { code: string } | null
  const out = t.call({}, code, `${REPO_ROOT}/${file}`)
  return out ? out.code : code
}

/** All `data-desde-src` values in transformed output, in source order. */
function stamps(code: string): string[] {
  return [...code.matchAll(/data-desde-src="([^"]*)"/g)].map((m) => m[1])
}

describe("jsx-source-tag-plugin", () => {
  it("stamps nested host elements at their Babel line:col (1-based line, 0-based col)", () => {
    const code = `const C = () => (
  <div className="a">
    <span>hi</span>
  </div>
)
`
    const out = transform(code)
    // <div> is line 2, indented 2 → col 2; <span> is line 3, indented 4 → col 4.
    expect(stamps(out)).toEqual(["src/Test.tsx:2:2", "src/Test.tsx:3:4"])
    // Stamp lands right after the tag name, before existing attributes.
    // data-desde-v is the version hash; both attrs are present.
    const expectedHash = sourceVersionOf(code)
    expect(out).toContain(`<div data-desde-v="${expectedHash}" data-desde-src="src/Test.tsx:2:2" className="a">`)
    expect(out).toContain(`<span data-desde-v="${expectedHash}" data-desde-src="src/Test.tsx:3:4">`)
  })

  it("stamps component and member-expression elements", () => {
    const code = `const C = () => <Foo.Bar baz={1} />\n`
    const out = transform(code)
    const expectedHash = sourceVersionOf(code)
    expect(out).toContain(`<Foo.Bar data-desde-call="src/Test.tsx:1:16 Foo.Bar" data-desde-v="${expectedHash}" data-desde-src="src/Test.tsx:1:16" baz={1} />`)
  })

  it("stamps a self-closing element", () => {
    const code = `const C = () => <img src="x" />\n`
    const out = transform(code)
    const expectedHash = sourceVersionOf(code)
    expect(out).toContain(`<img data-desde-v="${expectedHash}" data-desde-src="src/Test.tsx:1:16" src="x" />`)
  })

  it("preserves attribute values containing '>' (the regex-killer)", () => {
    const code = `const C = () => <div title="a > b">x</div>\n`
    const out = transform(code)
    const expectedHash = sourceVersionOf(code)
    expect(out).toContain(`<div data-desde-v="${expectedHash}" data-desde-src="src/Test.tsx:1:16" title="a > b">`)
    expect(stamps(out)).toHaveLength(1)
  })

  it("stamps after TSX type arguments on a generic component (<Table<Row> …>)", () => {
    const code = `const C = () => <Table<Row> rows={r} />\n`
    const out = transform(code)
    // Must land after `<Row>`, not split the type args.
    const expectedHash = sourceVersionOf(code)
    expect(out).toContain(`<Table<Row> data-desde-call="src/Test.tsx:1:16 Table" data-desde-v="${expectedHash}" data-desde-src="src/Test.tsx:1:16" rows={r} />`)
  })

  it("skips fragments but still stamps their children", () => {
    const code = `const C = () => (
  <>
    <p>a</p>
  </>
)
`
    const out = transform(code)
    // Only the <p>, not the fragment.
    expect(stamps(out)).toEqual(["src/Test.tsx:3:4"])
  })

  it("stamps AFTER the last attribute when an element has a {...spread}", () => {
    // A forwarded data-desde-src in the spread must not clobber the element's own
    // stamp — so the stamp goes last (later-key-wins on React's prop merge).
    const code = `const C = (props) => <Card {...props} title="x" />\n`
    const out = transform(code)
    const expectedHash = sourceVersionOf(code)
    expect(out).toContain(`<Card {...props} title="x" data-desde-call="src/Test.tsx:1:21 Card" data-desde-v="${expectedHash}" data-desde-src="src/Test.tsx:1:21" />`)
  })

  it("stamps after a sole {...spread}", () => {
    const code = `const C = (props) => <Card {...props} />\n`
    const out = transform(code)
    const expectedHash = sourceVersionOf(code)
    expect(out).toContain(`<Card {...props} data-desde-call="src/Test.tsx:1:21 Card" data-desde-v="${expectedHash}" data-desde-src="src/Test.tsx:1:21" />`)
  })

  it("is idempotent — re-running does not double-stamp", () => {
    const code = `const C = () => <div className="a">x</div>\n`
    const once = transform(code)
    const twice = transform(once)
    expect(twice).toBe(once)
    expect(stamps(twice)).toHaveLength(1)
    // Verify data-desde-v is also not duplicated
    const versionMatches = [...twice.matchAll(/data-desde-v="[^"]*"/g)]
    expect(versionMatches).toHaveLength(1)
  })

  it("stamps each element with data-desde-v equal to sourceVersionOf(input)", () => {
    const code = `const C = () => (
  <div>
    <span>text</span>
  </div>
)
`
    const out = transform(code)
    const expectedVersion = sourceVersionOf(code)
    const versionMatches = [...out.matchAll(/data-desde-v="([^"]*)"/g)]
    expect(versionMatches).toHaveLength(2)
    expect(versionMatches[0][1]).toBe(expectedVersion)
    expect(versionMatches[1][1]).toBe(expectedVersion)
  })

  it("stamps data-desde-v with exactly 12 lowercase hex chars", () => {
    const code = `const C = () => <div>test</div>\n`
    const out = transform(code)
    const versionMatches = [...out.matchAll(/data-desde-v="([^"]*)"/g)]
    expect(versionMatches).toHaveLength(1)
    const hash = versionMatches[0][1]
    expect(hash).toMatch(/^[0-9a-f]{12}$/)
  })

  it("handles .jsx (no typescript plugin)", () => {
    const code = `const C = () => <button onClick={f}>Go</button>\n`
    const out = transform(code, "src/Test.jsx")
    const expectedHash = sourceVersionOf(code)
    expect(out).toContain(`<button data-desde-v="${expectedHash}" data-desde-src="src/Test.jsx:1:16" onClick={f}>`)
  })

  it("stamps TS-specific .tsx syntax (generics, type annotations)", () => {
    const code = `const C = (p: { n: number }) => <div>{p.n as number}</div>\n`
    const out = transform(code)
    expect(stamps(out)).toEqual(["src/Test.tsx:1:32"])
  })

  it("bails on non-JSX extensions", () => {
    const code = `export const x = 1\n`
    expect(transform(code, "src/util.ts")).toBe(code)
  })

  it("bails inside node_modules", () => {
    const code = `const C = () => <div>x</div>\n`
    const plugin = jsxSourceTagPlugin({ repoRoot: REPO_ROOT })
    const t = plugin.transform as (this: unknown, code: string, id: string) => { code: string } | null
    const out = t.call({}, code, `${REPO_ROOT}/node_modules/pkg/dist/Foo.jsx`)
    expect(out).toBeNull()
  })

  it("returns null (no-op) for a JSX-free module", () => {
    const code = `export function add(a: number, b: number) { return a + b }\n`
    const plugin = jsxSourceTagPlugin({ repoRoot: REPO_ROOT })
    const t = plugin.transform as (this: unknown, code: string, id: string) => { code: string } | null
    expect(t.call({}, code, `${REPO_ROOT}/src/math.tsx`)).toBeNull()
  })

  it("strips a Vite query suffix before the extension check", () => {
    const code = `const C = () => <div>x</div>\n`
    const plugin = jsxSourceTagPlugin({ repoRoot: REPO_ROOT })
    const t = plugin.transform as (this: unknown, code: string, id: string) => { code: string } | null
    const out = t.call({}, code, `${REPO_ROOT}/src/Test.tsx?t=123`)
    expect(out?.code).toContain('data-desde-src="src/Test.tsx:1:16"')
  })
})

/**
 * `data-desde-call` — the CALLSITE stamp, written on component elements only.
 *
 * Why a second attribute: a component that spreads its props onto its root
 * (`function Card(props) { return <div {...props} /> }`) receives the caller's
 * `data-desde-src` through the spread and then overwrites it with the root's
 * own stamp, which is placed after the spread on purpose. When the component
 * renders on the server (Next.js App Router) there is no client fiber to
 * recover the callsite from either, so the callsite is lost entirely: four
 * sibling `<Card>`s all resolve to `card.tsx:10:4`, and reordering them is
 * refused. A distinct attribute name survives the spread because the callee
 * never writes it on a host element.
 */
describe("jsx-source-tag-plugin — data-desde-call", () => {
  /** All `data-desde-call` values in transformed output, in source order. */
  function callStamps(code: string): string[] {
    return [...code.matchAll(/data-desde-call="([^"]*)"/g)].map((m) => m[1])
  }

  it("writes data-desde-call on a component element, carrying the tag name", () => {
    const code = `const P = () => <Card />\n`
    expect(callStamps(transform(code))).toEqual(["src/Test.tsx:1:16 Card"])
  })

  it("does NOT write data-desde-call on a host element", () => {
    const code = `const P = () => <div className="a"><span>x</span></div>\n`
    expect(callStamps(transform(code))).toEqual([])
  })

  it("writes it for a member-expression component with the dotted tag", () => {
    const code = `const P = () => <Router.Outlet />\n`
    expect(callStamps(transform(code))).toEqual(["src/Test.tsx:1:16 Router.Outlet"])
  })

  it("places it after a {...spread}, next to the other stamps, so the nearest callsite wins", () => {
    const code = `const C = (props) => <Card {...props} />\n`
    const out = transform(code)
    const spreadEnd = out.indexOf("{...props}") + "{...props}".length
    const callAt = out.indexOf("data-desde-call=")
    expect(callAt).toBeGreaterThan(spreadEnd)
  })

  it("is idempotent — a re-run adds no second data-desde-call", () => {
    const code = `const P = () => <Card />\n`
    const once = transform(code)
    expect(callStamps(transform(once))).toHaveLength(1)
  })
})
