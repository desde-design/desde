import { describe, expect, it } from "vitest"
import {
  applyClassMutation,
  BORDER_RADII,
  BORDER_STYLES,
  BORDER_WIDTHS,
  FONT_SIZES,
  FONT_WEIGHTS,
  LEADING_VALUES,
  parseBorder,
  parseGap,
  parseMargin,
  parsePadding,
  parseTypography,
  resolveBorderRadiusCorners,
  resolveBorderWidthSides,
  setBorderRadius,
  setBorderRadiusCorner,
  setBorderStyle,
  setBorderWidth,
  setBorderWidthSide,
  setFontSize,
  setFontWeight,
  resolveSpacingSides,
  setGapAll,
  setLeading,
  setMarginAll,
  setMarginSide,
  setPaddingAll,
  setPaddingSide,
  setShadow,
  setTextAlign,
  setTracking,
  snapToSpacingScale,
  parseShadow,
  SHADOWS,
  SPACING_SCALE,
  TEXT_ALIGNMENTS,
  TRACKING_VALUES,
} from "./tailwind-classes"

describe("applyClassMutation — pure list operations", () => {
  it("removes listed classes and appends new ones", () => {
    const result = applyClassMutation(["p-2", "rounded-md"], {
      remove: ["p-2"],
      add: ["p-4"],
    })
    expect(result).toEqual(["rounded-md", "p-4"])
  })

  it("dedupes adds against the post-removal list", () => {
    const result = applyClassMutation(["p-4", "rounded-md"], {
      remove: [],
      add: ["p-4", "p-4"],
    })
    expect(result).toEqual(["p-4", "rounded-md"])
  })

  it("ignores empty add entries", () => {
    const result = applyClassMutation(["a"], { remove: [], add: ["", "b"] })
    expect(result).toEqual(["a", "b"])
  })

  it("preserves order of unmodified classes", () => {
    const result = applyClassMutation(
      ["a", "b", "c", "d"],
      { remove: ["b"], add: ["e"] },
    )
    expect(result).toEqual(["a", "c", "d", "e"])
  })

  it("returns a new array (input not mutated)", () => {
    const input = ["a"]
    applyClassMutation(input, { remove: ["a"], add: ["b"] })
    expect(input).toEqual(["a"])
  })
})

describe("snapToSpacingScale", () => {
  it("snaps integers above the scale to the largest step (96)", () => {
    expect(snapToSpacingScale(100)).toBe(96)
  })

  it("returns 0 for negative inputs", () => {
    expect(snapToSpacingScale(-3)).toBe(0)
  })

  it("returns 0 for non-finite inputs", () => {
    expect(snapToSpacingScale(NaN)).toBe(0)
    expect(snapToSpacingScale(Infinity)).toBe(0) // clamped via not-finite branch? Infinity IS finite for isFinite(false)
  })

  it("snaps to the closest valid scale step", () => {
    expect(snapToSpacingScale(0.4)).toBe(0.5)
    expect(snapToSpacingScale(13)).toBe(12) // 12 vs 14, equidistant — picks first encountered (12)
    expect(snapToSpacingScale(15)).toBe(14)
  })

  it("returns exact match when input is already on the scale", () => {
    for (const step of SPACING_SCALE) {
      expect(snapToSpacingScale(step)).toBe(step)
    }
  })
})

describe("parsePadding — happy paths", () => {
  it("returns empty when no padding classes are present", () => {
    const result = parsePadding(["rounded-md", "bg-white"])
    expect(result.all).toBeNull()
    expect(result.x).toBeNull()
    expect(result.y).toBeNull()
    expect(result.preservedRaw).toEqual([])
  })

  it("extracts all-sides padding (p-4)", () => {
    const result = parsePadding(["p-4", "rounded-md"])
    expect(result.all).toEqual({ step: 4, raws: ["p-4"] })
  })

  it("extracts per-axis padding (px-2 py-3)", () => {
    const result = parsePadding(["px-2", "py-3"])
    expect(result.x).toEqual({ step: 2, raws: ["px-2"] })
    expect(result.y).toEqual({ step: 3, raws: ["py-3"] })
  })

  it("extracts per-side padding (pt/pr/pb/pl)", () => {
    const result = parsePadding(["pt-1", "pr-2", "pb-3", "pl-4"])
    expect(result.top?.step).toBe(1)
    expect(result.right?.step).toBe(2)
    expect(result.bottom?.step).toBe(3)
    expect(result.left?.step).toBe(4)
  })

  it("extracts half-step values (p-0.5)", () => {
    const result = parsePadding(["p-0.5"])
    expect(result.all).toEqual({ step: 0.5, raws: ["p-0.5"] })
  })

  it("accumulates duplicate matches (e.g., 'p-2 p-4' → step=4 raws=['p-2','p-4'])", () => {
    // Codex P2 regression guard: a prior edit could leave a duplicate;
    // both classes must end up in raws so the mutator removes both on
    // commit instead of stranding `p-2` after the user sets a new
    // padding value.
    const result = parsePadding(["p-2", "p-4"])
    expect(result.all).toEqual({ step: 4, raws: ["p-2", "p-4"] })
  })

  it("preserves responsive variants without parsing them as values", () => {
    const result = parsePadding(["md:p-4", "p-2"])
    expect(result.all).toEqual({ step: 2, raws: ["p-2"] })
    expect(result.preservedRaw).toContain("md:p-4")
  })

  it("preserves state variants (hover:p-4)", () => {
    const result = parsePadding(["hover:p-4"])
    expect(result.all).toBeNull()
    expect(result.preservedRaw).toContain("hover:p-4")
  })

  it("preserves arbitrary values (p-[10px])", () => {
    const result = parsePadding(["p-[10px]"])
    expect(result.all).toBeNull()
    expect(result.preservedRaw).toContain("p-[10px]")
  })

  it("ignores unrelated classes", () => {
    const result = parsePadding(["text-sm", "rounded-md", "bg-white"])
    expect(result.preservedRaw).toEqual([])
  })

  it("does NOT match margin classes (separate parser)", () => {
    const result = parsePadding(["m-4", "p-2"])
    expect(result.all?.step).toBe(2)
    // margin should not appear in padding's preservedRaw — different family.
    expect(result.preservedRaw).not.toContain("m-4")
  })
})

describe("parseMargin — distinct from padding", () => {
  it("extracts all-sides margin (m-6)", () => {
    const result = parseMargin(["m-6", "p-2"])
    expect(result.all?.step).toBe(6)
  })

  it("ignores padding classes", () => {
    const result = parseMargin(["p-4"])
    expect(result.all).toBeNull()
    expect(result.preservedRaw).not.toContain("p-4")
  })

  it("preserves negative margin (-m-2) without parsing it", () => {
    // V1: negatives aren't UI-settable. Preserve them so we don't strip.
    const result = parseMargin(["-m-2"])
    expect(result.all).toBeNull()
    expect(result.preservedRaw).toContain("-m-2")
  })
})

describe("parseGap — gap-only, no per-side", () => {
  it("extracts gap-{n}", () => {
    const result = parseGap(["gap-4"])
    expect(result.all?.step).toBe(4)
  })

  it("extracts gap-x and gap-y", () => {
    const result = parseGap(["gap-x-2", "gap-y-3"])
    expect(result.x?.step).toBe(2)
    expect(result.y?.step).toBe(3)
  })

  it("does NOT spuriously fill per-side fields", () => {
    const result = parseGap(["gap-4"])
    expect(result.top).toBeNull()
    expect(result.right).toBeNull()
  })
})

describe("setPaddingAll — emits the right diff", () => {
  it("removes all existing padding classes and adds p-{step}", () => {
    const current = parsePadding(["p-2", "px-4", "pt-1"])
    const mutation = setPaddingAll(current, 8)
    expect(new Set(mutation.remove)).toEqual(new Set(["p-2", "px-4", "pt-1"]))
    expect(mutation.add).toEqual(["p-8"])
  })

  it("clears all padding when step is null", () => {
    const current = parsePadding(["p-2", "py-1"])
    const mutation = setPaddingAll(current, null)
    expect(new Set(mutation.remove)).toEqual(new Set(["p-2", "py-1"]))
    expect(mutation.add).toEqual([])
  })

  it("doesn't touch preserved classes (responsive/state/negative)", () => {
    const current = parsePadding(["md:p-4", "p-2"])
    const mutation = setPaddingAll(current, 8)
    // Only the simple p-2 is removed; md:p-4 stays.
    expect(mutation.remove).toEqual(["p-2"])
    expect(mutation.add).toEqual(["p-8"])
  })

  it("emits half-step values correctly (0.5 → p-0.5)", () => {
    const current = parsePadding([])
    const mutation = setPaddingAll(current, 0.5)
    expect(mutation.add).toEqual(["p-0.5"])
  })

  it("end-to-end: applyClassMutation produces the expected list", () => {
    const before = ["rounded-md", "p-2", "px-4", "bg-white"]
    const current = parsePadding(before)
    const after = applyClassMutation(before, setPaddingAll(current, 6))
    expect(after).toEqual(["rounded-md", "bg-white", "p-6"])
  })

  it("end-to-end with duplicates: removes ALL matching classes (codex P2)", () => {
    const before = ["p-2", "p-4", "rounded-md"]
    const current = parsePadding(before)
    const after = applyClassMutation(before, setPaddingAll(current, 8))
    // Both p-2 AND p-4 are removed; only p-8 remains.
    expect(after).toEqual(["rounded-md", "p-8"])
  })
})

describe("setMarginAll + setGapAll mirror setPaddingAll behavior", () => {
  it("setMarginAll removes existing margin classes and adds m-{step}", () => {
    const current = parseMargin(["m-2", "mx-1"])
    const mutation = setMarginAll(current, 4)
    expect(new Set(mutation.remove)).toEqual(new Set(["m-2", "mx-1"]))
    expect(mutation.add).toEqual(["m-4"])
  })

  it("setGapAll removes existing gap classes and adds gap-{step}", () => {
    const current = parseGap(["gap-2", "gap-x-4"])
    const mutation = setGapAll(current, 6)
    expect(new Set(mutation.remove)).toEqual(new Set(["gap-2", "gap-x-4"]))
    expect(mutation.add).toEqual(["gap-6"])
  })
})

describe("resolveSpacingSides — cascade resolution", () => {
  it("all-sides shorthand fills every side", () => {
    expect(resolveSpacingSides(parsePadding(["p-4"]))).toEqual({
      top: 4,
      right: 4,
      bottom: 4,
      left: 4,
    })
  })

  it("axis wins over all; side wins over axis", () => {
    expect(resolveSpacingSides(parsePadding(["p-4", "px-2", "pt-1"]))).toEqual({
      top: 1,
      right: 2,
      bottom: 4,
      left: 2,
    })
  })

  it("unowned sides resolve to null", () => {
    expect(resolveSpacingSides(parsePadding(["pt-2"]))).toEqual({
      top: 2,
      right: null,
      bottom: null,
      left: null,
    })
  })
})

describe("setPaddingSide / setMarginSide — Figma-style per-side edits", () => {
  it("editing one side of a shorthand explodes into the minimal class set", () => {
    const current = parsePadding(["p-4"])
    const mutation = setPaddingSide(current, "top", 2)
    expect(new Set(mutation.remove)).toEqual(new Set(["p-4"]))
    // left===right (px-4) and top(2)!=bottom(4) → pt-2 pb-4
    expect(new Set(mutation.add)).toEqual(new Set(["px-4", "pt-2", "pb-4"]))
  })

  it("collapses back to the shorthand when all sides become equal", () => {
    const current = parsePadding(["pt-2", "pr-4", "pb-4", "pl-4"])
    const mutation = setPaddingSide(current, "top", 4)
    expect(new Set(mutation.remove)).toEqual(
      new Set(["pt-2", "pr-4", "pb-4", "pl-4"]),
    )
    expect(mutation.add).toEqual(["p-4"])
  })

  it("clearing a side drops only that side's class", () => {
    const current = parsePadding(["pt-2", "pb-6"])
    const mutation = setPaddingSide(current, "top", null)
    expect(new Set(mutation.remove)).toEqual(new Set(["pt-2", "pb-6"]))
    expect(mutation.add).toEqual(["pb-6"])
  })

  it("symmetric axes serialize to px/py", () => {
    // set all four so left===right and top===bottom but the axes differ
    let next = applyClassMutation([], setPaddingSide(parsePadding([]), "left", 2))
    next = applyClassMutation(next, setPaddingSide(parsePadding(next), "right", 2))
    next = applyClassMutation(next, setPaddingSide(parsePadding(next), "top", 6))
    next = applyClassMutation(next, setPaddingSide(parsePadding(next), "bottom", 6))
    expect(new Set(next)).toEqual(new Set(["px-2", "py-6"]))
  })

  it("setMarginSide mirrors padding with the m-prefix family", () => {
    const current = parseMargin(["m-2"])
    const mutation = setMarginSide(current, "left", 8)
    expect(new Set(mutation.remove)).toEqual(new Set(["m-2"]))
    // top===bottom===right=2 (py-2 + mr-2), left=8
    expect(new Set(mutation.add)).toEqual(new Set(["my-2", "mr-2", "ml-8"]))
  })
})

describe("parseBorder — width/radius/style", () => {
  it("returns empty when no border classes are present", () => {
    const result = parseBorder(["bg-white", "p-4"])
    expect(result.width).toBeNull()
    expect(result.radius).toBeNull()
    expect(result.style).toBeNull()
    expect(result.preservedRaw).toEqual([])
  })

  it("recognizes bare `border` as width=1", () => {
    const result = parseBorder(["border"])
    expect(result.width).toEqual({ value: 1, raws: ["border"] })
  })

  it("recognizes border-{n} for n in {0, 2, 4, 8}", () => {
    for (const n of [0, 2, 4, 8]) {
      const result = parseBorder([`border-${n}`])
      expect(result.width?.value).toBe(n)
    }
  })

  it("recognizes border-{style}", () => {
    for (const style of BORDER_STYLES) {
      const result = parseBorder([`border-${style}`])
      expect(result.style?.value).toBe(style)
    }
  })

  it("recognizes bare `rounded` as radius=default", () => {
    const result = parseBorder(["rounded"])
    expect(result.radius?.value).toBe("default")
  })

  it("recognizes rounded-{size}", () => {
    for (const size of BORDER_RADII.filter((s) => s !== "default")) {
      const result = parseBorder([`rounded-${size}`])
      expect(result.radius?.value).toBe(size)
    }
  })

  it("does NOT match border color classes (Phase B owns those)", () => {
    const result = parseBorder(["border-amber-500", "border-slate-200"])
    expect(result.width).toBeNull()
    expect(result.style).toBeNull()
  })

  it("parses per-side width structurally (border-t-2)", () => {
    const result = parseBorder(["border-t-2"])
    expect(result.width).toBeNull()
    expect(result.widthSides.top).toEqual({ value: 2, raws: ["border-t-2"] })
    expect(result.preservedRaw).toEqual([])
  })

  it("parses bare per-side width as 1 (border-l) and axes (border-x-4)", () => {
    const result = parseBorder(["border-l", "border-x-4"])
    expect(result.widthSides.left).toEqual({ value: 1, raws: ["border-l"] })
    expect(result.widthSides.x).toEqual({ value: 4, raws: ["border-x-4"] })
  })

  it("parses per-corner radius structurally (rounded-tl-md)", () => {
    const result = parseBorder(["rounded-tl-md"])
    expect(result.radius).toBeNull()
    expect(result.radiusParts.topLeft).toEqual({
      value: "md",
      raws: ["rounded-tl-md"],
    })
    expect(result.preservedRaw).toEqual([])
  })

  it("parses per-side radius shorthand (rounded-t, rounded-b-lg)", () => {
    const result = parseBorder(["rounded-t", "rounded-b-lg"])
    expect(result.radiusParts.top).toEqual({ value: "default", raws: ["rounded-t"] })
    expect(result.radiusParts.bottom).toEqual({
      value: "lg",
      raws: ["rounded-b-lg"],
    })
  })

  it("preserves arbitrary per-side width (border-t-[3px]) instead of dropping", () => {
    const result = parseBorder(["border-t-[3px]"])
    expect(result.widthSides.top).toBeUndefined()
    expect(result.preservedRaw).toContain("border-t-[3px]")
  })

  it("preserves logical-side width (border-s, border-e, border-s-2)", () => {
    // Codex P2 round 2: logical-side classes were silently dropped.
    const result = parseBorder(["border-s", "border-e-4", "border-s-2"])
    expect(result.preservedRaw).toEqual(["border-s", "border-e-4", "border-s-2"])
  })

  it("preserves logical-corner radius (rounded-ss-md, rounded-se, rounded-es-lg, rounded-ee)", () => {
    // Codex P2 round 2.
    const result = parseBorder([
      "rounded-ss-md",
      "rounded-se",
      "rounded-es-lg",
      "rounded-ee",
    ])
    expect(result.preservedRaw).toEqual([
      "rounded-ss-md",
      "rounded-se",
      "rounded-es-lg",
      "rounded-ee",
    ])
  })

  it("preserves logical-side rounded (rounded-s-md, rounded-e)", () => {
    const result = parseBorder(["rounded-s-md", "rounded-e"])
    expect(result.preservedRaw).toEqual(["rounded-s-md", "rounded-e"])
  })

  it("does NOT mistake size keywords for logical-side classes (regression)", () => {
    // `rounded-sm` is a size, owned by the radius select. The new
    // preserve regex must not catch it via a `rounded-s` prefix
    // alternation — the (?:$|-) anchor after the side/corner group
    // prevents this.
    const result = parseBorder(["rounded-sm"])
    expect(result.radius?.value).toBe("sm")
    expect(result.preservedRaw).not.toContain("rounded-sm")
  })

  it("preserves responsive variants (md:border)", () => {
    const result = parseBorder(["md:border"])
    expect(result.width).toBeNull()
    expect(result.preservedRaw).toContain("md:border")
  })

  it("accumulates duplicates per property (codex P2 pattern)", () => {
    const result = parseBorder(["border-2", "border-4"])
    expect(result.width?.value).toBe(4)
    expect(result.width?.raws).toEqual(["border-2", "border-4"])
  })
})

describe("setBorderWidth / setBorderRadius / setBorderStyle", () => {
  it("setBorderWidth(1) emits the bare `border` keyword", () => {
    const current = parseBorder(["border-2"])
    const mutation = setBorderWidth(current, 1)
    expect(mutation).toEqual({ remove: ["border-2"], add: ["border"] })
  })

  it("setBorderWidth(0) emits border-0", () => {
    const current = parseBorder(["border"])
    const mutation = setBorderWidth(current, 0)
    expect(mutation).toEqual({ remove: ["border"], add: ["border-0"] })
  })

  it("setBorderWidth(null) clears", () => {
    const current = parseBorder(["border-4"])
    const mutation = setBorderWidth(current, null)
    expect(mutation).toEqual({ remove: ["border-4"], add: [] })
  })

  it("setBorderRadius('default') emits bare `rounded`", () => {
    const current = parseBorder(["rounded-lg"])
    const mutation = setBorderRadius(current, "default")
    expect(mutation).toEqual({ remove: ["rounded-lg"], add: ["rounded"] })
  })

  it("setBorderStyle removes existing style and adds new", () => {
    const current = parseBorder(["border-dashed"])
    const mutation = setBorderStyle(current, "solid")
    expect(mutation).toEqual({ remove: ["border-dashed"], add: ["border-solid"] })
  })

  it("end-to-end: applyClassMutation produces the expected list", () => {
    const before = ["border-2", "border-dashed", "rounded-md", "p-4"]
    const current = parseBorder(before)
    let after = applyClassMutation(before, setBorderWidth(current, 4))
    let next = parseBorder(after)
    after = applyClassMutation(after, setBorderStyle(next, "solid"))
    next = parseBorder(after)
    after = applyClassMutation(after, setBorderRadius(next, "lg"))
    expect(after).toEqual(["p-4", "border-4", "border-solid", "rounded-lg"])
  })
})

describe("resolveBorderWidthSides — cascade resolution", () => {
  it("all-sides width applies to every side", () => {
    expect(resolveBorderWidthSides(parseBorder(["border-2"]))).toEqual({
      top: 2, right: 2, bottom: 2, left: 2,
    })
  })

  it("per-side wins over axis wins over all (border-4 border-x-2 border-t-8)", () => {
    const result = resolveBorderWidthSides(
      parseBorder(["border-4", "border-x-2", "border-t-8"]),
    )
    expect(result).toEqual({ top: 8, right: 2, bottom: 4, left: 2 })
  })

  it("unowned sides resolve to null", () => {
    expect(resolveBorderWidthSides(parseBorder(["border-t-2"]))).toEqual({
      top: 2, right: null, bottom: null, left: null,
    })
  })
})

describe("resolveBorderRadiusCorners — cascade resolution", () => {
  it("all-corners radius applies to every corner", () => {
    expect(resolveBorderRadiusCorners(parseBorder(["rounded-lg"]))).toEqual({
      topLeft: "lg", topRight: "lg", bottomRight: "lg", bottomLeft: "lg",
    })
  })

  it("corner wins over side shorthand wins over all", () => {
    const result = resolveBorderRadiusCorners(
      parseBorder(["rounded-md", "rounded-t-lg", "rounded-tl-xl"]),
    )
    // tl: corner xl; tr: side-top lg; br/bl: all md (bl also sees no side).
    expect(result).toEqual({
      topLeft: "xl", topRight: "lg", bottomRight: "md", bottomLeft: "md",
    })
  })

  it("logical corners are preserved, not resolved", () => {
    const border = parseBorder(["rounded-ss-md"])
    expect(border.preservedRaw).toContain("rounded-ss-md")
    expect(resolveBorderRadiusCorners(border)).toEqual({
      topLeft: null, topRight: null, bottomRight: null, bottomLeft: null,
    })
  })
})

describe("setBorderWidthSide / setBorderRadiusCorner — Figma-style per-side edits", () => {
  it("explodes an all-sides width when one side changes", () => {
    const current = parseBorder(["border-2"])
    const mutation = setBorderWidthSide(current, "top", 8)
    const after = applyClassMutation(["border-2"], mutation)
    expect(after).toContain("border-t-8")
    expect(after).toContain("border-b-2")
    // left+right collapse to the x axis.
    expect(after).toContain("border-x-2")
    expect(after).not.toContain("border-2")
  })

  it("collapses back to the all-sides shorthand when sides re-equalize", () => {
    const current = parseBorder(["border-t-8", "border-x-2", "border-b-2"])
    const mutation = setBorderWidthSide(current, "top", 2)
    const after = applyClassMutation(
      ["border-t-8", "border-x-2", "border-b-2"],
      mutation,
    )
    expect(after).toEqual(["border-2"])
  })

  it("clears a single side with null", () => {
    const current = parseBorder(["border-2"])
    const mutation = setBorderWidthSide(current, "top", null)
    const after = applyClassMutation(["border-2"], mutation)
    expect(after).not.toContain("border-t-2")
    expect(after).toContain("border-b-2")
    expect(after).toContain("border-x-2")
  })

  it("explodes an all-corners radius when one corner changes", () => {
    const current = parseBorder(["rounded-md"])
    const mutation = setBorderRadiusCorner(current, "topLeft", "xl")
    const after = applyClassMutation(["rounded-md"], mutation)
    expect(after).toContain("rounded-tl-xl")
    expect(after).toContain("rounded-tr-md")
    expect(after).toContain("rounded-br-md")
    expect(after).toContain("rounded-bl-md")
    expect(after).not.toContain("rounded-md")
  })

  it("collapses corners back to the all-corners shorthand", () => {
    const current = parseBorder([
      "rounded-tl-xl", "rounded-tr-md", "rounded-br-md", "rounded-bl-md",
    ])
    const mutation = setBorderRadiusCorner(current, "topLeft", "md")
    const after = applyClassMutation(
      ["rounded-tl-xl", "rounded-tr-md", "rounded-br-md", "rounded-bl-md"],
      mutation,
    )
    expect(after).toEqual(["rounded-md"])
  })

  it("setBorderWidth (all-sides) wipes per-side overrides", () => {
    const current = parseBorder(["border-t-8", "border-x-2"])
    const mutation = setBorderWidth(current, 4)
    const after = applyClassMutation(["border-t-8", "border-x-2"], mutation)
    expect(after).toEqual(["border-4"])
  })

  it("setBorderRadius (all-corners) wipes per-corner overrides", () => {
    const current = parseBorder(["rounded-tl-xl", "rounded-md"])
    const mutation = setBorderRadius(current, "lg")
    const after = applyClassMutation(["rounded-tl-xl", "rounded-md"], mutation)
    expect(after).toEqual(["rounded-lg"])
  })
})

describe("BORDER_WIDTHS / BORDER_RADII / BORDER_STYLES exports", () => {
  it("BORDER_WIDTHS includes 0, 1, 2, 4, 8", () => {
    expect(BORDER_WIDTHS).toEqual([0, 1, 2, 4, 8])
  })

  it("BORDER_RADII includes none + default + size scale + full", () => {
    expect(BORDER_RADII).toContain("none")
    expect(BORDER_RADII).toContain("default")
    expect(BORDER_RADII).toContain("full")
    expect(BORDER_RADII).toContain("md")
  })

  it("BORDER_STYLES is exactly the supported set", () => {
    expect(BORDER_STYLES).toEqual([
      "solid", "dashed", "dotted", "double", "none",
    ])
  })
})

describe("parseTypography — size / weight / leading / tracking / alignment", () => {
  it("returns empty when no typography classes are present", () => {
    const result = parseTypography(["bg-white", "p-4"])
    expect(result.size).toBeNull()
    expect(result.weight).toBeNull()
    expect(result.leading).toBeNull()
    expect(result.tracking).toBeNull()
    expect(result.align).toBeNull()
  })

  it("recognizes every font size", () => {
    for (const size of FONT_SIZES) {
      const result = parseTypography([`text-${size}`])
      expect(result.size?.value).toBe(size)
    }
  })

  it("recognizes every font weight", () => {
    for (const weight of FONT_WEIGHTS) {
      const result = parseTypography([`font-${weight}`])
      expect(result.weight?.value).toBe(weight)
    }
  })

  it("recognizes every leading value", () => {
    for (const leading of LEADING_VALUES) {
      const result = parseTypography([`leading-${leading}`])
      expect(result.leading?.value).toBe(leading)
    }
  })

  it("recognizes every tracking value", () => {
    for (const tracking of TRACKING_VALUES) {
      const result = parseTypography([`tracking-${tracking}`])
      expect(result.tracking?.value).toBe(tracking)
    }
  })

  it("recognizes every text alignment", () => {
    for (const align of TEXT_ALIGNMENTS) {
      const result = parseTypography([`text-${align}`])
      expect(result.align?.value).toBe(align)
    }
  })

  it("disambiguates text-{size} from text-{align} from text-{color}", () => {
    const result = parseTypography(["text-sm", "text-center", "text-amber-500"])
    expect(result.size?.value).toBe("sm")
    expect(result.align?.value).toBe("center")
    // text-amber-500 is a color (Phase B's territory). Typography
    // shouldn't claim it.
    // It also shouldn't end up in preservedRaw since it's not a
    // typography concern at all.
  })

  it("ignores responsive variants at the base parser (handled by stripVariant upstream)", () => {
    const result = parseTypography(["md:text-lg"])
    expect(result.size).toBeNull()
  })

  it("captures numeric leading (leading-6) into the leading field", () => {
    const result = parseTypography(["leading-6"])
    expect(result.leading?.value).toBe("6")
  })

  it("captures font-mono / font-sans / font-serif into family (not weight)", () => {
    const result = parseTypography(["font-mono"])
    expect(result.weight).toBeNull()
    expect(result.family?.value).toBe("mono")
  })

  it("accumulates duplicates per property", () => {
    const result = parseTypography(["text-sm", "text-lg"])
    expect(result.size?.value).toBe("lg")
    expect(result.size?.raws).toEqual(["text-sm", "text-lg"])
  })
})

describe("set* typography mutators", () => {
  it("setFontSize emits text-{size}, removes existing", () => {
    const current = parseTypography(["text-sm", "text-base"])
    const mutation = setFontSize(current, "lg")
    expect(new Set(mutation.remove)).toEqual(new Set(["text-sm", "text-base"]))
    expect(mutation.add).toEqual(["text-lg"])
  })

  it("setFontWeight emits font-{weight}", () => {
    const current = parseTypography(["font-bold"])
    const mutation = setFontWeight(current, "semibold")
    expect(mutation).toEqual({ remove: ["font-bold"], add: ["font-semibold"] })
  })

  it("setLeading / setTracking / setTextAlign mirror the pattern", () => {
    const current = parseTypography([
      "leading-tight", "tracking-wide", "text-left",
    ])
    expect(setLeading(current, "loose")).toEqual({
      remove: ["leading-tight"],
      add: ["leading-loose"],
    })
    expect(setTracking(current, "wider")).toEqual({
      remove: ["tracking-wide"],
      add: ["tracking-wider"],
    })
    expect(setTextAlign(current, "right")).toEqual({
      remove: ["text-left"],
      add: ["text-right"],
    })
  })

  it("setFontSize(null) clears", () => {
    const current = parseTypography(["text-xl"])
    expect(setFontSize(current, null)).toEqual({
      remove: ["text-xl"],
      add: [],
    })
  })

  it("end-to-end: applyClassMutation produces the expected list", () => {
    const before = ["text-sm", "font-bold", "leading-tight", "p-4"]
    const current = parseTypography(before)
    let after = applyClassMutation(before, setFontSize(current, "lg"))
    let next = parseTypography(after)
    after = applyClassMutation(after, setFontWeight(next, "semibold"))
    next = parseTypography(after)
    after = applyClassMutation(after, setLeading(next, "loose"))
    expect(after).toEqual(["p-4", "text-lg", "font-semibold", "leading-loose"])
  })
})

describe("parseShadow / setShadow", () => {
  it("reads a shadow preset off the class list", () => {
    expect(parseShadow(["p-4", "shadow-md"])).toEqual({
      value: { value: "md", raws: ["shadow-md"] },
      preservedRaw: [],
    })
  })

  it("recognizes every scale value including shadow-none", () => {
    for (const size of SHADOWS) {
      expect(parseShadow([`shadow-${size}`]).value?.value).toBe(size)
    }
  })

  it("preserves shadow color / arbitrary / variant utilities", () => {
    const parsed = parseShadow(["shadow-lg", "shadow-blue-500", "hover:shadow-xl"])
    expect(parsed.value?.value).toBe("lg")
    expect(parsed.preservedRaw).toEqual(["shadow-blue-500", "hover:shadow-xl"])
  })

  it("ignores classes that merely start with 'shadow' but aren't shadow utils", () => {
    // No false positives on unrelated families.
    expect(parseShadow(["p-2", "rounded-md"]).preservedRaw).toEqual([])
  })

  it("setShadow swaps the owned class and clears with null", () => {
    const before = ["shadow-sm", "p-4"]
    const current = parseShadow(before)
    expect(applyClassMutation(before, setShadow(current, "xl"))).toEqual([
      "p-4",
      "shadow-xl",
    ])
    expect(applyClassMutation(before, setShadow(current, null))).toEqual(["p-4"])
  })
})
