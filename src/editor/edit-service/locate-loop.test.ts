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

describe("locateLoopAt", () => {
  it("finds the .map() enclosing a JSX element", () => {
    const r = locateLoopAt({ file: "src/List.tsx", source: LIST_TSX, templateLocation: babelLoc(LIST_TSX, "<li key") })
    expect(r).toEqual({ found: true, kind: "map", expression: "items.map" })
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
    expect(r).toEqual({ found: true, kind: "v-for", expression: "r in rows" })
  })

  it("reports no loop for a plain Vue element", () => {
    const r = locateLoopAt({ file: "src/Plain.vue", source: PLAIN_VUE, templateLocation: { line: 3, column: 5 } })
    expect(r.found).toBe(false)
  })

  it("refuses an unsupported extension", () => {
    const r = locateLoopAt({ file: "src/x.svelte", source: "", templateLocation: { line: 1, column: 0 } })
    expect(r).toEqual({ found: false, reason: "Only .vue, .tsx, and .jsx files can be checked for a loop" })
  })
})
