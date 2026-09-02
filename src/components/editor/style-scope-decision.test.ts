/**
 * Tests for the provenance-gated scope-decision core (Phase 2).
 */
import { describe, expect, it } from "vitest"
import {
  availableScopes,
  excludePreviewInline,
  isLibraryStylesheet,
  isWarningWorthyReason,
  needsScopeDialog,
  scopeDialogReasonEntries,
  scopeDialogReasons,
  singleScopeWarning,
} from "./style-scope-decision"
import type { StyleOrigin } from "@/types/bridge"

const FIRST_PARTY = { href: "http://x/src/styles/app.css" }
const LIBRARY = {
  href: "http://x/node_modules/@acme/design-system/style.css",
  package: "@acme/design-system",
}

function origin(over: Partial<StyleOrigin> = {}): StyleOrigin {
  return {
    property: "background-color",
    // Empty by default (falsy) so a bare `origin()` — with no winningRule,
    // inline, or varChain either — reads as wholly unambiguous rather than
    // tripping the "un-attributable rendered value" trigger. Tests that need
    // that trigger set computedValue explicitly.
    computedValue: "",
    winningRule: null,
    varChain: [],
    ...over,
  }
}

describe("needsScopeDialog", () => {
  it("does NOT prompt for a plain first-party consumer rule", () => {
    expect(
      needsScopeDialog(
        origin({
          winningRule: {
            selector: ".my-card",
            stylesheet: FIRST_PARTY,
            declaration: "background-color: #eee",
            specificity: [0, 1, 0],
          },
        }),
      ),
    ).toBe(false)
  })

  it("does NOT prompt for an inline override on the element", () => {
    expect(
      needsScopeDialog(origin({ inline: { value: "red", important: false } })),
    ).toBe(false)
  })

  it("prompts for a token-driven value", () => {
    expect(
      needsScopeDialog(
        origin({
          winningRule: {
            selector: ".acme-empty-state",
            stylesheet: LIBRARY,
            declaration: "background-color: var(--acme-color-background-disabled)",
            specificity: [0, 1, 0],
          },
          varChain: [
            {
              name: "--acme-color-background-disabled",
              value: "#f7f7f7",
              definedAt: { selector: ":root", stylesheet: FIRST_PARTY },
            },
          ],
        }),
      ),
    ).toBe(true)
  })

  it("prompts for a library-rendered (node_modules) winning rule", () => {
    expect(
      needsScopeDialog(
        origin({
          winningRule: {
            selector: ".acme-empty-state",
            stylesheet: LIBRARY,
            declaration: "background-color: #f7f7f7",
            specificity: [0, 1, 0],
          },
        }),
      ),
    ).toBe(true)
  })

  it("prompts for an inherited value", () => {
    expect(
      needsScopeDialog(
        origin({
          property: "font-weight",
          inherited: true,
          winningRule: {
            selector: ".acme-button",
            stylesheet: LIBRARY,
            declaration: "font-weight: 600",
            specificity: [0, 1, 0],
          },
        }),
      ),
    ).toBe(true)
  })

  it("prompts for an un-attributable rendered value (no rule, no inline)", () => {
    expect(needsScopeDialog(origin({ winningRule: null, computedValue: "rgb(0,0,0)" }))).toBe(true)
  })
})

describe("availableScopes", () => {
  it("offers element + page always; component only for first-party rules", () => {
    const firstParty = availableScopes(
      origin({
        winningRule: {
          selector: ".my-card",
          stylesheet: FIRST_PARTY,
          declaration: "background-color: #eee",
          specificity: [0, 1, 0],
        },
      }),
    )
    expect(firstParty).toContain("element")
    expect(firstParty).toContain("page")
    expect(firstParty).toContain("component")
    expect(firstParty).not.toContain("token")
  })

  it("hides component scope for a node_modules winning rule", () => {
    const lib = availableScopes(
      origin({
        winningRule: {
          selector: ".acme-empty-state",
          stylesheet: LIBRARY,
          declaration: "background-color: #f7f7f7",
          specificity: [0, 1, 0],
        },
      }),
    )
    expect(lib).not.toContain("component")
  })

  it("offers token scope only when the root token def is first-party", () => {
    const firstPartyToken = availableScopes(
      origin({
        varChain: [
          { name: "--c", value: "#fff", definedAt: { selector: ":root", stylesheet: FIRST_PARTY } },
        ],
      }),
    )
    expect(firstPartyToken).toContain("token")

    const libraryToken = availableScopes(
      origin({
        varChain: [
          { name: "--acme-c", value: "#fff", definedAt: { selector: ":root", stylesheet: LIBRARY } },
        ],
      }),
    )
    expect(libraryToken).not.toContain("token")
  })

  it("drops page scope when there is no stable selector", () => {
    expect(availableScopes(origin({}), { hasStableSelector: false })).not.toContain("page")
  })

  it("offers page on React too, and withholds it only when nothing can hold the rule", () => {
    // A first-party token-backed origin that on Vue would offer page+token.
    const o = origin({
      varChain: [
        { name: "--c", value: "#fff", definedAt: { selector: ":root", stylesheet: FIRST_PARTY } },
      ],
      winningRule: {
        selector: ".x",
        stylesheet: FIRST_PARTY,
        declaration: "color: var(--c)",
        specificity: [0, 1, 0],
      },
    })
    const reactScopes = availableScopes(o, { framework: "react" })
    expect(reactScopes).toContain("page")
    expect(reactScopes).toContain("token")
    expect(reactScopes).toContain("component")
    // The one thing that withholds it is the absence of a destination.
    expect(
      availableScopes(o, { framework: "react", hasOverrideDestination: false }),
    ).not.toContain("page")
    // Vue is unchanged from the same origin.
    expect(availableScopes(o, { framework: "vue3" })).toContain("page")
  })
})

describe("isLibraryStylesheet", () => {
  it("is true for node_modules (has package), false for first-party", () => {
    expect(isLibraryStylesheet(LIBRARY)).toBe(true)
    expect(isLibraryStylesheet(FIRST_PARTY)).toBe(false)
  })
})

describe("needsScopeDialog — !important incumbent", () => {
  it("prompts when a first-party !important rule holds the property", () => {
    expect(
      needsScopeDialog(
        origin({
          winningRule: {
            selector: ".local-override",
            stylesheet: FIRST_PARTY,
            declaration: "background-color: #eee !important",
            specificity: [0, 1, 0],
          },
        }),
      ),
    ).toBe(true)
  })

  it("prompts when an inline !important declaration holds the property", () => {
    expect(
      needsScopeDialog(origin({ inline: { value: "#eee", important: true } })),
    ).toBe(true)
  })

  it("still does not prompt for an ordinary-weight first-party rule", () => {
    expect(
      needsScopeDialog(
        origin({
          winningRule: {
            selector: ".local",
            stylesheet: FIRST_PARTY,
            declaration: "background-color: #eee",
            specificity: [0, 1, 0],
          },
        }),
      ),
    ).toBe(false)
  })
})

describe("scopeDialogReasons", () => {
  it("names the token chain", () => {
    const reasons = scopeDialogReasons(
      origin({
        varChain: [
          {
            name: "--acme-color-background",
            value: "#fff",
            definedAt: { selector: ":root", stylesheet: FIRST_PARTY },
          },
        ],
      }),
    )
    expect(reasons.some((r) => r.includes("--acme-color-background"))).toBe(true)
  })

  it("names a library winner", () => {
    const reasons = scopeDialogReasons(
      origin({
        winningRule: {
          selector: ".ui-card",
          stylesheet: LIBRARY,
          declaration: "background-color: #f7f7f7",
          specificity: [0, 1, 0],
        },
      }),
    )
    expect(reasons.some((r) => r.includes("@acme/design-system"))).toBe(true)
  })

  it("warns about an !important incumbent", () => {
    const reasons = scopeDialogReasons(
      origin({
        winningRule: {
          selector: ".x",
          stylesheet: FIRST_PARTY,
          declaration: "background-color: #eee !important",
          specificity: [0, 1, 0],
        },
      }),
    )
    expect(reasons.some((r) => r.includes("!important"))).toBe(true)
  })

  it("returns no reasons for an unambiguous origin", () => {
    expect(scopeDialogReasons(origin())).toEqual([])
  })
})

describe("availableScopes — React parity", () => {
  const tokenOrigin = origin({
    varChain: [
      {
        name: "--brand-bg",
        value: "#fff",
        definedAt: { selector: ":root", stylesheet: FIRST_PARTY },
      },
    ],
  })

  it("offers the token scope on React when the token is first-party", () => {
    expect(availableScopes(tokenOrigin, { framework: "react" })).toContain("token")
  })

  it("offers the page scope on React — it is no longer Vue-only", () => {
    // It WAS Vue-only, because it wrote an SFC `<style scoped>` block. It now
    // writes a project `.css` on substrates that have no such block, so the
    // framework name stopped being the right question.
    expect(availableScopes(tokenOrigin, { framework: "react" })).toContain("page")
  })

  it("withholds the page scope when there is nowhere to write the rule", () => {
    // The gate is a fact about the PROJECT (does a first-party writable
    // stylesheet reach this page?), not about React. A CSS-Modules-only app
    // has no destination, and a Vue app always does.
    expect(
      availableScopes(tokenOrigin, {
        framework: "react",
        hasOverrideDestination: false,
      }),
    ).not.toContain("page")
    expect(
      availableScopes(tokenOrigin, {
        framework: "vue3",
        hasOverrideDestination: false,
      }),
    ).not.toContain("page")
  })

  it("offers the component scope on React for a first-party winning rule", () => {
    const o = origin({
      winningRule: {
        selector: ".card",
        stylesheet: FIRST_PARTY,
        declaration: "background-color: #eee",
        specificity: [0, 1, 0],
      },
    })
    expect(availableScopes(o, { framework: "react" })).toContain("component")
  })

  it("withholds token and component when they live in a package", () => {
    const o = origin({
      varChain: [
        {
          name: "--acme-bg",
          value: "#fff",
          definedAt: { selector: ":root", stylesheet: LIBRARY },
        },
      ],
      winningRule: {
        selector: ".ui-card",
        stylesheet: LIBRARY,
        declaration: "background-color: #f7f7f7",
        specificity: [0, 1, 0],
      },
    })
    expect(availableScopes(o, { framework: "react" })).toEqual([
      "element",
      "page",
    ])
  })

  it("still offers page on Vue", () => {
    expect(availableScopes(tokenOrigin, { framework: "vue3" })).toContain("page")
  })
})

describe("excludePreviewInline (Phase 2 — the exact fromPreview flag)", () => {
  // Editor's own live preview stamps its resolved declarations inline with
  // `!important`, and the inspector re-reads provenance right after dispatching
  // — so from the SECOND edit of a property onward the origin honestly reports
  // OUR shim. Feeding that to the pre-flight gate interrupts the core
  // iterate-on-a-colour loop with a dialog / warning on every repeat click.
  //
  // The exclusion is keyed on `inline.fromPreview`, which the bridge sets only
  // for a declaration its preview layer actually stamped and the engine actually
  // accepted (`src/bridge/override-preview.ts`). Two earlier approximations —
  // comparing the previewed VALUE, then keying on previewed PROPERTY NAMES — are
  // both retired; the fixtures below therefore express the flag, not a value.
  /** Our shim's declaration as the walker reports it: hex sent, rgb() read back. */
  const previewInline = {
    value: "rgb(239, 68, 68)",
    important: true,
    fromPreview: true,
  }

  it("drops an inline declaration the bridge marked as ours", () => {
    const stripped = excludePreviewInline(origin({ inline: previewInline }))
    expect(stripped.inline).toBeUndefined()
  })

  it("is indifferent to how CSSOM serialized the value", () => {
    // A value comparison matched only the middle spelling; the flag is
    // indifferent, which is the whole point of asking the bridge instead.
    for (const value of ["rgb(239, 68, 68)", "#ef4444", "rgb(239 68 68 / 1)"]) {
      const stripped = excludePreviewInline(
        origin({ inline: { value, important: true, fromPreview: true } }),
      )
      expect(stripped.inline).toBeUndefined()
    }
  })

  it("KEEPS an author's own !important inline — the case the property-name approximation got wrong", () => {
    // THE Phase 2 regression gate. Under the previous cut this declaration was
    // discounted whenever `background-color` happened to be a property the panel
    // had previewed earlier on this element, so the gate went silent exactly
    // where it should have warned. `fromPreview` is absent here, so it stays.
    const authored = { value: "rgb(0, 0, 255)", important: true }
    const kept = excludePreviewInline(origin({ inline: authored }))
    expect(kept.inline).toEqual(authored)
    // And the gate it feeds must still fire.
    expect(needsScopeDialog(kept)).toBe(true)
  })

  it("keeps a plain (non-important) inline declaration with no flag", () => {
    const kept = excludePreviewInline(
      origin({ inline: { value: "blue", important: false } }),
    )
    expect(kept.inline).toEqual({ value: "blue", important: false })
  })

  it("keeps an inline declaration whose flag is explicitly false", () => {
    // Only `true` is a positive claim; anything else is not ours.
    const inline = { value: "blue", important: true, fromPreview: false }
    expect(excludePreviewInline(origin({ inline })).inline).toEqual(inline)
  })

  it("is a no-op (same object) when there is no inline declaration at all", () => {
    const o = origin()
    expect(excludePreviewInline(o)).toBe(o)
  })

  it("is a no-op on an older bridge that never sets the flag (back-compat)", () => {
    const o = origin({ inline: { value: "rgb(239, 68, 68)", important: true } })
    expect(excludePreviewInline(o)).toBe(o)
  })

  it("leaves every other field intact", () => {
    const o = origin({
      inline: previewInline,
      computedValue: "rgb(239, 68, 68)",
      varChain: [
        {
          name: "--brand-bg",
          value: "#fff",
          definedAt: { selector: ":root", stylesheet: FIRST_PARTY },
        },
      ],
    })
    const stripped = excludePreviewInline(o)
    expect(stripped.computedValue).toBe("rgb(239, 68, 68)")
    expect(stripped.varChain).toEqual(o.varChain)
  })

  it("closes the repeat-COLOUR-edit loop end to end", () => {
    // Edit 1 lands on an unambiguous plain first-party rule (no prompt) and
    // previews `bg-red-500`; the `editNonce` re-fetch then reports our own shim
    // back as `rgb(239, 68, 68) !important`, flagged `fromPreview`. Edit 2 of the
    // same property must stay silent instead of tripping the `!important` gate.
    const afterFirstEdit = origin({
      computedValue: "rgb(239, 68, 68)",
      winningRule: {
        selector: ".my-card",
        stylesheet: FIRST_PARTY,
        declaration: "background-color: #eee",
        specificity: [0, 1, 0],
      },
      inline: previewInline,
    })
    expect(needsScopeDialog(afterFirstEdit)).toBe(true)
    expect(needsScopeDialog(excludePreviewInline(afterFirstEdit))).toBe(false)
  })
})

/**
 * The dialog-worthy / warning-worthy SPLIT (cascade follow-ups, final live
 * report §3-B). A live run made four Background edits on a transparent
 * `div.metricscard-title.sm`; all four landed (confirmed by computed style AND
 * by the written source rule) and all four toasted "This may not take effect —
 * No stylesheet rule declares this property…". A property no rule declares is
 * the easiest case for a local override to win: there is nothing to outrank.
 *
 * `singleScopeWarning` therefore returns null unless a reason describes a way
 * the edit can FAIL TO TAKE EFFECT. It keeps the final-review M11 applicability
 * filters, now expressed against that subset.
 */
describe("singleScopeWarning — dialog-worthy is not warning-worthy", () => {
  const tokenChain = [
    {
      name: "--acme-color-background",
      value: "#fff",
      definedAt: { selector: ":root", stylesheet: FIRST_PARTY },
    },
  ]

  /** The live-observed false alarm: nothing declares the property. */
  const unattributable = origin({ winningRule: null, computedValue: "rgba(0, 0, 0, 0)" })

  it("says NOTHING for an un-attributable value (the live false alarm)", () => {
    // Still dialog-worthy — the gate is untouched...
    expect(needsScopeDialog(unattributable)).toBe(true)
    expect(scopeDialogReasons(unattributable)).toHaveLength(1)
    // ...but there is no way for this edit to lose, so no warning.
    expect(singleScopeWarning(unattributable, ["element"])).toBeNull()
  })

  it("still warns for an `!important` incumbent — the one genuine loss risk", () => {
    const importantIncumbent = origin({
      winningRule: {
        selector: ".ui-card",
        stylesheet: FIRST_PARTY,
        declaration: "background-color: #f7f7f7 !important",
        specificity: [0, 1, 0],
      },
    })
    expect(singleScopeWarning(importantIncumbent, ["element"])).toContain("!important")
  })

  it("says nothing for a token-driven value — patching vs overriding is a choice", () => {
    expect(singleScopeWarning(origin({ varChain: tokenChain }), ["element"])).toBeNull()
    // Not even when the token scope IS on offer: a warning is about failure, not
    // about which remedy the user might have preferred.
    expect(singleScopeWarning(origin({ varChain: tokenChain }), ["element", "token"])).toBeNull()
  })

  it("says nothing for an inherited value — a local declaration beats inheritance", () => {
    expect(singleScopeWarning(origin({ inherited: true }), ["element"])).toBeNull()
  })

  it("says nothing for an ordinary-weight library winner — our !important outranks it", () => {
    const libraryWinner = origin({
      varChain: tokenChain,
      winningRule: {
        selector: ".ui-card",
        stylesheet: LIBRARY,
        declaration: "background-color: #f7f7f7",
        specificity: [0, 1, 0],
      },
    })
    // The dialog still explains the node_modules winner...
    expect(scopeDialogReasons(libraryWinner).some((r) => r.includes("@acme/design-system"))).toBe(true)
    // ...and the warning does not claim a failure the cascade verifier would
    // measure for real if it ever happened.
    expect(singleScopeWarning(libraryWinner, ["element"])).toBeNull()
  })

  it("does not claim `!important` when the flag is on an ANCESTOR's rule", () => {
    // `inherited` means the winning rule matched an ancestor, not this element —
    // "the current value is set with !important" would describe the wrong rule,
    // and a declaration on the element beats an inherited value regardless.
    expect(
      singleScopeWarning(
        origin({
          inherited: true,
          winningRule: {
            selector: ".card",
            stylesheet: FIRST_PARTY,
            declaration: "color: red !important",
            specificity: [0, 1, 0],
          },
        }),
        ["element"],
      ),
    ).toBeNull()
  })

  it("still claims `!important` for an inherited origin whose own inline carries it", () => {
    const inheritedOwnInline = origin({
      inherited: true,
      inline: { value: "red", important: true },
      winningRule: {
        selector: ".card",
        stylesheet: FIRST_PARTY,
        declaration: "color: blue",
        specificity: [0, 1, 0],
      },
    })
    expect(
      scopeDialogReasonEntries(inheritedOwnInline).some((r) => r.kind === "important"),
    ).toBe(true)
    expect(singleScopeWarning(inheritedOwnInline, ["element"])).toContain("!important")
  })

  it("says nothing for an origin with no reasons at all", () => {
    expect(singleScopeWarning(origin(), ["element"])).toBeNull()
  })

  it("says nothing when the only scope edits the declaration itself", () => {
    // `!important` is a loss risk for an OVERRIDE, not for an edit to the
    // winning rule (or its token) in place.
    const importantIncumbent = origin({ inline: { value: "red", important: true } })
    expect(singleScopeWarning(importantIncumbent, ["element"])).toContain("!important")
    expect(singleScopeWarning(importantIncumbent, ["token"])).toBeNull()
    expect(singleScopeWarning(importantIncumbent, ["component"])).toBeNull()
  })

  it("only ever returns a line the dialog would also show", () => {
    // The warning is a SUBSET of the dialog reasons — it never invents copy.
    for (const o of [unattributable, origin({ inherited: true }), origin({ varChain: tokenChain })]) {
      const warning = singleScopeWarning(o, ["element"])
      if (warning !== null) expect(scopeDialogReasons(o)).toContain(warning)
    }
  })
})

/**
 * The gate is unchanged by the split: an un-attributable origin with MORE than
 * one enabled scope still opens the dialog, with its reason text intact. The
 * suppression is warning-only.
 */
describe("the scope dialog is unaffected by warning suppression", () => {
  const unattributable = origin({ winningRule: null, computedValue: "rgba(0, 0, 0, 0)" })

  it("still prompts, with the reason text, when several scopes are enabled", () => {
    expect(needsScopeDialog(unattributable)).toBe(true)
    // What the caller does with >1 enabled scope: open the dialog, which renders
    // exactly these lines (`style-scope-dialog.tsx` → `scopeDialogReasons`).
    expect(scopeDialogReasons(unattributable)).toEqual([
      "No stylesheet rule declares this property: the value comes from a browser default or an unreadable stylesheet.",
    ])
    // The dialog offers more than one scope for this origin on a Vue substrate.
    expect(availableScopes(unattributable).length).toBeGreaterThan(1)
  })
})

describe("elementScopeOutranked — important-utilities substrate (rec 3)", () => {
  /** A first-party `!important` winner: the shape a global-important utility has. */
  const importantWinner = origin({
    winningRule: {
      selector: ".bg-red-500",
      stylesheet: FIRST_PARTY,
      declaration: "background-color: #ef4444 !important",
      specificity: [0, 1, 0],
    },
  })

  it("keeps the element scope AVAILABLE but offers it LAST", () => {
    const scopes = availableScopes(importantWinner, { elementScopeOutranked: true })
    expect(scopes).toContain("element")
    expect(scopes[scopes.length - 1]).toBe("element")
    expect(scopes[0]).not.toBe("element")
  })

  it("leads with the element scope when the capability is UNSET (today's behavior)", () => {
    const scopes = availableScopes(importantWinner)
    expect(scopes[0]).toBe("element")
    // Same membership either way — deprioritising is ordering, not removal.
    expect([...scopes].sort()).toEqual(
      [...availableScopes(importantWinner, { elementScopeOutranked: true })].sort(),
    )
  })

  it("still offers element LAST even when it is the only scope (nothing to prefer)", () => {
    const onlyElement = availableScopes(origin(), {
      framework: "react",
      // No destination stylesheet ⇒ no page scope, so element really is the
      // only entry and its position is the whole assertion.
      hasOverrideDestination: false,
      elementScopeOutranked: true,
    })
    expect(onlyElement).toEqual(["element"])
  })

  it("explains WHY, replacing the vague !important line with the substrate one", () => {
    const reasons = scopeDialogReasons(importantWinner, { elementScopeOutranked: true })
    expect(reasons.some((r) => r.includes("marks its utility CSS !important"))).toBe(true)
    // Exactly one !important-flavored line — the sharp one supersedes the generic.
    expect(
      scopeDialogReasonEntries(importantWinner, { elementScopeOutranked: true }).filter(
        (r) => r.kind === "important" || r.kind === "outranked",
      ),
    ).toHaveLength(1)
    expect(
      scopeDialogReasonEntries(importantWinner, { elementScopeOutranked: true })[0].kind,
    ).toBe("outranked")
  })

  it("keeps the generic !important line when the capability is unset", () => {
    const entries = scopeDialogReasonEntries(importantWinner)
    expect(entries.some((r) => r.kind === "important")).toBe(true)
    expect(entries.some((r) => r.kind === "outranked")).toBe(false)
  })

  it("does NOT claim anything for a property nothing important declares", () => {
    // The capability is a substrate fact, not a claim about every property: an
    // ordinary-weight winner is still winnable at the element scope.
    const ordinary = origin({
      winningRule: {
        selector: ".x",
        stylesheet: FIRST_PARTY,
        declaration: "background-color: #eee",
        specificity: [0, 1, 0],
      },
    })
    expect(needsScopeDialog(ordinary)).toBe(false)
    expect(scopeDialogReasons(ordinary, { elementScopeOutranked: true })).toEqual([])
  })

  it("uses the substrate line for the single-scope warning", () => {
    const warning = singleScopeWarning(importantWinner, ["element"], {
      elementScopeOutranked: true,
    })
    expect(warning).toContain("marks its utility CSS !important")
    // …and never proposes a scope the user can't pick.
    expect(warning).not.toContain("Patching the token")
  })

  it("does not blame the element for an ANCESTOR's !important (inherited origin)", () => {
    const inheritedImportant = origin({
      inherited: true,
      winningRule: {
        selector: ".parent",
        stylesheet: FIRST_PARTY,
        declaration: "color: #111 !important",
        specificity: [0, 1, 0],
      },
    })
    // The dialog still explains the inheritance; the WARNING stays silent —
    // a declaration on the element beats an inherited value either way.
    expect(
      scopeDialogReasons(inheritedImportant, { elementScopeOutranked: true }).some((r) =>
        r.includes("inherited from an ancestor"),
      ),
    ).toBe(true)
    expect(
      singleScopeWarning(inheritedImportant, ["element"], { elementScopeOutranked: true }),
    ).toBeNull()
  })
})

/**
 * N5 (rec-4 live run) — one dialog showed `From: only under :hover` two lines
 * above "No stylesheet rule declares this property — the value comes from a
 * browser default or an unreadable stylesheet." A `:hover` rule DOES declare it,
 * so the reason line was false. The trigger is unchanged (the origin is still
 * scope-ambiguous); the explanation is now state-aware.
 */
describe("scopeDialogReasonEntries — transient-state-only property", () => {
  const hoverOnly = origin({
    winningRule: null,
    computedValue: "rgb(224, 228, 234)",
    transientRuleApplies: { pseudoClass: ":hover" },
  })

  it("names the transient state instead of claiming nothing declares the property", () => {
    const entries = scopeDialogReasonEntries(hoverOnly)
    expect(entries.map((r) => r.kind)).toEqual(["transient-only"])
    expect(entries[0].text).toContain(":hover")
    expect(entries[0].text).toContain("at rest")
  })

  it("never emits the browser-default claim for this case", () => {
    for (const text of scopeDialogReasons(hoverOnly)) {
      expect(text).not.toContain("browser default")
      expect(text).not.toContain("No stylesheet rule declares this property")
    }
  })

  it("leaves the generic no-rule line alone when no transient rule applies", () => {
    const entries = scopeDialogReasonEntries(
      origin({ winningRule: null, computedValue: "rgb(0, 0, 0)" }),
    )
    expect(entries.map((r) => r.kind)).toEqual(["no-rule"])
    expect(entries[0].text).toContain("browser default")
  })

  it("explains the transient state in the DIALOG but does not warn", () => {
    // Our override applies at rest, so the edit lands — "may not take effect" is
    // false. (It also outranks the `:hover` rule, which is a side effect worth
    // explaining where the user is choosing a scope, not a failure claim.)
    expect(scopeDialogReasons(hoverOnly)[0]).toContain(":hover")
    expect(singleScopeWarning(hoverOnly, ["element"])).toBeNull()
  })
})

/**
 * The load-bearing invariant `scopeDialogReasonEntries` is documented to hold:
 * it mirrors `needsScopeDialog` one-for-one, so a prompted edit always has at
 * least one explanation and an unprompted one never manufactures a reason. A
 * previous review verified it by inspection; asserted here across every trigger
 * (and the transient refinement, which is where it could have drifted).
 */
describe("needsScopeDialog ⟺ scopeDialogReasonEntries", () => {
  const rule = (stylesheet: { href: string; package?: string }) => ({
    selector: ".x",
    stylesheet,
    declaration: "background-color: #eee",
    specificity: [0, 1, 0] as [number, number, number],
  })
  const cases: [string, StyleOrigin][] = [
    ["unambiguous first-party rule", origin({ winningRule: rule(FIRST_PARTY) })],
    ["bare origin (nothing rendered)", origin()],
    [
      "token-driven",
      origin({
        winningRule: rule(FIRST_PARTY),
        varChain: [
          {
            name: "--t",
            value: "#eee",
            definedAt: { selector: ":root", stylesheet: FIRST_PARTY },
          },
        ],
      }),
    ],
    ["inherited", origin({ inherited: true, winningRule: rule(FIRST_PARTY) })],
    ["library winner", origin({ winningRule: rule(LIBRARY) })],
    ["no rule but something renders", origin({ computedValue: "rgb(0, 0, 0)" })],
    [
      "transient-state only",
      origin({
        computedValue: "rgb(1, 2, 3)",
        transientRuleApplies: { pseudoClass: ":hover" },
      }),
    ],
    [
      "transient state beside a resting rule",
      origin({
        winningRule: rule(FIRST_PARTY),
        computedValue: "rgb(1, 2, 3)",
        transientRuleApplies: { pseudoClass: ":hover" },
      }),
    ],
    [
      "important incumbent",
      origin({ inline: { value: "#eee", important: true } }),
    ],
  ]

  for (const [name, o] of cases) {
    it(`agrees for: ${name}`, () => {
      const prompted = needsScopeDialog(o)
      expect(scopeDialogReasonEntries(o).length > 0).toBe(prompted)
      // …and with the substrate option set, which swaps one line for another
      // rather than adding or dropping one.
      expect(
        scopeDialogReasonEntries(o, { elementScopeOutranked: true }).length > 0,
      ).toBe(prompted)
    })
  }

  /**
   * The warning-worthy subset is exactly that — a SUBSET. Introducing it must
   * not break the mirror above (it doesn't: `scopeDialogReasonEntries` is
   * untouched and the filter lives in `singleScopeWarning`), and an unprompted
   * origin must never produce a warning either.
   */
  for (const [name, o] of cases) {
    it(`warning ⊆ dialog reasons for: ${name}`, () => {
      for (const opts of [{}, { elementScopeOutranked: true }]) {
        const warning = singleScopeWarning(o, ["element"], opts)
        if (warning === null) continue
        expect(needsScopeDialog(o)).toBe(true)
        expect(scopeDialogReasons(o, opts)).toContain(warning)
        expect(
          scopeDialogReasonEntries(o, opts)
            .filter((r) => isWarningWorthyReason(r.kind))
            .map((r) => r.text),
        ).toContain(warning)
      }
    })
  }
})
