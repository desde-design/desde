import type { StyleProperty } from "@/types/bridge"

/**
 * Collapse the Inspector's repeated per-side longhands into one row each.
 *
 * The bridge sends computed styles as longhands: four `border-*-width`, four
 * `border-*-style`, four `border-*-color`, four radius corners, four margins,
 * four paddings. On a typical element they are IDENTICAL, so the Border
 * section alone printed seventeen rows to say four things (Mo, 2026-09-01:
 * "there is a lot of repetition ... I would expect it to be more summarized").
 *
 * The rule is deliberately the narrowest one that fixes it: collapse a family
 * only when every side shows the SAME value, and otherwise leave the
 * longhands exactly as they were. A collapsed row is always a real CSS
 * property name, so nothing on screen is a notation the reader has to decode
 * or would be wrong to paste.
 *
 * Presentation only. This runs in the shell, over data the panel already
 * holds, so there is no bridge change and no bundle rebuild. The Editor is
 * unaffected: it flattens `StyleCategory[]` into a map and never renders
 * these sections.
 */
export interface SummarizedStyleProperty extends StyleProperty {
  /**
   * The longhand names this row stands for, when it is a collapsed one.
   *
   * The panel's filter matches on `name`. Without this, collapsing the four
   * `border-*-width` rows away would mean typing "border-top" finds nothing
   * in a panel that used to find it — a silent capability loss, which is the
   * kind of regression a summarizer is most likely to ship. The filter
   * matches these too.
   */
  members?: string[]
}

/** Longhand families that collapse to a single shorthand row. */
const FAMILIES: { shorthand: string; sides: string[] }[] = [
  { shorthand: "border-width", sides: ["border-top-width", "border-right-width", "border-bottom-width", "border-left-width"] },
  { shorthand: "border-style", sides: ["border-top-style", "border-right-style", "border-bottom-style", "border-left-style"] },
  { shorthand: "border-color", sides: ["border-top-color", "border-right-color", "border-bottom-color", "border-left-color"] },
  { shorthand: "border-radius", sides: ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"] },
  { shorthand: "margin", sides: ["margin-top", "margin-right", "margin-bottom", "margin-left"] },
  { shorthand: "padding", sides: ["padding-top", "padding-right", "padding-bottom", "padding-left"] },
]

/**
 * Properties that describe nothing while their `-style` is `none`.
 *
 * `outline-style: none` means there is no outline, yet the panel still
 * printed `outline-width: 3px`, `outline-color` and `outline-offset` under
 * it: three rows about something that does not render. `outline-style` has no
 * entry in the bridge's own `DEFAULT_VALUES`, which is why it is not filtered
 * at source the way `transform: none` and `box-shadow: none` already are.
 *
 * Handled here rather than there because fixing it in `style-categories.ts`
 * costs a bridge version bump and a bundle rebuild for a presentation
 * decision, and because the same judgement — "this row is inert given that
 * one" — is what the collapsing above is already doing.
 *
 * The `-style` row itself always survives. It is the row that EXPLAINS the
 * absence, so hiding it would turn a tidy-up into a lie.
 */
const INERT_WHEN_NONE: { styleProp: string; dependents: string[] }[] = [
  { styleProp: "outline-style", dependents: ["outline-width", "outline-color", "outline-offset"] },
  { styleProp: "border-style", dependents: ["border-width", "border-color"] },
]

/**
 * What the row actually SHOWS — `rawValue` when there is one, else the
 * computed value.
 *
 * Comparing the computed value would be wrong. Two sides can share a computed
 * value while their authored values differ, and collapsing on the computed
 * one would claim an equality the reader cannot see on screen.
 */
const shown = (p: StyleProperty): string => p.rawValue ?? p.value

export function summarizeStyleProperties(
  properties: StyleProperty[],
): SummarizedStyleProperty[] {
  const byName = new Map(properties.map((p) => [p.name, p]))
  // Longhands that a collapse consumed, so the second pass can skip them.
  const consumed = new Set<string>()
  // Collapsed rows, keyed by the FIRST member's name so each lands where its
  // family started. Reordering sections between elements would make the panel
  // feel like it was rebuilding itself on every hover.
  const insertAt = new Map<string, SummarizedStyleProperty>()

  for (const { shorthand, sides } of FAMILIES) {
    const rows = sides.map((n) => byName.get(n)).filter((r): r is StyleProperty => !!r)
    if (rows.length !== sides.length) continue
    const first = shown(rows[0])
    if (!rows.every((r) => shown(r) === first)) continue

    for (const n of sides) consumed.add(n)

    // `border-radius` already exists as its own row in the bridge's Border
    // category, alongside the four corners. When it is present the corners
    // are simply dropped; only otherwise is a row synthesised.
    const existing = byName.get(shorthand)
    if (existing) continue

    insertAt.set(sides[0], {
      name: shorthand,
      value: rows[0].value,
      ...(rows[0].rawValue !== undefined ? { rawValue: rows[0].rawValue } : {}),
      members: [...sides],
    })
  }

  const out: SummarizedStyleProperty[] = []
  for (const p of properties) {
    const collapsed = insertAt.get(p.name)
    if (collapsed) out.push(collapsed)
    if (consumed.has(p.name)) continue
    out.push(p)
  }

  // Second pass: drop rows that describe nothing. Runs AFTER collapsing so it
  // can read `border-style` whether that row was collapsed or was already a
  // single longhand.
  const finalByName = new Map(out.map((p) => [p.name, p]))
  const drop = new Set<string>()
  for (const { styleProp, dependents } of INERT_WHEN_NONE) {
    const style = finalByName.get(styleProp)
    if (!style || shown(style).trim() !== "none") continue
    for (const d of dependents) {
      if (finalByName.has(d)) drop.add(d)
      // An uncollapsed family (sides disagree) still has inert longhands.
      const family = FAMILIES.find((f) => f.shorthand === d)
      if (family) for (const side of family.sides) drop.add(side)
    }
  }
  return drop.size === 0 ? out : out.filter((p) => !drop.has(p.name))
}
