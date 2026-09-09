import { describe, expect, it } from "vitest"
import { locateLoopAt } from "./locate-loop"

function babelLoc(src: string, marker: string): { line: number; column: number } {
  const idx = src.indexOf(marker)
  const before = src.slice(0, idx)
  return { line: before.split("\n").length, column: idx - (before.lastIndexOf("\n") + 1) }
}

const LIST_TSX = `const items = [{ id: 1 }, { id: 2 }]
export function List() {
  return (
    <ul>
      {items.map((item) => <li key={item.id}>{item.id}</li>)}
    </ul>
  )
}
`

// Four hand-written usages of one component. The DOM shows four nodes with
// one stamp, but there is no loop in source. This is the incident shape.
const CARDS_TSX = `function CardAction({ ...props }: { children?: unknown }) {
  return <div data-slot="card-action" {...props} />
}
export function Cards() {
  return (
    <section>
      <CardAction>a</CardAction>
      <CardAction>b</CardAction>
      <CardAction>c</CardAction>
      <CardAction>d</CardAction>
    </section>
  )
}
`

const LIST_VUE = `<script setup>
const rows = [{ id: 1 }, { id: 2 }]
</script>
<template>
  <ul>
    <li v-for="r in rows" :key="r.id">{{ r.id }}</li>
  </ul>
</template>
`

const PLAIN_VUE = `<template>
  <ul>
    <li>one</li>
    <li>two</li>
  </ul>
</template>
`

// A nested element inside a loop row. The click stamps the SPAN, not the
// `<li v-for>`, and the span is just as much a loop row as its parent.
const NESTED_VUE = `<script setup>
const rows = [{ id: 1 }, { id: 2 }]
</script>
<template>
  <ul>
    <li v-for="r in rows" :key="r.id">
      <span class="label">{{ r.id }}</span>
    </li>
  </ul>
</template>
`

const NESTED_NO_LOOP_VUE = `<template>
  <ul>
    <li>
      <span class="label">one</span>
    </li>
  </ul>
</template>
`

const NESTED_TSX = `const items = [{ id: 1 }, { id: 2 }]
export function List() {
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}><span className="label">{item.id}</span></li>
      ))}
    </ul>
  )
}
`

describe("locateLoopAt", () => {
  it("finds the .map() enclosing a JSX element", () => {
    const r = locateLoopAt({ file: "src/List.tsx", source: LIST_TSX, templateLocation: babelLoc(LIST_TSX, "<li key") })
    expect(r).toEqual({
      found: true,
      kind: "map",
      expression: "items.map",
      // The clicked element IS the callback's root here, so the reported
      // loop position is the position asked about.
      location: babelLoc(LIST_TSX, "<li key"),
    })
  })

  it("reports no loop for a component's own root rendered by repeated usages", () => {
    const r = locateLoopAt({ file: "src/cards.tsx", source: CARDS_TSX, templateLocation: babelLoc(CARDS_TSX, "<div data-slot") })
    expect(r.found).toBe(false)
    if (!r.found) expect(r.reason).toMatch(/not rendered by a `.map\(\)`/)
  })

  it("reports no element when the position points at nothing", () => {
    const r = locateLoopAt({ file: "src/List.tsx", source: LIST_TSX, templateLocation: { line: 1, column: 0 } })
    expect(r.found).toBe(false)
  })

  it("finds a v-for in a Vue SFC (SFC-absolute, 1-based column)", () => {
    // Line 6 of the SFC, column of `<li`. Vue positions are 1-based.
    const r = locateLoopAt({ file: "src/List.vue", source: LIST_VUE, templateLocation: { line: 6, column: 5 } })
    expect(r).toEqual({
      found: true,
      kind: "v-for",
      expression: "r in rows",
      location: { line: 6, column: 5 },
    })
  })

  it("reports no loop for a plain Vue element", () => {
    const r = locateLoopAt({ file: "src/Plain.vue", source: PLAIN_VUE, templateLocation: { line: 3, column: 5 } })
    expect(r.found).toBe(false)
  })

  it("finds the v-for enclosing a NESTED Vue element, not just the v-for node itself", () => {
    // The bridge stamps the element the user clicked. Clicking the label
    // inside a loop row used to answer "no loop", which handed the edit to
    // chat with a false premise and made "all rows" unreachable.
    const r = locateLoopAt({ file: "src/List.vue", source: NESTED_VUE, templateLocation: { line: 7, column: 7 } })
    expect(r).toEqual({
      found: true,
      kind: "v-for",
      expression: "r in rows",
      // The `<li v-for>` on line 6, NOT the span on line 7 that was clicked.
      // "This item" dispatches against this, and the data resolver matches
      // the loop element exactly.
      location: { line: 6, column: 5 },
    })
  })

  it("reports no loop for a nested Vue element with no enclosing v-for", () => {
    const r = locateLoopAt({
      file: "src/Plain.vue",
      source: NESTED_NO_LOOP_VUE,
      templateLocation: { line: 4, column: 7 },
    })
    expect(r.found).toBe(false)
    if (!r.found) expect(r.reason).toBe("This element is not inside a `v-for`")
  })

  it("distinguishes 'nothing at that position' from 'no loop encloses it' in Vue", () => {
    const r = locateLoopAt({ file: "src/Plain.vue", source: PLAIN_VUE, templateLocation: { line: 99, column: 1 } })
    expect(r.found).toBe(false)
    if (!r.found) expect(r.reason).toBe("No element at 99:1")
  })

  it("finds the .map() enclosing a NESTED JSX element", () => {
    const r = locateLoopAt({
      file: "src/List.tsx",
      source: NESTED_TSX,
      templateLocation: babelLoc(NESTED_TSX, "<span className"),
    })
    expect(r).toEqual({
      found: true,
      kind: "map",
      expression: "items.map",
      // The `<li>` the callback returns, not the span that was clicked.
      location: babelLoc(NESTED_TSX, "<li key"),
    })
  })

  it("reports the row's position for an element nested several levels into a JSX row", () => {
    const DEEP_TSX = `const items = [{ id: 1 }]
export function List() {
  return (
    <ul>
      {items.map((item) => {
        return (
          <li key={item.id}>
            <div className="wrap"><span className="label">{item.id}</span></div>
          </li>
        )
      })}
    </ul>
  )
}
`
    const r = locateLoopAt({
      file: "src/List.tsx",
      source: DEEP_TSX,
      templateLocation: babelLoc(DEEP_TSX, "<span className"),
    })
    // A block body with a `return`, and two levels of nesting. The row is
    // still the `<li>`.
    expect(r.found).toBe(true)
    if (r.found) expect(r.location).toEqual(babelLoc(DEEP_TSX, "<li key"))
  })

  it("refuses an unsupported extension", () => {
    const r = locateLoopAt({ file: "src/x.svelte", source: "", templateLocation: { line: 1, column: 0 } })
    expect(r).toEqual({ found: false, reason: "Only .vue, .tsx, and .jsx files can be checked for a loop" })
  })
})
