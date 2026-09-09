import { describe, expect, it } from "vitest"
import { fieldLocationInsideLoop } from "./field-inside-loop"

/**
 * Two loops in one file, so "inside the loop at templateLocation" has a wrong
 * answer available. The attack the confinement closes: verify the first loop,
 * point `fieldLocation` at a field in the second, and the property read there
 * is patched into the FIRST loop's array.
 */
const TSX = `export function Page() {
  return (
    <div>
      <ul>
        {rows.map((r) => (
          <li key={r.id}><span>{r.label}</span></li>
        ))}
      </ul>
      <ol>
        {other.map((o) => (
          <li key={o.id}><span>{o.secret}</span></li>
        ))}
      </ol>
    </div>
  )
}
`

const VUE = `<template>
  <ul>
    <li v-for="r in rows" :key="r.id"><span>{{ r.label }}</span></li>
  </ul>
  <ol>
    <li v-for="o in other" :key="o.id"><span>{{ o.secret }}</span></li>
  </ol>
</template>
<script setup>
const rows = [{ id: 1, label: 'A' }]
const other = [{ id: 1, secret: 'x' }]
</script>
`

/** 1-based line, 0-based column: the position of `needle`'s first character. */
function at(source: string, needle: string, occurrence = 1): { line: number; column: number } {
  let index = -1
  for (let i = 0; i < occurrence; i++) index = source.indexOf(needle, index + 1)
  const before = source.slice(0, index)
  const line = before.split("\n").length
  return { line, column: index - (before.lastIndexOf("\n") + 1) }
}

/** The same, in Vue's 1-based column convention. */
function atVue(source: string, needle: string, occurrence = 1): { line: number; column: number } {
  const p = at(source, needle, occurrence)
  return { line: p.line, column: p.column + 1 }
}

describe("fieldLocationInsideLoop — JSX", () => {
  const firstLoopRow = at(TSX, "<li key={r.id}")
  const secondLoopRow = at(TSX, "<li key={o.id}")

  it("accepts a field nested inside the verified loop", () => {
    expect(
      fieldLocationInsideLoop({
        file: "src/Page.tsx",
        source: TSX,
        templateLocation: firstLoopRow,
        fieldLocation: at(TSX, "<span>{r.label}"),
      }),
    ).toEqual({ ok: true })
  })

  it("accepts the loop root itself", () => {
    expect(
      fieldLocationInsideLoop({
        file: "src/Page.tsx",
        source: TSX,
        templateLocation: firstLoopRow,
        fieldLocation: firstLoopRow,
      }),
    ).toEqual({ ok: true })
  })

  it("REFUSES a field in a different loop of the same file", () => {
    const result = fieldLocationInsideLoop({
      file: "src/Page.tsx",
      source: TSX,
      templateLocation: firstLoopRow,
      fieldLocation: at(TSX, "<span>{o.secret}"),
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe(
      "fieldLocation must be inside the loop at templateLocation",
    )
  })

  it("REFUSES a field outside any loop", () => {
    const result = fieldLocationInsideLoop({
      file: "src/Page.tsx",
      source: TSX,
      templateLocation: firstLoopRow,
      fieldLocation: at(TSX, "<div>"),
    })
    expect(result.ok).toBe(false)
  })

  it("refuses when there is no loop at templateLocation at all", () => {
    const result = fieldLocationInsideLoop({
      file: "src/Page.tsx",
      source: TSX,
      templateLocation: at(TSX, "<div>"),
      fieldLocation: at(TSX, "<span>{r.label}"),
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/No loop at templateLocation/)
  })

  it("still sees the second loop as its own loop, so this is confinement and not a ban", () => {
    expect(
      fieldLocationInsideLoop({
        file: "src/Page.tsx",
        source: TSX,
        templateLocation: secondLoopRow,
        fieldLocation: at(TSX, "<span>{o.secret}"),
      }),
    ).toEqual({ ok: true })
  })
})

describe("fieldLocationInsideLoop — Vue", () => {
  const firstLoopRow = atVue(VUE, '<li v-for="r in rows"')

  it("accepts a field nested inside the verified loop", () => {
    expect(
      fieldLocationInsideLoop({
        file: "src/Page.vue",
        source: VUE,
        templateLocation: firstLoopRow,
        fieldLocation: atVue(VUE, "<span>{{ r.label }}"),
      }),
    ).toEqual({ ok: true })
  })

  it("REFUSES a field in a different v-for of the same file", () => {
    const result = fieldLocationInsideLoop({
      file: "src/Page.vue",
      source: VUE,
      templateLocation: firstLoopRow,
      fieldLocation: atVue(VUE, "<span>{{ o.secret }}"),
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe(
      "fieldLocation must be inside the loop at templateLocation",
    )
  })

  it("REFUSES a line that does not exist in the file", () => {
    const result = fieldLocationInsideLoop({
      file: "src/Page.vue",
      source: VUE,
      templateLocation: firstLoopRow,
      fieldLocation: { line: 9999, column: 1 },
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/not a position in this file/)
  })

  it("refuses an unsupported extension rather than allowing it through", () => {
    const result = fieldLocationInsideLoop({
      file: "src/Page.ts",
      source: VUE,
      templateLocation: firstLoopRow,
      fieldLocation: firstLoopRow,
    })
    expect(result.ok).toBe(false)
  })
})
