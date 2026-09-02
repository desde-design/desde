import { describe, expect, it } from "vitest"
import { EXPANDABLE_SHORTHANDS } from "@/editor/verification"
import {
  SPACING_PREFIXES,
  resolveTailwindClass,
  resolveTailwindClasses,
} from "./tailwind-declarations"
import {
  TAILWIND_COLOR_FAMILIES,
  TAILWIND_COLOR_SHADES,
} from "./tailwind-colors"
import {
  BORDER_RADII,
  BORDER_STYLES,
  BORDER_WIDTHS,
  FONT_SIZES,
  FONT_WEIGHTS,
  LEADING_VALUES,
  SPACING_SCALE,
  TEXT_ALIGNMENTS,
  TRACKING_VALUES,
} from "./tailwind-classes"

describe("resolveTailwindClass", () => {
  describe("colors", () => {
    it("resolves palette bg/text/border to hex declarations", () => {
      expect(resolveTailwindClass("bg-emerald-800")).toEqual({
        "background-color": "#065f46",
      })
      expect(resolveTailwindClass("text-blue-500")).toEqual({
        color: "#3b82f6",
      })
      expect(resolveTailwindClass("border-rose-300")).toEqual({
        "border-color": "#fda4af",
      })
    })

    it("resolves color specials to keywords / hex", () => {
      expect(resolveTailwindClass("bg-white")).toEqual({
        "background-color": "#ffffff",
      })
      expect(resolveTailwindClass("text-current")).toEqual({
        color: "currentColor",
      })
      expect(resolveTailwindClass("border-transparent")).toEqual({
        "border-color": "transparent",
      })
    })

    it("returns null for unknown shade or unknown family", () => {
      expect(resolveTailwindClass("bg-emerald-1234")).toBeNull()
      expect(resolveTailwindClass("bg-supernova-500")).toBeNull()
    })
  })

  describe("borders", () => {
    it("resolves border widths and co-emits border-style on non-zero", () => {
      expect(resolveTailwindClass("border")).toEqual({
        "border-width": "1px",
        "border-style": "solid",
      })
      expect(resolveTailwindClass("border-4")).toEqual({
        "border-width": "4px",
        "border-style": "solid",
      })
      expect(resolveTailwindClass("border-0")).toEqual({
        "border-width": "0",
      })
    })

    it("resolves border styles", () => {
      expect(resolveTailwindClass("border-dashed")).toEqual({
        "border-style": "dashed",
      })
      expect(resolveTailwindClass("border-none")).toEqual({
        "border-style": "none",
      })
    })

    it("resolves border radii including bare `rounded`", () => {
      expect(resolveTailwindClass("rounded")).toEqual({
        "border-radius": "0.25rem",
      })
      expect(resolveTailwindClass("rounded-lg")).toEqual({
        "border-radius": "0.5rem",
      })
      expect(resolveTailwindClass("rounded-full")).toEqual({
        "border-radius": "9999px",
      })
      expect(resolveTailwindClass("rounded-none")).toEqual({
        "border-radius": "0",
      })
    })
  })

  describe("typography", () => {
    it("resolves font-size with bundled line-height", () => {
      expect(resolveTailwindClass("text-base")).toEqual({
        "font-size": "1rem",
        "line-height": "1.5rem",
      })
      expect(resolveTailwindClass("text-5xl")).toEqual({
        "font-size": "3rem",
        "line-height": "1",
      })
    })

    it("resolves text alignment without colliding with size or color", () => {
      expect(resolveTailwindClass("text-center")).toEqual({
        "text-align": "center",
      })
      expect(resolveTailwindClass("text-justify")).toEqual({
        "text-align": "justify",
      })
      // Palette match takes precedence over the `text-` size/align suffix.
      expect(resolveTailwindClass("text-emerald-800")).toEqual({
        color: "#065f46",
      })
    })

    it("resolves font weights", () => {
      expect(resolveTailwindClass("font-semibold")).toEqual({
        "font-weight": "600",
      })
      expect(resolveTailwindClass("font-normal")).toEqual({
        "font-weight": "400",
      })
    })

    it("resolves leading and tracking", () => {
      expect(resolveTailwindClass("leading-relaxed")).toEqual({
        "line-height": "1.625",
      })
      expect(resolveTailwindClass("tracking-wide")).toEqual({
        "letter-spacing": "0.025em",
      })
      expect(resolveTailwindClass("tracking-normal")).toEqual({
        "letter-spacing": "0em",
      })
    })

    it("returns null for unknown typography suffixes", () => {
      expect(resolveTailwindClass("text-superlarge")).toBeNull()
      expect(resolveTailwindClass("font-grotesque")).toBeNull()
      expect(resolveTailwindClass("leading-extreme")).toBeNull()
    })
  })

  describe("spacing", () => {
    it("resolves padding shorthand and per-side", () => {
      expect(resolveTailwindClass("p-4")).toEqual({ padding: "1rem" })
      expect(resolveTailwindClass("pt-2")).toEqual({ "padding-top": "0.5rem" })
      expect(resolveTailwindClass("pl-0.5")).toEqual({
        "padding-left": "0.125rem",
      })
    })

    it("resolves padding-x / padding-y to two declarations each", () => {
      expect(resolveTailwindClass("px-6")).toEqual({
        "padding-left": "1.5rem",
        "padding-right": "1.5rem",
      })
      expect(resolveTailwindClass("py-3")).toEqual({
        "padding-top": "0.75rem",
        "padding-bottom": "0.75rem",
      })
    })

    it("resolves margin shorthand and axis variants", () => {
      expect(resolveTailwindClass("m-8")).toEqual({ margin: "2rem" })
      expect(resolveTailwindClass("mx-2")).toEqual({
        "margin-left": "0.5rem",
        "margin-right": "0.5rem",
      })
      expect(resolveTailwindClass("mb-12")).toEqual({
        "margin-bottom": "3rem",
      })
    })

    it("resolves gap shorthand and axis variants without ambiguity", () => {
      expect(resolveTailwindClass("gap-4")).toEqual({ gap: "1rem" })
      expect(resolveTailwindClass("gap-x-2")).toEqual({
        "column-gap": "0.5rem",
      })
      expect(resolveTailwindClass("gap-y-1.5")).toEqual({
        "row-gap": "0.375rem",
      })
    })

    it("resolves the zero step without unit", () => {
      expect(resolveTailwindClass("p-0")).toEqual({ padding: "0" })
      expect(resolveTailwindClass("m-0")).toEqual({ margin: "0" })
    })

    it("returns null for steps not on the V4 scale", () => {
      expect(resolveTailwindClass("p-13")).toBeNull()
      expect(resolveTailwindClass("p-100")).toBeNull()
    })
  })

  it("returns null for unrelated classes", () => {
    expect(resolveTailwindClass("flex")).toBeNull()
    expect(resolveTailwindClass("hidden")).toBeNull()
    expect(resolveTailwindClass("custom-class")).toBeNull()
  })

  describe("design-token arbitrary-value classes", () => {
    it("resolves bg-[var(--token)] to background-color: var(--token)", () => {
      expect(
        resolveTailwindClass("bg-[var(--acme-color-background-primary)]"),
      ).toEqual({
        "background-color": "var(--acme-color-background-primary)",
      })
    })

    it("resolves text-[var(--token)] to color: var(--token)", () => {
      expect(
        resolveTailwindClass("text-[var(--acme-color-text-neutral)]"),
      ).toEqual({
        color: "var(--acme-color-text-neutral)",
      })
    })

    it("resolves border-[var(--token)] to border-color: var(--token)", () => {
      expect(
        resolveTailwindClass("border-[var(--acme-color-border-strong)]"),
      ).toEqual({
        "border-color": "var(--acme-color-border-strong)",
      })
    })

    it("does NOT resolve opaque arbitrary values like bg-[#fff]", () => {
      // Inline hex / rgb arbitrary values stay opaque to the resolver.
      // The class string lands in source as-is and only takes effect
      // in Tailwind substrates.
      expect(resolveTailwindClass("bg-[#fff]")).toBeNull()
      expect(resolveTailwindClass("bg-[rgb(0,0,0)]")).toBeNull()
    })
  })
})

describe("resolveTailwindClasses", () => {
  it("merges declarations across classes with later-wins on collisions", () => {
    // Two bg colors → last wins.
    expect(
      resolveTailwindClasses(["bg-emerald-800", "bg-blue-500"]),
    ).toEqual({ "background-color": "#3b82f6" })
  })

  it("layers font-size's bundled line-height under an explicit leading", () => {
    // Tailwind's font-size utilities ship with a default line-height;
    // an explicit leading-* class should override only line-height.
    expect(
      resolveTailwindClasses(["text-base", "leading-relaxed"]),
    ).toEqual({ "font-size": "1rem", "line-height": "1.625" })
  })

  it("combines orthogonal categories without conflict", () => {
    expect(
      resolveTailwindClasses([
        "bg-emerald-800",
        "border-4",
        "rounded-lg",
        "p-4",
        "font-semibold",
        "text-center",
      ]),
    ).toEqual({
      "background-color": "#065f46",
      "border-width": "4px",
      "border-style": "solid",
      "border-radius": "0.5rem",
      padding: "1rem",
      "font-weight": "600",
      "text-align": "center",
    })
  })

  it("skips unresolvable classes silently", () => {
    // `flex` doesn't resolve; bg + items-center do.
    expect(
      resolveTailwindClasses(["bg-emerald-800", "flex", "items-center"]),
    ).toEqual({ "background-color": "#065f46", "align-items": "center" })
  })

  it("returns an empty object when no class resolves", () => {
    expect(resolveTailwindClasses(["flex", "block"])).toEqual({})
  })

  describe("alignment + width (direct-manip align/size)", () => {
    it("resolves justify-content + align-items utilities", () => {
      expect(resolveTailwindClass("justify-center")).toEqual({ "justify-content": "center" })
      expect(resolveTailwindClass("justify-between")).toEqual({ "justify-content": "space-between" })
      expect(resolveTailwindClass("items-start")).toEqual({ "align-items": "flex-start" })
      expect(resolveTailwindClass("items-stretch")).toEqual({ "align-items": "stretch" })
    })
    it("resolves width keywords, fractions, and numeric scale", () => {
      expect(resolveTailwindClass("w-full")).toEqual({ width: "100%" })
      expect(resolveTailwindClass("w-auto")).toEqual({ width: "auto" })
      expect(resolveTailwindClass("w-1/2")).toEqual({ width: "50%" })
      expect(resolveTailwindClass("w-fit")).toEqual({ width: "fit-content" })
      expect(resolveTailwindClass("w-64")).toEqual({ width: "16rem" })
    })
    it("does not misread min-w / max-w as width", () => {
      expect(resolveTailwindClass("min-w-0")).toBeNull()
      expect(resolveTailwindClass("max-w-lg")).toBeNull()
    })
  })
})

// ── cascade-oracle drift gate ────────────────────────────────────────────────
//
// `expandStyleDeclarations` (`src/editor/verification/style-shorthands.ts`)
// expands shorthands to longhands for the cascade oracle, and its map is bounded
// to the shorthands THIS resolver can emit. A new emission that is a shorthand and
// is not in that map silently re-opens the longhand blind spot: a competing
// library rule declaring only `padding-left` is never a candidate in the walk for
// `padding`, so the oracle reports our rule as the winner while the padding
// visibly does not move.
//
// The gate has to live HERE, driving real classes through the real resolver.
// Asserting `Object.keys(EXPANDABLE_SHORTHANDS)` against a hardcoded list — which
// is what the colocated shorthand test used to do — pins the map to a copy of
// itself: add `inset-*` → `{ inset: '1rem' }` below and that assertion still
// passes. This one does not.
//
// The spacing/gap families come from the resolver's OWN `SPACING_PREFIXES` map, so
// adding `inset` there puts `inset-4` in the corpus automatically and the pin
// trips. A family added as a fresh `startsWith` branch instead has to be added to
// `CORPUS` by hand — no test can discover that structurally, so: WHEN YOU ADD A
// UTILITY FAMILY, add it below, then decide whether the new property needs an
// `EXPANDABLE_SHORTHANDS` entry (it does, if it is a CSS shorthand).
describe("cascade-oracle drift gate — the properties this resolver can emit", () => {
  const CORPUS: string[] = [
    // Colors: palette × the three properties, specials, and the arbitrary-token form.
    ...TAILWIND_COLOR_FAMILIES.flatMap((family) =>
      TAILWIND_COLOR_SHADES.flatMap((shade) =>
        ["bg", "text", "border"].map((p) => `${p}-${family}-${shade}`),
      ),
    ),
    ...["white", "black", "transparent", "current", "inherit"].flatMap((name) =>
      ["bg", "text", "border"].map((p) => `${p}-${name}`),
    ),
    ...["bg", "text", "border"].map((p) => `${p}-[var(--acme-color-x)]`),
    // Borders: styles, widths (bare + scale), radii (bare + scale).
    ...BORDER_STYLES.map((s) => `border-${s}`),
    "border",
    ...BORDER_WIDTHS.map((w) => `border-${w}`),
    "rounded",
    ...BORDER_RADII.map((r) => `rounded-${r}`),
    // Typography.
    ...FONT_SIZES.map((s) => `text-${s}`),
    ...TEXT_ALIGNMENTS.map((a) => `text-${a}`),
    ...FONT_WEIGHTS.map((w) => `font-${w}`),
    ...LEADING_VALUES.map((l) => `leading-${l}`),
    ...TRACKING_VALUES.map((t) => `tracking-${t}`),
    // Alignment + width.
    ...["start", "center", "end", "between", "around", "evenly", "normal", "stretch"].map(
      (v) => `justify-${v}`,
    ),
    ...["start", "center", "end", "stretch", "baseline"].map((v) => `items-${v}`),
    ...["full", "auto", "fit", "screen", "min", "max", "px"].map((v) => `w-${v}`),
    ...["1/2", "1/3", "2/3", "1/4", "2/4", "3/4"].map((v) => `w-${v}`),
    ...SPACING_SCALE.map((n) => `w-${n}`),
    // Spacing: every prefix the resolver declares × the whole scale.
    ...Object.keys(SPACING_PREFIXES).flatMap((prefix) =>
      SPACING_SCALE.map((n) => `${prefix}-${n}`),
    ),
  ]

  /** Every CSS property name any class in the corpus resolves to. */
  const emitted = (() => {
    const out = new Set<string>()
    for (const cls of CORPUS) {
      for (const property of Object.keys(resolveTailwindClass(cls) ?? {})) {
        out.add(property)
      }
    }
    return [...out].sort()
  })()

  it("emits exactly this property set", () => {
    expect(emitted).toEqual([
      "align-items",
      "background-color",
      "border-color",
      "border-radius",
      "border-style",
      "border-width",
      "color",
      "column-gap",
      "font-size",
      "font-weight",
      "gap",
      "justify-content",
      "letter-spacing",
      "line-height",
      "margin",
      "margin-bottom",
      "margin-left",
      "margin-right",
      "margin-top",
      "padding",
      "padding-bottom",
      "padding-left",
      "padding-right",
      "padding-top",
      "row-gap",
      "text-align",
      "width",
    ])
  })

  it("declares an expansion for every shorthand in that set", () => {
    // The seven the oracle's map covers, cross-checked against what the resolver
    // actually emits — so a dead map entry is caught in the same breath as a
    // missing one. A property here that the map does not know is the drift.
    const shorthands = emitted.filter((p) => p in EXPANDABLE_SHORTHANDS)
    expect(shorthands).toEqual(Object.keys(EXPANDABLE_SHORTHANDS).sort())
  })

  it("resolves a broad corpus (the gate is not vacuously empty)", () => {
    const resolved = CORPUS.filter((c) => resolveTailwindClass(c) !== null)
    expect(resolved.length).toBeGreaterThan(600)
  })
})
