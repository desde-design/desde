import { describe, expect, it } from "vitest"
import {
  parseColor,
  previewHex,
  setColor,
  TAILWIND_COLOR_FAMILIES,
  TAILWIND_COLOR_SHADES,
} from "./tailwind-colors"
import { applyClassMutation } from "./tailwind-classes"

describe("parseColor — bg property", () => {
  it("returns null for an empty list", () => {
    expect(parseColor([], "bg")).toBeNull()
  })

  it("extracts a palette color (bg-amber-50)", () => {
    const result = parseColor(["bg-amber-50", "rounded-md"], "bg")
    expect(result).toEqual({
      kind: "palette",
      family: "amber",
      shade: 50,
      raws: ["bg-amber-50"],
    })
  })

  it("extracts a deep palette shade (bg-slate-950)", () => {
    const result = parseColor(["bg-slate-950"], "bg")
    expect(result).toMatchObject({ kind: "palette", family: "slate", shade: 950 })
  })

  it("extracts a special color (bg-transparent)", () => {
    const result = parseColor(["bg-transparent"], "bg")
    expect(result).toEqual({
      kind: "special",
      name: "transparent",
      raws: ["bg-transparent"],
    })
  })

  it("extracts bg-white / bg-black / bg-current / bg-inherit", () => {
    for (const name of ["white", "black", "current", "inherit"]) {
      const result = parseColor([`bg-${name}`], "bg")
      expect(result).toEqual({ kind: "special", name, raws: [`bg-${name}`] })
    }
  })

  it("the LAST class in cascade order wins for the displayed value", () => {
    const result = parseColor(["bg-amber-50", "bg-slate-700"], "bg")
    expect(result).toMatchObject({ family: "slate", shade: 700 })
    // BUT raws contains both — so the mutator removes both on commit.
    expect(result?.raws).toEqual(["bg-amber-50", "bg-slate-700"])
  })

  it("ignores non-bg classes (text-sm, border-2 etc.)", () => {
    expect(parseColor(["text-sm", "border-2", "rounded-md"], "bg")).toBeNull()
  })

  it("ignores responsive/state variants (md:bg-red-500)", () => {
    expect(parseColor(["md:bg-red-500"], "bg")).toBeNull()
  })

  it("ignores arbitrary values (bg-[#abc])", () => {
    // V1 doesn't UI-edit arbitrary values; preserve them as unrelated.
    expect(parseColor(["bg-[#abc]"], "bg")).toBeNull()
  })
})

describe("parseColor — text/border ambiguity defenses", () => {
  it("does NOT match text-sm as a text color", () => {
    expect(parseColor(["text-sm"], "text")).toBeNull()
  })

  it("does NOT match text-center / text-left / text-right as colors", () => {
    expect(parseColor(["text-center", "text-left"], "text")).toBeNull()
  })

  it("DOES match text-amber-700 as a text color", () => {
    expect(parseColor(["text-amber-700"], "text")).toMatchObject({
      family: "amber",
      shade: 700,
    })
  })

  it("does NOT match `border` (bare width keyword) as a border color", () => {
    expect(parseColor(["border"], "border")).toBeNull()
  })

  it("does NOT match border-2 / border-t as a border color", () => {
    expect(parseColor(["border-2", "border-t"], "border")).toBeNull()
  })

  it("DOES match border-slate-200 as a border color", () => {
    expect(parseColor(["border-slate-200"], "border")).toMatchObject({
      family: "slate",
      shade: 200,
    })
  })
})

describe("setColor — emits the right mutation", () => {
  it("removes every existing class and adds the new palette class", () => {
    const current = parseColor(["bg-amber-50", "bg-slate-700"], "bg")
    const mutation = setColor(
      current,
      { kind: "palette", family: "blue", shade: 500 },
      "bg",
    )
    expect(new Set(mutation.remove)).toEqual(new Set(["bg-amber-50", "bg-slate-700"]))
    expect(mutation.add).toEqual(["bg-blue-500"])
  })

  it("emits special values (bg-transparent)", () => {
    const current = parseColor(["bg-amber-50"], "bg")
    const mutation = setColor(current, { kind: "special", name: "transparent" }, "bg")
    expect(mutation.add).toEqual(["bg-transparent"])
  })

  it("clears with null (removes all, adds nothing)", () => {
    const current = parseColor(["bg-amber-50"], "bg")
    const mutation = setColor(current, null, "bg")
    expect(mutation).toEqual({ remove: ["bg-amber-50"], add: [] })
  })

  it("end-to-end: applyClassMutation produces the expected list", () => {
    const before = ["bg-amber-50", "rounded-md", "p-4"]
    const current = parseColor(before, "bg")
    const after = applyClassMutation(
      before,
      setColor(current, { kind: "palette", family: "slate", shade: 700 }, "bg"),
    )
    expect(after).toEqual(["rounded-md", "p-4", "bg-slate-700"])
  })
})

describe("previewHex", () => {
  it("returns the V4 default hex for a known palette color", () => {
    expect(previewHex({ kind: "palette", family: "amber", shade: 50, raws: [] })).toBe(
      "#fffbeb",
    )
  })

  it("returns hex for white/black special", () => {
    expect(previewHex({ kind: "special", name: "white", raws: [] })).toBe("#ffffff")
    expect(previewHex({ kind: "special", name: "black", raws: [] })).toBe("#000000")
  })

  it("returns null for transparent/current/inherit (resolved meaning is contextual)", () => {
    expect(previewHex({ kind: "special", name: "transparent", raws: [] })).toBeNull()
    expect(previewHex({ kind: "special", name: "current", raws: [] })).toBeNull()
    expect(previewHex({ kind: "special", name: "inherit", raws: [] })).toBeNull()
  })

  it("returns null for null input", () => {
    expect(previewHex(null)).toBeNull()
  })
})

describe("design-token arbitrary-value classes", () => {
  it("parses bg-[var(--acme-token)] arbitrary value as a token", () => {
    const result = parseColor(["bg-[var(--acme-color-background-primary)]"], "bg")
    expect(result).toMatchObject({
      kind: "token",
      tokenName: "--acme-color-background-primary",
    })
  })

  it("parses text-[var(--acme-token)] arbitrary value as a token", () => {
    const result = parseColor(["text-[var(--acme-color-text-neutral)]"], "text")
    expect(result).toMatchObject({
      kind: "token",
      tokenName: "--acme-color-text-neutral",
    })
  })

  it("does NOT match opaque arbitrary values like bg-[#fff] or bg-[rgb(...)]", () => {
    // Tokens are specifically `var(--…)` references. Inline hex /
    // rgb arbitrary values stay outside the token system — they're
    // designer-meaningful but not token-meaningful.
    expect(parseColor(["bg-[#fff]"], "bg")).toBeNull()
    expect(parseColor(["bg-[rgb(0,0,0)]"], "bg")).toBeNull()
  })

  it("setColor with kind=token emits a Tailwind arbitrary-value class", () => {
    const result = setColor(
      null,
      { kind: "token", tokenName: "--acme-color-background-primary" },
      "bg",
    )
    expect(result).toEqual({
      remove: [],
      add: ["bg-[var(--acme-color-background-primary)]"],
    })
  })

  it("setColor replacing a palette with a token removes the palette class", () => {
    const current = parseColor(["bg-blue-600"], "bg")
    const result = setColor(
      current,
      { kind: "token", tokenName: "--acme-color-background-primary" },
      "bg",
    )
    expect(result.remove).toEqual(["bg-blue-600"])
    expect(result.add).toEqual(["bg-[var(--acme-color-background-primary)]"])
  })

  it("setColor replacing a token with a token swaps cleanly", () => {
    const current = parseColor(
      ["bg-[var(--acme-color-background-primary)]"],
      "bg",
    )
    const result = setColor(
      current,
      { kind: "token", tokenName: "--acme-color-background-danger" },
      "bg",
    )
    expect(result.remove).toEqual([
      "bg-[var(--acme-color-background-primary)]",
    ])
    expect(result.add).toEqual([
      "bg-[var(--acme-color-background-danger)]",
    ])
  })
})

describe("palette completeness sanity check", () => {
  it("every (family, shade) combo can be parsed back from its emitted class", () => {
    for (const family of TAILWIND_COLOR_FAMILIES) {
      for (const shade of TAILWIND_COLOR_SHADES) {
        const cls = `bg-${family}-${shade}`
        const result = parseColor([cls], "bg")
        expect(result, cls).toMatchObject({ kind: "palette", family, shade })
      }
    }
  })
})
