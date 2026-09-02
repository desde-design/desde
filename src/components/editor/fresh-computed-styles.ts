/**
 * Keep the inspector's structured style sections reading the CURRENT computed
 * value instead of the one captured when the element was selected.
 *
 * The bug this exists for (F8, observed live twice — see
 * `tasks/editor-edit-verification.md` § "The inspector's colour swatch"):
 * `Selection.computedStyles` is produced in exactly one place,
 * `src/editor/adapters/bridge/inspection-conversion.ts`, from an
 * `ELEMENT_INSPECTED` payload. Nothing republishes that message after a style
 * edit — the bridge's `SET_ELEMENT_CLASSES` handler mutates the live DOM and
 * says nothing back, and there is no re-inspection message in the protocol at
 * all — so the snapshot is frozen for the whole lifetime of a selection. The
 * panel's `editNonce` re-fetches STYLE PROVENANCE after an edit but cannot
 * refresh `selection`, so the colour swatch and its token/class label kept
 * rendering the PRE-EDIT colour: `rose-300` on an element already green,
 * `--acme-color-background-neutral-weakest` on a badge already violet,
 * `bg-white` on an input already amber.
 *
 * The fix is to read the value from the thing that IS re-fetched. Provenance is
 * already requested for every property the sections need
 * (`ALL_PROVENANCE_PROPERTIES`), and each `StyleOrigin` carries a fresh
 * `computedValue` for its property — so overlaying those onto the snapshot
 * makes every section (colour, border, typography, shadow) track the live
 * element without a new bridge message or a second round-trip.
 *
 * Framework-neutral and dependency-free on purpose: pure functions over
 * `StyleOrigin`, unit-tested, no React and no hook imports.
 */
import type { StyleOrigin } from "@/types/bridge"

/** The provenance shape both helpers read (`StyleProvenanceMap`, structurally). */
export type StyleOriginsByProperty = Readonly<Record<string, StyleOrigin>>

/**
 * Split a CSS value into its top-level components — whitespace-separated, with
 * whitespace inside parentheses ignored so `rgb(0, 9, 51)` counts as ONE
 * component and `rgb(0, 9, 51) rgb(224, 228, 234)` as two.
 */
function topLevelComponentCount(value: string): number {
  let count = 0
  let depth = 0
  let inComponent = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === "(") depth++
    else if (ch === ")") depth = Math.max(0, depth - 1)
    const isSpace = depth === 0 && (ch === " " || ch === "\t" || ch === "\n")
    if (isSpace) {
      inComponent = false
      continue
    }
    if (!inComponent) {
      inComponent = true
      count++
    }
  }
  return count
}

/**
 * May this freshly-read `computedValue` be written onto the snapshot for
 * `property`?
 *
 * L3, a REGRESSION the first cut of this overlay introduced. Provenance is
 * requested for the SHORTHANDS the style rows edit (`border-color`, `padding`,
 * `margin`, `border-width`, `border-style` — see each section's
 * `*_PROVENANCE_PROPERTIES`), while the `ELEMENT_INSPECTED` snapshot carries only
 * the sided longhands for those groups (`STYLE_CATEGORIES`,
 * `src/bridge/style-categories.ts`). So the overlay was ADDING keys the snapshot
 * never has — and the consuming rows read a shorthand FIRST and only fall back to
 * a longhand when the shorthand key is `undefined` (`inferColor`:
 * `computedStyles["border-color"] ?? computedStyles["border-top-color"]`).
 * Introducing the key therefore switched which branch the row took.
 *
 * On an element whose four border colours differ, Chromium serialises
 * `border-color` as the MULTI-VALUE form — measured, not assumed, in
 * `tasks/scripts/style-provenance-smoke.mts` § "shorthand serialisation" — so the
 * Border → Color row rendered, literally,
 * `rgb(0, 9, 51) rgb(0, 9, 51) rgb(224, 228, 234) (computed)` with a chip in a
 * colour no side has. (The first cut's stated reason for not guarding this —
 * "the CSSOM reports `''` for a shorthand no rule declared" — was wrong: that is
 * true of a RULE's declaration block, which is what the shorthand-vs-longhand
 * verification work measured, and never of `getComputedStyle`, which always
 * resolves.)
 *
 * The guard is by VALUE SHAPE, not by property name — a name blacklist would rot
 * as soon as another shorthand joined the provenance set:
 *
 *  1. A **single** top-level value is always safe. Every row that reads a
 *     property can render that property's canonical single value, and where a
 *     shorthand serialises as one value it equals the longhands it summarises.
 *  2. A **multi-value** serialisation is safe only as a like-for-like refresh of
 *     a key the snapshot ALREADY carries. There the row was already being fed
 *     the engine's own serialisation for that key, so the overlay introduces no
 *     shape the row hasn't already had to handle (`box-shadow`,
 *     `border-radius`). Everywhere else it degrades to the snapshot, which is
 *     the standing rule: briefly stale beats unrenderable.
 */
export function canOverlayComputedValue(
  property: string,
  value: string,
  snapshot: Record<string, string> | undefined,
): boolean {
  if (topLevelComponentCount(value) <= 1) return true
  return snapshot?.[property] !== undefined
}

/**
 * Overlay each origin's freshly-read `computedValue` onto the inspection-time
 * `computedStyles` snapshot, keyed by the property the origin answers for.
 *
 * Returns the snapshot by REFERENCE when there is nothing to overlay, so a
 * `useMemo` downstream keeps its identity and the sections don't re-render on
 * every provenance fetch that changed nothing.
 *
 * Two classes of value are skipped rather than written:
 *  - an EMPTY `computedValue` (a bridge that had no answer) — blanking the key
 *    would strip a value the snapshot legitimately has, and the section's own
 *    sided-property fallback needs it;
 *  - anything {@link canOverlayComputedValue} refuses (L3).
 *
 * Both degrade that one property to the snapshot (the pre-F8 behaviour) instead
 * of making it worse.
 */
export function freshComputedStyles(
  snapshot: Record<string, string> | undefined,
  origins: StyleOriginsByProperty,
): Record<string, string> | undefined {
  let overlay: Record<string, string> | undefined
  for (const [key, origin] of Object.entries(origins)) {
    const value = origin.computedValue
    if (typeof value !== "string" || value.length === 0) continue
    // `origin.property` is authoritative (the walker stamps it); the map key is
    // what the shell asked for. They agree today — prefer the origin's own
    // answer and fall back to the key so a future keying change can't silently
    // write the value under the wrong property.
    const property = origin.property || key
    if (snapshot?.[property] === value) continue
    if (!canOverlayComputedValue(property, value, snapshot)) continue
    overlay ??= {}
    overlay[property] = value
  }
  if (!overlay) return snapshot
  return { ...snapshot, ...overlay }
}
