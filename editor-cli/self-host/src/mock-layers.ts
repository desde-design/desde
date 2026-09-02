import type { OutlineNode } from "@/types/bridge"

/**
 * A mock DOM/component tree seeded into the Layers panel at boot so the
 * harness renders a FULLY POPULATED layers tree with NO live bridge —
 * the analog of `mock-selection.ts` for the inspector.
 *
 * Why: the Layers panel is prop-driven by `useEditorEditing.layersRoots`,
 * which is normally filled by `adapter.getStructure()` over the bridge. In
 * this nested harness there's no bridge to query when run standalone
 * (`vite`), so the tree would sit on its "Loading layers…" state forever.
 * Seeding `window.__DESDE_SELF_HOST_LAYERS__` (read by the hook's
 * `useState` initializer) sidesteps the bridge. Under CLI supervision the
 * real bridge connects and `refreshLayers()` overwrites this seed with the
 * live `prototype.html` tree — so the seed only ever shows in raw mode.
 *
 * The tree is intentionally representative: a mix of `element` /
 * `component` / `text` node types, library vs first-party components
 * (`packageName` / `isLibrary` drive the badges), source locations
 * (`editTarget` / `authoredAt` drive "open file at line" + move/detach),
 * and one `iterationContext` node so the "1 of N" loop affordance renders.
 */

let autoId = 0
const nextId = () => `mock-layer-${++autoId}`

/**
 * Terse node factory — keeps the tree literal below readable.
 *
 * The default rect is deliberately NON-zero. The density filter's rule 2
 * dissolves any node with `width === 0 && height === 0` (a real DOM walk
 * only produces that for unrendered layout artifacts), so a 0×0 default
 * here would make the default `essentials` density dissolve nearly the
 * whole fixture and the harness would render a broken-looking tree.
 * Structural nodes below override with rects that nest plausibly.
 */
function node(
  name: string,
  type: OutlineNode["type"],
  selector: string,
  extra: Partial<OutlineNode> = {},
): OutlineNode {
  return {
    id: nextId(),
    name,
    type,
    selector,
    x: 0,
    y: 0,
    width: 160,
    height: 32,
    ...extra,
  }
}

const FIRST_PARTY = "src/App.vue"

export const MOCK_LAYERS: OutlineNode[] = [
  node("App", "component", "#app", {
    componentFile: FIRST_PARTY,
    authoredAt: { file: FIRST_PARTY, line: 1, column: 0 },
    width: 1280,
    height: 800,
    children: [
      node("AppSidebar", "component", "aside.sidebar", {
        componentFile: "src/components/AppSidebar.vue",
        editTarget: { file: FIRST_PARTY, line: 8, column: 4 },
        authoredAt: { file: "src/components/AppSidebar.vue", line: 1, column: 0 },
        width: 240,
        height: 800,
        children: [
          node("div.brand", "element", "aside.sidebar > .brand", {
            editTarget: { file: "src/components/AppSidebar.vue", line: 3, column: 4 },
            x: 16,
            y: 16,
            width: 208,
            height: 40,
            children: [node("Acme Console", "text", "")],
          }),
          node("UiNavMenu", "component", "nav.nav", {
            componentFile: "node_modules/@acme/design-system/dist/UiNavMenu.vue",
            packageName: "@acme/design-system",
            isLibrary: true,
            editTarget: { file: "src/components/AppSidebar.vue", line: 5, column: 6 },
            x: 16,
            y: 72,
            width: 208,
            height: 320,
            children: [
              // A v-for rendering: surfaced as "1 of 4" before the user clicks.
              node("UiNavItem", "component", "nav.nav > a.active", {
                componentFile: "node_modules/@acme/design-system/dist/UiNavItem.vue",
                packageName: "@acme/design-system",
                isLibrary: true,
                editTarget: { file: "src/components/AppSidebar.vue", line: 6, column: 8 },
                x: 16,
                y: 72,
                width: 208,
                height: 36,
                children: [node("Overview", "text", "")],
              }),
            ],
          }),
        ],
      }),
      node("main.main", "element", "main.main", {
        editTarget: { file: FIRST_PARTY, line: 14, column: 4 },
        x: 240,
        y: 0,
        width: 1040,
        height: 800,
        children: [
          node("h1.page-title", "element", "main.main > .page-title", {
            editTarget: { file: FIRST_PARTY, line: 15, column: 6 },
            x: 272,
            y: 32,
            width: 320,
            height: 36,
            children: [node("Overview", "text", "")],
          }),
          node("StatGrid", "component", "section.grid", {
            componentFile: "src/components/StatGrid.vue",
            editTarget: { file: FIRST_PARTY, line: 17, column: 6 },
            authoredAt: { file: "src/components/StatGrid.vue", line: 1, column: 0 },
            x: 272,
            y: 96,
            width: 976,
            height: 140,
            children: [
              node("StatCard", "component", "section.grid > .stat:nth-of-type(1)", {
                componentFile: "src/components/StatCard.vue",
                editTarget: { file: "src/components/StatGrid.vue", line: 4, column: 4 },
                x: 272,
                y: 96,
                width: 300,
                height: 140,
                iterationContext: {
                  source: "v-for",
                  key: "requests",
                  index: 0,
                  siblingCount: 3,
                  expression: "stat in stats",
                },
                children: [
                  node("div.label", "element", "section.grid > .stat:nth-of-type(1) > .label", {
                    x: 288,
                    y: 112,
                    width: 120,
                    height: 20,
                    children: [node("Requests", "text", "")],
                  }),
                  node("div.value", "element", "section.grid > .stat:nth-of-type(1) > .value", {
                    x: 288,
                    y: 140,
                    width: 160,
                    height: 44,
                    children: [node("12,402", "text", "")],
                  }),
                ],
              }),
            ],
          }),
          node("UiCard", "component", "section.card", {
            componentFile: "node_modules/@acme/design-system/dist/UiCard.vue",
            packageName: "@acme/design-system",
            isLibrary: true,
            editTarget: { file: FIRST_PARTY, line: 22, column: 6 },
            x: 272,
            y: 268,
            width: 976,
            height: 220,
            children: [
              node("UiInput", "component", "section.card #name", {
                componentFile: "node_modules/@acme/design-system/dist/UiInput.vue",
                packageName: "@acme/design-system",
                isLibrary: true,
                editTarget: { file: FIRST_PARTY, line: 26, column: 8 },
                x: 296,
                y: 300,
                width: 400,
                height: 36,
              }),
              node("UiButton", "component", "section.card .btn.primary", {
                componentFile: "node_modules/@acme/design-system/dist/UiButton.vue",
                packageName: "@acme/design-system",
                isLibrary: true,
                editTarget: { file: FIRST_PARTY, line: 33, column: 8 },
                x: 296,
                y: 356,
                width: 140,
                height: 36,
                children: [node("Save changes", "text", "")],
              }),
            ],
          }),
        ],
      }),
    ],
  }),
]
