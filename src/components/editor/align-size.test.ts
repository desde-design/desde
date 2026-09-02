/**
 * Tests for the alignment & sizing class helpers (direct-manip Phase 1).
 * Pure mapping: parse a group out of a class list (last-wins, all raws
 * collected) + set* → ClassMutation applied via applyClassMutation.
 */

import { describe, expect, it } from "vitest"
import {
  applyClassMutation,
  isFlexLikeContainer,
  parseAlignItems,
  parseJustify,
  parseTextAlign,
  parseWidth,
  setAlignItems,
  setJustify,
  setTextAlign,
  setWidth,
} from "./align-size"

describe("parse* (last-wins + raws)", () => {
  it("parses the representable value and collects every matching class", () => {
    const classes = ["flex", "justify-start", "justify-center", "p-4"]
    const j = parseJustify(classes)
    expect(j.value).toBe("center") // last representable wins
    expect(j.raws).toEqual(["justify-start", "justify-center"]) // both removed on set
    expect(j.unrepresentable).toBe(false)
  })

  it("shows custom when a trailing unrepresentable utility wins (last-match convention)", () => {
    // `justify-start justify-between` — between is last so it wins; the control
    // must show custom (value null), not falsely highlight start (codex).
    const j = parseJustify(["flex", "justify-start", "justify-between"])
    expect(j.value).toBeNull()
    expect(j.unrepresentable).toBe(true)
    expect(j.raws).toEqual(["justify-start", "justify-between"])
    // ...but a representable utility AFTER an unrepresentable one wins normally.
    expect(parseJustify(["justify-between", "justify-end"]).value).toBe("end")
    // Width: w-full then w-64 → custom.
    const w = parseWidth(["w-full", "w-64"])
    expect(w.value).toBeNull()
    expect(w.unrepresentable).toBe(true)
  })

  it("flags an unrepresentable value (justify-between) but still tracks it for removal", () => {
    const j = parseJustify(["flex", "justify-between"])
    expect(j.value).toBeNull()
    expect(j.raws).toEqual(["justify-between"])
    expect(j.unrepresentable).toBe(true)
  })

  it("maps logical text-align aliases (text-start/text-end) to left/right", () => {
    expect(parseTextAlign(["text-start"]).value).toBe("left")
    expect(parseTextAlign(["text-end"]).value).toBe("right")
    expect(parseTextAlign(["text-center"]).value).toBe("center")
  })

  it("parses items- and width presets; ignores min-w-/max-w-", () => {
    expect(parseAlignItems(["items-stretch"]).unrepresentable).toBe(true)
    expect(parseAlignItems(["items-center"]).value).toBe("center")
    const w = parseWidth(["w-full", "min-w-0", "max-w-lg"])
    expect(w.value).toBe("full")
    expect(w.raws).toEqual(["w-full"]) // min-w/max-w excluded
  })

  it("captures a fixed/fractional width for removal even though it's not a v1 preset", () => {
    const w = parseWidth(["w-64"])
    expect(w.value).toBeNull()
    expect(w.unrepresentable).toBe(true)
    expect(w.raws).toEqual(["w-64"])
  })
})

describe("set* → ClassMutation (via applyClassMutation)", () => {
  it("replaces an existing justify value (removes all, adds the new)", () => {
    const classes = ["flex", "justify-start", "justify-between", "p-4"]
    const j = parseJustify(classes)
    const next = applyClassMutation(classes, setJustify(j, "end"))
    expect(next).toContain("justify-end")
    expect(next).not.toContain("justify-start")
    expect(next).not.toContain("justify-between")
    expect(next).toContain("flex")
    expect(next).toContain("p-4")
  })

  it("clears a group when value is null", () => {
    const classes = ["items-center", "gap-2"]
    const a = parseAlignItems(classes)
    const next = applyClassMutation(classes, setAlignItems(a, null))
    expect(next).not.toContain("items-center")
    expect(next).toEqual(["gap-2"])
  })

  it("sets width preset, replacing a prior fixed width", () => {
    const classes = ["w-64", "rounded"]
    const w = parseWidth(classes)
    const next = applyClassMutation(classes, setWidth(w, "full"))
    expect(next).toContain("w-full")
    expect(next).not.toContain("w-64")
    expect(next).toContain("rounded")
  })

  it("sets text-align", () => {
    const classes = ["text-left"]
    const t = parseTextAlign(classes)
    const next = applyClassMutation(classes, setTextAlign(t, "center"))
    expect(next).toEqual(["text-center"])
  })

  it("round-trips: parse(after a set) reflects the new value", () => {
    let classes = ["flex"]
    classes = applyClassMutation(classes, setJustify(parseJustify(classes), "center"))
    classes = applyClassMutation(classes, setAlignItems(parseAlignItems(classes), "end"))
    expect(parseJustify(classes).value).toBe("center")
    expect(parseAlignItems(classes).value).toBe("end")
  })
})

describe("isFlexLikeContainer", () => {
  it("is true for flex/grid displays, false otherwise / when absent", () => {
    expect(isFlexLikeContainer({ display: "flex" })).toBe(true)
    expect(isFlexLikeContainer({ display: "inline-flex" })).toBe(true)
    expect(isFlexLikeContainer({ display: "grid" })).toBe(true)
    expect(isFlexLikeContainer({ display: "block" })).toBe(false)
    expect(isFlexLikeContainer({})).toBe(false)
    expect(isFlexLikeContainer(undefined)).toBe(false)
  })
})
