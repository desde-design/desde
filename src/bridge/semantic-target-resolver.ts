/**
 * Semantic-target resolution + interaction (editor-screenshot-flows.md
 * Phase 2). Resolves a framework-neutral `SemanticTarget` (ARIA role +
 * accessible name, with a visible-text fallback) to a live element + a stable
 * selector — the cheap validity gate the deterministic replay uses to decide
 * "act, no LLM" vs. "escalate to heal". A last-known-good `selector` (replay
 * cache) is honored first.
 *
 * Resolution mirrors Playwright's resilient-locator doctrine: prefer the
 * accessibility tree (role+name), not a brittle CSS path. The returned
 * `selector` (from the existing stable-selector engine) is the cache the heal
 * step rewrites.
 */

import { generateSelector } from "./selector-engine"
import { isBridgeOwnElement } from "./selector-helpers"
import { simulateClick } from "./dom-events"

export interface SemanticTargetInput {
  role?: string
  name?: string
  text?: string
  /** Last-known-good selector (replay cache); tried first. */
  selector?: string
}

export interface ResolveTargetResult {
  found: boolean
  /** Stable selector for the matched element (the replay cache value). */
  selector?: string
  /** The resolved element's role (for heal write-back). */
  role?: string
  /** The resolved element's accessible name (for heal write-back). */
  name?: string
  /**
   * Why resolution failed, when `found` is false. `"ambiguous"` means the
   * page really does contain several equally-good matches — a different
   * situation from "nothing matched", and one a heal step can act on by
   * asking for a more specific target.
   */
  reason?: "not-found" | "ambiguous"
}

export type InteractAction = "click" | "fill" | "select"

export interface PerformInteractInput {
  selector: string
  action: InteractAction
  value?: string
}

export interface PerformInteractResult {
  ok: boolean
  error?: string
}

/** Implicit ARIA role for the common HTML elements we resolve against.
 * `<input>` is intentionally absent — its role depends on `type` (see
 * {@link inputRole}). */
const TAG_ROLE: Record<string, string> = {
  a: "link",
  button: "button",
  textarea: "textbox",
  select: "combobox",
  nav: "navigation",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  img: "img",
  table: "table",
  ul: "list",
  ol: "list",
  li: "listitem",
}

/** Implicit ARIA role for an `<input>` by its `type` (checkbox / radio /
 * submit-button / slider / … all differ from the default textbox). */
function inputRole(el: HTMLInputElement): string {
  const type = (el.getAttribute("type") || el.type || "text").toLowerCase()
  switch (type) {
    case "checkbox":
      return "checkbox"
    case "radio":
      return "radio"
    case "submit":
    case "button":
    case "reset":
    case "image":
      return "button"
    case "range":
      return "slider"
    case "number":
      return "spinbutton"
    case "search":
      return "searchbox"
    default:
      // text, email, password, tel, url, date, … → textbox
      return "textbox"
  }
}

/** The element's ARIA role — explicit `role` attr wins, else the implicit one. */
function elementRole(el: Element): string {
  const explicit = el.getAttribute("role")
  if (explicit) return explicit.trim().toLowerCase()
  const tag = el.tagName.toLowerCase()
  if (tag === "input") return inputRole(el as HTMLInputElement)
  return TAG_ROLE[tag] ?? tag
}

/** Collect text from a space-separated list of element ids (aria-labelledby). */
function idListText(ids: string): string {
  return ids
    .split(/\s+/)
    .map((id) => {
      try {
        return document.getElementById(id)?.textContent?.trim() ?? ""
      } catch {
        return ""
      }
    })
    .filter(Boolean)
    .join(" ")
    .trim()
}

/** Form controls that take an associated <label>'s text as their accessible
 * name (both the `for=`/`id` and the wrapping-`<label>` association forms). */
const LABELABLE_TAGS = new Set(["input", "select", "textarea", "meter", "progress", "output"])

/**
 * Compute an element's accessible name, in the priority order browsers use:
 * aria-label → aria-labelledby → associated <label> (for= OR wrapping) →
 * title → placeholder → trimmed text content. Good enough for matching authored
 * targets without a full accessible-name spec implementation.
 *
 * Exported for unit testing (jsdom can't exercise it via
 * `resolveSemanticTarget`, whose visibility gate needs real layout).
 */
export function accessibleName(el: Element): string {
  const aria = el.getAttribute("aria-label")
  if (aria && aria.trim()) return aria.trim()

  const labelledby = el.getAttribute("aria-labelledby")
  if (labelledby) {
    const t = idListText(labelledby)
    if (t) return t
  }

  // Associated <label>, but only for labelable controls (a label's text is
  // its control's name, not a generic element's). Two association forms:
  //   1. explicit `<label for="id">` ↔ `<input id="id">`
  //   2. the wrapping `<label>Name <input/></label>` (no id needed) — the
  //      common pattern the first cut missed (codex P2).
  if (LABELABLE_TAGS.has(el.tagName.toLowerCase())) {
    if (el.id) {
      try {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
        const t = lab?.textContent?.trim()
        if (t) return t
      } catch {
        /* invalid id for a selector — ignore */
      }
    }
    const wrapping = el.closest("label")
    if (wrapping) {
      // The label's caption is its text MINUS the wrapped control's own
      // subtree. `<input>`/`<textarea>` contribute nothing to textContent,
      // but a `<select>`'s `<option>`s DO (that's the control's value, not
      // its name) — so strip controls from a clone before reading text.
      const clone = wrapping.cloneNode(true) as HTMLElement
      clone
        .querySelectorAll("input,select,textarea,meter,progress,output,button")
        .forEach((c) => c.remove())
      const wt = clone.textContent?.trim()
      if (wt) return wt
    }
  }

  // <input type=submit|button|reset> — these have no text content; their
  // button label is the `value` attribute. `inputRole()` maps them to role
  // "button", so without this `{role:'button', name:'Save'}` would miss a
  // native `<input type="submit" value="Save">` (codex).
  if (el.tagName.toLowerCase() === "input") {
    const inputType = ((el as HTMLInputElement).getAttribute("type") || "text").toLowerCase()
    if (inputType === "submit" || inputType === "button" || inputType === "reset") {
      const v = el.getAttribute("value")?.trim()
      if (v) return v
    }
  }

  const title = el.getAttribute("title")
  if (title && title.trim()) return title.trim()

  const placeholder = el.getAttribute("placeholder")
  if (placeholder && placeholder.trim()) return placeholder.trim()

  const text = (el.textContent ?? "").trim()
  return text
}

/** Whether an element is rendered (has layout box + isn't display:none/hidden). */
function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return false
  const style = window.getComputedStyle(el)
  if (style.display === "none" || style.visibility === "hidden") return false
  if (Number(style.opacity) === 0) return false
  return true
}

/** Tags whose implicit role maps to a wanted role — used to narrow the scan. */
function tagsForRole(role: string): string[] {
  const out: string[] = []
  for (const [tag, r] of Object.entries(TAG_ROLE)) {
    if (r === role) out.push(tag)
  }
  return out
}

/** Build the candidate element set to scan (narrowed by role when given). */
function candidateElements(role: string): Element[] {
  let selector: string
  if (role) {
    const tags = tagsForRole(role)
    // `<input>` roles depend on `type`, so a role-tag map can't pre-select
    // them. Include all inputs and let the caller's `elementRole` filter narrow
    // to the right type (so role:'checkbox'/'radio'/'button' still find native
    // controls). Cheap on real pages relative to a correctness miss.
    const parts = [`[role="${role}"]`, ...tags, "input"]
    selector = parts.join(",")
  } else {
    // No role given — scan the usual interactive + labelled surfaces.
    selector =
      "a,button,input,select,textarea,[role],[aria-label],h1,h2,h3,h4,h5,h6,label"
  }
  try {
    return Array.from(document.querySelectorAll(selector))
  } catch {
    return []
  }
}

/**
 * Whether a live element still matches the recorded target's role + name.
 * Role must match exactly when the target recorded one; name matches on exact
 * or contains. Used to (a) confirm a cached selector hasn't gone stale and
 * (b) filter candidates by role.
 */
function elementMatchesTarget(el: Element, wantRole: string, wantName: string): boolean {
  if (wantRole && elementRole(el) !== wantRole) return false
  if (wantName) {
    const name = accessibleName(el).toLowerCase()
    if (name !== wantName && !name.includes(wantName)) return false
  }
  return true
}

/**
 * Resolve a semantic target to a live element + stable selector, or a miss.
 * Pure read — no side effects. The cache `selector` is tried first — but only
 * trusted when the element it still points at matches the recorded role/name
 * (a stale selector that now points elsewhere falls through to semantic
 * resolution → a miss → heal, rather than clicking the wrong element).
 */
export function resolveSemanticTarget(
  target: SemanticTargetInput,
): ResolveTargetResult {
  const wantRole = (target.role ?? "").trim().toLowerCase()
  const wantName = (target.name ?? target.text ?? "").trim().toLowerCase()

  // 1. Replay cache — last-known-good selector, accepted ONLY if it still
  //    resolves to a visible, non-tool element that matches the recorded
  //    role/name. Otherwise the cache is stale → fall through.
  if (target.selector) {
    try {
      const cached = document.querySelector(target.selector)
      if (
        cached &&
        !isBridgeOwnElement(cached) &&
        isVisible(cached) &&
        elementMatchesTarget(cached, wantRole, wantName)
      ) {
        return {
          found: true,
          selector: target.selector,
          role: elementRole(cached),
          name: accessibleName(cached),
        }
      }
    } catch {
      /* stale/invalid cached selector — fall through to semantic resolve */
    }
  }

  const candidates = candidateElements(wantRole).filter(
    (el) =>
      !isBridgeOwnElement(el) &&
      isVisible(el) &&
      (!wantRole || elementRole(el) === wantRole),
  )

  // Prefer an exact accessible-name match; fall back to a contains match.
  //
  // COLLECT rather than take-first-and-break. Breaking on the first exact
  // match meant a page with two "Save" buttons — or any repeated row action —
  // resolved to whichever came first in DOM order and reported `found: true`.
  // Replay then clicked an element the plan never named, confidently.
  //
  // Ambiguity loses, which is this codebase's standing rule elsewhere:
  // ambiguous selectors refuse the edit rather than risk the wrong target
  // (drift Phase 5), and a semantic-target miss stops a replay run with
  // `needsHeal`. An arbitrary pick is the one outcome that is silently wrong
  // instead of loudly unresolved.
  const exactMatches: Element[] = []
  const partialMatches: Element[] = []
  for (const el of candidates) {
    if (!wantName) {
      // Role-only target → any visible candidate of that role counts, so
      // more than one is just as ambiguous as two same-named buttons.
      exactMatches.push(el)
      if (exactMatches.length > 1) break
      continue
    }
    const name = accessibleName(el).toLowerCase()
    if (!name) continue
    if (name === wantName) {
      exactMatches.push(el)
      if (exactMatches.length > 1) break
      continue
    }
    if (name.includes(wantName)) partialMatches.push(el)
  }

  // An exact match outranks any number of partials — a page with one "Save"
  // and several "Save draft" is NOT ambiguous.
  const tier = exactMatches.length > 0 ? exactMatches : partialMatches
  if (tier.length > 1) return { found: false, reason: "ambiguous" }
  const match = tier[0] ?? null
  if (!match) return { found: false, reason: "not-found" }

  const selector = generateSelector(match)
  if (!selector) return { found: false, reason: "not-found" }
  return {
    found: true,
    selector,
    role: elementRole(match),
    name: accessibleName(match),
  }
}

/**
 * Perform a click / fill / select on the element matching `selector`, reusing
 * the shared click simulation (dom-events) + input-event dispatch. Returns a miss
 * when the selector no longer resolves (the caller re-resolves first, so this
 * is a defensive guard).
 */
export function performInteract(
  input: PerformInteractInput,
): PerformInteractResult {
  let el: Element | null
  try {
    el = document.querySelector(input.selector)
  } catch {
    return { ok: false, error: `invalid selector '${input.selector}'` }
  }
  if (!el || isBridgeOwnElement(el)) {
    return { ok: false, error: "element not found" }
  }
  const htmlEl = el as HTMLElement

  if (input.action === "click") {
    simulateClick(htmlEl)
    return { ok: true }
  }

  // `<select>` — match an option before claiming success. A bare
  // `select.value = "US East"` when the option is `<option value="us-east-1">US
  // East</option>` silently leaves the select unmatched (value → "") yet the
  // old code returned ok:true and replay captured the wrong state (codex P2).
  // Accept either the option's value or its visible label/text.
  if (el.tagName.toLowerCase() === "select") {
    const select = el as HTMLSelectElement
    const want = input.value ?? ""
    const wantTrim = want.trim()
    const wantLc = wantTrim.toLowerCase()
    const options = Array.from(select.options)
    const match =
      options.find((o) => o.value === want) ??
      options.find((o) => o.value.trim() === wantTrim) ??
      options.find((o) => (o.label ?? "").trim().toLowerCase() === wantLc) ??
      options.find((o) => (o.textContent ?? "").trim().toLowerCase() === wantLc)
    if (!match) {
      return {
        ok: false,
        error: `no <option> matches '${want}' (by value or visible label)`,
      }
    }
    setNativeValue(select, match.value)
    htmlEl.focus()
    el.dispatchEvent(new Event("input", { bubbles: true }))
    el.dispatchEvent(new Event("change", { bubbles: true }))
    return { ok: true }
  }

  // `select` only works against a native <select> (handled above). A custom
  // combobox (e.g. <div role="combobox">) needs click-to-open + click-option —
  // assigning `.value` to it is a no-op, so don't report false success (codex).
  const tag = el.tagName.toLowerCase()
  if (input.action === "select") {
    return {
      ok: false,
      error: `select requires a native <select>; '${tag}' is a custom control — open it with a click, then click the option`,
    }
  }

  // fill — only fill-capable native controls. Setting `.value` on anything
  // else (a <div>, a custom widget) silently does nothing, so reject rather
  // than claim success replay would trust (codex).
  if (tag !== "input" && tag !== "textarea") {
    return {
      ok: false,
      error: `fill requires an <input>/<textarea>; got '${tag}'`,
    }
  }
  // Use the native prototype setters (see setNativeValue) so React-controlled
  // inputs register the change and fire onChange — a plain `el.value =` updates
  // React's value-tracker first, so the dispatched event is swallowed and the
  // app reverts on the next render while we'd still report ok.
  const inputEl = el as HTMLInputElement
  if (inputEl.type === "checkbox" || inputEl.type === "radio") {
    setNativeChecked(inputEl, input.value === "true")
  } else {
    setNativeValue(inputEl, input.value ?? "")
  }
  htmlEl.focus()
  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
  return { ok: true }
}

/**
 * Set a control's `value` via its NATIVE prototype setter so React's
 * value-tracker (which patches the instance's own `value`) sees the change and
 * lets the subsequent `input`/`change` event fire `onChange`. Assigning
 * `el.value = …` directly updates the tracker first, so React can treat the
 * event as a no-op and revert on the next render — the fill silently fails.
 * Falls back to a direct assignment if no prototype setter exists.
 */
function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const proto = Object.getPrototypeOf(el) as object | null
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, "value") : undefined
  if (desc?.set) desc.set.call(el, value)
  else (el as { value: string }).value = value
}

/** `checked` analog of {@link setNativeValue} for checkbox/radio inputs. */
function setNativeChecked(el: HTMLInputElement, checked: boolean): void {
  const proto = Object.getPrototypeOf(el) as object | null
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, "checked") : undefined
  if (desc?.set) desc.set.call(el, checked)
  else el.checked = checked
}
