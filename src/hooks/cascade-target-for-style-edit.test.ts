/**
 * Gate tests for the multi-property cascade oracle (Phase 2).
 *
 * These deliberately drive the WHOLE chain a dispatched style edit takes —
 * `StructuralEdit` → `cascadeTargetForStyleEdit` → `deriveExpectation` →
 * `verifyRender` — because the defect being closed lived in the seam: the
 * evaluator was fine, the walker was fine, and the shell handed them ONE
 * representative property. A test on any single layer cannot see that.
 *
 * The injected provenance reader answers PER REQUESTED PROPERTY, which is what
 * lets these fixtures reproduce the CSSOM asymmetry faithfully: a rule declaring
 * only `padding-left` is not a candidate in the walk for `padding` (CSSOM reports
 * `''` for a shorthand the rule didn't declare), but it is one for `padding-left`.
 */
import { describe, expect, it } from "vitest"
import type { StructuralEdit } from "@/editor/core"
import type { StyleOrigin } from "@/types/bridge"
import { deriveExpectation, verifyRender } from "@/editor/verification"
import type { VerifyDeps } from "@/editor/verification"
import { cascadeTargetForStyleEdit } from "./cascade-target-for-style-edit"

const FIRST_PARTY = { href: "http://x/src/App.vue" }
const LIBRARY = {
  href: "http://x/node_modules/@acme/design-system/dist/style.css",
  package: "@acme/design-system",
}

const target = {
  targetId: ".ui-card",
  selector: ".ui-card",
  editTarget: { file: "src/App.vue", line: 3, column: 2 },
}

function scopedOverride(declarations: Record<string, string>): StructuralEdit {
  return {
    kind: "scoped-css-override",
    id: "e1",
    target,
    anchor: { file: "src/App.vue", line: 3, column: 2 },
    declarations,
  }
}

/** React `jsx-style` className splice — the `classes` cascade owner. */
function classNameEdit(...addClasses: string[]): StructuralEdit {
  return { kind: "jsx-style", id: "e1", target, mode: "classname", addClasses }
}

/** Our own `[data-desde-src]` rule, owning `property` with the given value. */
function ourRule(property: string, value: string) {
  return {
    selector: '[data-desde-src="src/App.vue:3:2"][data-v-a1]',
    stylesheet: FIRST_PARTY,
    declaration: `${property}: ${value} !important`,
    specificity: [0, 2, 0] as [number, number, number],
  }
}

function libraryRule(property: string, value: string) {
  return {
    selector: ".ui-card",
    stylesheet: LIBRARY,
    declaration: `${property}: ${value} !important`,
    specificity: [0, 1, 0] as [number, number, number],
  }
}

function origin(over: Partial<StyleOrigin> & { property: string }): StyleOrigin {
  return { computedValue: "", winningRule: null, varChain: [], ...over }
}

/**
 * Run the real chain for `edit` against a per-property provenance answer.
 * Returns the single `VerificationResult` the user would get — one result per
 * edit, never one per property.
 */
async function verify(
  edit: StructuralEdit,
  provenance: Record<string, StyleOrigin>,
  over: Partial<VerifyDeps> = {},
) {
  const cascadeTarget = cascadeTargetForStyleEdit(edit)
  expect(cascadeTarget).not.toBeNull()
  const expectation = deriveExpectation({
    editId: edit.id,
    selector: target.selector,
    expectedValue: cascadeTarget!.value,
    editKind: "style",
    styleProperty: cascadeTarget!.property,
    cascadeOwner: cascadeTarget!.owner,
    styleProperties: cascadeTarget!.properties,
  })
  expect(expectation).not.toBeNull()
  return verifyRender(expectation!, {
    readRenderedValue: async () => "block",
    pollIntervalMs: 1,
    timeoutMs: 10,
    sleep: async () => {},
    readStyleProvenance: async (_selector, properties) =>
      Object.fromEntries(
        properties.flatMap((p) => (provenance[p] ? [[p, provenance[p]]] : [])),
      ),
    ...over,
  })
}

describe("cascadeTargetForStyleEdit — the verified property set", () => {
  it("carries EVERY declaration the edit set, not one representative", () => {
    const t = cascadeTargetForStyleEdit(
      scopedOverride({ "border-style": "solid", "border-width": "1px" }),
    )
    expect(t!.properties.map((p) => p.property).sort()).toEqual([
      "border-bottom-style",
      "border-bottom-width",
      "border-left-style",
      "border-left-width",
      "border-right-style",
      "border-right-width",
      "border-top-style",
      "border-top-width",
    ])
    // The representative survives for the label + accessor only.
    expect(t!.property).toBe("border-style")
    expect(t!.value).toBe("solid")
  })

  it("attaches NO expected value for the classes owner — Tailwind authors it", () => {
    const t = cascadeTargetForStyleEdit({
      kind: "jsx-style",
      id: "e2",
      target,
      mode: "classname",
      addClasses: ["font-bold"],
    })
    expect(t!.owner).toEqual({ kind: "classes", classes: ["font-bold"] })
    expect(t!.properties).toEqual([{ property: "font-weight" }])
  })

  it("attaches a per-property expected value for the inline owner", () => {
    // `inline` writes the literal into `style={{}}` itself, so the comparison is
    // authored-vs-specified for one declaration — the premise `classes` lacks.
    const t = cascadeTargetForStyleEdit({
      kind: "jsx-style",
      id: "e2",
      target,
      mode: "inline",
      declarations: { "font-weight": "700" },
    })
    expect(t!.owner).toEqual({ kind: "inline" })
    expect(t!.properties).toEqual([
      { property: "font-weight", expectedDeclarationValue: "700" },
    ])
  })

  it("returns null for an edit kind it does not recognize", () => {
    expect(
      cascadeTargetForStyleEdit({
        kind: "prop",
        id: "e3",
        target,
        propName: "title",
        value: "x",
      }),
    ).toBeNull()
  })
})

describe("multi-property verification (the border false pass)", () => {
  // THE Phase 2 scenario, verbatim from the limitations list: the user applies
  // Tailwind `border`, so the edit writes `border-style: solid !important` AND
  // `border-width: 1px !important`, but the element already carries
  // `style="border-width: 0 !important"`. Sampling one representative property
  // (`border-style`, the sorted-first key) reported a PASS while the border was
  // invisible, because the un-sampled property lost.
  const borderEdit = scopedOverride({
    "border-style": "solid",
    "border-width": "1px",
  })

  function borderProvenance(widthInlineImportant: boolean) {
    const out: Record<string, StyleOrigin> = {}
    for (const side of ["top", "right", "bottom", "left"]) {
      out[`border-${side}-style`] = origin({
        property: `border-${side}-style`,
        computedValue: "solid",
        winningRule: ourRule(`border-${side}-style`, "solid"),
      })
      out[`border-${side}-width`] = origin({
        property: `border-${side}-width`,
        computedValue: widthInlineImportant ? "0px" : "1px",
        winningRule: ourRule(`border-${side}-width`, "1px"),
        ...(widthInlineImportant
          ? { inline: { value: "0", important: true } }
          : {}),
      })
    }
    return out
  }

  it("FAILS and names border-width when a per-property inline !important beats us", async () => {
    const result = await verify(borderEdit, borderProvenance(true))
    expect(result.status).toBe("fail")
    expect(result.failedAt).toBe("L2")
    expect(result.cause).toBe("css-overridden")
    expect(result.detail).toContain("border-")
    expect(result.detail).toContain("width")
    expect(result.detail).toContain("inline style")
    // Partial application is named — the styles DID land, the widths did not.
    expect(result.detail).toContain("only partly applied")
  })

  it("passes when every property the edit set is owned", async () => {
    const result = await verify(borderEdit, borderProvenance(false))
    expect(result.status).toBe("pass")
    expect(result.detail).toContain("all 8 properties")
  })

  it("FAILS on a two-LONGHAND edit whose second property lost (the false pass, expansion out of the picture)", async () => {
    // Same defect isolated from the shorthand dimension: the edit sets two plain
    // longhands, so nothing is expanded. The pre-fix oracle sampled the
    // sorted-first key (`border-left-style`, which our rule owns) and reported a
    // PASS while `border-left-width` was beaten by an inline `!important` and the
    // border stayed invisible.
    const edit = scopedOverride({
      "border-left-style": "solid",
      "border-left-width": "1px",
    })
    expect(cascadeTargetForStyleEdit(edit)!.property).toBe("border-left-style")
    const result = await verify(edit, {
      "border-left-style": origin({
        property: "border-left-style",
        computedValue: "solid",
        winningRule: ourRule("border-left-style", "solid"),
      }),
      "border-left-width": origin({
        property: "border-left-width",
        computedValue: "0px",
        winningRule: ourRule("border-left-width", "1px"),
        inline: { value: "0", important: true },
      }),
    })
    expect(result.status).toBe("fail")
    expect(result.cause).toBe("css-overridden")
    expect(result.detail).toContain("border-left-width")
    expect(result.detail).toContain("inline style")
  })

  it("produces exactly ONE result for a multi-property edit (no per-property noise)", async () => {
    // The aggregate is the user-facing contract: one Checks record, at most one
    // toast, regardless of how many properties were verified.
    const result = await verify(borderEdit, borderProvenance(true))
    expect(result.editId).toBe("e1")
    expect(Array.isArray(result)).toBe(false)
  })
})

describe("shorthand vs longhand (the padding blind spot)", () => {
  // `p-4` resolves to the SHORTHAND `{ padding: '1rem' }`. CSSOM's
  // `getPropertyValue('padding')` returns `''` for a rule that sets only
  // longhands, so a library rule declaring `padding-left` was never a candidate
  // in the walk for `padding` — our shorthand rule was reported as the winner
  // while the padding visibly did not move on the side the library owns.
  const paddingEdit = scopedOverride({ padding: "1rem" })

  /** Faithful CSSOM asymmetry: the library's `padding-left` rule is a candidate
   *  for `padding-left` only; the shorthand `padding` sees only our rule. */
  const paddingProvenance: Record<string, StyleOrigin> = {
    padding: origin({
      property: "padding",
      computedValue: "16px",
      winningRule: ourRule("padding", "1rem"),
    }),
    "padding-top": origin({
      property: "padding-top",
      computedValue: "16px",
      winningRule: ourRule("padding-top", "1rem"),
    }),
    "padding-right": origin({
      property: "padding-right",
      computedValue: "16px",
      winningRule: ourRule("padding-right", "1rem"),
    }),
    "padding-bottom": origin({
      property: "padding-bottom",
      computedValue: "16px",
      winningRule: ourRule("padding-bottom", "1rem"),
    }),
    "padding-left": origin({
      property: "padding-left",
      computedValue: "32px",
      winningRule: libraryRule("padding-left", "2rem"),
    }),
  }

  it("expands the shorthand so a competing LONGHAND rule is a candidate at all", () => {
    const t = cascadeTargetForStyleEdit(paddingEdit)
    expect(t!.properties.map((p) => p.property)).toEqual([
      "padding-bottom",
      "padding-left",
      "padding-right",
      "padding-top",
    ])
    expect(t!.properties.every((p) => p.expectedDeclarationValue === "1rem")).toBe(
      true,
    )
  })

  it("FAILS and names the library rule that owns padding-left", async () => {
    const result = await verify(paddingEdit, paddingProvenance)
    expect(result.status).toBe("fail")
    expect(result.cause).toBe("css-overridden")
    expect(result.detail).toContain("padding-left")
    expect(result.detail).toContain("@acme/design-system")
  })

  it("never asks about the bare shorthand (its read is the blind spot)", async () => {
    const asked: string[][] = []
    await verify(paddingEdit, paddingProvenance, {
      readStyleProvenance: async (_s, properties) => {
        asked.push([...properties])
        return {}
      },
      readRenderedValue: async () => "16px",
    })
    expect(asked.length).toBeGreaterThan(0)
    for (const set of asked) expect(set).not.toContain("padding")
  })

  it("DEGRADES to the shorthand (today's behavior) when it cannot be expanded", async () => {
    // `border-[var(--brand)]` → `border-color: var(--brand)`. Expanding it would
    // make our OWN rule stop answering for `border-top-color` (CSSOM serializes
    // a pending-substitution longhand as `''`), turning a good edit into a
    // reported loss. So the shorthand is verified as-is — no signal on the
    // longhands, rather than a wrong verdict.
    const edit = scopedOverride({ "border-color": "var(--brand)" })
    const t = cascadeTargetForStyleEdit(edit)
    expect(t!.properties).toEqual([
      { property: "border-color", expectedDeclarationValue: "var(--brand)" },
    ])
    const result = await verify(edit, {
      "border-color": origin({
        property: "border-color",
        computedValue: "rgb(1, 2, 3)",
        winningRule: ourRule("border-color", "var(--brand)"),
      }),
    })
    expect(result.status).toBe("pass")
  })
})

// ── The `classes` owner: expansion AND value comparison are both unsound here,
// because Tailwind — not us — authors the declaration.
//
// The provenance in these fixtures is shaped the way real Chromium reports it
// (measured, not assumed): a utility whose value routes through a custom property
// is a *pending-substitution value*, so `rule.style.getPropertyValue(longhand)`
// returns `''` and the walker's candidacy test
// (`if (!rule.style.getPropertyValue(property)) continue`,
// `src/bridge/style-provenance.ts`) skips the utility for its OWN longhands.
// Preflight (`*, ::before, ::after { margin: 0; padding: 0; border: 0 solid }`)
// declares real shorthands, so it answers for every longhand and wins them.
//
//   v4 .p-4          { padding: calc(var(--spacing)*4) }  → padding-top          ''
//   v4 .rounded-lg   { border-radius: var(--radius-lg) }  → border-top-left-…    ''
//   v4 .border-red-500 { border-color: var(--color-red-500) } → border-top-color ''
//   v3 .border-red-500 { border-color: rgb(… / var(--tw-border-opacity)) } → ''
//
// Every case below is a PASS: the computed value is visibly correct, and the only
// honest verdict is "the utility owns the property it declares". Against the
// pre-fix code (unconditional expansion + value comparison) all of them FAIL —
// `p-4` as `overridden` by the preflight selector, `rounded-lg` as `no-rule`.
describe("classes owner — shorthand utilities (the false-alarm regression)", () => {
  const PREFLIGHT = "*, ::after, ::before"

  /** A Tailwind utility rule that wins the property it declares. */
  function utilityRule(className: string, declaration: string) {
    return {
      selector: `.${className}`,
      stylesheet: FIRST_PARTY,
      declaration,
      specificity: [0, 1, 0] as [number, number, number],
    }
  }

  /** Preflight, which owns the longhands the utility cannot answer for. */
  function preflightRule(property: string, value: string) {
    return {
      selector: PREFLIGHT,
      stylesheet: FIRST_PARTY,
      declaration: `${property}: ${value}`,
      specificity: [0, 0, 0] as [number, number, number],
    }
  }

  it("p-4 PASSES on the shorthand instead of losing four longhands to preflight", async () => {
    const edit = classNameEdit("p-4")
    // Unexpanded and ownership-only: `padding` alone, no expected value.
    expect(cascadeTargetForStyleEdit(edit)!.properties).toEqual([
      { property: "padding" },
    ])
    const result = await verify(edit, {
      padding: origin({
        property: "padding",
        computedValue: "16px",
        winningRule: utilityRule("p-4", "padding: calc(var(--spacing)*4)"),
      }),
      // What the pre-fix expanded set would have asked for, answered faithfully:
      // the utility is not a candidate, so preflight wins every longhand.
      ...Object.fromEntries(
        ["top", "right", "bottom", "left"].map((side) => [
          `padding-${side}`,
          origin({
            property: `padding-${side}`,
            computedValue: "16px",
            winningRule: preflightRule(`padding-${side}`, "0px"),
          }),
        ]),
      ),
    })
    expect(result.status).toBe("pass")
  })

  it("rounded-lg PASSES instead of reporting no-rule on four corner longhands", async () => {
    const edit = classNameEdit("rounded-lg")
    expect(cascadeTargetForStyleEdit(edit)!.properties).toEqual([
      { property: "border-radius" },
    ])
    // Preflight sets no radius, so the corner longhands have no candidate at all —
    // the pre-fix verdict was `no-rule` on a visibly rounded element.
    const result = await verify(edit, {
      "border-radius": origin({
        property: "border-radius",
        computedValue: "8px",
        winningRule: utilityRule("rounded-lg", "border-radius: var(--radius-lg)"),
      }),
    })
    expect(result.status).toBe("pass")
  })

  it("border-red-500 PASSES on v4 (var()) and on v3 (rgb-with-var)", async () => {
    for (const declaration of [
      "border-color: var(--color-red-500)",
      "border-color: rgb(239 68 68 / var(--tw-border-opacity))",
    ]) {
      const edit = classNameEdit("border-red-500")
      expect(cascadeTargetForStyleEdit(edit)!.properties).toEqual([
        { property: "border-color" },
      ])
      const result = await verify(edit, {
        "border-color": origin({
          property: "border-color",
          computedValue: "rgb(239, 68, 68)",
          winningRule: utilityRule("border-red-500", declaration),
        }),
        // v4 preflight's `border: 0 solid` answers for the side longhands (the
        // omitted colour resets to `currentcolor`); v3 preflight declares a
        // literal `border-color`. Either way the utility is not a candidate there.
        ...Object.fromEntries(
          ["top", "right", "bottom", "left"].map((side) => [
            `border-${side}-color`,
            origin({
              property: `border-${side}-color`,
              computedValue: "rgb(239, 68, 68)",
              winningRule: preflightRule(`border-${side}-color`, "currentcolor"),
            }),
          ]),
        ),
      })
      expect(result.status).toBe("pass")
    }
  })

  it("PASSES when the substrate's theme value differs from our model of the utility", async () => {
    // Tailwind v3 emits plain literals for every customizable scale, so a
    // `theme.extend.spacing['4'] = '1.125rem'` substrate has `.p-4 { padding:
    // 1.125rem }` — comparable, and NOT what our resolver models (`1rem`). Value-
    // comparing there says our model drifted, not that the edit failed; the
    // pre-fix code turned it into `stale-value` → the full poll budget → an
    // `hmr-stale` failure claiming OUR declaration was stale.
    const edit = classNameEdit("p-4")
    const result = await verify(edit, {
      padding: origin({
        property: "padding",
        computedValue: "18px",
        winningRule: utilityRule("p-4", "padding: 1.125rem"),
      }),
    })
    expect(result.status).toBe("pass")
  })

  it("STILL fails when a library rule genuinely outranks the utility", async () => {
    // Ownership-only must not go soft: the verdict this lane exists for survives.
    const edit = classNameEdit("p-4")
    const result = await verify(edit, {
      padding: origin({
        property: "padding",
        computedValue: "32px",
        winningRule: libraryRule("padding", "2rem"),
      }),
    })
    expect(result.status).toBe("fail")
    expect(result.cause).toBe("css-overridden")
    expect(result.detail).toContain("@acme/design-system")
  })

  it("carries EVERY authored property on a multi-declaration utility, unexpanded", async () => {
    // `border` resolves to `{ border-width: 1px, border-style: solid }` — two
    // shorthands. Both are verified (the multi-property fix is lane-independent);
    // neither is expanded.
    const edit = classNameEdit("border")
    expect(
      cascadeTargetForStyleEdit(edit)!.properties.map((p) => p.property),
    ).toEqual(["border-style", "border-width"])
    const result = await verify(edit, {
      "border-style": origin({
        property: "border-style",
        winningRule: utilityRule("border", "border-style: solid"),
      }),
      "border-width": origin({
        property: "border-width",
        winningRule: preflightRule("border-width", "0px"),
      }),
    })
    // The width lost to preflight — a real per-property loss on this lane, still
    // reported.
    expect(result.status).toBe("fail")
    expect(result.cause).toBe("css-overridden")
    expect(result.detail).toContain("border-width")
  })
})

describe("per-property value staleness", () => {
  const borderEdit = scopedOverride({
    "border-style": "solid",
    "border-width": "1px",
  })

  it("reports hmr-stale — NOT css-overridden — when ONE longhand still carries the old value", async () => {
    // Our rule owns every property; the left width still declares the previous
    // value, so nobody outranked us and "escalate the scope" would be wrong.
    const provenance: Record<string, StyleOrigin> = {}
    for (const side of ["top", "right", "bottom", "left"]) {
      provenance[`border-${side}-style`] = origin({
        property: `border-${side}-style`,
        winningRule: ourRule(`border-${side}-style`, "solid"),
      })
      provenance[`border-${side}-width`] = origin({
        property: `border-${side}-width`,
        winningRule: ourRule(
          `border-${side}-width`,
          side === "left" ? "4px" : "1px",
        ),
      })
    }
    const result = await verify(borderEdit, provenance)
    expect(result.status).toBe("fail")
    expect(result.cause).toBe("hmr-stale")
    expect(result.detail).toContain("border-left-width")
    expect(result.detail).toContain("still declares the previous value")
    expect(result.detail).not.toContain("broader scope")
  })

  it("prefers the OVERRIDDEN property over a merely stale sibling in the report", async () => {
    // A named competing winner is the one verdict that changes what the user
    // should do (escalate the scope); it must not be masked by a sibling that
    // has merely not HMR'd yet.
    const provenance: Record<string, StyleOrigin> = {}
    for (const side of ["top", "right", "bottom", "left"]) {
      provenance[`border-${side}-style`] = origin({
        // Stale: ours, wrong value. Sorts BEFORE the widths.
        property: `border-${side}-style`,
        winningRule: ourRule(`border-${side}-style`, "dashed"),
      })
      provenance[`border-${side}-width`] = origin({
        property: `border-${side}-width`,
        winningRule: libraryRule(`border-${side}-width`, "0"),
      })
    }
    const result = await verify(borderEdit, provenance)
    expect(result.status).toBe("fail")
    expect(result.cause).toBe("css-overridden")
    expect(result.detail).toContain("@acme/design-system")
  })
})

describe("fail-safe behavior is preserved", () => {
  const paddingEdit = scopedOverride({ padding: "1rem" })

  it("skips (never fails) when the provenance read itself fails", async () => {
    const result = await verify(paddingEdit, {}, {
      readStyleProvenance: async () => null,
    })
    expect(result.status).toBe("skipped")
  })

  it("skips when the whole set is empty AND the selector matches nothing", async () => {
    const result = await verify(paddingEdit, {}, {
      readStyleProvenance: async () => ({}),
      readRenderedValue: async () => null,
    })
    expect(result.status).toBe("skipped")
    expect(result.detail).toContain("no element matches")
  })

  it("does NOT probe-and-skip when only SOME properties have no origin", async () => {
    // Any single origin proves the selector matched, so a per-property miss is a
    // real signal rather than a missing element.
    const result = await verify(paddingEdit, {
      "padding-top": origin({
        property: "padding-top",
        winningRule: ourRule("padding-top", "1rem"),
      }),
    })
    expect(result.status).toBe("fail")
    expect(result.cause).toBe("selector-missing")
  })
})
