/**
 * WHERE a `scoped-css-override` rule is written on a substrate that has no
 * `<style scoped>` block to carry it (React, and anything else whose
 * components are not single-file).
 *
 * **The question that decides whether the rule renders is reachability, not
 * existence.** A rule spliced into a `.css` file the app never imports is
 * inert — the write succeeds, the file parses, the server returns `ok: true`,
 * and nothing changes on screen. That is the same silent failure the Vue lane
 * shipped for a different reason (`tasks/dev-server-hosts.md` § 9g.8), so the
 * candidate set here comes from `document.styleSheets` (via the bridge's
 * `GET_STYLESHEET_TARGETS`), never from a filesystem walk.
 *
 * **Why not `buildDesignTokenSources`, which § 9f pointed at.** It builds
 * `DesignTokenSource`s, and its app arm is filtered to files that DECLARE
 * custom properties (`css-custom-properties/discover.ts` — `appCssFiles` keeps
 * only files where `parseCustomProperties(text).length > 0`). Routing a
 * styling lane through a token-declaration filter would make "can I restyle
 * this button?" depend on whether the project happens to use CSS variables:
 * an unrelated and invisible gate. Its lower-level sibling `walkAppCssFiles`
 * has no such filter and IS reused — but on the SERVER, for the sticky rung
 * below, because it answers "which file already holds our block?" and cannot
 * answer "which file does the page load?".
 *
 * The ladder, first hit wins:
 *
 *  1. **Configured** — `styling.overrideStylesheet` in
 *     `desde.config.json`. A team says "put them here" once.
 *  2. **Sticky** — the loaded first-party stylesheet that already holds our
 *     managed marker block. This is the important rung: it makes the choice
 *     *made once and read back*, so a later change in import order cannot
 *     scatter a project's overrides across three files, and idempotence works
 *     across sessions rather than only within one.
 *  3. **Runtime-last** — the LAST first-party writable stylesheet in document
 *     order. Cascade-derived, not filename-derived: later source order breaks
 *     ties at equal importance and specificity. (In practice it rarely
 *     decides anything, because the rules are unlayered `!important` — but
 *     "rarely decides" is not "may be arbitrary".)
 *  4. **Refuse**, with the one-line fix.
 *
 * With SEVERAL stylesheets the ladder is deterministic and the answer is
 * visible: the caller can name the destination before the write, and rung 2
 * makes it the same file next time. With NONE — the normal state of a
 * CSS-Modules-only or styled-components-only app — the lane refuses and
 * suggests creating one. Creating the file and importing it from the entry
 * module is a separate, separately-confirmed bootstrap: the edit handler's
 * contract is single-file, and a styling edit that silently rewrites
 * `src/main.tsx` is exactly the kind of surprise this design exists to avoid.
 */
import type { StyleStylesheetRef } from "@/types/bridge"
import {
  resolveTokenSourceFile,
  type TokenSourceOptions,
} from "./resolve-token-source-file"

/** The file a rule would be written into, and which rung chose it. */
export interface OverrideStylesheetChoice {
  file: string
  rung: "configured" | "sticky" | "runtime-last"
  /**
   * Every reachable first-party writable stylesheet, document order. Exposed
   * so a UI can say WHY this file and offer the others; also what makes the
   * "several stylesheets" case explainable rather than magic.
   */
  candidates: string[]
}

export interface OverrideStylesheetRefusal {
  rung: "none"
  reason: string
  /** Path the bootstrap action would create. Never created by this module. */
  suggestion: string
  candidates: string[]
}

export type OverrideStylesheetResolution =
  | OverrideStylesheetChoice
  | OverrideStylesheetRefusal

export function isOverrideStylesheetRefusal(
  r: OverrideStylesheetResolution,
): r is OverrideStylesheetRefusal {
  return r.rung === "none"
}

export const OVERRIDE_STYLESHEET_SUGGESTION = "src/desde-overrides.css"

export interface ResolveOverrideStylesheetOptions extends TokenSourceOptions {
  /**
   * `styling.overrideStylesheet` from the customer's config, as the CLI
   * resolved it (prototype-root-relative). Trusted-but-validated: it still
   * goes through the same writable-CSS gate as a discovered sheet, and it is
   * only honoured when the page actually LOADS it — a configured destination
   * the app does not import would be inert exactly like any other unimported
   * file, and silently obeying it would turn a typo into a dead lane.
   */
  configured?: string
  /**
   * Prototype-root-relative path of the app stylesheet that already contains
   * the editor-managed marker block, found by the CLI at boot with
   * `walkAppCssFiles`. Same reachability rule as `configured`: honoured only
   * if the page loads it.
   */
  sticky?: string
}

/**
 * Map the document's stylesheets to first-party writable paths and pick one.
 *
 * `sheets` must be in DOCUMENT ORDER — rung 3 depends on it.
 */
export function resolveOverrideStylesheet(
  sheets: readonly Pick<StyleStylesheetRef, "href" | "package" | "sourceHint">[],
  options: ResolveOverrideStylesheetOptions = {},
): OverrideStylesheetResolution {
  const candidates: string[] = []
  for (const ref of sheets) {
    const file = resolveTokenSourceFile(ref, options)
    // De-duplicate: Vite serves one file as several sheets in some setups
    // (an `@import` chain, a `?direct` request alongside the injected style).
    if (file && !candidates.includes(file)) candidates.push(file)
  }

  if (candidates.length === 0) {
    return {
      rung: "none",
      reason:
        "No project stylesheet is loaded on this page, so there's nowhere to write a style override that would render.",
      suggestion: OVERRIDE_STYLESHEET_SUGGESTION,
      candidates,
    }
  }

  if (options.configured && candidates.includes(options.configured)) {
    return { file: options.configured, rung: "configured", candidates }
  }
  if (options.sticky && candidates.includes(options.sticky)) {
    return { file: options.sticky, rung: "sticky", candidates }
  }
  return {
    file: candidates[candidates.length - 1],
    rung: "runtime-last",
    candidates,
  }
}
