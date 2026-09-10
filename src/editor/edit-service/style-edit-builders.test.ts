/**
 * Tests for the pure style-edit builders extracted from `useEditorEditing`
 * (share-readiness Phase 3 Batch B) — the scoped-css-override (Vue) /
 * jsx-style (React) / substrate-picker trio.
 *
 * See tasks/share-readiness-plan.md.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Mutation } from "@/editor/core/edit"

function makeClassMutation(overrides: Partial<Mutation> = {}): Mutation {
  return {
    id: "m-1",
    kind: "class",
    sourceLoc: "src/App.vue:12:4",
    resolutionKind: "direct",
    scope: "definition",
    callsiteLoc: null,
    instancePath: "[0]",
    selector: "body > div.card > button.cta",
    before: "cta",
    after: "cta bg-white",
    ...overrides,
  }
}

describe("buildScopedCssOverrideEdit (Vue lane)", () => {
  it("returns null when the mutation has no sourceLoc", async () => {
    const { buildScopedCssOverrideEdit } = await import("./style-edit-builders")
    const edit = buildScopedCssOverrideEdit(
      makeClassMutation({ sourceLoc: undefined }),
    )
    expect(edit).toBeNull()
  })

  it("returns null when there are no added classes", async () => {
    const { buildScopedCssOverrideEdit } = await import("./style-edit-builders")
    const edit = buildScopedCssOverrideEdit(
      makeClassMutation({ before: "cta", after: "cta" }),
    )
    expect(edit).toBeNull()
  })

  it("builds a scoped-css-override with resolved declarations for a direct resolution", async () => {
    const { buildScopedCssOverrideEdit } = await import("./style-edit-builders")
    const edit = buildScopedCssOverrideEdit(makeClassMutation())
    expect(edit).not.toBeNull()
    if (!edit || "unsupported" in edit || edit.kind !== "scoped-css-override") {
      throw new Error("expected a scoped-css-override edit")
    }
    expect(edit.target.selector).toBe("body > div.card > button.cta")
    expect(edit.declarations?.["background-color"]).toBe("#ffffff")
    expect(edit.deepSelector).toBeUndefined()
  })

  it("uses a :deep() selector for ancestor resolution", async () => {
    const { buildScopedCssOverrideEdit } = await import("./style-edit-builders")
    const edit = buildScopedCssOverrideEdit(
      makeClassMutation({ resolutionKind: "ancestor" }),
    )
    if (!edit || "unsupported" in edit || edit.kind !== "scoped-css-override") {
      throw new Error("expected a scoped-css-override edit")
    }
    expect(edit.deepSelector).toBe("button.cta")
  })

  it("falls back to @apply-style applyClasses for unresolved utilities", async () => {
    const { buildScopedCssOverrideEdit } = await import("./style-edit-builders")
    const edit = buildScopedCssOverrideEdit(
      makeClassMutation({ before: "cta", after: "cta shadow-lg" }),
    )
    if (!edit || "unsupported" in edit || edit.kind !== "scoped-css-override") {
      throw new Error("expected a scoped-css-override edit")
    }
    expect(edit.applyClasses).toEqual(["shadow-lg"])
    expect(edit.declarations).toEqual({})
  })

  it("prefers `context.classListBefore/After` over splitting before/after strings", async () => {
    const { buildScopedCssOverrideEdit } = await import("./style-edit-builders")
    const edit = buildScopedCssOverrideEdit(
      makeClassMutation({
        before: "irrelevant",
        after: "irrelevant",
        context: {
          classListBefore: ["cta"],
          classListAfter: ["cta", "bg-white"],
          inlineStyleBefore: {},
          inlineStyleAfter: {},
          computedStyleDelta: {},
          domSnippet: "<button class=\"cta bg-white\"></button>",
          siblingClasses: [],
        },
      }),
    )
    if (!edit || "unsupported" in edit || edit.kind !== "scoped-css-override") {
      throw new Error("expected a scoped-css-override edit")
    }
    expect(edit.declarations?.["background-color"]).toBe("#ffffff")
  })
})

/**
 * § 9g.8 — a rule that matches nothing must refuse, on BOTH lanes.
 *
 * The measured defect wrote `[data-desde-src="src/Plain.vue:2:3"] { … }` into a
 * real file and returned `ok: true`, while the attribute it names was on no
 * element in the document. The anchor bug that produced that coordinate is
 * fixed separately; this is the class-level guard that makes any future dead
 * rule a visible refusal instead of a silent write.
 */
describe("scoped-css-override — dead-anchor guard (lane A)", () => {
  it("refuses when the anchor matches nothing in the live DOM", async () => {
    const { buildScopedCssOverrideEdit } = await import("./style-edit-builders")
    const edit = buildScopedCssOverrideEdit(
      makeClassMutation({ anchorMatchCount: 0 }),
    )
    expect(edit).toEqual({
      unsupported: expect.stringContaining("src/App.vue:12:4"),
    })
  })

  it("still builds when the anchor matches exactly one element", async () => {
    const { buildScopedCssOverrideEdit } = await import("./style-edit-builders")
    const edit = buildScopedCssOverrideEdit(
      makeClassMutation({ anchorMatchCount: 1 }),
    )
    expect(edit && "kind" in edit ? edit.kind : null).toBe("scoped-css-override")
  })

  it("builds when the bridge reported no count at all (nothing to check)", async () => {
    // A count is a fact the bridge supplies. Absent, there is nothing to
    // verify — refusing would brick the lane rather than protect it.
    const { buildScopedCssOverrideEdit } = await import("./style-edit-builders")
    const edit = buildScopedCssOverrideEdit(
      makeClassMutation({ anchorMatchCount: undefined }),
    )
    expect(edit && "kind" in edit ? edit.kind : null).toBe("scoped-css-override")
  })
})

/**
 * § 9g.8 — the inspector's "This page" scope.
 *
 * MEASURED on a pristine Vue fixture, one element, same property, both lanes:
 *
 *   DOM:    data-desde-src="src/App.vue:14:7"  data-desde-own="src/Plain.vue:2:3 …"
 *   lane A  [data-desde-src="src/App.vue:14:7"]   match 1  10px → 42px  APPLIED
 *   lane B  [data-desde-src="src/Plain.vue:2:3"]  match 0  10px → 10px  DEAD
 *
 * Lane B took its anchor from `authoredAt` — the rescue stamp, which is the
 * right answer to "where do this element's bytes live?" and the wrong answer
 * to "what selector matches it?".
 */
describe("buildPageScopedCssOverrideEdit (inspector 'This page' lane)", () => {
  /** The rescued-root selection the measurement produced. */
  function rescuedRootSelection(overrides: Record<string, unknown> = {}) {
    return {
      selector: "body > div#app > div.plain-root",
      classes: ["plain-root"],
      // Both point at the component definition — the rescue stamp.
      authoredAt: { file: "src/Plain.vue", line: 2, column: 3 },
      editTarget: { file: "src/Plain.vue", line: 2, column: 3 },
      // …while the attribute actually in the DOM is the parent's callsite.
      domAnchor: {
        file: "src/App.vue",
        line: 14,
        column: 7,
        matchCount: 1,
        resolution: "direct" as const,
      },
      ...overrides,
    }
  }

  it("anchors the rule on the live data-desde-src, not the rescue stamp", async () => {
    const { buildPageScopedCssOverrideEdit } = await import(
      "./style-edit-builders"
    )
    const built = buildPageScopedCssOverrideEdit(rescuedRootSelection(), [
      "plain-root",
      "bg-white",
    ])
    if (built.kind !== "edit") {
      throw new Error(`expected an edit, got ${JSON.stringify(built)}`)
    }
    expect(built.edit.target.editTarget).toEqual({
      file: "src/App.vue",
      line: 14,
      column: 7,
    })
  })

  it("writes into the file the anchor names, not the definition's file", async () => {
    // The destination must follow the anchor: the applicator writes the rule
    // into `target.editTarget.file`'s `<style scoped>` block, and a rule head
    // naming App.vue only compiles correctly inside App.vue.
    const { buildPageScopedCssOverrideEdit } = await import(
      "./style-edit-builders"
    )
    const built = buildPageScopedCssOverrideEdit(rescuedRootSelection(), [
      "plain-root",
      "bg-white",
    ])
    if (built.kind !== "edit") throw new Error("expected an edit")
    expect(built.edit.target.editTarget?.file).toBe("src/App.vue")
  })

  it("keeps two instances of the same component distinct", async () => {
    // Blast radius: `authoredAt` collapsed both `<Plain/>` callsites onto one
    // rule head, and the applicator's idempotence key merged them — the second
    // edit silently overwrote the first.
    const { buildPageScopedCssOverrideEdit } = await import(
      "./style-edit-builders"
    )
    const first = buildPageScopedCssOverrideEdit(rescuedRootSelection(), [
      "plain-root",
      "bg-white",
    ])
    const second = buildPageScopedCssOverrideEdit(
      rescuedRootSelection({
        domAnchor: {
          file: "src/App.vue",
          line: 17,
          column: 7,
          matchCount: 1,
          resolution: "direct" as const,
        },
      }),
      ["plain-root", "bg-white"],
    )
    if (first.kind !== "edit" || second.kind !== "edit") {
      throw new Error("expected two edits")
    }
    expect(first.edit.target.editTarget).not.toEqual(
      second.edit.target.editTarget,
    )
  })

  it("refuses when the anchor matches nothing in the live DOM", async () => {
    const { buildPageScopedCssOverrideEdit } = await import(
      "./style-edit-builders"
    )
    const built = buildPageScopedCssOverrideEdit(
      rescuedRootSelection({
        domAnchor: {
          file: "src/Ghost.vue",
          line: 9,
          column: 1,
          matchCount: 0,
          resolution: "direct" as const,
        },
      }),
      ["plain-root", "bg-white"],
    )
    expect(built).toEqual({
      kind: "refused",
      reason: expect.stringContaining("src/Ghost.vue:9:1"),
    })
  })

  it("refuses when the bridge surfaced no DOM anchor at all", async () => {
    const { buildPageScopedCssOverrideEdit } = await import(
      "./style-edit-builders"
    )
    const built = buildPageScopedCssOverrideEdit(
      rescuedRootSelection({ domAnchor: undefined }),
      ["plain-root", "bg-white"],
    )
    expect(built).toMatchObject({ kind: "refused" })
  })

  it("pierces the scope boundary with :deep() when the anchor is an ancestor", async () => {
    // Same rule lane A already follows: an ancestor anchor styles the ANCESTOR
    // unless the clicked element is named inside `:deep()`.
    const { buildPageScopedCssOverrideEdit } = await import(
      "./style-edit-builders"
    )
    const built = buildPageScopedCssOverrideEdit(
      rescuedRootSelection({
        selector: "body > div#host > b.pt-probe",
        domAnchor: {
          file: "src/App.vue",
          line: 23,
          column: 7,
          matchCount: 1,
          resolution: "ancestor" as const,
        },
      }),
      ["plain-root", "bg-white"],
    )
    if (built.kind !== "edit") throw new Error("expected an edit")
    if (built.edit.kind !== "scoped-css-override") {
      throw new Error("expected a scoped-css-override edit")
    }
    expect(built.edit.deepSelector).toBe("b.pt-probe")
  })

  it("keeps refusing a cross-file reused component", async () => {
    const { buildPageScopedCssOverrideEdit } = await import(
      "./style-edit-builders"
    )
    const built = buildPageScopedCssOverrideEdit(
      rescuedRootSelection({
        editTarget: { file: "src/App.vue", line: 30, column: 2 },
      }),
      ["plain-root", "bg-white"],
    )
    expect(built).toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("reused component"),
    })
  })

  it("keeps refusing an iterated element", async () => {
    const { buildPageScopedCssOverrideEdit } = await import(
      "./style-edit-builders"
    )
    const built = buildPageScopedCssOverrideEdit(
      rescuedRootSelection({
        iterationContext: {
          source: "v-for",
          key: 0,
          index: 0,
          siblingCount: 3,
          expression: "items",
        },
      }),
      ["plain-root", "bg-white"],
    )
    expect(built).toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("repeated instances"),
    })
  })

  it("keeps refusing a removal-only change", async () => {
    const { buildPageScopedCssOverrideEdit } = await import(
      "./style-edit-builders"
    )
    const built = buildPageScopedCssOverrideEdit(rescuedRootSelection(), [])
    expect(built).toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("Clearing"),
    })
  })
})

describe("buildJsxStyleEdit (React lane)", () => {
  it("returns null for a non-class mutation kind", async () => {
    const { buildJsxStyleEdit } = await import("./style-edit-builders")
    const edit = buildJsxStyleEdit(makeClassMutation({ kind: "text" }))
    expect(edit).toBeNull()
  })

  it("returns null when neither added nor removed classes exist", async () => {
    const { buildJsxStyleEdit } = await import("./style-edit-builders")
    const edit = buildJsxStyleEdit(makeClassMutation({ before: "cta", after: "cta" }))
    expect(edit).toBeNull()
  })

  it("refuses a non-direct resolution when there is no stylesheet to write into", async () => {
    // React has no `:deep()` and no `<style scoped>`, so an ancestor-resolved
    // element cannot be styled by editing an attribute — the ancestor is a
    // different node. It now routes to `scoped-css-override`, which needs a
    // destination; without one this is a refusal that names the fix.
    vi.resetModules()
    vi.doMock("@/lib/editor-feature-flags", () => ({
      EDITOR_FRAMEWORK: "react",
      EDITOR_STYLING_SYSTEM: "tailwind",
      EDITOR_VITE_BASE: "/",
    }))
    const { buildJsxStyleEdit } = await import("./style-edit-builders")
    const edit = buildJsxStyleEdit(makeClassMutation({ resolutionKind: "ancestor" }))
    expect(edit).toEqual({
      unsupported: expect.stringContaining("No project stylesheet"),
    })
    vi.doUnmock("@/lib/editor-feature-flags")
    vi.resetModules()
  })

  it("splices class NAMES into className when the substrate is tailwind", async () => {
    vi.resetModules()
    vi.doMock("@/lib/editor-feature-flags", () => ({
      EDITOR_FRAMEWORK: "react",
      EDITOR_STYLING_SYSTEM: "tailwind",
      EDITOR_VITE_BASE: "/",
    }))
    const { buildJsxStyleEdit } = await import("./style-edit-builders")
    const edit = buildJsxStyleEdit(makeClassMutation())
    if (!edit || edit === null || "unsupported" in edit) {
      throw new Error("expected a jsx-style edit")
    }
    expect(edit.kind).toBe("jsx-style")
    expect(edit).toMatchObject({
      mode: "classname",
      addClasses: ["bg-white"],
      removeClasses: [],
    })
    vi.doUnmock("@/lib/editor-feature-flags")
    vi.resetModules()
  })

  it("builds an inline style object on a non-tailwind substrate when every class resolves", async () => {
    vi.resetModules()
    vi.doMock("@/lib/editor-feature-flags", () => ({
      EDITOR_FRAMEWORK: "react",
      EDITOR_STYLING_SYSTEM: "css-modules",
      EDITOR_VITE_BASE: "/",
    }))
    const { buildJsxStyleEdit } = await import("./style-edit-builders")
    const edit = buildJsxStyleEdit(makeClassMutation())
    if (!edit || edit === null || "unsupported" in edit) {
      throw new Error("expected a jsx-style edit")
    }
    expect(edit.kind).toBe("jsx-style")
    expect(edit).toMatchObject({
      mode: "inline",
      declarations: { "background-color": "#ffffff" },
    })
    vi.doUnmock("@/lib/editor-feature-flags")
    vi.resetModules()
  })

  it("surfaces unsupported on a non-tailwind substrate when a class has no CSS mapping", async () => {
    vi.resetModules()
    vi.doMock("@/lib/editor-feature-flags", () => ({
      EDITOR_FRAMEWORK: "react",
      EDITOR_STYLING_SYSTEM: "css-modules",
      EDITOR_VITE_BASE: "/",
    }))
    const { buildJsxStyleEdit } = await import("./style-edit-builders")
    const edit = buildJsxStyleEdit(
      makeClassMutation({ before: "cta", after: "cta shadow-lg" }),
    )
    expect(edit).toEqual({
      unsupported: expect.stringContaining("shadow-lg"),
    })
    vi.doUnmock("@/lib/editor-feature-flags")
    vi.resetModules()
  })
})

describe("buildStyleEdit (substrate picker)", () => {
  it("routes to the Vue scoped-css-override builder by default", async () => {
    const { buildStyleEdit } = await import("./style-edit-builders")
    const edit = buildStyleEdit(makeClassMutation())
    expect(edit).not.toBeNull()
    expect(edit && "kind" in edit ? edit.kind : null).toBe("scoped-css-override")
  })

  it("routes to the React jsx-style builder when EDITOR_FRAMEWORK is react", async () => {
    vi.resetModules()
    vi.doMock("@/lib/editor-feature-flags", () => ({
      EDITOR_FRAMEWORK: "react",
      EDITOR_STYLING_SYSTEM: "tailwind",
      EDITOR_VITE_BASE: "/",
    }))
    const { buildStyleEdit } = await import("./style-edit-builders")
    const edit = buildStyleEdit(makeClassMutation())
    expect(edit && "kind" in edit ? edit.kind : null).toBe("jsx-style")
    vi.doUnmock("@/lib/editor-feature-flags")
    vi.resetModules()
  })
})

describe("isUnsupportedStyleBuild", () => {
  it("narrows only the { unsupported } shape", async () => {
    const { isUnsupportedStyleBuild } = await import("./style-edit-builders")
    expect(isUnsupportedStyleBuild(null)).toBe(false)
    expect(isUnsupportedStyleBuild({ unsupported: "nope" })).toBe(true)
    expect(
      isUnsupportedStyleBuild({
        kind: "scoped-css-override",
        id: "x",
        target: { targetId: "a", selector: "a" },
        applyClasses: [],
        declarations: {},
      } as never),
    ).toBe(false)
  })
})

/**
 * The React `scoped-css-override` lane — restyling an element inside a
 * component the user does not own, which is the polish-loop capability the
 * product is positioned on and which React had none of.
 *
 * The binding constraint these tests exist to pin (`tasks/dev-server-hosts.md`
 * § 9g.9): the anchor MUST be the DOM anchor the bridge read, and its match
 * count must come from the SAME read. The dead-anchor guard compares the count
 * the producer attached against the anchor the producer chose, so it is blind
 * to a producer that computes the two from different places — the protection
 * is producer discipline, not verification, and a test is the only thing that
 * can hold it.
 */
describe("scoped-css-override on React", () => {
  const CSS = "src/index.css"

  async function reactBuilders() {
    vi.resetModules()
    vi.doMock("@/lib/editor-feature-flags", () => ({
      EDITOR_FRAMEWORK: "react",
      EDITOR_STYLING_SYSTEM: "tailwind",
      EDITOR_VITE_BASE: "/",
    }))
    return import("./style-edit-builders")
  }

  function jsxMutation(overrides: Partial<Mutation> = {}): Mutation {
    return makeClassMutation({
      sourceLoc: "src/App.tsx:33:46",
      selector: "body > div.MuiAlert-root > div.MuiAlert-message",
      ...overrides,
    })
  }

  it("routes an ancestor-resolved element to a CSS rule with a descendant selector", async () => {
    const { buildStyleEdit } = await reactBuilders()
    const edit = buildStyleEdit(
      jsxMutation({ resolutionKind: "ancestor", anchorMatchCount: 1 }),
      { overrideStylesheet: CSS },
    )
    if (!edit || "unsupported" in edit || edit.kind !== "scoped-css-override") {
      throw new Error(`expected a scoped-css-override, got ${JSON.stringify(edit)}`)
    }
    // The rule HEAD names the rendered anchor…
    expect(edit.anchor).toEqual({ file: "src/App.tsx", line: 33, column: 46 })
    // …and the DESTINATION is the project stylesheet, a different file.
    expect(edit.target.editTarget?.file).toBe(CSS)
    expect(edit.deepSelector).toBe("div.MuiAlert-message")
    // `@apply` would be inert in a stylesheet Tailwind may not process.
    expect(edit.applyClasses).toBeUndefined()
  })

  it("keeps a DIRECT element on the in-place jsx-style lane", async () => {
    // The 2x2: you own the element -> edit it; you don't -> write a rule.
    const { buildStyleEdit } = await reactBuilders()
    const edit = buildStyleEdit(jsxMutation({ resolutionKind: "direct" }), {
      overrideStylesheet: CSS,
    })
    if (!edit || "unsupported" in edit) throw new Error("expected an edit")
    expect(edit.kind).toBe("jsx-style")
  })

  it("takes the anchor from the DOM anchor, never from the destination", async () => {
    // The § 9g.9 constraint, as an assertion: `sourceLoc` is what
    // `resolveDomAnchor` read off the live element. Anchoring on anything else
    // is how a rule that matches nothing gets written and reported ok.
    const { buildStyleEdit } = await reactBuilders()
    const edit = buildStyleEdit(
      jsxMutation({
        sourceLoc: "src/components/Card.tsx:5:9",
        resolutionKind: "ancestor",
        anchorMatchCount: 1,
      }),
      { overrideStylesheet: CSS },
    )
    if (!edit || "unsupported" in edit || edit.kind !== "scoped-css-override") {
      throw new Error("expected a scoped-css-override")
    }
    expect(edit.anchor.file).toBe("src/components/Card.tsx")
    expect(edit.target.editTarget?.file).toBe(CSS)
  })

  it("refuses a dead anchor rather than writing an inert rule", async () => {
    const { buildStyleEdit } = await reactBuilders()
    const edit = buildStyleEdit(
      jsxMutation({ resolutionKind: "ancestor", anchorMatchCount: 0 }),
      { overrideStylesheet: CSS },
    )
    expect(edit).toEqual({ unsupported: expect.stringContaining("matches nothing") })
  })

  it("refuses a utility with no declaration mapping instead of emitting @apply", async () => {
    const { buildStyleEdit } = await reactBuilders()
    const edit = buildStyleEdit(
      jsxMutation({
        resolutionKind: "ancestor",
        anchorMatchCount: 1,
        before: "x",
        after: "x shadow-lg",
      }),
      { overrideStylesheet: CSS },
    )
    expect(edit).toEqual({ unsupported: expect.stringContaining("shadow-lg") })
  })

  it("builds the page scope for a library element that has no authoredAt at all", async () => {
    // MEASURED on MUI (§ 9g.2): clicking `.MuiAlert-message` yields
    // `editTarget null, authoredAt null` — the edit pipeline correctly refuses
    // it, and this lane correctly does not, because it never opens the
    // anchor's file. It quotes the coordinate into a string.
    const { buildPageScopedCssOverrideEdit } = await reactBuilders()
    const built = buildPageScopedCssOverrideEdit(
      {
        selector: "div.MuiAlert-root > div.MuiAlert-message",
        classes: [],
        authoredAt: undefined,
        editTarget: undefined,
        iterationContext: undefined,
        domAnchor: {
          file: "src/App.tsx",
          line: 33,
          column: 46,
          matchCount: 1,
          resolution: "ancestor",
        },
      },
      ["pt-10"],
      { overrideStylesheet: CSS },
    )
    if (built.kind !== "edit") {
      throw new Error(`expected an edit, got ${JSON.stringify(built)}`)
    }
    const edit = built.edit
    if (edit.kind !== "scoped-css-override") throw new Error("wrong kind")
    expect(edit.anchor).toEqual({ file: "src/App.tsx", line: 33, column: 46 })
    expect(edit.target.editTarget?.file).toBe(CSS)
    expect(edit.deepSelector).toBe("div.MuiAlert-message")
  })

  it("refuses when no project stylesheet reaches the page, and names the fix", async () => {
    const { buildStyleEdit } = await reactBuilders()
    const edit = buildStyleEdit(
      jsxMutation({ resolutionKind: "ancestor", anchorMatchCount: 1 }),
      {},
    )
    expect(edit).toEqual({
      unsupported: expect.stringContaining("import it from your entry module"),
    })
  })
})

/**
 * "N > 1 must say N" (§ 9g.8 fix item 4). On React a FIRST-PARTY component's
 * internal root stamp is shared by every instance, so one rule can restyle
 * every card on the page — and the count was in hand the whole time.
 */
describe("blastRadiusNotice", () => {
  // The React describe above registers a module mock that outlives it, and
  // the last case here is a VUE-lane assertion. Drop it explicitly rather
  // than depending on describe order.
  beforeEach(() => {
    vi.doUnmock("@/lib/editor-feature-flags")
    vi.resetModules()
  })

  it("says nothing for one element, or for an unknown count", async () => {
    const { blastRadiusNotice } = await import("./style-edit-builders")
    expect(blastRadiusNotice(1)).toBeNull()
    expect(blastRadiusNotice(undefined)).toBeNull()
    expect(blastRadiusNotice(0)).toBeNull()
  })

  it("states the number, and states it as a LOWER bound", async () => {
    const { blastRadiusNotice } = await import("./style-edit-builders")
    const note = blastRadiusNotice(3)
    expect(note).toContain("3")
    // The count is taken against the rendered page; the rule also applies on
    // routes that are not mounted. "at least" is the honest word.
    expect(note).toMatch(/at least/)
  })

  it("rides along on the page-scope build so a caller cannot forget it", async () => {
    const { buildPageScopedCssOverrideEdit } = await import("./style-edit-builders")
    const built = buildPageScopedCssOverrideEdit(
      {
        selector: "div.card",
        classes: [],
        authoredAt: { file: "src/App.vue", line: 5, column: 3 },
        editTarget: { file: "src/App.vue", line: 5, column: 3 },
        iterationContext: undefined,
        domAnchor: {
          file: "src/App.vue",
          line: 5,
          column: 3,
          matchCount: 2,
          resolution: "direct",
        },
      },
      ["pt-10"],
    )
    if (built.kind !== "edit") throw new Error("expected an edit")
    expect(built.notice).toMatch(/at least 2/)
  })
})
