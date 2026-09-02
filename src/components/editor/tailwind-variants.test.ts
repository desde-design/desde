import { describe, expect, it } from "vitest"
import {
  applyClassMutation,
  applyScopedChange,
  composeVariant,
  parseVariantChain,
  prefixMutation,
  presentVariants,
  stripVariant,
  parseTypography,
  setFontSize,
  setFontFamily,
  setLeading,
  withArbitraryOption,
} from "./tailwind-classes"

describe("composeVariant — canonical prefix", () => {
  it("returns empty string for base + default", () => {
    expect(composeVariant("base", "default")).toBe("")
    expect(composeVariant()).toBe("")
  })
  it("emits breakpoint-only", () => {
    expect(composeVariant("md", "default")).toBe("md")
  })
  it("emits state-only", () => {
    expect(composeVariant("base", "hover")).toBe("hover")
  })
  it("emits breakpoint-then-state in canonical order", () => {
    expect(composeVariant("md", "hover")).toBe("md:hover")
    expect(composeVariant("xl", "dark")).toBe("xl:dark")
  })
})

describe("parseVariantChain — bracket-depth-aware colon split", () => {
  it("treats a bare utility as base (no variants)", () => {
    expect(parseVariantChain("text-lg")).toEqual({
      variants: [],
      utility: "text-lg",
    })
  })
  it("splits a single variant", () => {
    expect(parseVariantChain("md:text-lg")).toEqual({
      variants: ["md"],
      utility: "text-lg",
    })
  })
  it("splits a stacked variant chain", () => {
    expect(parseVariantChain("md:hover:font-bold")).toEqual({
      variants: ["md", "hover"],
      utility: "font-bold",
    })
  })
  it("does NOT split a colon inside square brackets", () => {
    expect(parseVariantChain("text-[color:red]")).toEqual({
      variants: [],
      utility: "text-[color:red]",
    })
  })
  it("does NOT split a colon inside a variant's arbitrary value, but keeps the real prefix", () => {
    expect(parseVariantChain("md:text-[color:red]")).toEqual({
      variants: ["md"],
      utility: "text-[color:red]",
    })
  })
  it("handles nested parens inside brackets (CSS var)", () => {
    expect(parseVariantChain("md:bg-[var(--x)]")).toEqual({
      variants: ["md"],
      utility: "bg-[var(--x)]",
    })
  })
  it("keeps negative utilities intact", () => {
    expect(parseVariantChain("md:-m-2")).toEqual({
      variants: ["md"],
      utility: "-m-2",
    })
  })
})

describe("stripVariant — context filtering", () => {
  const classes = [
    "text-sm",
    "md:text-lg",
    "lg:text-xl",
    "hover:font-bold",
    "md:hover:underline",
    "bg-[var(--x)]",
    "text-[color:red]",
  ]
  it("base selects only un-prefixed classes (utilities unchanged)", () => {
    expect(stripVariant(classes, "")).toEqual([
      "text-sm",
      "bg-[var(--x)]",
      "text-[color:red]",
    ])
  })
  it("a breakpoint context returns its stripped utilities", () => {
    expect(stripVariant(classes, "md")).toEqual(["text-lg"])
    expect(stripVariant(classes, "lg")).toEqual(["text-xl"])
  })
  it("a state context returns its stripped utilities", () => {
    expect(stripVariant(classes, "hover")).toEqual(["font-bold"])
  })
  it("a composed breakpoint:state context matches only that exact chain", () => {
    expect(stripVariant(classes, "md:hover")).toEqual(["underline"])
  })
})

describe("prefixMutation — diff stays in variant-space", () => {
  it("is a no-op for the base context", () => {
    const m = { remove: ["text-sm"], add: ["text-lg"] }
    expect(prefixMutation(m, "")).toEqual(m)
  })
  it("prefixes both remove and add", () => {
    const m = { remove: ["text-sm"], add: ["text-lg"] }
    expect(prefixMutation(m, "md")).toEqual({
      remove: ["md:text-sm"],
      add: ["md:text-lg"],
    })
  })
  it("prefixes composed contexts", () => {
    expect(prefixMutation({ remove: [], add: ["font-bold"] }, "md:hover")).toEqual({
      remove: [],
      add: ["md:hover:font-bold"],
    })
  })
})

describe("presentVariants — which contexts have overrides", () => {
  it("reports the distinct breakpoints and states present", () => {
    const result = presentVariants([
      "text-sm",
      "md:text-lg",
      "lg:p-4",
      "hover:font-bold",
      "md:hover:underline",
      "dark:bg-black",
    ])
    expect(result.breakpoints).toEqual(["md", "lg"])
    expect(result.states).toEqual(["hover", "dark"])
  })
  it("returns empty arrays when only base classes exist", () => {
    expect(presentVariants(["text-sm", "p-4"])).toEqual({
      breakpoints: [],
      states: [],
    })
  })
})

describe("representable-but-hidden typography values are captured (not preserved)", () => {
  it("captures font-family into its own field", () => {
    const v = parseTypography(["text-sm", "font-mono"])
    expect(v.family?.value).toBe("mono")
    expect(v.preservedRaw).not.toContain("font-mono")
    expect(setFontFamily(v, "serif")).toEqual({
      remove: ["font-mono"],
      add: ["font-serif"],
    })
  })
  it("captures numeric leading and round-trips it", () => {
    const v = parseTypography(["leading-6"])
    expect(v.leading?.value).toBe("6")
    expect(setLeading(v, "7")).toEqual({ remove: ["leading-6"], add: ["leading-7"] })
  })
  it("captures arbitrary font-size verbatim", () => {
    const v = parseTypography(["text-[13px]"])
    expect(v.size?.value).toBe("[13px]")
    expect(setFontSize(v, "sm")).toEqual({ remove: ["text-[13px]"], add: ["text-sm"] })
  })
  it("captures arbitrary leading", () => {
    expect(parseTypography(["leading-[1.6]"]).leading?.value).toBe("[1.6]")
  })
  it("does NOT steal an arbitrary text COLOR as a size", () => {
    const v = parseTypography(["text-[#abc]", "text-[var(--c)]"])
    expect(v.size).toBeNull()
  })
})

describe("withArbitraryOption", () => {
  const opts = [
    { value: "__unset", label: "—" },
    { value: "sm", label: "sm" },
  ]
  it("returns options unchanged for a known/unset value", () => {
    expect(withArbitraryOption(opts, "sm")).toEqual(opts)
    expect(withArbitraryOption(opts, "__unset")).toEqual(opts)
    expect(withArbitraryOption(opts, null)).toEqual(opts)
  })
  it("prepends an out-of-set value as its own option", () => {
    expect(withArbitraryOption(opts, "[13px]")).toEqual([
      { value: "[13px]", label: "[13px]" },
      ...opts,
    ])
  })
})

describe("applyScopedChange — the panel choke point", () => {
  it("at base, splices only the changed base class, preserving variant siblings in place", () => {
    const full = ["text-sm", "md:text-lg", "p-4", "hover:font-bold"]
    const scopedBefore = stripVariant(full, "") // base utilities
    // a section changed text-sm → text-base in scoped space
    const scopedNext = ["text-base", "p-4"]
    expect(applyScopedChange(full, "", scopedBefore, scopedNext)).toEqual([
      "md:text-lg",
      "p-4",
      "hover:font-bold",
      "text-base",
    ])
  })

  it("at a breakpoint, rewrites only that breakpoint's class", () => {
    const full = ["text-sm", "md:text-lg", "p-4"]
    const variant = "md"
    const scopedBefore = stripVariant(full, variant) // ["text-lg"]
    const scopedNext = ["text-xl"]
    expect(applyScopedChange(full, variant, scopedBefore, scopedNext)).toEqual([
      "text-sm",
      "p-4",
      "md:text-xl",
    ])
  })

  it("adds a brand-new class for a context that had none", () => {
    const full = ["text-sm"]
    const variant = "lg"
    expect(applyScopedChange(full, variant, [], ["font-bold"])).toEqual([
      "text-sm",
      "lg:font-bold",
    ])
  })

  it("clearing a value removes only that context's class", () => {
    const full = ["text-sm", "md:text-lg"]
    expect(applyScopedChange(full, "md", ["text-lg"], [])).toEqual(["text-sm"])
  })
})

describe("end-to-end round-trip: edit one variant, leave the rest", () => {
  it("editing the md size rewrites only md:, base + other variants intact", () => {
    const classes = ["text-sm", "md:text-lg", "lg:text-xl", "hover:font-bold"]
    const variant = composeVariant("md", "default") // "md"
    const value = parseTypography(stripVariant(classes, variant))
    expect(value.size?.value).toBe("lg")

    const mutation = prefixMutation(setFontSize(value, "xl"), variant)
    const next = applyClassMutation(classes, mutation)
    expect(next).toEqual(["text-sm", "lg:text-xl", "hover:font-bold", "md:text-xl"])
  })

  it("editing a composed md:hover context writes the stacked prefix", () => {
    const classes = ["font-normal", "md:hover:font-bold"]
    const variant = composeVariant("md", "hover") // "md:hover"
    const value = parseTypography(stripVariant(classes, variant))
    expect(value.weight?.value).toBe("bold")

    const mutation = prefixMutation(setFontSize(value, "lg"), variant)
    const next = applyClassMutation(classes, mutation)
    expect(next).toContain("md:hover:text-lg")
    expect(next).toContain("font-normal")
    expect(next).toContain("md:hover:font-bold")
  })

  it("base edit is unprefixed and ignores variant siblings", () => {
    const classes = ["text-sm", "md:text-lg"]
    const value = parseTypography(stripVariant(classes, ""))
    expect(value.size?.value).toBe("sm")
    const next = applyClassMutation(classes, prefixMutation(setFontSize(value, "base"), ""))
    expect(next).toEqual(["md:text-lg", "text-base"])
  })
})
