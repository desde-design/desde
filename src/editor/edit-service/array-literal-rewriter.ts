/**
 * Pure (filesystem-free) array-literal mutation. Shared by the
 * iteration-data applicators in Phase 3 of
 * `tasks/_archive/one-shot-tasks/iteration-aware-edits.md`.
 *
 * Given a file's source, the (line, column) of an array literal, a
 * matcher describing which element to act on, and an operation, this
 * module returns a new source with the array mutated. The five
 * operations (remove / patch / duplicate / reorder / insert) all live
 * here so applicators are thin wrappers.
 *
 * Strategy: parse the file with `@vue/compiler-sfc`'s re-exported Babel
 * parser, locate the `ArrayExpression` at the requested position, find
 * the matching element node, and rewrite the source by splicing on
 * byte offsets — never regenerate the whole file. This preserves
 * comments, trailing commas, and surrounding formatting in the rest of
 * the file; the rewriter only changes the bytes inside the array.
 *
 * Refuses (returns `{ ok: false }`):
 *  - No array literal found at the requested location.
 *  - Matcher resolves to zero or more than one entry.
 *  - Operation-specific guards (e.g. reorder toIndex out of bounds).
 *  - Parser errors.
 */

import { babelParse } from '@vue/compiler-sfc'
import type { File, Node, ArrayExpression } from '@babel/types'

export interface ArrayLocation {
  /** 1-based line of the start of the array literal. */
  line: number
  /** 1-based column. */
  column: number
}

export type ArrayMatcher =
  | {
      kind: 'object-property'
      property: string
      value: string | number
      /**
       * String-coerce the comparison (`String(a) === String(b)`). Set by the
       * React/JSX iteration path: React exposes `key={item.id}` as a STRING
       * even when the array stores a NumericLiteral. Vue keeps `:key` typed, so
       * it leaves this off and gets strict `===` — preserving the ability to
       * distinguish `{ id: 1 }` from `{ id: "1" }`.
       */
      coerce?: boolean
    }
  | { kind: 'index'; index: number }

export type ArrayOperation =
  | { kind: 'remove' }
  | { kind: 'patch'; updates: Readonly<Record<string, JsonValue>> }
  | { kind: 'duplicate'; afterMatch?: boolean }
  | { kind: 'reorder'; toIndex: number }
  | {
      kind: 'insert'
      entry: JsonValue
      position: 'before' | 'after'
    }

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface RewriteInput {
  /** Full source text of the file. */
  source: string
  /** Position of the `[` token (or the array-returning expression's start). */
  location: ArrayLocation
  /** Which entry to operate on. */
  matcher: ArrayMatcher
  /** What to do. */
  operation: ArrayOperation
  /**
   * File extension hint — controls the Babel parser plugins enabled.
   * `'ts'` / `'tsx'` enables TypeScript parsing; `'js'` / `'jsx'`
   * enables JSX. Vue SFC `<script setup lang="ts">` blocks pass `'ts'`.
   */
  lang?: 'js' | 'jsx' | 'ts' | 'tsx'
  /**
   * When the file IS a Vue SFC and the array literal lives inside
   * `<script setup>`, callers MUST pass the script block's offset within
   * the SFC source so the (line, column) the resolver hands us — which
   * is SFC-absolute when computed from the source-tag plugin OR script-
   * relative when computed inside babelParse — line up correctly. Pass 0
   * for non-SFC files. The implementation just adds `scriptOffset` to
   * Babel's reported positions when comparing against `location`.
   */
  scriptOffset?: { line: number; column: number }
}

export type RewriteResult =
  | { ok: true; source: string }
  | { ok: false; reason: string }

const ARRAY_TYPE = 'ArrayExpression'

interface BabelLoc {
  start: { line: number; column: number }
  end: { line: number; column: number }
}

/**
 * Walk every node in `file` and yield `ArrayExpression`s with their loc.
 * Babel doesn't expose a traverser inside `@vue/compiler-sfc`, so we do
 * a hand-rolled recursive descent. Skipping the deep `@babel/traverse`
 * dependency keeps the bundle size in check.
 */
function findArrayExpressions(file: File): Array<{ node: ArrayExpression; loc: BabelLoc }> {
  const out: Array<{ node: ArrayExpression; loc: BabelLoc }> = []
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { type?: string; loc?: BabelLoc }
    if (n.type === ARRAY_TYPE && n.loc) {
      out.push({ node: node as ArrayExpression, loc: n.loc })
    }
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue
      const v = (n as Record<string, unknown>)[key]
      if (Array.isArray(v)) {
        for (const item of v) visit(item)
      } else if (v && typeof v === 'object') {
        visit(v)
      }
    }
  }
  visit(file)
  return out
}

/** Compare two 1-based positions for equality / closeness. */
function positionEquals(
  a: { line: number; column: number },
  b: { line: number; column: number },
): boolean {
  return a.line === b.line && a.column === b.column
}

/**
 * Match an array literal at `location` (1-based line, column). We accept
 * exact match on `[`'s position, OR an array whose start is the closest
 * non-greater-than position on the same line — handles minor parser
 * discrepancies between `data-desde-src` and Babel's reporting.
 */
function locateArray(
  arrays: Array<{ node: ArrayExpression; loc: BabelLoc }>,
  location: ArrayLocation,
  scriptOffset: { line: number; column: number },
): ArrayExpression | null {
  // `data-desde-src` line numbers are 1-based but Babel returns 1-based
  // line and 0-based column. The caller-supplied location uses the
  // source-tag convention (1-based both), so we normalize Babel's
  // columns by adding 1, then add scriptOffset (which is also 1-based
  // line, 0-based column → +1 too).
  for (const { node, loc } of arrays) {
    const startLine = loc.start.line + scriptOffset.line - 1
    const startCol = loc.start.column + 1 + (loc.start.line === 1 ? scriptOffset.column : 0)
    if (positionEquals({ line: startLine, column: startCol }, location)) {
      return node
    }
  }
  // Fall back: pick the array on the same line, earliest start <= location.column
  let best: ArrayExpression | null = null
  let bestDelta = Infinity
  for (const { node, loc } of arrays) {
    const startLine = loc.start.line + scriptOffset.line - 1
    if (startLine !== location.line) continue
    const startCol = loc.start.column + 1 + (loc.start.line === 1 ? scriptOffset.column : 0)
    if (startCol > location.column) continue
    const delta = location.column - startCol
    if (delta < bestDelta) {
      bestDelta = delta
      best = node
    }
  }
  return best
}

/**
 * Find the array element index whose object literal has property
 * `property` whose value matches `value`. Returns -1 when no match (or
 * multiple matches).
 */
function findByProperty(
  arr: ArrayExpression,
  property: string,
  value: string | number,
  coerce: boolean,
): number {
  let foundIndex = -1
  for (let i = 0; i < arr.elements.length; i++) {
    const el = arr.elements[i]
    if (!el || el.type !== 'ObjectExpression') continue
    for (const prop of el.properties) {
      if (prop.type !== 'ObjectProperty') continue
      const key = prop.key as { type?: string; name?: string; value?: string | number }
      const keyName =
        key.type === 'Identifier'
          ? key.name
          : key.type === 'StringLiteral'
          ? (key.value as string)
          : undefined
      if (keyName !== property) continue
      const valNode = prop.value as { type?: string; value?: string | number }
      const litValue =
        valNode.type === 'StringLiteral' || valNode.type === 'NumericLiteral'
          ? valNode.value
          : undefined
      if (litValue === undefined) continue
      // Strict `===` by default (Vue keeps `:key` typed, so `{id:1}` and
      // `{id:"1"}` stay distinct). The React path opts into String() coercion
      // via `matcher.coerce` because React exposes `key={item.id}` as a STRING
      // ("1") even when the array stores a NumericLiteral (1).
      const isMatch = coerce
        ? String(litValue) === String(value)
        : litValue === value
      if (isMatch) {
        if (foundIndex !== -1) return -1 // ambiguous
        foundIndex = i
        break
      }
    }
  }
  return foundIndex
}

/** Element bounds in the source string — `[start, end)` byte offsets. */
interface ElementBounds {
  start: number
  end: number
}

function elementBounds(
  arr: ArrayExpression,
  index: number,
): ElementBounds | null {
  const el = arr.elements[index] as unknown as Node | null
  if (!el || !('start' in el) || typeof el.start !== 'number') return null
  const end = (el as unknown as { end: number }).end
  if (typeof end !== 'number') return null
  return { start: el.start, end }
}

/**
 * Best-effort serializer for the JSON-shaped payload used in `patch`
 * and `insert`. Outputs JS-source-compatible literals (no surprises
 * like Python `None`). We deliberately don't use `JSON.stringify`
 * directly for object KEYS — keys go unquoted when they're valid JS
 * identifiers, mirroring the in-code style.
 */
function serializeValue(v: JsonValue, indent: string = '  '): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    return `[${v.map((x) => serializeValue(x, indent + '  ')).join(', ')}]`
  }
  const entries = Object.entries(v)
  if (entries.length === 0) return '{}'
  const inner = entries
    .map(([k, val]) => `${formatKey(k)}: ${serializeValue(val, indent + '  ')}`)
    .join(', ')
  return `{ ${inner} }`
}

function formatKey(k: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k)
}

/**
 * Re-parse the WHOLE FILE. Only `reorder` needs it (it removes, then has to
 * recover offsets before re-inserting), and it is passed in rather than
 * re-derived so it cannot be configured differently from the parse that got us
 * here.
 *
 * That divergence was a real defect, live until 2026-08-11: the reorder branch
 * called `babelParse(removed.source, { sourceType: 'module' })` with no
 * plugins, on the reasoning that "the reorder path runs on already-validated
 * source". The source IS valid — but the parse re-reads the whole file, not the
 * array, so ANY TypeScript or JSX syntax elsewhere in it threw and the
 * operation refused. That is every React substrate and every typed
 * `<script setup lang="ts">`, i.e. the common case; measured through the
 * shipped handler against the edit-matrix React fixture. See the `lang` cases
 * in `array-literal-rewriter.test.ts` for the red proof.
 */
type Reparse = (source: string) => File

/**
 * Apply the operation. Mutates the source string by splicing on byte
 * offsets — no whole-file re-generation.
 */
function applyOperation(
  source: string,
  arr: ArrayExpression,
  index: number,
  operation: ArrayOperation,
  reparse: Reparse,
): RewriteResult {
  const bounds = elementBounds(arr, index)
  if (!bounds) {
    return { ok: false, reason: 'Target element bounds unavailable' }
  }
  const elText = source.slice(bounds.start, bounds.end)

  switch (operation.kind) {
    case 'remove': {
      // Remove the entry plus the trailing comma + whitespace, if any.
      // Look forward from `end` for `,` followed by whitespace; if not
      // found (we're the last entry) look backward for the preceding
      // comma + whitespace instead.
      let removeStart = bounds.start
      let removeEnd = bounds.end
      const after = source.slice(bounds.end)
      const trailingMatch = after.match(/^\s*,/)
      if (trailingMatch) {
        removeEnd += trailingMatch[0].length
        // Eat the same amount of trailing whitespace so the next entry
        // doesn't get pulled flush against the prior line.
        const wsAfter = source.slice(removeEnd).match(/^[ \t]*/)
        if (wsAfter) removeEnd += wsAfter[0].length
      } else {
        // Last entry: eat the preceding `,` + whitespace so we don't
        // leave a dangling comma after the prior entry.
        const before = source.slice(0, bounds.start)
        const leadingMatch = before.match(/,\s*$/)
        if (leadingMatch) removeStart -= leadingMatch[0].length
      }
      // Also eat the immediately-preceding indentation on the line so
      // the result doesn't leave a blank-indented line behind.
      const lineStart = source.lastIndexOf('\n', removeStart - 1) + 1
      const between = source.slice(lineStart, removeStart)
      if (/^[ \t]*$/.test(between)) {
        removeStart = lineStart
        const eatNewline = source[removeEnd] === '\n' ? 1 : 0
        removeEnd += eatNewline
      }
      const next = source.slice(0, removeStart) + source.slice(removeEnd)
      return { ok: true, source: next }
    }

    case 'patch': {
      // Patch only ObjectExpression entries. Replace existing keys or
      // append new ones; preserve formatting style of existing props.
      //
      // Codex P2 #6: multi-field patches must avoid stale offsets. The
      // AST offsets are tied to `source`, but each replacement mutates
      // `newElText` — applying replacements in original order shifts
      // later byte positions and corrupts the literal when an earlier
      // value-string is longer/shorter than the original. We sort
      // existing-property replacements by descending start offset so
      // each splice happens at an offset still valid in the working
      // text, then handle appends (which target the closing `}`) at
      // the end.
      const el = arr.elements[index]
      if (!el || el.type !== 'ObjectExpression') {
        return {
          ok: false,
          reason: 'Cannot patch a non-object array entry',
        }
      }
      type PropertyNode = {
        type: string
        key: { type?: string; name?: string; value?: string | number }
        start: number
        end: number
      }
      type Replacement = { start: number; end: number; text: string }
      type Append = { text: string }
      const replacements: Replacement[] = []
      const appends: Append[] = []
      for (const [key, value] of Object.entries(operation.updates)) {
        const valueStr = serializeValue(value)
        const existing = el.properties.find((p) => {
          if (p.type !== 'ObjectProperty') return false
          const k = (p as unknown as PropertyNode).key
          const name =
            k.type === 'Identifier'
              ? k.name
              : k.type === 'StringLiteral'
              ? (k.value as string)
              : undefined
          return name === key
        }) as unknown as PropertyNode | undefined
        if (existing && typeof existing.start === 'number' && typeof existing.end === 'number') {
          replacements.push({
            start: existing.start - bounds.start,
            end: existing.end - bounds.start,
            text: `${formatKey(key)}: ${valueStr}`,
          })
        } else {
          appends.push({ text: `${formatKey(key)}: ${valueStr}` })
        }
      }
      // Apply replacements in descending-start order so earlier offsets
      // stay valid after later (rightmost) splices.
      replacements.sort((a, b) => b.start - a.start)
      let newElText = elText
      for (const r of replacements) {
        newElText = newElText.slice(0, r.start) + r.text + newElText.slice(r.end)
      }
      for (const a of appends) {
        const closingIdx = newElText.lastIndexOf('}')
        if (closingIdx < 0) {
          return { ok: false, reason: 'Object literal closing brace not found' }
        }
        const before = newElText.slice(0, closingIdx).trimEnd()
        const needsComma = !before.endsWith(',') && !before.endsWith('{')
        newElText =
          (needsComma ? `${before}, ` : `${before} `) +
          `${a.text} ` +
          newElText.slice(closingIdx)
      }
      const next =
        source.slice(0, bounds.start) + newElText + source.slice(bounds.end)
      return { ok: true, source: next }
    }

    case 'duplicate': {
      // Insert a copy of the matched element. Codex P2 #7: when
      // duplicating a non-last entry we must terminate the inserted
      // copy with a comma so the array stays well-formed. The previous
      // version skipped the original entry's existing comma but didn't
      // re-add one after the copy, producing `{a},\n{a}\n{b}` (invalid).
      const inserted = elText
      const after = source.slice(bounds.end)
      const trailingComma = after.match(/^\s*,/)
      if (operation.afterMatch === false) {
        // Insert BEFORE the matched entry — always terminate with comma.
        const next =
          source.slice(0, bounds.start) +
          `${inserted},\n  ` +
          source.slice(bounds.start)
        return { ok: true, source: next }
      }
      // Insert AFTER: place right after the original entry's existing
      // comma (if any) and terminate the copy with a comma when more
      // entries follow.
      let insertAt = bounds.end
      let insertText: string
      const lineStart = source.lastIndexOf('\n', bounds.start - 1) + 1
      const indent = source.slice(lineStart, bounds.start).match(/^[ \t]*/)?.[0] ?? '  '
      if (trailingComma) {
        insertAt = bounds.end + trailingComma[0].length
        // Original had a comma → more entries follow OR it's the last
        // with a trailing comma. Either way, terminate the copy with
        // a comma so we don't break the subsequent entry.
        insertText = `\n${indent}${inserted},`
      } else {
        // No trailing comma — original was the last entry, no following
        // entries. Insert with a leading comma; no trailing one needed.
        insertText = `,\n${indent}${inserted}`
      }
      const next =
        source.slice(0, insertAt) + insertText + source.slice(insertAt)
      return { ok: true, source: next }
    }

    case 'reorder': {
      const total = arr.elements.length
      const target = Math.max(0, Math.min(operation.toIndex, total - 1))
      if (target === index) return { ok: true, source } // no-op
      // Remove the element from its current position, then re-insert at
      // the target index. The remove step uses the same logic as
      // `remove`; insert mirrors `duplicate` but with adjusted bounds
      // for the new index.
      // For brevity in v1 — chain two operations.
      const removed = applyOperation(source, arr, index, { kind: 'remove' }, reparse)
      if (!removed.ok) return removed
      // Re-parse the file after removal to refresh offsets. (Cheap — small
      // files.) `reparse` is the SAME parser configuration that produced `arr`;
      // see the note on `Reparse` for what happened when it was not.
      let reparsedFile: File
      try {
        reparsedFile = reparse(removed.source)
      } catch (err) {
        return {
          ok: false,
          reason: `Reorder reparse failed: ${(err as Error).message}`,
        }
      }
      // Re-locate the SAME array in the reparsed file, by the BYTE OFFSET of
      // its `[`.
      //
      // That offset is invariant across the remove step, and provably so: every
      // byte `remove` deletes lies between the array's `[` and its `]`, so
      // nothing before the `[` can move. Two array literals cannot share a `[`,
      // so the match is exact and unique — no tolerance, no ordering, nothing
      // to tune.
      //
      // Until 2026-08-12 this picked "the FIRST array whose start line is
      // within ±5 lines of the original", described in the code it replaces as
      // a "V1 simplification … fine for the motivating examples". It was not
      // fine. Any array literal declared within five lines ABOVE the iterated
      // one wins that search, and the moved entry is then spliced into THAT
      // array — the row leaves the list it belonged to, joins an unrelated one,
      // the file still parses, and the endpoint returns `ok: true`.
      //
      // The triggering shape is ordinary, not exotic: a chip/filter/column list
      // declared above a row list is the common way to write these files.
      // MEASURED through `POST /api/editor/edit-iteration` on two hosts and
      // both languages — `vite` + Vue `<script setup lang="ts">` and
      // `react-router` + `.tsx` — where the containment assertion caught the
      // write landing in `const chips = [...]` two lines above the target. See
      // the `decoy` cases in `array-literal-rewriter.test.ts`.
      const originalStart = (arr as unknown as { start?: number }).start
      if (typeof originalStart !== 'number') {
        // Babel always sets `start`; a node without one cannot be matched
        // exactly, and guessing is what this replaced.
        return {
          ok: false,
          reason: 'Reorder needs the array literal offset and the parser did not provide one',
        }
      }
      const arrs2 = findArrayExpressions(reparsedFile)
      let nextArr: ArrayExpression | null = null
      for (const { node } of arrs2) {
        if ((node as unknown as { start?: number }).start === originalStart) {
          nextArr = node
          break
        }
      }
      if (!nextArr) {
        return { ok: false, reason: 'Could not re-locate array after remove step' }
      }
      // Insert the previously-removed element text at `target`.
      const insertBounds =
        target >= nextArr.elements.length
          ? elementBounds(nextArr, nextArr.elements.length - 1)
          : elementBounds(nextArr, target)
      if (!insertBounds) {
        return {
          ok: false,
          reason: 'Could not bound destination element for reorder',
        }
      }
      const lineStart =
        removed.source.lastIndexOf('\n', insertBounds.start - 1) + 1
      const indent =
        removed.source.slice(lineStart, insertBounds.start).match(/^[ \t]*/)?.[0] ??
        '  '
      let insertAt: number
      let insertText: string
      if (target >= nextArr.elements.length) {
        // Append: place after the last entry + comma.
        const lastEnd = insertBounds.end
        const after = removed.source.slice(lastEnd)
        const trailing = after.match(/^\s*,/)
        insertAt = lastEnd + (trailing ? trailing[0].length : 0)
        const prefix = trailing ? '' : ','
        insertText = `${prefix}\n${indent}${elText}`
      } else {
        // Prepend at target: insert before the target element.
        insertAt = insertBounds.start
        insertText = `${elText},\n${indent}`
      }
      const next =
        removed.source.slice(0, insertAt) +
        insertText +
        removed.source.slice(insertAt)
      return { ok: true, source: next }
    }

    case 'insert': {
      const newEntryText = serializeValue(operation.entry)
      const after = source.slice(bounds.end)
      const trailingComma = after.match(/^\s*,/)
      if (operation.position === 'before') {
        const lineStart = source.lastIndexOf('\n', bounds.start - 1) + 1
        const indent = source.slice(lineStart, bounds.start).match(/^[ \t]*/)?.[0] ?? '  '
        const next =
          source.slice(0, bounds.start) +
          `${newEntryText},\n${indent}` +
          source.slice(bounds.start)
        return { ok: true, source: next }
      }
      // 'after'
      let insertAt = bounds.end
      let insertText: string
      if (trailingComma) {
        insertAt = bounds.end + trailingComma[0].length
        const lineStart = source.lastIndexOf('\n', bounds.start - 1) + 1
        const indent = source.slice(lineStart, bounds.start).match(/^[ \t]*/)?.[0] ?? '  '
        insertText = `\n${indent}${newEntryText},`
      } else {
        insertText = `,\n  ${newEntryText}`
      }
      const next =
        source.slice(0, insertAt) + insertText + source.slice(insertAt)
      return { ok: true, source: next }
    }
  }
}

/**
 * Top-level entry point. Parses `source`, locates the array at
 * `location`, finds the matching entry by `matcher`, applies
 * `operation`, returns the rewritten source.
 */
export function rewriteArrayLiteral(input: RewriteInput): RewriteResult {
  const lang = input.lang ?? 'ts'
  // scriptOffset semantics: `line` is the 1-based SFC line where the
  // script block STARTS (== 1 for plain .ts/.js files). `column` is a
  // first-line column offset (== 0 unless the script content begins
  // inline mid-line, which Vue SFCs don't do).
  const scriptOffset = input.scriptOffset ?? { line: 1, column: 0 }
  const plugins: string[] = []
  if (lang === 'ts' || lang === 'tsx') plugins.push('typescript')
  if (lang === 'jsx' || lang === 'tsx') plugins.push('jsx')

  // ONE parser configuration for this call, used by the initial parse and by
  // `reorder`'s post-remove reparse. Two independently-configured call sites is
  // exactly what the defect on `Reparse` describes.
  const parse: Reparse = (source) =>
    babelParse(source, {
      sourceType: 'module',
      // The Babel-core `ParserPlugin` type expects more than `string`,
      // but the runtime accepts plugin-name strings; cast here so we
      // don't need to widen consumers.
      plugins: plugins as unknown as Parameters<typeof babelParse>[1] extends { plugins?: infer P } ? P : never,
      allowReturnOutsideFunction: true,
    }) as unknown as File

  let file: File
  try {
    file = parse(input.source)
  } catch (err) {
    return { ok: false, reason: `Parse failed: ${(err as Error).message}` }
  }

  const arrays = findArrayExpressions(file)
  const arr = locateArray(arrays, input.location, scriptOffset)
  if (!arr) {
    return {
      ok: false,
      reason: `No array literal at ${input.location.line}:${input.location.column}`,
    }
  }

  let index: number
  if (input.matcher.kind === 'object-property') {
    index = findByProperty(
      arr,
      input.matcher.property,
      input.matcher.value,
      input.matcher.coerce === true,
    )
    if (index < 0) {
      return {
        ok: false,
        reason: `No entry where ${input.matcher.property} = ${JSON.stringify(input.matcher.value)} (or matched multiple)`,
      }
    }
  } else {
    index = input.matcher.index
    if (index < 0 || index >= arr.elements.length) {
      return {
        ok: false,
        reason: `Index ${index} out of bounds (array length ${arr.elements.length})`,
      }
    }
  }

  return applyOperation(input.source, arr, index, input.operation, parse)
}
