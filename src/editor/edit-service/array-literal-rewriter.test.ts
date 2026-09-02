/**
 * Tests for the array-literal rewriter — the core mutation primitive
 * for Phase 3 iteration-aware static edits.
 */

import { describe, expect, it } from 'vitest'
import { rewriteArrayLiteral } from './array-literal-rewriter'

/** Find the (line, column) of the first `[` in `source`. 1-based. */
function findArrayStart(source: string): { line: number; column: number } {
  const idx = source.indexOf('[')
  if (idx < 0) throw new Error('no array literal in fixture')
  const before = source.slice(0, idx)
  const newlines = before.split('\n')
  return {
    line: newlines.length,
    column: newlines[newlines.length - 1].length + 1,
  }
}

describe('rewriteArrayLiteral — remove', () => {
  it('removes the matched entry from a flat array of objects', () => {
    const src = `const items = [
  { key: 'id', label: 'ID' },
  { key: 'type', label: 'Type' },
  { key: 'tags', label: 'Tags' },
]`
    const result = rewriteArrayLiteral({
      source: src,
      location: findArrayStart(src),
      matcher: { kind: 'object-property', property: 'key', value: 'type' },
      operation: { kind: 'remove' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain("key: 'id'")
    expect(result.source).toContain("key: 'tags'")
    expect(result.source).not.toContain("key: 'type'")
    // No double comma or trailing-comma corruption
    expect(result.source).not.toMatch(/,\s*,/)
  })

  it('removes the last entry without leaving a dangling comma', () => {
    const src = `const items = [
  { key: 'a' },
  { key: 'b' },
  { key: 'c' },
]`
    const result = rewriteArrayLiteral({
      source: src,
      location: findArrayStart(src),
      matcher: { kind: 'object-property', property: 'key', value: 'c' },
      operation: { kind: 'remove' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).not.toContain("key: 'c'")
    // The remaining entries should still be valid syntax.
    expect(() => new Function(result.source + '\nreturn items')).not.toThrow()
  })

  it('refuses when no entry matches', () => {
    const src = `const items = [{ key: 'a' }]`
    const result = rewriteArrayLiteral({
      source: src,
      location: findArrayStart(src),
      matcher: { kind: 'object-property', property: 'key', value: 'zzz' },
      operation: { kind: 'remove' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/No entry where key/)
  })

  it('removes by positional index', () => {
    const src = `const items = ['a', 'b', 'c']`
    const result = rewriteArrayLiteral({
      source: src,
      location: findArrayStart(src),
      matcher: { kind: 'index', index: 1 },
      operation: { kind: 'remove' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).not.toContain("'b'")
  })
})

describe('rewriteArrayLiteral — patch', () => {
  it('updates an existing property on the matched entry', () => {
    const src = `const items = [
  { key: 'type', label: 'Type', value: 'proxy' },
]`
    const result = rewriteArrayLiteral({
      source: src,
      location: findArrayStart(src),
      matcher: { kind: 'object-property', property: 'key', value: 'type' },
      operation: { kind: 'patch', updates: { value: 'admin' } },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain("value: \"admin\"")
    expect(result.source).not.toContain("value: 'proxy'")
  })

  it('adds a new property when it does not exist', () => {
    const src = `const items = [
  { key: 'type', label: 'Type' },
]`
    const result = rewriteArrayLiteral({
      source: src,
      location: findArrayStart(src),
      matcher: { kind: 'object-property', property: 'key', value: 'type' },
      operation: { kind: 'patch', updates: { value: 'admin' } },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toMatch(/value:\s*"admin"/)
  })

  it('refuses to patch a non-object entry', () => {
    const src = `const items = ['a', 'b']`
    const result = rewriteArrayLiteral({
      source: src,
      location: findArrayStart(src),
      matcher: { kind: 'index', index: 0 },
      operation: { kind: 'patch', updates: { x: 1 } },
    })
    expect(result.ok).toBe(false)
  })
})

describe('rewriteArrayLiteral — duplicate', () => {
  it('inserts a copy of the matched entry after it', () => {
    const src = `const items = [
  { key: 'a', label: 'A' },
  { key: 'b', label: 'B' },
]`
    const result = rewriteArrayLiteral({
      source: src,
      location: findArrayStart(src),
      matcher: { kind: 'object-property', property: 'key', value: 'a' },
      operation: { kind: 'duplicate' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Two copies of "label: 'A'" — original plus duplicate.
    const matches = result.source.match(/label: 'A'/g)
    expect(matches?.length).toBe(2)
  })
})

/**
 * `reorder` is the operation the "move a row" iteration edit dispatches
 * (`useEditorEditing` maps `editKind: "move"` → `{ operation: "reorder" }`), and
 * until 2026-08-11 it had no test at all. It is the only operation that PARSES
 * A SECOND TIME — it removes the entry, then re-parses the whole file to
 * recover offsets before re-inserting — and that second parse was configured
 * independently of the first, with no plugins. So it refused on any file
 * containing TypeScript or JSX syntax ANYWHERE, which is every React substrate
 * and every typed `<script setup lang="ts">`.
 *
 * The `lang` cases below are the red proof: they fail with
 * "Reorder reparse failed: …" against the unfixed rewriter and pass against the
 * fixed one. The plain-JS case passes in both directions, which is why the
 * defect was invisible.
 */
describe('rewriteArrayLiteral — reorder', () => {
  const rows = `const rows = [
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
  { id: 'c', label: 'C' },
]`

  /** Entry ids, in source order, after a rewrite. */
  const orderOf = (source: string): string[] =>
    [...source.matchAll(/id: '([a-z0-9]+)'/g)].map((m) => m[1])

  it('moves the matched entry to the requested index', () => {
    const result = rewriteArrayLiteral({
      source: rows,
      location: findArrayStart(rows),
      matcher: { kind: 'object-property', property: 'id', value: 'a' },
      operation: { kind: 'reorder', toIndex: 1 },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(orderOf(result.source)).toEqual(['b', 'a', 'c'])
  })

  it('reorders inside a file that uses TypeScript syntax elsewhere', () => {
    const src = `const flag: boolean = true\n${rows}`
    const result = rewriteArrayLiteral({
      source: src,
      location: findArrayStart(src),
      matcher: { kind: 'object-property', property: 'id', value: 'a' },
      operation: { kind: 'reorder', toIndex: 1 },
      lang: 'ts',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(orderOf(result.source)).toEqual(['b', 'a', 'c'])
    expect(result.source).toContain('const flag: boolean = true')
  })

  it('reorders inside a file that uses JSX elsewhere', () => {
    const src = `${rows}\nexport const El = () => <p className="x">hi</p>\n`
    const result = rewriteArrayLiteral({
      source: src,
      location: findArrayStart(src),
      matcher: { kind: 'object-property', property: 'id', value: 'a' },
      operation: { kind: 'reorder', toIndex: 1 },
      lang: 'tsx',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(orderOf(result.source)).toEqual(['b', 'a', 'c'])
    expect(result.source).toContain('<p className="x">hi</p>')
  })

  it('appends when the destination index is past the end', () => {
    const result = rewriteArrayLiteral({
      source: rows,
      location: findArrayStart(rows),
      matcher: { kind: 'object-property', property: 'id', value: 'a' },
      operation: { kind: 'reorder', toIndex: 2 },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(orderOf(result.source)).toEqual(['b', 'c', 'a'])
  })

  it('is a no-op when the entry is already at the destination', () => {
    const result = rewriteArrayLiteral({
      source: rows,
      location: findArrayStart(rows),
      matcher: { kind: 'object-property', property: 'id', value: 'a' },
      operation: { kind: 'reorder', toIndex: 0 },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toBe(rows)
  })

  /**
   * The entry that MOVED must survive byte-identically, not merely appear in
   * the right position. `orderOf` above reads ids only, so it passes on a
   * source where the moved entry lost every other property — which is exactly
   * the weaker check this asserts against.
   */
  it('moves the entry VERBATIM, including fields no id check would notice', () => {
    const src = `const columns = [
    {
        id: 'alpha',
        label: 'Alpha column',
        render: (row) => row.alpha ?? '-',
    },
    {
        id: 'beta',
        label: 'Beta column',
        render: (row) => row.beta ?? '-',
    },
]`
    const moved = src.slice(src.indexOf('{', src.indexOf('[')), src.indexOf('},') + 1)
    const result = rewriteArrayLiteral({
      source: src,
      location: findArrayStart(src),
      matcher: { kind: 'object-property', property: 'id', value: 'alpha' },
      operation: { kind: 'reorder', toIndex: 1 },
      lang: 'ts',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(orderOf(result.source)).toEqual(['beta', 'alpha'])
    // The whole entry text, character for character.
    expect(result.source).toContain(moved)
  })
})

/**
 * `reorder` removes the entry and re-parses to recover offsets, so it has to
 * find THE SAME array again in the reparsed file. Until 2026-08-12 it did that
 * by taking the first array literal whose start line was within ±5 lines of the
 * original — so an unrelated array declared just above the target won the
 * search and received the moved entry, while the call returned `ok: true` and
 * the file still parsed.
 *
 * The shape is ordinary. A chip list, a filter list or a column list declared
 * above a row list is how these files are normally written, and it was measured
 * end to end through `POST /api/editor/edit-iteration` on `vite` + Vue and
 * `react-router` + `.tsx` before the offset match replaced the heuristic.
 *
 * These cases FAIL against the ±5-line version and pass against the offset one.
 * The `>5 lines away` case passes against both, which is why the defect could
 * sit behind a green suite.
 */
describe('rewriteArrayLiteral — reorder must not re-locate onto a neighbouring array', () => {
  /** The `[` of the Nth array literal in `source`, 1-based line/column. */
  const nthArrayStart = (source: string, n: number): { line: number; column: number } => {
    let idx = -1
    for (let i = 0; i <= n; i++) idx = source.indexOf('[', idx + 1)
    const lines = source.slice(0, idx).split('\n')
    return { line: lines.length, column: lines[lines.length - 1].length + 1 }
  }

  const withDecoy = (gap: string): string =>
    `const chips = ['recent', 'starred']\n${gap}const rows = [
  { id: 'r1', label: 'First' },
  { id: 'r2', label: 'Second' },
  { id: 'r3', label: 'Third' },
]`

  it('leaves a decoy array TWO lines above untouched', () => {
    const src = withDecoy('')
    const result = rewriteArrayLiteral({
      source: src,
      location: nthArrayStart(src, 1),
      matcher: { kind: 'object-property', property: 'id', value: 'r1' },
      operation: { kind: 'reorder', toIndex: 1 },
      lang: 'ts',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain("const chips = ['recent', 'starred']")
    expect([...result.source.matchAll(/id: '(\w+)'/g)].map((m) => m[1])).toEqual([
      'r2',
      'r1',
      'r3',
    ])
  })

  it('leaves a decoy array on the SAME line untouched', () => {
    const src = `const chips = ['recent']; const rows = [
  { id: 'r1', label: 'First' },
  { id: 'r2', label: 'Second' },
]`
    const result = rewriteArrayLiteral({
      source: src,
      location: nthArrayStart(src, 1),
      matcher: { kind: 'object-property', property: 'id', value: 'r1' },
      operation: { kind: 'reorder', toIndex: 1 },
      lang: 'ts',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain("const chips = ['recent']")
    expect([...result.source.matchAll(/id: '(\w+)'/g)].map((m) => m[1])).toEqual(['r2', 'r1'])
  })

  it('still works when the decoy is far away (the case that always passed)', () => {
    const src = withDecoy('//\n//\n//\n//\n//\n//\n')
    const result = rewriteArrayLiteral({
      source: src,
      location: nthArrayStart(src, 1),
      matcher: { kind: 'object-property', property: 'id', value: 'r1' },
      operation: { kind: 'reorder', toIndex: 1 },
      lang: 'ts',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain("const chips = ['recent', 'starred']")
    expect([...result.source.matchAll(/id: '(\w+)'/g)].map((m) => m[1])).toEqual([
      'r2',
      'r1',
      'r3',
    ])
  })

  it('leaves an array nested INSIDE a sibling entry untouched', () => {
    const src = `const rows = [
  { id: 'r1', tags: ['x', 'y'] },
  { id: 'r2', tags: ['z'] },
  { id: 'r3', tags: [] },
]`
    const result = rewriteArrayLiteral({
      source: src,
      location: findArrayStart(src),
      matcher: { kind: 'object-property', property: 'id', value: 'r1' },
      operation: { kind: 'reorder', toIndex: 2 },
      lang: 'ts',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect([...result.source.matchAll(/id: '(\w+)'/g)].map((m) => m[1])).toEqual([
      'r2',
      'r3',
      'r1',
    ])
    expect(result.source).toContain("{ id: 'r1', tags: ['x', 'y'] }")
    expect(result.source).toContain("{ id: 'r2', tags: ['z'] }")
    expect(result.source).toContain("{ id: 'r3', tags: [] }")
  })
})

describe('rewriteArrayLiteral — insert', () => {
  it('inserts a new entry after the matched one', () => {
    const src = `const items = [
  { key: 'a' },
  { key: 'b' },
]`
    const result = rewriteArrayLiteral({
      source: src,
      location: findArrayStart(src),
      matcher: { kind: 'object-property', property: 'key', value: 'a' },
      operation: {
        kind: 'insert',
        entry: { key: 'a2', label: 'A2' },
        position: 'after',
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain('a2')
    // a should still come before a2, and a2 before b
    const idxA = result.source.indexOf("key: 'a' }")
    const idxA2 = result.source.indexOf('a2')
    const idxB = result.source.indexOf("key: 'b'")
    expect(idxA).toBeLessThan(idxA2)
    expect(idxA2).toBeLessThan(idxB)
  })
})

describe('rewriteArrayLiteral — guardrails', () => {
  it('returns a parse error when the source is malformed', () => {
    const result = rewriteArrayLiteral({
      source: 'const x = [bogus syntax!!@!@',
      location: { line: 1, column: 11 },
      matcher: { kind: 'index', index: 0 },
      operation: { kind: 'remove' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/Parse failed/i)
  })

  it('returns failure when no array literal exists at the location', () => {
    const result = rewriteArrayLiteral({
      source: 'const x = { a: 1 }',
      location: { line: 1, column: 100 },
      matcher: { kind: 'index', index: 0 },
      operation: { kind: 'remove' },
    })
    expect(result.ok).toBe(false)
  })
})

describe('rewriteArrayLiteral — key matching (strict vs coerce)', () => {
  const mixed = `const items = [{ id: 1 }, { id: "1" }]`

  it('strict (default) distinguishes numeric 1 from string "1" — Vue semantics', () => {
    const result = rewriteArrayLiteral({
      source: mixed,
      location: findArrayStart(mixed),
      matcher: { kind: 'object-property', property: 'id', value: 1 },
      operation: { kind: 'remove' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Only the numeric { id: 1 } removed; { id: "1" } kept.
    expect(result.source).toContain('{ id: "1" }')
    expect(result.source).not.toMatch(/\{\s*id:\s*1\s*\}/)
  })

  it('coerce collapses numeric/string — and is ambiguous on a mixed array', () => {
    const result = rewriteArrayLiteral({
      source: mixed,
      location: findArrayStart(mixed),
      matcher: { kind: 'object-property', property: 'id', value: 1, coerce: true },
      operation: { kind: 'remove' },
    })
    // Both entries match "1" → ambiguous → refused. (Real React arrays have
    // consistent id types, so this mixed case doesn't arise in practice.)
    expect(result.ok).toBe(false)
  })

  it('coerce matches a numeric id from a React-stringified key', () => {
    const numeric = `const items = [{ id: 1, n: "A" }, { id: 2, n: "B" }]`
    const result = rewriteArrayLiteral({
      source: numeric,
      location: findArrayStart(numeric),
      matcher: { kind: 'object-property', property: 'id', value: '1', coerce: true },
      operation: { kind: 'remove' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).not.toContain('n: "A"')
    expect(result.source).toContain('n: "B"')
  })
})
