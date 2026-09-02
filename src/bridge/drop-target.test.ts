import { describe, expect, it } from "vitest"
import {
  axisForFlexDirection,
  computeDropIndex,
  isReverseFlexDirection,
  rectMidpoint,
} from "./drop-target"

describe("computeDropIndex", () => {
  // Three stacked children with vertical midpoints at 50/150/250.
  const mids = [50, 150, 250]
  it("drops before the first child when above its midpoint", () => {
    expect(computeDropIndex(mids, 10)).toBe(0)
    expect(computeDropIndex(mids, 49)).toBe(0)
  })
  it("drops between children by midpoint", () => {
    expect(computeDropIndex(mids, 100)).toBe(1) // past child0, before child1
    expect(computeDropIndex(mids, 200)).toBe(2) // past child0+1
  })
  it("appends when below the last midpoint", () => {
    expect(computeDropIndex(mids, 999)).toBe(3)
  })
  it("returns 0 for an empty container", () => {
    expect(computeDropIndex([], 123)).toBe(0)
  })
  it("treats exactly-on-midpoint as before that child (insert at its index)", () => {
    expect(computeDropIndex(mids, 150)).toBe(1)
  })
})

describe("axisForFlexDirection", () => {
  it("row layouts are horizontal", () => {
    expect(axisForFlexDirection("row")).toBe("horizontal")
    expect(axisForFlexDirection("row-reverse")).toBe("horizontal")
  })
  it("column/grid/block/absent are vertical", () => {
    expect(axisForFlexDirection("column")).toBe("vertical")
    expect(axisForFlexDirection("column-reverse")).toBe("vertical")
    expect(axisForFlexDirection(undefined)).toBe("vertical")
    expect(axisForFlexDirection("")).toBe("vertical")
  })
})

describe("isReverseFlexDirection", () => {
  it("detects reverse directions only", () => {
    expect(isReverseFlexDirection("row-reverse")).toBe(true)
    expect(isReverseFlexDirection("column-reverse")).toBe(true)
    expect(isReverseFlexDirection("row")).toBe(false)
    expect(isReverseFlexDirection("column")).toBe(false)
    expect(isReverseFlexDirection(undefined)).toBe(false)
  })
})

describe("rectMidpoint", () => {
  const rect = { top: 100, bottom: 200, left: 10, right: 30 }
  it("projects to the right axis", () => {
    expect(rectMidpoint(rect, "vertical")).toBe(150)
    expect(rectMidpoint(rect, "horizontal")).toBe(20)
  })
})
