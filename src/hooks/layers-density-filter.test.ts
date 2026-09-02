import { describe, expect, it } from "vitest"
import type { OutlineNode } from "@/types/bridge"
import {
  DEFAULT_LAYERS_DENSITY,
  filterLayersByDensity,
  findVisibleSelector,
  isLayersDensity,
} from "./layers-density-filter"
import {
  mergeConditionalGroups,
  type FileConditionalGroups,
} from "./layers-conditional-groups"

const FILE = "src/components/Panel.vue"

function node(partial: Partial<OutlineNode> & { id: string }): OutlineNode {
  return {
    name: partial.name ?? partial.id,
    type: partial.type ?? "element",
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    width: partial.width ?? 100,
    height: partial.height ?? 40,
    selector: partial.selector ?? `#${partial.id}`,
    ...partial,
  }
}

/** Flatten a tree to `name` strings, depth-first, for readable assertions. */
function names(nodes: OutlineNode[]): string[] {
  const out: string[] = []
  const walk = (list: OutlineNode[]): void => {
    for (const n of list) {
      out.push(n.name)
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return out
}

describe("filterLayersByDensity", () => {
  it("defaults to essentials", () => {
    expect(DEFAULT_LAYERS_DENSITY).toBe("essentials")
  })

  describe('"everything" is the identity function', () => {
    it("returns the exact same array reference", () => {
      const roots = [
        node({
          id: "root",
          name: "div",
          children: [
            node({ id: "s", name: "script", width: 0, height: 0 }),
            node({ id: "w", name: "div", children: [node({ id: "b", name: "button" })] }),
          ],
        }),
      ]
      expect(filterLayersByDensity(roots, "everything")).toBe(roots)
    })
  })

  describe("rule 1 — non-rendering tags", () => {
    it("drops script/style/link/meta/noscript/template/br/wbr", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [
            node({ id: "a", name: "script" }),
            node({ id: "b", name: "style" }),
            node({ id: "c", name: "link" }),
            node({ id: "d", name: "meta" }),
            node({ id: "e", name: "noscript" }),
            node({ id: "f", name: "template" }),
            node({ id: "g", name: "br" }),
            node({ id: "h", name: "wbr" }),
            node({ id: "i", name: "p" }),
            node({ id: "j", name: "span" }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual([
        "main",
        "p",
        "span",
      ])
    })

    it("matches the tag case-insensitively", () => {
      const roots = [
        node({ id: "root", name: "main", children: [node({ id: "s", name: "SCRIPT" })] }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual(["main"])
    })

    it("does NOT drop a COMPONENT that happens to be named like a tag", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [
            node({ id: "t", name: "Template", type: "component" }),
            node({ id: "l", name: "Link", type: "component" }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual([
        "main",
        "Template",
        "Link",
      ])
    })

    it("drops the never-content tags at the 'detailed' level too", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [
            node({ id: "s", name: "script" }),
            node({ id: "st", name: "style" }),
            node({ id: "l", name: "link" }),
            node({ id: "m", name: "meta" }),
            node({ id: "n", name: "noscript" }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "detailed"))).toEqual(["main"])
    })

    it("KEEPS br/wbr/template at 'detailed' — they are real source elements", () => {
      // A <br> is authored, selectable and deletable. "Detailed" promises
      // every wrapper, so dropping one there would be a lie. They go only
      // at "essentials", where a line break is noise.
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [
            node({ id: "br", name: "br", height: 0 }),
            node({ id: "wbr", name: "wbr", height: 0 }),
            node({ id: "t", name: "template", height: 12 }),
            node({ id: "p", name: "p" }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "detailed"))).toEqual([
        "main",
        "br",
        "wbr",
        "template",
        "p",
      ])
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual([
        "main",
        "p",
      ])
    })
  })

  describe("rule 2 — invisible subtrees", () => {
    it("hoists the children of a zero-size node instead of dropping them", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [
            node({
              id: "ghost",
              name: "div",
              width: 0,
              height: 0,
              children: [
                node({ id: "pop", name: "dialog" }),
                node({ id: "tip", name: "aside" }),
              ],
            }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual([
        "main",
        "dialog",
        "aside",
      ])
    })

    it("hoists the children of a node with an empty selector", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [
            node({
              id: "unselectable",
              name: "div",
              selector: "",
              children: [node({ id: "kid", name: "p" })],
            }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual(["main", "p"])
    })

    it("drops a childless invisible node entirely", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [node({ id: "ghost", name: "div", width: 0, height: 0 })],
        }),
      ]
      const filtered = filterLayersByDensity(roots, "essentials")
      expect(names(filtered)).toEqual(["main"])
      expect(filtered[0].children).toBeUndefined()
    })

    it("keeps a zero-WIDTH node that still has height (only both-zero is invisible)", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [
            node({ id: "rule", name: "hr", width: 0, height: 1 }),
            node({ id: "rule2", name: "hr", width: 1, height: 0 }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual([
        "main",
        "hr",
        "hr",
      ])
    })

    it("applies at the 'detailed' level too", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [
            node({
              id: "ghost",
              name: "div",
              width: 0,
              height: 0,
              children: [node({ id: "kid", name: "span" })],
            }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "detailed"))).toEqual(["main", "span"])
    })
  })

  describe("rule 3 — pass-through wrapper elision", () => {
    it("replaces a single-child wrapper with its child", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [
            node({ id: "wrap", name: "div", children: [node({ id: "b", name: "button" })] }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual([
        "main",
        "button",
      ])
    })

    it("collapses a whole wrapper CHAIN to a fixpoint in one pass", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [
            node({
              id: "w1",
              name: "div",
              children: [
                node({
                  id: "w2",
                  name: "div",
                  children: [
                    node({
                      id: "w3",
                      name: "span",
                      children: [node({ id: "b", name: "button" })],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual([
        "main",
        "button",
      ])
    })

    it("collapses a chain created by hoisting an invisible node", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [
            node({
              id: "wrap",
              name: "div",
              children: [
                node({
                  id: "ghost",
                  name: "div",
                  width: 0,
                  height: 0,
                  children: [node({ id: "b", name: "button" })],
                }),
              ],
            }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual([
        "main",
        "button",
      ])
    })

    it("keeps a wrapper with two children", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [
            node({
              id: "wrap",
              name: "div",
              children: [node({ id: "b", name: "button" }), node({ id: "p", name: "p" })],
            }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual([
        "main",
        "div",
        "button",
        "p",
      ])
    })

    it("keeps a childless leaf element", () => {
      const roots = [
        node({ id: "root", name: "main", children: [node({ id: "leaf", name: "div" })] }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual(["main", "div"])
    })

    it("does NOT elide at the 'detailed' level", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [
            node({
              id: "w1",
              name: "div",
              children: [
                node({ id: "w2", name: "div", children: [node({ id: "b", name: "button" })] }),
              ],
            }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "detailed"))).toEqual([
        "main",
        "div",
        "div",
        "button",
      ])
    })
  })

  describe("rule 4 — semantic tags survive elision", () => {
    it("keeps a single-child semantic wrapper", () => {
      const roots = [
        node({
          id: "root",
          name: "section",
          children: [
            node({ id: "n", name: "nav", children: [node({ id: "a", name: "a" })] }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual([
        "section",
        "nav",
        "a",
      ])
    })

    it("keeps every named semantic tag as a single-child wrapper", () => {
      const semantic = [
        "button", "a", "input", "select", "textarea", "label", "form", "img",
        "svg", "video", "canvas", "iframe", "table", "thead", "tbody", "tr",
        "td", "th", "li", "h1", "h2", "h3", "h4", "h5", "h6", "p", "nav",
        "header", "footer", "main", "aside", "section", "article", "dialog",
        "details", "summary",
      ]
      for (const tag of semantic) {
        const roots = [
          node({
            id: "root",
            name: "div",
            children: [
              node({ id: "s", name: tag, children: [node({ id: "k", name: "em" })] }),
              node({ id: "sibling", name: "em" }),
            ],
          }),
        ]
        expect(names(filterLayersByDensity(roots, "essentials"))).toEqual([
          "div",
          tag,
          "em",
          "em",
        ])
      }
    })

    it("does NOT treat a COMPONENT named after a non-semantic tag as elidable-by-tag", () => {
      // `type === "component"` is what saves it (rule 5), not the tag set.
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [
            node({
              id: "c",
              name: "div",
              type: "component",
              children: [node({ id: "b", name: "button" })],
            }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual([
        "main",
        "div",
        "button",
      ])
    })
  })

  describe("rule 5 — component roots are always kept", () => {
    it("keeps a single-child component wrapper", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [
            node({
              id: "card",
              name: "UiCard",
              type: "component",
              children: [node({ id: "b", name: "button" })],
            }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual([
        "main",
        "UiCard",
        "button",
      ])
    })

    it("keeps a zero-size component only when it is otherwise protected", () => {
      // Rule 2 is not component-aware: a component root with no box and no
      // editTarget still dissolves, hoisting its children.
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [
            node({
              id: "portal",
              name: "UiPortal",
              type: "component",
              width: 0,
              height: 0,
              children: [node({ id: "d", name: "dialog" })],
            }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual([
        "main",
        "dialog",
      ])
    })
  })

  describe("stamped nodes are filtered like any other (an editTarget grants NO protection)", () => {
    // The real tree shape: editor-cli's source-tag-plugin stamps EVERY Vue
    // SFC template element, so `attributeElement` gives essentially every
    // first-party element an `editTarget` — including the pass-through
    // wrapper divs this filter exists to hide. The first version of this
    // filter protected editTarget-bearing nodes, which made it inert on a
    // real prototype. These tests pin the fix. Hiding a stamped row is safe
    // because the panel's move-index math reads the RAW tree — see the
    // module header and layers-panel.test.tsx's raw-index drag test.
    const target = (line: number) => ({ file: FILE, line, column: 3 })

    it("collapses a chain of STAMPED single-child wrapper divs under essentials", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          editTarget: target(2),
          children: [
            node({
              id: "w1",
              name: "div",
              editTarget: target(3),
              children: [
                node({
                  id: "w2",
                  name: "div",
                  editTarget: target(4),
                  children: [
                    node({
                      id: "w3",
                      name: "div",
                      editTarget: target(5),
                      children: [
                        node({ id: "b", name: "button", editTarget: target(6) }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual([
        "main",
        "button",
      ])
    })

    it("drops a stamped non-rendering tag", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          editTarget: target(2),
          children: [node({ id: "s", name: "script", editTarget: target(9) })],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual(["main"])
    })

    it("dissolves a stamped zero-size wrapper, hoisting its children", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          editTarget: target(2),
          children: [
            node({
              id: "ghost",
              name: "div",
              width: 0,
              height: 0,
              editTarget: target(3),
              children: [
                node({ id: "x", name: "p", editTarget: target(4) }),
                node({ id: "y", name: "p", editTarget: target(5) }),
              ],
            }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual([
        "main",
        "p",
        "p",
      ])
    })

    it("still keeps a stamped wrapper with two visible children (rule 3 needs a single child)", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          editTarget: target(2),
          children: [
            node({
              id: "wrap",
              name: "div",
              editTarget: target(3),
              children: [
                node({ id: "a", name: "button", editTarget: target(4) }),
                node({ id: "b", name: "p", editTarget: target(5) }),
              ],
            }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual([
        "main",
        "div",
        "button",
        "p",
      ])
    })
  })

  describe("modelled stamped Vue page (row-count measurement)", () => {
    // A MODELLED tree, not a live prototype: ~80 nodes shaped like a real
    // stamped Vue page — mostly wrapper divs around a handful of semantic
    // elements and component roots, every first-party element stamped
    // (source-tag-plugin stamps them all), plus the usual unstamped noise
    // (mount wrapper, a <style>, a zero-size portal outlet).
    function realisticPage(): OutlineNode[] {
      let line = 0
      const t = () => ({ file: FILE, line: ++line, column: 3 })
      let n = 0
      const el = (
        name: string,
        extra: Partial<OutlineNode> = {},
        children?: OutlineNode[],
      ): OutlineNode =>
        node({
          id: `m${++n}`,
          name,
          width: 200,
          height: 40,
          editTarget: t(),
          ...(children ? { children } : {}),
          ...extra,
        })

      const row = () =>
        el("div", {}, [
          el("span", { width: 80 }),
          el("span", { width: 120 }),
        ])

      const section = () =>
        el("section", { width: 960, height: 240 }, [
          // Card chrome: two stamped single-child wrappers deep.
          el("div", { width: 960, height: 240 }, [
            el("div", { width: 928, height: 208 }, [
              el("h2", { width: 300, height: 24 }),
              el("div", { width: 928, height: 160 }, [row(), row(), row()]),
            ]),
          ]),
        ])

      return [
        // Unstamped mount wrapper (index.html, no data-desde-src).
        node({
          id: "app",
          name: "div",
          width: 1280,
          height: 800,
          editTarget: undefined,
          children: [
            el("SettingsPage", { type: "component", width: 1280, height: 800 }, [
              el("div", { width: 1280, height: 800 }, [
                el("div", { width: 960, height: 800 }, [
                  el("aside", { width: 240, height: 800 }, [
                    // Sidebar chrome: one stamped single-child wrapper.
                    el("div", { width: 240, height: 760 }, [
                      el("nav", { width: 240, height: 400 }, [
                        el("ul", { width: 240, height: 400 }, [
                          el("li", { height: 32 }, [el("a", { height: 32 })]),
                          el("li", { height: 32 }, [el("a", { height: 32 })]),
                          el("li", { height: 32 }, [el("a", { height: 32 })]),
                          el("li", { height: 32 }, [el("a", { height: 32 })]),
                          el("li", { height: 32 }, [el("a", { height: 32 })]),
                        ]),
                      ]),
                    ]),
                  ]),
                  el("header", { width: 960, height: 80 }, [
                    el("div", { width: 960, height: 48 }, [
                      el("h1", { width: 400, height: 32 }),
                    ]),
                    el("p", { width: 600, height: 20 }),
                  ]),
                  el("main", { width: 960, height: 640 }, [
                    section(),
                    section(),
                    section(),
                    el("KCard", {
                      type: "component",
                      width: 960,
                      height: 120,
                      componentFile: "node_modules/@acme/ds/dist/KCard.vue",
                      packageName: "@acme/ds",
                    }, [
                      // Library-internal wrapper: rendered by the package,
                      // still stamped via the consumer chain in real trees.
                      el("div", { width: 928, height: 88 }, [
                        el("KInput", {
                          type: "component",
                          width: 400,
                          height: 36,
                          componentFile: "node_modules/@acme/ds/dist/KInput.vue",
                          packageName: "@acme/ds",
                        }),
                        el("KButton", {
                          type: "component",
                          width: 120,
                          height: 36,
                          componentFile: "node_modules/@acme/ds/dist/KButton.vue",
                          packageName: "@acme/ds",
                        }),
                      ]),
                    ]),
                  ]),
                  el("div", { width: 960, height: 56 }, [
                    el("KButton", {
                      type: "component",
                      width: 120,
                      height: 36,
                      componentFile: "node_modules/@acme/ds/dist/KButton.vue",
                      packageName: "@acme/ds",
                    }),
                    el("KButton", {
                      type: "component",
                      width: 120,
                      height: 36,
                      componentFile: "node_modules/@acme/ds/dist/KButton.vue",
                      packageName: "@acme/ds",
                    }),
                  ]),
                ]),
              ]),
            ]),
            // Zero-size portal outlet + a style tag: the unstamped noise the
            // inert version was limited to removing.
            node({ id: "portal", name: "div", width: 0, height: 0, editTarget: undefined }),
            node({ id: "style", name: "style", editTarget: undefined }),
          ],
        }),
      ]
    }

    function countRows(roots: OutlineNode[]): number {
      return names(roots).length
    }

    it("reduces the modelled page: everything > detailed > essentials", () => {
      const raw = realisticPage()
      const everything = countRows(filterLayersByDensity(raw, "everything"))
      const detailed = countRows(filterLayersByDensity(raw, "detailed"))
      const essentials = countRows(filterLayersByDensity(raw, "essentials"))
      // Pinned counts — if a rule changes, re-derive these deliberately.
      // 74 raw. Detailed drops the <style> and the childless 0-size portal
      // outlet (rules 1-2). Essentials additionally elides the stamped
      // single-child wrappers: the mount div (its only surviving child is
      // SettingsPage once the noise is gone), the page div, the header's
      // flex div, the sidebar's chrome div, and one card-chrome div per
      // section — the rows the inert editTarget-protected version could
      // never touch.
      expect(everything).toBe(74)
      expect(detailed).toBe(72)
      expect(essentials).toBe(65)
      expect(essentials).toBeLessThan(detailed)
      expect(detailed).toBeLessThan(everything)
    })

    it("keeps every component root and semantic landmark at essentials", () => {
      const raw = realisticPage()
      const flat = names(filterLayersByDensity(raw, "essentials"))
      for (const kept of ["SettingsPage", "KCard", "KInput", "KButton", "header", "main", "h1", "h2", "p", "section"]) {
        expect(flat).toContain(kept)
      }
      // The stamped single-child card-chrome wrappers are gone.
      expect(flat).not.toContain("style")
    })
  })

  describe("conditionalGroup and iterationContext are always kept", () => {
    it("keeps a synthetic conditional-group row that would otherwise be elided", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [
            node({
              id: "group",
              name: 'v-if="ready"',
              width: 0,
              height: 0,
              conditionalGroup: { directive: "if", expression: "ready" },
              children: [node({ id: "b", name: "button" })],
            }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual([
        "main",
        'v-if="ready"',
        "button",
      ])
    })

    it("keeps a loop member carrying an iterationContext", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [
            node({
              id: "item",
              name: "div",
              iterationContext: {
                source: "v-for",
                key: 0,
                index: 0,
                siblingCount: 5,
                expression: "item in items",
              },
              children: [node({ id: "b", name: "button" })],
            }),
          ],
        }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual([
        "main",
        "div",
        "button",
      ])
    })
  })

  describe("pipeline order: merge conditional groups FIRST, filter SECOND", () => {
    // The order `useEditorEditing.layersRoots` runs. It used to be the
    // other way round, and that was the defect these tests pin: a
    // `<div v-if>` wrapper holding one child is a stamped, single-child,
    // non-semantic wrapper, so rule 3 elided it at `essentials` before the
    // merge could match it by (file, line, column) and the group row was
    // never built at the default density.
    const GROUP_FILE = "src/components/Panel.vue"

    /** A `<div v-if="ready">` wrapper with exactly one child. */
    function vIfWrapperPage(): OutlineNode[] {
      return [
        node({
          id: "root",
          name: "main",
          children: [
            node({
              id: "wrapper",
              name: "div",
              editTarget: { file: GROUP_FILE, line: 12, column: 5 },
              children: [
                node({
                  id: "inner",
                  name: "div",
                  editTarget: { file: GROUP_FILE, line: 13, column: 7 },
                  children: [
                    node({
                      id: "leaf",
                      name: "button",
                      editTarget: { file: GROUP_FILE, line: 14, column: 9 },
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ]
    }

    const groups: Map<string, FileConditionalGroups> = new Map([
      [
        GROUP_FILE,
        {
          fileHash: "abc123def456",
          groups: [
            {
              head: { line: 12, column: 5 },
              directive: "if" as const,
              expression: "ready",
              branches: [
                { directive: "if", expression: "ready", line: 12, column: 5 },
              ],
              memberLocs: [{ line: 12, column: 5 }],
            },
          ],
        },
      ],
    ])

    it("keeps a <div v-if> wrapper with a single child as a group row at essentials", () => {
      const merged = mergeConditionalGroups(vIfWrapperPage(), groups)
      const rendered = filterLayersByDensity(merged, "essentials")
      const flat = names(rendered)
      expect(flat).toContain('v-if="ready"')
      // The group row survives. Its member chain (the wrapper div, then the
      // inner div) still collapses inside it, which is rule 3 doing its job
      // one level down.
      expect(flat).toEqual(["main", 'v-if="ready"', "button"])
    })

    it("does not elide a real wrapper in favour of a synthetic group row", () => {
      // A group row has a `__desde-group__…` sentinel selector and resolves to
      // no DOM element. Replacing a real single-child wrapper with one would
      // leave a row nothing can select.
      const roots = [
        node({
          id: "shell",
          name: "div",
          children: [
            node({
              id: "wrapper",
              name: "div",
              editTarget: { file: GROUP_FILE, line: 12, column: 5 },
              children: [
                node({
                  id: "leaf",
                  name: "button",
                  editTarget: { file: GROUP_FILE, line: 14, column: 9 },
                }),
              ],
            }),
          ],
        }),
      ]
      const merged = mergeConditionalGroups(roots, groups)
      expect(names(filterLayersByDensity(merged, "essentials"))).toEqual([
        "div",
        'v-if="ready"',
        "button",
      ])
    })

    it("the OLD order loses the group row entirely (the defect, pinned)", () => {
      const filteredFirst = filterLayersByDensity(vIfWrapperPage(), "essentials")
      const mergedAfter = mergeConditionalGroups(filteredFirst, groups)
      expect(names(mergedAfter)).not.toContain('v-if="ready"')
    })

    it("a group row's own CHILDREN still filter normally after the reorder", () => {
      // A v-for body whose member wraps a pass-through chain: the group row
      // survives, the wrapper chain inside it still collapses.
      const forGroups: Map<string, FileConditionalGroups> = new Map([
        [
          GROUP_FILE,
          {
            fileHash: "abc123def456",
            groups: [
              {
                head: { line: 20, column: 3 },
                directive: "for" as const,
                expression: "item in items",
                branches: [
                  {
                    directive: "for",
                    expression: "item in items",
                    line: 20,
                    column: 3,
                  },
                ],
                memberLocs: [
                  { line: 21, column: 5 },
                  { line: 21, column: 5 },
                ],
              },
            ],
          },
        ],
      ])
      const member = (id: string): OutlineNode =>
        node({
          id,
          name: "li",
          editTarget: { file: GROUP_FILE, line: 21, column: 5 },
          children: [
            node({
              id: `${id}-w1`,
              name: "div",
              editTarget: { file: GROUP_FILE, line: 22, column: 7 },
              children: [
                node({
                  id: `${id}-w2`,
                  name: "div",
                  editTarget: { file: GROUP_FILE, line: 23, column: 9 },
                  children: [
                    node({
                      id: `${id}-label`,
                      name: "span",
                      editTarget: { file: GROUP_FILE, line: 24, column: 11 },
                    }),
                  ],
                }),
              ],
            }),
          ],
        })
      const roots = [
        node({
          id: "root",
          name: "ul",
          children: [member("a"), member("b")],
        }),
      ]
      const merged = mergeConditionalGroups(roots, forGroups)
      const flat = names(filterLayersByDensity(merged, "essentials"))
      // One synthetic row wrapping both <li>s; the two-deep wrapper chain
      // inside each member is gone.
      expect(flat).toEqual([
        "ul",
        'v-for="item in items"',
        "li",
        "span",
        "li",
        "span",
      ])
    })
  })

  describe("isLayersDensity", () => {
    it("accepts every density the menu offers", () => {
      expect(isLayersDensity("essentials")).toBe(true)
      expect(isLayersDensity("detailed")).toBe(true)
      expect(isLayersDensity("everything")).toBe(true)
    })

    it("rejects anything else", () => {
      for (const bad of [null, undefined, "", "compact", "ESSENTIALS", 3, {}]) {
        expect(isLayersDensity(bad)).toBe(false)
      }
    })
  })

  describe("reference stability", () => {
    it("returns the same array reference when nothing is filtered", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [node({ id: "a", name: "p" }), node({ id: "b", name: "button" })],
        }),
      ]
      expect(filterLayersByDensity(roots, "essentials")).toBe(roots)
      expect(filterLayersByDensity(roots, "detailed")).toBe(roots)
    })

    it("reuses untouched subtree references when a sibling changes", () => {
      const untouched = node({
        id: "keep",
        name: "section",
        children: [node({ id: "x", name: "p" }), node({ id: "y", name: "button" })],
      })
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [untouched, node({ id: "s", name: "script" })],
        }),
      ]
      const filtered = filterLayersByDensity(roots, "essentials")
      expect(filtered).not.toBe(roots)
      expect(filtered[0].children?.[0]).toBe(untouched)
    })

    it("does not mutate the input tree", () => {
      const roots = [
        node({
          id: "root",
          name: "main",
          children: [
            node({ id: "s", name: "script" }),
            node({ id: "w", name: "div", children: [node({ id: "b", name: "button" })] }),
          ],
        }),
      ]
      const before = JSON.stringify(roots)
      filterLayersByDensity(roots, "essentials")
      expect(JSON.stringify(roots)).toBe(before)
    })
  })

  describe("root-level filtering", () => {
    it("filters the root list itself, not just descendants", () => {
      const roots = [
        node({ id: "s", name: "script" }),
        node({ id: "wrap", name: "div", children: [node({ id: "app", name: "main" })] }),
      ]
      expect(names(filterLayersByDensity(roots, "essentials"))).toEqual(["main"])
    })
  })
})

describe("findVisibleSelector", () => {
  const rawRoots = [
    node({
      id: "root",
      name: "main",
      selector: "main",
      children: [
        node({
          id: "wrap",
          name: "div",
          selector: "#wrap",
          children: [
            node({
              id: "inner",
              name: "div",
              selector: "#inner",
              children: [node({ id: "btn", name: "button", selector: "#btn" })],
            }),
          ],
        }),
      ],
    }),
  ]

  it("returns the selector unchanged when it IS visible", () => {
    const visible = filterLayersByDensity(rawRoots, "essentials")
    expect(findVisibleSelector(visible, rawRoots, "#btn")).toBe("#btn")
  })

  it("falls back to the nearest surviving ancestor when the node was filtered out", () => {
    const visible = filterLayersByDensity(rawRoots, "essentials")
    // #wrap and #inner were elided as pass-through wrappers.
    expect(names(visible)).toEqual(["main", "button"])
    expect(findVisibleSelector(visible, rawRoots, "#inner")).toBe("main")
    expect(findVisibleSelector(visible, rawRoots, "#wrap")).toBe("main")
  })

  it("skips an ancestor that is itself hidden and keeps walking up", () => {
    const raw = [
      node({
        id: "root",
        name: "main",
        selector: "main",
        children: [
          node({
            id: "a",
            name: "div",
            selector: "#a",
            children: [
              node({
                id: "b",
                name: "div",
                selector: "#b",
                children: [node({ id: "c", name: "div", selector: "#c" })],
              }),
            ],
          }),
        ],
      }),
    ]
    const visible = filterLayersByDensity(raw, "essentials")
    expect(names(visible)).toEqual(["main", "div"])
    expect(findVisibleSelector(visible, raw, "#b")).toBe("main")
  })

  it("returns null when the selector is nowhere in the raw tree", () => {
    const visible = filterLayersByDensity(rawRoots, "essentials")
    expect(findVisibleSelector(visible, rawRoots, "#gone")).toBeNull()
  })

  it("returns null when there is no raw tree to walk", () => {
    const visible = filterLayersByDensity(rawRoots, "essentials")
    expect(findVisibleSelector(visible, null, "#inner")).toBeNull()
  })

  it("ignores an ancestor with an empty selector", () => {
    const raw = [
      node({
        id: "root",
        name: "main",
        selector: "main",
        children: [
          node({
            id: "blank",
            name: "div",
            selector: "",
            editTarget: { file: FILE, line: 2, column: 1 },
            children: [node({ id: "kid", name: "div", selector: "#kid" })],
          }),
        ],
      }),
    ]
    // The blank-selector node dissolves (rule 2 — an empty selector renders
    // as a dead row), hoisting #kid. Even if a blank-selector ancestor DID
    // survive, it could never be the highlight target: the panel keys
    // highlighting on selector equality and "" matches nothing.
    const visible = filterLayersByDensity(raw, "detailed")
    expect(findVisibleSelector(visible, raw, "#missing")).toBeNull()
    expect(findVisibleSelector(visible, raw, "#kid")).toBe("#kid")
  })
})
