/**
 * Whitespace primitives shared by the structural Vue-template applicators.
 *
 * Why this is its own module rather than a helper inside one applicator:
 * `editor-cli`'s edit handler types its applicator loaders as
 * `() => Promise<typeof import('…/apply-move-edit')>`, and its tests mock them
 * with object literals. Adding ANY export to `apply-move-edit.ts` /
 * `apply-delete-edit.ts` / `apply-insert-edit.ts` therefore breaks those mocks
 * structurally. The applicator modules' public surface is effectively frozen
 * to their `apply*` function plus types, so shared helpers live beside them.
 *
 * Why shared rather than copied: move and delete had independently "simplified"
 * whitespace handling away, and the SAME defect (a whitespace-only orphan line
 * left at the vacated position) shipped in both. One implementation is the
 * point — the repo already learned this when ~11 copies of the template-target
 * resolver drifted apart (see `resolve-template-target.ts`).
 */

/**
 * Start of the whitespace "gutter" immediately preceding `offset`: the run of
 * horizontal whitespace back to the start of the line, plus that line's
 * terminating newline when `offset` is the first non-whitespace position on
 * its line. Returns `offset` unchanged when the preceding character is not
 * whitespace (adjacent siblings written with no separator).
 *
 * This is the unit of relocation. Removing `[gutterStart, end)` rather than
 * `[start, end)` leaves the neighbours that become adjacent separated by
 * exactly ONE run instead of two, and leaves no whitespace-only orphan line
 * behind. That is not only cosmetic: Vue's default `whitespace: 'condense'`
 * DROPS a newline-bearing run between elements but COLLAPSES a same-line run
 * to a single rendered space — so mishandling the same-line case changes what
 * the page displays.
 *
 * It can never reach back past a `<template>` block's opening tag: the
 * character preceding the block's content is `>`, which stops the backscan.
 */
export function findGutterStart(source: string, offset: number): number {
  let i = offset
  while (i > 0 && (source[i - 1] === ' ' || source[i - 1] === '\t')) i--
  if (i > 0 && source[i - 1] === '\n') {
    i--
    if (i > 0 && source[i - 1] === '\r') i--
  }
  return i
}

/** The gutter text itself — `source.slice(findGutterStart(source, o), o)`. */
export function readGutterBefore(source: string, offset: number): string {
  return source.slice(findGutterStart(source, offset), offset)
}

/**
 * Leading whitespace of the line `offset` sits on. Empty when the line has
 * non-whitespace content before `offset` (i.e. it isn't the line's indent).
 */
export function readLineIndent(source: string, offset: number): string {
  let lineStart = offset
  while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--
  let i = lineStart
  while (i < offset && (source[i] === ' ' || source[i] === '\t')) i++
  return source.slice(lineStart, i)
}
