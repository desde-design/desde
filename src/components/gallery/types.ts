import type { ReactNode } from "react"

/**
 * Surface gallery — the shared vocabulary for a catalog of UI surfaces, each
 * rendered on demand with fixture data.
 *
 * There are two catalogs in this repo and they exist for the same reason: the
 * states that most need design attention are the ones hardest to summon. The
 * Editor's (`src/components/editor/gallery/`) holds its decision and failure
 * modals, each of which needs a specific ambiguity reproduced against a live
 * prototype. The Viewer's (`viewer/gallery/`) holds its screens, which
 * otherwise need a running server, a GitHub App, a real repository and a real
 * build before anyone can look at them.
 *
 * These types live here, above both, so the two catalogs cannot drift into
 * different shapes — and so the controller in `./use-surface-gallery.ts` can
 * serve either one.
 *
 * See docs/superpowers/specs/2026-08-08-surface-gallery-design.md.
 */

/**
 * How a surface presents, for grouping in the picker. It does NOT change how
 * the surface renders — each fixture's own JSX decides that — so this is a
 * label, and a wrong one only misleads the reviewer.
 *
 * `page` is distinct from `inline`: an inline surface is a region inside a
 * page (a panel section, a form row), a `page` surface IS the page.
 */
export type SurfaceKind = "modal" | "page" | "inline" | "toast"

/**
 * Handed to a state's `render`/`fire` so fixture callbacks can report what
 * the surface invoked. For decision UI the semantics of each choice are as
 * much the subject of a redesign as the layout, so the picker shows a
 * running log of calls rather than swallowing them.
 */
export interface SurfaceRenderContext {
  /**
   * Report a callback the surface invoked. **Call it only from a callback,
   * never while rendering.**
   *
   * `log` appends to state owned by the picker, and a fixture's `render`
   * executes inside the picker's OWN render pass — so calling it there is a
   * `setState` during render, which React answers with "Too many re-renders"
   * and an unmounted app. MEASURED: seven fixtures used it as a
   * this-is-what-this-state-does annotation and took the whole gallery down.
   * If a state needs a note for the reader, render the note.
   */
  log: (callback: string, ...args: unknown[]) => void
}

/** One distinct visual state of a surface. */
export interface SurfaceState {
  /** Stable and URL-addressable: `"<entry id>/<slug>"`. */
  id: string
  /** Short human label, shown in the picker. Entry title supplies context. */
  label: string
  /** Modal + inline states render a node. Exactly one of render/fire is set. */
  render?: (ctx: SurfaceRenderContext) => ReactNode
  /** Toast states fire the real call, pinned open. Exactly one of render/fire. */
  fire?: (ctx: SurfaceRenderContext) => void
  /**
   * CSS selector that appears only once this state has reached its FINAL
   * visual state. Omit for a declarative fixture (a prop bag), where the first
   * commit is already the final state.
   *
   * Set it for a **driven** fixture — one whose host gates its target behind
   * internal `useState` no prop can set, so the fixture types and clicks its
   * way there from an effect. For those, `data-gallery-ready` fires while the
   * interaction is still in flight, so it means only "the host mounted", not
   * "the state has arrived". A registry render test waits for this selector
   * before asserting content, which is what puts driven states under test at
   * all — without it a sweep's own synchronous `cleanup()` cancels every
   * driven interaction before it runs.
   */
  readyWhen?: string
  /**
   * Why this state cannot ARRIVE outside a real browser. Set it only when
   * that is true, and make the string the reason — it is read by a person,
   * not by code.
   *
   * There is exactly one cause today, and it is not a jsdom shim away. The
   * Viewer's review screen only trusts a message whose `event.source` is its
   * prototype iframe's `contentWindow`, and `event.source` is the realm of
   * the code that CALLED `postMessage` — not the object it was called on. So
   * the message has to be posted by a function defined inside the iframe's
   * own document, which means that document has to have loaded, which jsdom
   * does not do.
   *
   * A registry sweep still RENDERS these states — a throw or a blank render
   * is caught exactly as for any other — but it does not wait for
   * `readyWhen`, because in that environment the state never gets there. They
   * are verified by opening them in the gallery.
   */
  needsBrowser?: string
}

export interface SurfaceEntry {
  /** Slug shared by all this surface's state ids. */
  id: string
  title: string
  kind: SurfaceKind
  /** Repo-relative path, shown in the picker so a redesign edit lands right. */
  sourceFile: string
  states: SurfaceState[]
}

/** Resolve a state id against a catalog. Returns null for an unknown id. */
export function findStateInRegistry(
  registry: readonly SurfaceEntry[],
  id: string,
): { entry: SurfaceEntry; state: SurfaceState } | null {
  for (const entry of registry) {
    const state = entry.states.find((candidate) => candidate.id === id)
    if (state) return { entry, state }
  }
  return null
}
