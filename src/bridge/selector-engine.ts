/**
 * Desde Bridge — Selector Engine + Visibility helpers
 *
 * Extracted verbatim from `comment-bridge.ts` so the bridge IIFE entry stays
 * thin and these pure DOM utilities can be reasoned about (and unit-tested) in
 * isolation. No closure state — every function depends only on browser globals.
 * esbuild inlines this back into the IIFE at bundle time.
 */

import { isBridgeOwnElement } from "./selector-helpers"

// ── Selector Engine ───────────────────────────────────────────────────

/**
 * `querySelectorAll` that cannot throw.
 *
 * Every value spliced into a selector comes from page content, which is
 * attacker-controlled from the bridge's point of view. `CSS.escape` should
 * make that safe, but a selector that throws takes down whatever was
 * iterating over selections — a much worse outcome than skipping one
 * candidate. Treat unparseable as "matches nothing".
 */
function safeQueryAll(selector: string): Element[] {
  try {
    return Array.from(document.querySelectorAll(selector))
  } catch {
    return []
  }
}

/** True when `selector` resolves to exactly `el` and nothing else. */
function resolvesUniquelyTo(selector: string, el: Element): boolean {
  const matches = safeQueryAll(selector)
  return matches.length === 1 && matches[0] === el
}

export function generateSelector(el: Element): string {
  if (isBridgeOwnElement(el)) return ""

  // `data-flow-id` and `id` are PREFERENCES, not exemptions.
  //
  // Both used to return early, before the uniqueness gate below — so a
  // duplicated `data-flow-id` (a v-for stamping a constant, two instances of
  // one component) or a duplicated `id` (invalid HTML, ubiquitous in real
  // pages) yielded a selector that resolves to the FIRST match instead of the
  // clicked element. That selector then becomes a persisted comment anchor or
  // an edit target, so the next change lands on a node the user never picked.
  // It is the exact failure the gate was added for; these two just skipped it.
  //
  // The `data-flow-id` value was also interpolated unescaped, so a value
  // containing `"` closed the attribute string and produced a selector that
  // THREW on resolution.
  const preferred: string[] = []
  const flowId = el.getAttribute("data-flow-id")
  if (flowId) preferred.push(`[data-flow-id="${CSS.escape(flowId)}"]`)
  if (el.id && !looksGenerated(el.id)) preferred.push(`#${CSS.escape(el.id)}`)

  for (const sel of [...preferred, ...candidateSelectors(el)]) {
    // `querySelector(sel) === el` is true even when `sel` is ambiguous if `el`
    // happens to be the first match — that produced ambiguous selectors that
    // silently became persisted targetIds. Require uniqueness.
    if (resolvesUniquelyTo(sel, el)) return sel
  }

  return buildNthChildPath(el)
}

export function candidateSelectors(el: Element): string[] {
  const candidates: string[] = []
  const tag = el.tagName.toLowerCase()

  const dataTestId = el.getAttribute("data-testid")
  if (dataTestId) candidates.push(`[data-testid="${CSS.escape(dataTestId)}"]`)

  const ariaLabel = el.getAttribute("aria-label")
  if (ariaLabel) candidates.push(`[aria-label="${CSS.escape(ariaLabel)}"]`)

  const placeholder = el.getAttribute("placeholder")
  if (placeholder)
    candidates.push(`${tag}[placeholder="${CSS.escape(placeholder)}"]`)

  const classSel = buildClassSelector(el)
  if (classSel) candidates.push(classSel)

  return candidates
}

export function looksGenerated(id: string): boolean {
  return /[0-9a-f]{8,}|^[a-z]{1,2}-?\d+$/i.test(id) || id.length > 40
}

export function isUnique(selector: string): boolean {
  return safeQueryAll(selector).length === 1
}

export function buildClassSelector(el: Element): string | null {
  const tag = el.tagName.toLowerCase()
  const classes = Array.from(el.classList).filter(
    (c) => !looksGenerated(c) && !c.startsWith("v-") && c.length < 40
  )
  if (classes.length === 0) return null

  for (const cls of classes) {
    const sel = `${tag}.${CSS.escape(cls)}`
    if (isUnique(sel)) return sel
  }

  if (classes.length > 1) {
    const sel = `${tag}${classes.map((c) => `.${CSS.escape(c)}`).join("")}`
    if (isUnique(sel)) return sel
  }

  return null
}

export function buildNthChildPath(el: Element): string {
  const parts: string[] = []
  let current: Element | null = el

  while (current && current !== document.documentElement) {
    const tag = current.tagName.toLowerCase()

    // Same rule as above: only anchor on an id that is actually unique.
    // A duplicated ancestor id would root the whole path at the wrong
    // subtree, and every `:nth-of-type` below it would then be measured
    // against the wrong parent.
    if (current.id && !looksGenerated(current.id)) {
      const idSel = `#${CSS.escape(current.id)}`
      if (safeQueryAll(idSel).length === 1) {
        parts.unshift(idSel)
        break
      }
    }

    const parent = current.parentElement
    if (!parent) {
      parts.unshift(tag)
      break
    }

    const sameTagSiblings = Array.from(parent.children).filter(
      (s) => s.tagName === current!.tagName
    )

    if (sameTagSiblings.length === 1) {
      parts.unshift(tag)
    } else {
      const index = sameTagSiblings.indexOf(current) + 1
      parts.unshift(`${tag}:nth-of-type(${index})`)
    }

    current = parent
  }

  return parts.join(" > ")
}

// ── Visibility helpers ────────────────────────────────────────────────

export function isElementVisible(el: Element): boolean {
  if (typeof (el as HTMLElement).checkVisibility === "function") {
    return (el as HTMLElement).checkVisibility()
  }
  const rect = el.getBoundingClientRect()
  return rect.width > 0 || rect.height > 0
}

export function getAncestorTabPanelIds(el: Element): string[] {
  const ids: string[] = []
  let current: Element | null = el.closest('[role="tabpanel"]')
  while (current) {
    const id = current.getAttribute("aria-labelledby")
    if (id) ids.push(id)
    current = current.parentElement?.closest('[role="tabpanel"]') ?? null
  }
  return ids
}

export function areTabPanelsActive(panelIds?: string[]): boolean {
  if (!panelIds || panelIds.length === 0) return true
  return panelIds.every((id) => {
    const tab = document.getElementById(id)
    if (!tab) return true
    return tab.closest(".tab-item")?.classList.contains("active") ?? true
  })
}
