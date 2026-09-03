/**
 * Coverage for the two wire→core converters that carry the CSS-anchor facts
 * across the bridge boundary.
 *
 * Both are "structural mirrors": the wire shape and the core shape match by
 * design, and the converter exists so a divergence is loud. It wasn't —
 * `bridgeMutationToCore` enumerates fields explicitly, so a field added to
 * both types but not to the converter is dropped silently, and the only
 * symptom is a guard that never fires. These pin the two fields whose loss
 * is invisible: `domAnchor` (the anchor a CSS rule is built from) and
 * `anchorMatchCount` (the count that decides whether it is refused).
 *
 * See `tasks/dev-server-hosts.md` § 9g.8.
 */
import { describe, expect, it } from "vitest"
import {
  bridgeMutationToCore,
  inspectionDataToSelection,
} from "./inspection-conversion"
import type { BridgeMutation, InspectionData } from "@/types/bridge"

function makeInspectionData(
  overrides: Partial<InspectionData> = {},
): InspectionData {
  return {
    tagName: "div",
    id: "",
    classes: ["plain-root"],
    rect: {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      top: 0,
      right: 10,
      bottom: 10,
      left: 0,
    },
    styles: [],
    tokens: [],
    boxModel: {
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      border: { top: 0, right: 0, bottom: 0, left: 0 },
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      content: { width: 10, height: 10 },
    },
    selector: "body > div#app > div.plain-root",
    authoredAt: { file: "src/Plain.vue", line: 2, column: 3 },
    editTarget: { file: "src/Plain.vue", line: 2, column: 3 },
    domAnchor: {
      file: "src/App.vue",
      line: 14,
      column: 7,
      matchCount: 1,
      resolution: "direct",
    },
    ...overrides,
  } as InspectionData
}

describe("inspectionDataToSelection", () => {
  it("carries domAnchor through for a component-root selection", () => {
    // A rescued root: the component-tree branch of the converter.
    const selection = inspectionDataToSelection(makeInspectionData())
    expect(selection.domAnchor).toEqual({
      file: "src/App.vue",
      line: 14,
      column: 7,
      matchCount: 1,
      resolution: "direct",
    })
    // …and does NOT quietly substitute it for the bytes-level location.
    expect(selection.authoredAt).toEqual({
      file: "src/Plain.vue",
      line: 2,
      column: 3,
    })
  })

  it("carries domAnchor through the element-level branch too", () => {
    // `selectedAsElement` is a separate return statement in the converter —
    // the field has to be listed twice, so it can be forgotten once.
    const selection = inspectionDataToSelection(
      makeInspectionData({
        componentTree: [
          {
            name: "App",
            file: "src/App.vue",
            elementSelector: "body > div#app",
          },
          {
            name: "Plain",
            file: "src/Plain.vue",
            // No node claims the selected element, so the converter takes
            // its element-level branch.
            elementSelector: "body > div#app > div.other",
          },
        ],
      }),
    )
    // Assert the branch was actually taken — a test that silently stopped
    // exercising the second return statement would pass forever.
    expect(selection.selectedAsElement).toBe(true)
    expect(selection.domAnchor).toMatchObject({ file: "src/App.vue", line: 14 })
  })
})

describe("inspectionDataToSelection: which node is the component, on React (no editTargetComponent)", () => {
  // React fibers carry no file, so the bridge cannot resolve an
  // editTargetComponent there. Every node whose elementSelector is the
  // clicked selector is rooted at the clicked element; the outermost one
  // that carries a callsite stamp is the tag the user wrote. MEASURED on the
  // bundled Acme demo (2026-09-02): the tree was [App, Button, Button], the
  // last being base-ui's internal, and the old last-node rule picked it.
  const clicked = "body > div#app > button.group\\/button"

  it("prefers the outermost stamped node rooted at the clicked element over the library internal beneath it", () => {
    const selection = inspectionDataToSelection(
      makeInspectionData({
        selector: clicked,
        selfStamped: true,
        editTargetComponent: undefined,
        componentTree: [
          { name: "App", elementSelector: "body > div#app", callsite: "src/main.tsx:8:4" },
          { name: "Button", elementSelector: clicked, callsite: "src/App.tsx:26:8", props: { size: "sm" } },
          { name: "ButtonPrimitive", elementSelector: clicked, props: { type: "button" } },
        ],
      }),
    )
    expect(selection.selectedAsElement).toBeUndefined()
    expect(selection.componentName).toBe("Button")
    expect(selection.currentProps).toEqual({ size: "sm" })
    // The ancestry is what sits ABOVE the chosen node, leaf-first.
    expect(selection.ancestry.map((a) => a.componentName)).toEqual(["App"])
  })

  it("transparent first-party wrappers: the outermost stamped one wins, matching the Structure panel's label", () => {
    const selection = inspectionDataToSelection(
      makeInspectionData({
        selector: clicked,
        selfStamped: true,
        editTargetComponent: undefined,
        componentTree: [
          { name: "Owner", elementSelector: "body > div#app", callsite: "src/main.tsx:8:4" },
          { name: "Card", elementSelector: clicked, callsite: "src/Owner.tsx:5:6" },
          { name: "Panel", elementSelector: clicked, callsite: "src/Card.tsx:3:10" },
        ],
      }),
    )
    expect(selection.componentName).toBe("Card")
  })

  it("with no stamped node rooted there, the outermost rooted node still beats the last-node default", () => {
    const selection = inspectionDataToSelection(
      makeInspectionData({
        selector: clicked,
        selfStamped: false,
        editTargetComponent: undefined,
        componentTree: [
          { name: "App", elementSelector: "body > div#app" },
          { name: "LibButton", elementSelector: clicked },
          { name: "LibButtonInner", elementSelector: clicked },
        ],
      }),
    )
    expect(selection.componentName).toBe("LibButton")
  })

  it("with no node rooted at the clicked element, the last node is still the primary and the click is an element", () => {
    const selection = inspectionDataToSelection(
      makeInspectionData({
        selector: clicked,
        selfStamped: true,
        editTargetComponent: undefined,
        componentTree: [
          { name: "App", elementSelector: "body > div#app", callsite: "src/main.tsx:8:4" },
          { name: "Page", elementSelector: "body > div#app > main", callsite: "src/App.tsx:9:6" },
        ],
      }),
    )
    expect(selection.selectedAsElement).toBe(true)
    expect(selection.ancestry.map((a) => a.componentName)).toEqual(["Page", "App"])
  })
})

describe("bridgeMutationToCore", () => {
  function makeBridgeMutation(
    overrides: Partial<BridgeMutation> = {},
  ): BridgeMutation {
    return {
      id: "m-1",
      kind: "class",
      sourceLoc: "src/App.vue:14:7",
      anchorMatchCount: 1,
      sourceVersion: "v1",
      resolutionKind: "direct",
      scope: "definition",
      callsiteLoc: null,
      callsiteVersion: null,
      instancePath: "[0]",
      selector: "body > div#app > div.plain-root",
      before: "plain-root",
      after: "plain-root pt-10",
      ...overrides,
    }
  }

  it("carries anchorMatchCount across the wire boundary", () => {
    expect(bridgeMutationToCore(makeBridgeMutation()).anchorMatchCount).toBe(1)
  })

  it("carries a ZERO count — the value the guard exists to see", () => {
    // Dropping this is worse than dropping a 1: the lane treats "absent" as
    // "nothing to check" and writes the dead rule anyway.
    expect(
      bridgeMutationToCore(makeBridgeMutation({ anchorMatchCount: 0 }))
        .anchorMatchCount,
    ).toBe(0)
  })

  it("leaves it undefined when the bridge reported none", () => {
    expect(
      bridgeMutationToCore(makeBridgeMutation({ anchorMatchCount: undefined }))
        .anchorMatchCount,
    ).toBeUndefined()
  })
})
