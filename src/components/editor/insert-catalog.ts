/**
 * Hardcoded catalog of "what can I insert here" options for the
 * layers panel's right-click → "Insert child…" submenu.
 *
 * **V1 scope.** A small fixed list of HTML primitives — substrate-neutral
 * by construction, so it is correct on every prototype.
 *
 * It deliberately does NOT hardcode any design system's components. A
 * previous version shipped a fixed group of Acme DS entries, which
 * offered `<UiCard>` in a React repo that has never heard of it. Design-
 * system entries belong here only once they are sourced from the
 * prototype's own manifest catalog. Future iterations should:
 *   1. Read the manifest catalog for the components this prototype
 *      actually has (the pipeline already discovers them for the
 *      inspector — see `/api/editor/catalog`).
 *   2. Surface manifest-aware default props/text for components that
 *      have them.
 *   3. Let designers pin frequent choices.
 *
 * Each entry has a `label` (what the menu shows) and a `snippet` (the
 * exact Vue template substring to splice). Snippets are intentionally
 * minimal — designers customize via the inspector after insert.
 */

export interface InsertCatalogEntry {
  /** Stable id for keys / telemetry. */
  id: string
  /** What the menu shows. Designer-friendly. */
  label: string
  /** The Vue template snippet to insert. Single element. */
  snippet: string
}

export interface InsertCatalogGroup {
  /** Section header in the submenu. */
  label: string
  entries: InsertCatalogEntry[]
}

export const INSERT_CATALOG: readonly InsertCatalogGroup[] = [
  {
    label: "HTML",
    entries: [
      { id: "div", label: "<div>", snippet: "<div></div>" },
      { id: "span", label: "<span>", snippet: "<span></span>" },
      { id: "section", label: "<section>", snippet: "<section></section>" },
      { id: "p", label: "<p>", snippet: "<p>Text</p>" },
      { id: "h1", label: "<h1>", snippet: "<h1>Heading</h1>" },
      { id: "h2", label: "<h2>", snippet: "<h2>Heading</h2>" },
      { id: "h3", label: "<h3>", snippet: "<h3>Heading</h3>" },
      { id: "button", label: "<button>", snippet: "<button>Click</button>" },
      { id: "a", label: "<a href>", snippet: '<a href="#">Link</a>' },
      { id: "ul", label: "<ul>", snippet: "<ul>\n      <li>Item</li>\n    </ul>" },
      { id: "img", label: "<img />", snippet: '<img src="" alt="" />' },
      { id: "hr", label: "<hr />", snippet: "<hr />" },
    ],
  },
]
