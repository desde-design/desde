import { describe, expect, it } from "vitest"
import type { StyleOrigin } from "@/types/bridge"
import {
  canOverlayComputedValue,
  freshComputedStyles,
} from "./fresh-computed-styles"
import { inferColor } from "./infer-from-computed"

function origin(partial: Partial<StyleOrigin> & { property: string }): StyleOrigin {
  return {
    computedValue: "",
    winningRule: null,
    varChain: [],
    ...partial,
  }
}

describe("freshComputedStyles", () => {
  it("overlays a re-read computed value over the inspection-time snapshot (F8)", () => {
    // The live values from the rec-4 run: `.org-avatar` was rose when selected
    // and green after the edit landed.
    const result = freshComputedStyles(
      { "background-color": "rgb(255, 171, 171)", color: "rgb(0, 0, 0)" },
      {
        "background-color": origin({
          property: "background-color",
          computedValue: "rgb(34, 197, 94)",
        }),
      },
    )
    expect(result).toEqual({
      "background-color": "rgb(34, 197, 94)",
      color: "rgb(0, 0, 0)",
    })
  })

  it("returns the snapshot by reference when no origin adds anything", () => {
    const snapshot = { "background-color": "rgb(34, 197, 94)" }
    // Same value → no overlay; and an origin whose computedValue is empty must
    // not blank the key.
    expect(
      freshComputedStyles(snapshot, {
        "background-color": origin({
          property: "background-color",
          computedValue: "rgb(34, 197, 94)",
        }),
        "border-color": origin({ property: "border-color", computedValue: "" }),
      }),
    ).toBe(snapshot)
    expect(freshComputedStyles(snapshot, {})).toBe(snapshot)
  })

  it("keeps a snapshot-only property the provenance said nothing about", () => {
    const result = freshComputedStyles(
      { "border-top-color": "rgb(1, 2, 3)" },
      {
        "background-color": origin({
          property: "background-color",
          computedValue: "rgb(9, 9, 9)",
        }),
      },
    )
    expect(result).toEqual({
      "border-top-color": "rgb(1, 2, 3)",
      "background-color": "rgb(9, 9, 9)",
    })
  })

  it("keys the overlay off the origin's own property, not the map key", () => {
    const result = freshComputedStyles(undefined, {
      requested: origin({ property: "background-color", computedValue: "red" }),
    })
    expect(result).toEqual({ "background-color": "red" })
  })

  it("works with no snapshot at all", () => {
    expect(freshComputedStyles(undefined, {})).toBeUndefined()
  })
})

/**
 * L3 gate — the overlay must never hand a consuming row a value it cannot render.
 *
 * The regression, live on `header.acme-ui-app-navbar`: provenance asks for the
 * `border-color` SHORTHAND (what the Border → Color row edits), the
 * `ELEMENT_INSPECTED` snapshot carries only the sided longhands, and Chromium
 * serialises the shorthand as the multi-value form when the four sides differ
 * (measured in `tasks/scripts/style-provenance-smoke.mts` § "shorthand
 * serialisation"). Overlaying it introduced a key the row reads FIRST, so
 * `inferColor` stopped falling back to `border-top-color` and rendered
 * `rgb(0, 9, 51) rgb(0, 9, 51) rgb(224, 228, 234) (computed)` with a chip in a
 * colour no side has.
 */
describe("freshComputedStyles — a multi-value shorthand can't reach a colour row (L3)", () => {
  /** The live navbar header: border-bottom only, so the four sides disagree. */
  const ASYMMETRIC_SNAPSHOT = {
    "border-top-color": "rgb(0, 9, 51)",
    "border-right-color": "rgb(0, 9, 51)",
    "border-bottom-color": "rgb(224, 228, 234)",
    "border-left-color": "rgb(0, 9, 51)",
  }
  const MULTI_VALUE = "rgb(0, 9, 51) rgb(0, 9, 51) rgb(224, 228, 234)"

  it("leaves the shorthand out, so inferColor still reports the palette match", () => {
    const result = freshComputedStyles(ASYMMETRIC_SNAPSHOT, {
      "border-color": origin({
        property: "border-color",
        computedValue: MULTI_VALUE,
      }),
    })
    // Nothing was overlaid at all → the snapshot comes back by reference.
    expect(result).toBe(ASYMMETRIC_SNAPSHOT)
    expect(result?.["border-color"]).toBeUndefined()
    // And the row reads what it read before the overlay existed.
    expect(inferColor(result, "border")).toEqual({
      kind: "palette",
      family: "slate",
      shade: 900,
      raws: [],
    })
  })

  it("still overlays the shorthand when the engine serialises ONE value", () => {
    // All four sides equal → Chromium collapses to a single colour, which is
    // exactly the sided value, so the row's branch change is a no-op.
    const result = freshComputedStyles(ASYMMETRIC_SNAPSHOT, {
      "border-color": origin({
        property: "border-color",
        computedValue: "rgb(34, 197, 94)",
      }),
    })
    expect(result?.["border-color"]).toBe("rgb(34, 197, 94)")
    expect(inferColor(result, "border")).toEqual({
      kind: "palette",
      family: "green",
      shade: 500,
      raws: [],
    })
  })

  it("refuses every multi-value shorthand, not border-color by name", () => {
    const result = freshComputedStyles(
      { "padding-top": "16px" },
      {
        padding: origin({ property: "padding", computedValue: "16px 8px" }),
        margin: origin({ property: "margin", computedValue: "0px 4px 8px" }),
        "border-width": origin({
          property: "border-width",
          computedValue: "0px 0px 1px",
        }),
        "border-style": origin({
          property: "border-style",
          computedValue: "none none solid",
        }),
        "border-radius": origin({
          property: "border-radius",
          computedValue: "8px 8px 0px 0px",
        }),
      },
    )
    expect(result).toEqual({ "padding-top": "16px" })
  })

  it("allows a multi-token value for a key the snapshot already carries", () => {
    // A single `box-shadow` layer is legitimately multi-token, and the row was
    // already being fed the engine's serialisation for that key — refusing it
    // would break the shadow refresh for no benefit.
    const fresh = "rgba(0, 0, 0, 0.1) 0px 4px 6px -1px"
    const result = freshComputedStyles(
      { "box-shadow": "rgba(0, 0, 0, 0.05) 0px 1px 2px 0px" },
      { "box-shadow": origin({ property: "box-shadow", computedValue: fresh }) },
    )
    expect(result?.["box-shadow"]).toBe(fresh)
  })
})

describe("canOverlayComputedValue", () => {
  it("counts top-level components, ignoring whitespace inside parens", () => {
    expect(canOverlayComputedValue("border-color", "rgb(0, 9, 51)", {})).toBe(true)
    expect(
      canOverlayComputedValue("border-color", "rgb(0, 9, 51) rgb(1, 1, 1)", {}),
    ).toBe(false)
    expect(canOverlayComputedValue("border-radius", "9999px", undefined)).toBe(true)
    expect(canOverlayComputedValue("line-height", "normal", undefined)).toBe(true)
  })

  it("admits a multi-value serialisation only for an existing snapshot key", () => {
    expect(canOverlayComputedValue("padding", "16px 8px", { padding: "0px" })).toBe(
      true,
    )
    expect(canOverlayComputedValue("padding", "16px 8px", { "padding-top": "0px" })).toBe(
      false,
    )
  })
})
