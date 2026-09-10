/**
 * Pure Tailwind-class helpers for the alignment & sizing inspector control
 * (direct-manipulation Phase 1 — see tasks/editor-direct-manipulation.md).
 *
 * Same shape as the spacing/border/typography parsers in tailwind-classes.ts:
 * parse a group out of the class list (LAST match wins, ALL matches collected
 * so a set removes every stale duplicate), and `set*` returns a ClassMutation
 * the existing `applyClassMutation` applies. No new applicator/transport — the
 * section commits through the same `onClassesChange(next)` path the other
 * style sections use.
 *
 * v1 maps the common 3×3 alignment grid + a few width presets. Values the grid
 * can't represent (`justify-between`, `items-stretch`, fractional widths, …)
 * are still REMOVED on a set (so the control never leaves a stale conflicting
 * class) but display as `null` — the Classes input remains the escape hatch,
 * exactly like SpacingSection's per-side overrides.
 */

import { applyClassMutation, type ClassMutation } from "@/editor/tailwind/tailwind-classes"

export type JustifyValue = "start" | "center" | "end"
export type AlignValue = "start" | "center" | "end"
export type TextAlignValue = "left" | "center" | "right"
export type WidthPreset = "full" | "auto" | "half" | "fit"

// Full removal sets — every Tailwind utility in each group, so a set wipes any
// existing value (incl. ones the v1 control can't display) before adding the
// new one. Kept broader than the settable values on purpose.
const JUSTIFY_ALL = [
  "justify-start", "justify-center", "justify-end",
  "justify-between", "justify-around", "justify-evenly",
  "justify-normal", "justify-stretch",
]
const ITEMS_ALL = [
  "items-start", "items-center", "items-end", "items-stretch", "items-baseline",
]
const TEXT_ALIGN_ALL = [
  "text-left", "text-center", "text-right", "text-justify",
  "text-start", "text-end",
]

/** Settable (v1) → its Tailwind class. */
const JUSTIFY_CLASS: Record<JustifyValue, string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
}
const ITEMS_CLASS: Record<AlignValue, string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
}
const TEXT_ALIGN_CLASS: Record<TextAlignValue, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
}
const WIDTH_CLASS: Record<WidthPreset, string> = {
  full: "w-full",
  auto: "w-auto",
  half: "w-1/2",
  fit: "w-fit",
}

/** Reverse map for parse (class → settable value), null when not representable. */
function justifyOf(cls: string): JustifyValue | null {
  if (cls === "justify-start") return "start"
  if (cls === "justify-center") return "center"
  if (cls === "justify-end") return "end"
  return null
}
function alignOf(cls: string): AlignValue | null {
  if (cls === "items-start") return "start"
  if (cls === "items-center") return "center"
  if (cls === "items-end") return "end"
  return null
}
function textAlignOf(cls: string): TextAlignValue | null {
  if (cls === "text-left" || cls === "text-start") return "left"
  if (cls === "text-center") return "center"
  if (cls === "text-right" || cls === "text-end") return "right"
  return null
}
function widthOf(cls: string): WidthPreset | null {
  if (cls === "w-full") return "full"
  if (cls === "w-auto") return "auto"
  if (cls === "w-1/2") return "half"
  if (cls === "w-fit") return "fit"
  return null
}

export interface ParsedGroup<V> {
  /** The v1-settable value of the LAST matching class, or null. */
  value: V | null
  /** Every class in the list matching this group (removed on a set). */
  raws: string[]
  /**
   * True when a matching class exists but isn't representable by the v1
   * control (e.g. `justify-between`). The control shows "—" but a set still
   * clears it. Mirrors SpacingSection's `mixed`.
   */
  unrepresentable: boolean
}

function parseGroup<V>(
  classes: readonly string[],
  members: readonly string[],
  toValue: (cls: string) => V | null,
): ParsedGroup<V> {
  const raws = classes.filter((c) => members.includes(c))
  // The LAST matching utility wins (matches SpacingSection's convention +
  // the common Tailwind authoring order). Keying off the last raw — not the
  // last *representable* one — means `justify-start justify-between` shows as
  // "custom" (no active cell) rather than falsely highlighting `start` and
  // silently clobbering the `between` the user couldn't see (codex).
  const last = raws.length > 0 ? raws[raws.length - 1] : null
  const value = last !== null ? toValue(last) : null
  const unrepresentable = last !== null && value === null
  return { value, raws, unrepresentable }
}

/** Width is prefix-matched (`w-*`) rather than an enum — captures fixed/
 *  fractional widths for removal while only the presets are settable. Excludes
 *  `min-w-*` / `max-w-*` (different prefixes) by construction. */
function parseWidthGroup(classes: readonly string[]): ParsedGroup<WidthPreset> {
  const raws = classes.filter((c) => /^w-/.test(c))
  const last = raws.length > 0 ? raws[raws.length - 1] : null
  const value = last !== null ? widthOf(last) : null
  const unrepresentable = last !== null && value === null
  return { value, raws, unrepresentable }
}

export function parseJustify(classes: readonly string[]): ParsedGroup<JustifyValue> {
  return parseGroup(classes, JUSTIFY_ALL, justifyOf)
}
export function parseAlignItems(classes: readonly string[]): ParsedGroup<AlignValue> {
  return parseGroup(classes, ITEMS_ALL, alignOf)
}
export function parseTextAlign(classes: readonly string[]): ParsedGroup<TextAlignValue> {
  return parseGroup(classes, TEXT_ALIGN_ALL, textAlignOf)
}
export function parseWidth(classes: readonly string[]): ParsedGroup<WidthPreset> {
  return parseWidthGroup(classes)
}

/** Build the remove/add mutation for one group. `value === null` clears it. */
function setGroup(
  raws: string[],
  add: string | null,
): ClassMutation {
  return { remove: raws, add: add ? [add] : [] }
}

export function setJustify(
  parsed: ParsedGroup<JustifyValue>,
  value: JustifyValue | null,
): ClassMutation {
  return setGroup(parsed.raws, value ? JUSTIFY_CLASS[value] : null)
}
export function setAlignItems(
  parsed: ParsedGroup<AlignValue>,
  value: AlignValue | null,
): ClassMutation {
  return setGroup(parsed.raws, value ? ITEMS_CLASS[value] : null)
}
export function setTextAlign(
  parsed: ParsedGroup<TextAlignValue>,
  value: TextAlignValue | null,
): ClassMutation {
  return setGroup(parsed.raws, value ? TEXT_ALIGN_CLASS[value] : null)
}
export function setWidth(
  parsed: ParsedGroup<WidthPreset>,
  value: WidthPreset | null,
): ClassMutation {
  return setGroup(parsed.raws, value ? WIDTH_CLASS[value] : null)
}

/** Re-export so callers compose set* with the shared applicator. */
export { applyClassMutation }

/**
 * Which screen axis each CSS property controls.
 *
 * `justify-content` runs along the MAIN axis and `align-items` along the
 * CROSS axis. Which of those is horizontal is `flex-direction`'s business: a
 * row puts main across and cross down, a column swaps them. The `-reverse`
 * directions keep the axis and mirror it, and `flex-wrap: wrap-reverse`
 * mirrors the cross axis the same way.
 *
 * The 3×3 grid draws SCREEN positions, so it has to translate. Until
 * 2026-09-08 it did not: it assumed a row, so on a `flex-col` container the
 * top-right cell wrote `justify-end items-start`, which lays the children out
 * BOTTOM-LEFT. The highlight read the same assumption back, so the control
 * was self-consistent and wrong, which is why it survived.
 */
export interface FlexAxes {
  /** True when `justify-content` runs vertically (a column container). */
  column: boolean
  /** True when the main axis runs right-to-left or bottom-to-top. */
  mainReversed: boolean
  /** True when the cross axis is mirrored (`flex-wrap: wrap-reverse`). */
  crossReversed: boolean
}

/** Read the axes off the bridge's computed styles. Absent or unknown = row. */
export function parseFlexAxes(
  computedStyles: Record<string, string> | undefined,
): FlexAxes {
  const dir = computedStyles?.["flex-direction"]?.trim() ?? "row"
  const column = dir === "column" || dir === "column-reverse"
  const mainReversed = dir === "row-reverse" || dir === "column-reverse"
  const crossReversed = computedStyles?.["flex-wrap"]?.trim() === "wrap-reverse"
  return { column, mainReversed, crossReversed }
}

/** start <-> end; center is its own mirror. */
function mirror<T extends "start" | "center" | "end">(v: T): T {
  return (v === "start" ? "end" : v === "end" ? "start" : "center") as T
}

/**
 * A grid cell (a screen position) to the two CSS values that produce it.
 *
 * `col` is the screen column, left to right. `row` is the screen row, top to
 * bottom. The horizontal one drives the main axis in a row container and the
 * cross axis in a column container.
 */
export function cellToAxes(
  col: JustifyValue,
  row: AlignValue,
  axes: FlexAxes,
): { justify: JustifyValue; align: AlignValue } {
  const horizontal = col
  const vertical = row
  const main = axes.column ? vertical : horizontal
  const cross = axes.column ? horizontal : vertical
  return {
    justify: axes.mainReversed ? mirror(main) : main,
    align: axes.crossReversed ? mirror(cross) : cross,
  }
}

/**
 * The inverse: which cell a stored pair lights. `null` for either value (an
 * unset or unrepresentable axis) lights nothing.
 */
export function axesToCell(
  justify: JustifyValue | null,
  align: AlignValue | null,
  axes: FlexAxes,
): { col: JustifyValue; row: AlignValue } | null {
  if (justify === null || align === null) return null
  const main = axes.mainReversed ? mirror(justify) : justify
  const cross = axes.crossReversed ? mirror(align) : align
  return axes.column
    ? { col: cross, row: main }
    : { col: main, row: cross }
}

/**
 * Whether the element is a flex/grid CONTAINER — i.e. whether the
 * justify/align (3×3 box) control applies. Reads the live computed `display`
 * (the bridge collects it in the style allowlist). Inline/block/text elements
 * return false and the section shows only text-align + width.
 *
 * KNOWN GAP, grid containers. This returns true for `grid`/`inline-grid`, but
 * the two properties mean something different there: `justify-content` places
 * the TRACKS inside the container while `align-items` places each item inside
 * its own row. So the grid's cells are only loosely right for a CSS grid, and
 * `parseFlexAxes` reports `row` for one because `flex-direction` does not
 * apply. That is the behaviour this control has always had; the 2026-09-08
 * direction fix deliberately did not change it, because the honest options
 * are a different control or no control, and neither is a one-line call.
 */
export function isFlexLikeContainer(
  computedStyles: Record<string, string> | undefined,
): boolean {
  const display = computedStyles?.["display"]
  if (!display) return false
  return /\b(flex|inline-flex|grid|inline-grid)\b/.test(display)
}
