/**
 * Desde Bridge — Selector Helpers (for recorder/player)
 *
 * Extracted verbatim from `comment-bridge.ts`. Pure utilities used by the flow
 * recorder, flow player, and screenshot generator to describe elements/inputs,
 * wait for elements, walk to interactive ancestors, and sleep. No closure
 * state — browser globals only. esbuild inlines this back into the IIFE at
 * bundle time.
 */

/**
 * Attribute stamped on every element the bridge injects into the page (overlay
 * hosts, pin layers, the injected <script> tags). Selection, hit-testing,
 * mutation notification, and MCP queries all have to skip these so the tool
 * never targets its own DOM.
 */
export const BRIDGE_OWN_ATTR = "data-prototype-flow"
const BRIDGE_OWN_SELECTOR = `[${BRIDGE_OWN_ATTR}]`

/**
 * True when `el` IS bridge-injected DOM or lives inside it. Null/undefined and
 * non-Element nodes (which have no `closest`) are "not ours" — the callers that
 * care about node type check it themselves.
 *
 * Replaces the scattered `el.closest("[data-prototype-flow]")` literals so the
 * attribute name exists in exactly one place.
 */
export function isBridgeOwnElement(el: Element | Node | null | undefined): boolean {
  return !!(el as Element | null | undefined)?.closest?.(BRIDGE_OWN_SELECTOR)
}

/**
 * True when `el` ITSELF carries the attribute — ancestors are NOT consulted.
 * Used where the walk is already scoped to a known-substrate container and a
 * `closest()` would wrongly exclude the whole subtree.
 */
export function hasBridgeOwnAttr(el: Element | null | undefined): boolean {
  return !!el?.hasAttribute?.(BRIDGE_OWN_ATTR)
}

export function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase()
  const text = el.textContent?.trim().slice(0, 50) || ""
  const ariaLabel = el.getAttribute("aria-label")
  const title = el.getAttribute("title")
  const placeholder = el.getAttribute("placeholder")

  const label =
    ariaLabel || title || placeholder || (text ? `"${text}"` : tag)

  const roleMap: Record<string, string> = {
    a: "link",
    button: "button",
    input: "input",
    select: "dropdown",
    nav: "navigation",
    li: "menu item",
  }

  const role = roleMap[tag] || tag
  return `Click ${role} ${label}`
}

export function describeInput(el: Element, value: string): string {
  const tag = el.tagName.toLowerCase()
  const ariaLabel = el.getAttribute("aria-label")
  const placeholder = el.getAttribute("placeholder")
  const name = el.getAttribute("name")
  const label = ariaLabel || placeholder || name || tag

  if (tag === "select") {
    const truncated = value.length > 30 ? value.slice(0, 30) + "..." : value
    return `Select "${truncated}" in ${label}`
  }

  const inputEl = el as HTMLInputElement
  if (inputEl.type === "checkbox") {
    return `${value === "true" ? "Check" : "Uncheck"} ${label}`
  }
  if (inputEl.type === "radio") {
    return `Select radio ${label}`
  }

  const truncated = value.length > 30 ? value.slice(0, 30) + "..." : value
  return `Type "${truncated}" in ${label}`
}

export function waitForElement(
  selector: string,
  timeout = 3000
): Promise<Element | null> {
  const el = document.querySelector(selector)
  if (el) return Promise.resolve(el)

  return new Promise((resolve) => {
    const start = Date.now()
    const interval = setInterval(() => {
      const found = document.querySelector(selector)
      if (found) {
        clearInterval(interval)
        resolve(found)
      } else if (Date.now() - start > timeout) {
        clearInterval(interval)
        resolve(null)
      }
    }, 100)
  })
}

export function findInteractiveAncestor(el: Element): Element | null {
  let current: Element | null = el
  const interactiveTags = new Set([
    "A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "DETAILS", "SUMMARY",
  ])
  const interactiveRoles = new Set([
    "button", "link", "menuitem", "tab", "option", "switch", "checkbox", "radio",
  ])

  while (current && current !== document.body) {
    if (interactiveTags.has(current.tagName)) return current
    const role = current.getAttribute("role")
    if (role && interactiveRoles.has(role)) return current
    if (current.hasAttribute("onclick") || current.hasAttribute("tabindex")) return current
    current = current.parentElement
  }

  return null
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
