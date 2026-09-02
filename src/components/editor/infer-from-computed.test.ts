import { describe, expect, it } from "vitest"
import {
  inferBorder,
  inferColor,
  inferGapAllAxes,
  inferShadow,
  inferSpacingAllSides,
  inferTypography,
} from "./infer-from-computed"

describe("inferSpacingAllSides", () => {
  it("returns the snapped step when all four sides match", () => {
    expect(
      inferSpacingAllSides(
        {
          "padding-top": "16px",
          "padding-right": "16px",
          "padding-bottom": "16px",
          "padding-left": "16px",
        },
        "padding",
      ),
    ).toBe(4) // 16px = 1rem = step 4
  })

  it("returns null when sides differ (mixed)", () => {
    expect(
      inferSpacingAllSides(
        {
          "padding-top": "16px",
          "padding-right": "8px",
          "padding-bottom": "16px",
          "padding-left": "8px",
        },
        "padding",
      ),
    ).toBeNull()
  })

  it("snaps slightly off-scale values to the closest step", () => {
    // 13px is between p-3 (12px) and p-4 (16px) — closer to 12, so → 3
    expect(
      inferSpacingAllSides(
        {
          "padding-top": "13px",
          "padding-right": "13px",
          "padding-bottom": "13px",
          "padding-left": "13px",
        },
        "padding",
      ),
    ).toBe(3)
  })

  it("returns null when computedStyles is undefined", () => {
    expect(inferSpacingAllSides(undefined, "padding")).toBeNull()
  })

  it("handles rem and zero values", () => {
    expect(
      inferSpacingAllSides(
        {
          "margin-top": "0",
          "margin-right": "0",
          "margin-bottom": "0",
          "margin-left": "0",
        },
        "margin",
      ),
    ).toBe(0)
    expect(
      inferSpacingAllSides(
        {
          "margin-top": "1.5rem",
          "margin-right": "1.5rem",
          "margin-bottom": "1.5rem",
          "margin-left": "1.5rem",
        },
        "margin",
      ),
    ).toBe(6) // 1.5rem = 24px = step 6
  })
})

describe("inferGapAllAxes", () => {
  it("infers gap from row/column-gap when they match", () => {
    expect(
      inferGapAllAxes({ "row-gap": "16px", "column-gap": "16px" }),
    ).toBe(4)
  })

  it("returns null when row and column gaps differ", () => {
    expect(
      inferGapAllAxes({ "row-gap": "16px", "column-gap": "8px" }),
    ).toBeNull()
  })

  it("falls back to the shorthand `gap` property", () => {
    expect(inferGapAllAxes({ gap: "8px" })).toBe(2)
  })
})

describe("inferColor", () => {
  it("matches an exact emerald-500 background to the palette", () => {
    expect(
      inferColor({ "background-color": "rgb(16, 185, 129)" }, "bg"),
    ).toEqual({
      kind: "palette",
      family: "emerald",
      shade: 500,
      raws: [],
    })
  })

  it("returns transparent for alpha-0 colors", () => {
    expect(
      inferColor({ "background-color": "rgba(0, 0, 0, 0)" }, "bg"),
    ).toEqual({ kind: "special", name: "transparent", raws: [] })
  })

  it("returns null for the bridge's unparseable values", () => {
    expect(inferColor({ "background-color": "auto" }, "bg")).toBeNull()
    expect(inferColor({}, "bg")).toBeNull()
    expect(inferColor(undefined, "bg")).toBeNull()
  })

  it("falls back to border-top-color for the border property", () => {
    expect(
      inferColor({ "border-top-color": "rgb(220, 38, 38)" }, "border"),
    ).toEqual({
      kind: "palette",
      family: "red",
      shade: 600,
      raws: [],
    })
  })

  it("matches white as a special, not a palette family", () => {
    expect(
      inferColor({ "background-color": "rgb(255, 255, 255)" }, "bg"),
    ).toEqual({ kind: "special", name: "white", raws: [] })
  })

  it("surfaces an unparseable-but-renderable color as a custom value", () => {
    // The Tailwind-v4 case: the browser reports the compiled color in a
    // format the RGB matcher doesn't model (oklch). Rather than blank
    // the chip, show the actual value — the browser renders it directly.
    expect(
      inferColor({ "background-color": "oklch(0.62 0.19 259.8)" }, "bg"),
    ).toEqual({ kind: "custom", css: "oklch(0.62 0.19 259.8)", raws: [] })
  })

  it("stays blank for no-color sentinels", () => {
    expect(inferColor({ "background-color": "currentcolor" }, "bg")).toBeNull()
    expect(inferColor({ "background-color": "inherit" }, "bg")).toBeNull()
  })

  it("matches the computed color to a design token when supplied", () => {
    expect(
      inferColor({ "background-color": "rgb(0, 68, 244)" }, "bg", [
        { name: "--brand-primary", value: "#0044f4" },
      ]),
    ).toEqual({ kind: "token", tokenName: "--brand-primary", raws: [] })
  })

  it("matches an hsl-authored token against the rgb computed color", () => {
    // hsl(217 91% 60%) ≈ rgb(59, 130, 246) (blue-500). The token is
    // authored in HSL but the computed value is rgb — they still match.
    expect(
      inferColor({ "background-color": "rgb(59, 130, 246)" }, "bg", [
        { name: "--accent", value: "hsl(217, 91%, 60%)" },
      ]),
    ).toEqual({ kind: "token", tokenName: "--accent", raws: [] })
  })

  it("prefers a token over the nearest palette step", () => {
    // emerald-500 is rgb(16,185,129); a token sitting on it wins.
    expect(
      inferColor({ "background-color": "rgb(16, 185, 129)" }, "bg", [
        { name: "--success", value: "rgb(16, 185, 129)" },
      ]),
    ).toEqual({ kind: "token", tokenName: "--success", raws: [] })
  })
})

describe("inferShadow", () => {
  it("returns null when there is no shadow", () => {
    expect(inferShadow({ "box-shadow": "none" })).toBeNull()
    expect(inferShadow({})).toBeNull()
    expect(inferShadow(undefined)).toBeNull()
  })

  it("snaps a small computed shadow to a low preset", () => {
    // sm preset reference blur is 3px.
    expect(
      inferShadow({ "box-shadow": "rgba(0, 0, 0, 0.1) 0px 1px 3px 0px" }),
    ).toBe("sm")
  })

  it("snaps a large layered shadow to a high preset, ignoring rgba commas", () => {
    // Largest blur is 25px → xl. The rgba() commas must not split layers.
    expect(
      inferShadow({
        "box-shadow":
          "rgba(0, 0, 0, 0.1) 0px 20px 25px -5px, rgba(0, 0, 0, 0.1) 0px 8px 10px -6px",
      }),
    ).toBe("xl")
  })
})

describe("inferBorder", () => {
  it("infers width / style / radius when uniform", () => {
    expect(
      inferBorder({
        "border-top-width": "2px",
        "border-right-width": "2px",
        "border-bottom-width": "2px",
        "border-left-width": "2px",
        "border-top-style": "solid",
        "border-right-style": "solid",
        "border-bottom-style": "solid",
        "border-left-style": "solid",
        "border-radius": "8px",
      }),
    ).toEqual({ width: 2, style: "solid", radius: "lg" })
  })

  it("returns null fields when sides differ", () => {
    expect(
      inferBorder({
        "border-top-width": "2px",
        "border-right-width": "0px",
        "border-bottom-width": "2px",
        "border-left-width": "0px",
        "border-top-style": "solid",
        "border-right-style": "none",
        "border-bottom-style": "solid",
        "border-left-style": "none",
      }),
    ).toEqual({ width: null, style: null, radius: null })
  })

  it("treats border-style: none as no style", () => {
    expect(
      inferBorder({
        "border-top-style": "none",
        "border-right-style": "none",
        "border-bottom-style": "none",
        "border-left-style": "none",
      }),
    ).toEqual({ width: null, style: null, radius: null })
  })

  it("recognizes 9999px as a `full` radius", () => {
    expect(inferBorder({ "border-radius": "9999px" })).toMatchObject({
      radius: "full",
    })
  })
})

describe("inferTypography", () => {
  it("snaps font-size, weight, leading, tracking, align", () => {
    expect(
      inferTypography({
        "font-size": "0.875rem", // sm
        "font-weight": "600", // semibold
        "line-height": "1.375", // unitless multiplier — exactly snug
        "letter-spacing": "0em", // normal
        "text-align": "center",
      }),
    ).toEqual({
      size: "sm",
      weight: "semibold",
      leading: "snug",
      tracking: "normal",
      align: "center",
    })
  })

  it("handles `normal` line-height as the named keyword", () => {
    expect(inferTypography({ "line-height": "normal" })).toMatchObject({
      leading: "normal",
    })
  })

  it("returns nulls for empty input", () => {
    expect(inferTypography(undefined)).toEqual({
      size: null,
      weight: null,
      leading: null,
      tracking: null,
      align: null,
    })
  })

  it("ignores unknown text-align values", () => {
    expect(inferTypography({ "text-align": "diagonal" })).toMatchObject({
      align: null,
    })
  })
})
