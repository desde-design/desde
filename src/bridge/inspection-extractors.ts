/**
 * Desde Bridge — Inspection Extractors
 *
 * Extracted verbatim from `comment-bridge.ts`. Pure helpers the inspector uses
 * to pull design tokens (CSS custom properties) and raw stylesheet values off
 * an element, resolve the current page's source file, and parse `data-desde-src`
 * source tags — plus the InspectionData sub-types they produce. No IIFE closure
 * state; browser globals only. esbuild inlines this back into the IIFE.
 */

export interface InspectionStyleProperty {
  name: string
  value: string
  rawValue?: string
}

export interface InspectionStyleCategory {
  name: string
  properties: InspectionStyleProperty[]
}

export interface InspectionDesignToken {
  name: string
  value: string
  source: "element" | "inherited"
}

export interface InspectionBoxModelSides {
  top: number; right: number; bottom: number; left: number
}

export interface InspectionBoxModelData {
  width: number; height: number
  margin: InspectionBoxModelSides
  border: InspectionBoxModelSides
  padding: InspectionBoxModelSides
  content: { width: number; height: number }
}


export function extractDesignTokens(el: Element, computed: CSSStyleDeclaration): InspectionDesignToken[] {
  const tokens: InspectionDesignToken[] = []
  const seen = new Set<string>()

  const htmlEl = el as HTMLElement
  if (htmlEl.style) {
    for (let i = 0; i < htmlEl.style.length; i++) {
      const prop = htmlEl.style[i]
      if (prop.startsWith("--")) {
        seen.add(prop)
        tokens.push({ name: prop, value: computed.getPropertyValue(prop).trim(), source: "element" })
      }
    }
  }

  try {
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (!(rule instanceof CSSStyleRule)) continue
          try {
            if (!el.matches(rule.selectorText)) continue
          } catch { continue }
          for (let i = 0; i < rule.style.length; i++) {
            const prop = rule.style[i]
            if (prop.startsWith("--") && !seen.has(prop)) {
              seen.add(prop)
              tokens.push({ name: prop, value: computed.getPropertyValue(prop).trim(), source: "element" })
            }
          }
        }
      } catch { /* cross-origin */ }
    }
  } catch { /* unavailable */ }

  let ancestor = el.parentElement
  while (ancestor && ancestor !== document.documentElement && tokens.length < 50) {
    const ancestorStyle = (ancestor as HTMLElement).style
    if (ancestorStyle) {
      for (let i = 0; i < ancestorStyle.length; i++) {
        const prop = ancestorStyle[i]
        if (prop.startsWith("--") && !seen.has(prop)) {
          seen.add(prop)
          tokens.push({ name: prop, value: computed.getPropertyValue(prop).trim(), source: "inherited" })
        }
      }
    }
    ancestor = ancestor.parentElement
  }

  return tokens
}

export function buildRawValueMap(el: Element): Map<string, string> {
  const map = new Map<string, string>()
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (!(rule instanceof CSSStyleRule)) continue
          try {
            if (!el.matches(rule.selectorText)) continue
          } catch { continue } // invalid selector for matches()
          for (let i = 0; i < rule.style.length; i++) {
            const prop = rule.style[i]
            // LAST match in document order wins, not the first.
            //
            // Keeping the first was backwards: at equal specificity the CSS
            // cascade gives the later declaration priority, so
            // `.btn { color: red }` followed by `.primary { color: blue }`
            // reported `red` as the authored value while `computed` showed
            // blue — a silently wrong source value in the inspector.
            //
            // Document order alone is an APPROXIMATION: an earlier rule with
            // higher specificity legitimately wins, and this does not model
            // that. It is strictly closer than first-match (utility CSS and
            // the usual escalating-specificity patterns both put the winner
            // later), and `rawValue` is supplementary display info shown only
            // when it differs from `computed`. The specificity-aware answer
            // already exists in `style-provenance.ts`, which resolves the
            // winning rule via real Selectors-Level-4 specificity — that is
            // the path to use when the exact source rule matters.
            const val = rule.style.getPropertyValue(prop).trim()
            if (val) map.set(prop, val)
          }
        }
      } catch { /* cross-origin stylesheet */ }
    }
  } catch { /* styleSheets unavailable */ }
  return map
}

export function getPageSourceFile(): string | undefined {
  // Primary: read the data attribute stamped by the prototype's router hook
  const attr = document.documentElement.getAttribute("data-page-source")
  if (attr) return attr

  // Fallback: dig into Vue internals (dev-mode __file only)
  try {
    const appEl = document.querySelector("#app") as Record<string, unknown> | null
    const vueApp = appEl?.__vue_app__ as Record<string, unknown> | undefined
    const router = (vueApp?.config as Record<string, unknown> | undefined)
      ?.globalProperties as Record<string, unknown> | undefined
    const $router = router?.$router as Record<string, unknown> | undefined
    if (!$router) return undefined
    const currentRoute = $router.currentRoute as { value?: { matched?: unknown[] } } | undefined
    const matched = currentRoute?.value?.matched
    if (!Array.isArray(matched) || matched.length === 0) return undefined
    const last = matched[matched.length - 1] as Record<string, unknown> | undefined
    const components = last?.components as Record<string, unknown> | undefined
    const defaultComp = components?.default as Record<string, unknown> | undefined
    const file = defaultComp?.__file as string | undefined
    if (!file) return undefined
    const srcIdx = file.indexOf("src/")
    return srcIdx >= 0 ? file.slice(srcIdx) : undefined
  } catch {
    return undefined
  }
}

/**
 * Read a build-time source location from `el` or its nearest ancestor.
 * Substrates that ship `vite-plugin-source-tag` add `data-desde-src="<file>:<line>:<col>"`
 * on every concrete template element. Editor's edit service uses this to
 * rewrite the exact source position that produced the rendered DOM node.
 * Returns undefined when no tagged ancestor is found (e.g. slot fragments,
 * elements injected outside the substrate's compilation pipeline, or when
 * the plugin isn't installed).
 */
/**
 * Parse a `data-desde-src` value (`"<file>:<line>:<col>"`) into its parts.
 * `<file>` may itself contain colons on exotic paths, so split from the
 * right and take the last two pieces. Returns undefined when malformed.
 */
/**
 * Read the per-file source-version hash (`data-desde-v`) for `file` from the
 * live DOM. The source-tag plugin stamps `data-desde-v="<sha256-prefix>"` next
 * to every `data-desde-src` it writes, computed from the exact file bytes the
 * coordinates were derived from — so the version read here is always paired
 * with the coordinates captured in the same DOM snapshot. The server
 * compares it against the current on-disk content and refuses stale-target
 * edits instead of splicing at coordinates that no longer mean what the
 * user clicked (WS1, tasks/edit-pipeline-rearchitecture.md).
 *
 * Per-file, not per-element: every element stamped from one file carries
 * the same hash, so any `[data-desde-src^="<file>:"]` match supplies it.
 * Returns undefined when the plugin didn't stamp versions (older plugin,
 * prototype's own source-tag plugin) — the guard is opt-in by presence.
 */
export function fileVersionFor(file: string): string | undefined {
  try {
    const escaped = file.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    const el = document.querySelector(`[data-desde-v][data-desde-src^="${escaped}:"]`)
    return (el as HTMLElement | null)?.dataset?.desdeV || undefined
  } catch {
    return undefined
  }
}

export function parseSourceTag(
  raw: string,
): { file: string; line: number; column: number } | undefined {
  const lastColon = raw.lastIndexOf(":")
  if (lastColon < 0) return undefined
  const secondLastColon = raw.lastIndexOf(":", lastColon - 1)
  if (secondLastColon < 0) return undefined
  const file = raw.slice(0, secondLastColon)
  const line = Number(raw.slice(secondLastColon + 1, lastColon))
  const column = Number(raw.slice(lastColon + 1))
  if (!file || !Number.isFinite(line) || !Number.isFinite(column)) return undefined
  return { file, line, column }
}
