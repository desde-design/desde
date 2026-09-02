import { describe, it, expect } from "vitest"
import { extractSlotInterpolationKey } from "./extract-slot-interpolation-key"

/**
 * Helper — build a minimal SFC with the given template body so we can
 * point the extractor at the inner element. The wrapping <template> +
 * <script> means SFC-absolute lines/columns line up with what
 * data-desde-src would carry in production.
 */
function sfc(templateBody: string): string {
  return `<script setup>const steps = [{ label: 'A' }, { label: 'B' }]</script>
<template>
${templateBody}
</template>
`
}

describe("extractSlotInterpolationKey", () => {
  it("returns the property key for a simple member-access interpolation", () => {
    const source = sfc(`  <KStep>{{ step.label }}</KStep>`)
    // <KStep> is on line 3, column 3 (2-space indent before `<`).
    const result = extractSlotInterpolationKey({
      source,
      line: 3,
      column: 3,
      itemVar: "step",
    })
    expect(result).toEqual({ ok: true, propertyKey: "label" })
  })

  it("refuses literal-text slot content", () => {
    const source = sfc(`  <KStep>Logging</KStep>`)
    const result = extractSlotInterpolationKey({
      source,
      line: 3,
      column: 3,
      itemVar: "step",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/static text/)
    }
  })

  it("refuses when the interpolation reads the entry itself (no property)", () => {
    const source = sfc(`  <KStep>{{ step }}</KStep>`)
    const result = extractSlotInterpolationKey({
      source,
      line: 3,
      column: 3,
      itemVar: "step",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/entry itself/)
    }
  })

  it("refuses nested member access (chained property)", () => {
    const source = sfc(`  <KStep>{{ step.detail.label }}</KStep>`)
    const result = extractSlotInterpolationKey({
      source,
      line: 3,
      column: 3,
      itemVar: "step",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/nested property/)
    }
  })

  it("refuses expressions (method call, concatenation)", () => {
    const source = sfc(`  <KStep>{{ step.label.toUpperCase() }}</KStep>`)
    const result = extractSlotInterpolationKey({
      source,
      line: 3,
      column: 3,
      itemVar: "step",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/not a simple member access/)
    }
  })

  it("refuses when the interpolation root doesn't match the iteratee", () => {
    const source = sfc(`  <KStep>{{ otherVar.label }}</KStep>`)
    const result = extractSlotInterpolationKey({
      source,
      line: 3,
      column: 3,
      itemVar: "step",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/does not match the v-for iteratee/)
    }
  })

  it("refuses mixed slot content (interpolation alongside element siblings)", () => {
    const source = sfc(`  <KStep>{{ step.label }}<KIcon /></KStep>`)
    const result = extractSlotInterpolationKey({
      source,
      line: 3,
      column: 3,
      itemVar: "step",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/significant children/)
    }
  })

  it("refuses empty slots", () => {
    const source = sfc(`  <KStep></KStep>`)
    const result = extractSlotInterpolationKey({
      source,
      line: 3,
      column: 3,
      itemVar: "step",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/no significant slot content/)
    }
  })

  it("refuses self-closing elements (no slot to inspect)", () => {
    const source = sfc(`  <KStep />`)
    const result = extractSlotInterpolationKey({
      source,
      line: 3,
      column: 3,
      itemVar: "step",
    })
    expect(result.ok).toBe(false)
  })

  it("returns a clear refusal when no element exists at the given location", () => {
    const source = sfc(`  <KStep>{{ step.label }}</KStep>`)
    const result = extractSlotInterpolationKey({
      source,
      line: 99,
      column: 1,
      itemVar: "step",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/No element found/)
    }
  })

  it("refuses a malformed iteratee root", () => {
    const source = sfc(`  <KStep>{{ step.label }}</KStep>`)
    const result = extractSlotInterpolationKey({
      source,
      line: 3,
      column: 3,
      itemVar: "not a valid identifier",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/bare identifier/)
    }
  })

  it("ignores whitespace inside the interpolation braces", () => {
    const source = sfc(`  <KStep>{{    step.label    }}</KStep>`)
    const result = extractSlotInterpolationKey({
      source,
      line: 3,
      column: 3,
      itemVar: "step",
    })
    expect(result).toEqual({ ok: true, propertyKey: "label" })
  })
})
