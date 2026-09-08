import { describe, expect, it } from 'vitest'
import { findExportedArrayLiteral, findImportBinding, importsRelativeFile } from './import-binding'

describe('findImportBinding', () => {
  it('finds a plain named import', () => {
    const src = `import { METRICS } from "./data"\n`
    expect(findImportBinding(src, 'METRICS')).toEqual({
      specifier: './data',
      importedName: 'METRICS',
      via: 'import',
    })
  })

  it('resolves `import { A as B }` to importedName A when asked for B', () => {
    const src = `import { rows as B } from "./data"\n`
    expect(findImportBinding(src, 'B')).toEqual({
      specifier: './data',
      importedName: 'rows',
      via: 'import',
    })
  })

  it('resolves `export { A as B } from "./x"` via re-export', () => {
    const src = `export { rows as B } from "./x"\n`
    expect(findImportBinding(src, 'B')).toEqual({
      specifier: './x',
      importedName: 'rows',
      via: 're-export',
    })
  })

  it('returns null for a type-only `import type { X }`', () => {
    const src = `import type { X } from "./x"\n`
    expect(findImportBinding(src, 'X')).toBeNull()
  })

  it('returns null for an inline type specifier `import { type X }`', () => {
    const src = `import { type X } from "./x"\n`
    expect(findImportBinding(src, 'X')).toBeNull()
  })

  it('returns null for a bare (non-relative) specifier', () => {
    const src = `import { useState } from "react"\n`
    expect(findImportBinding(src, 'useState')).toBeNull()
  })

  it('returns null for a default import', () => {
    const src = `import Foo from "./foo"\n`
    expect(findImportBinding(src, 'Foo')).toBeNull()
  })

  it('returns null for a namespace import', () => {
    const src = `import * as Foo from "./foo"\n`
    expect(findImportBinding(src, 'Foo')).toBeNull()
  })

  it('returns null for a name that is not bound at all', () => {
    const src = `import { A } from "./x"\n`
    expect(findImportBinding(src, 'DoesNotExist')).toBeNull()
  })

  it('works on TSX source that also contains JSX', () => {
    const src = `import { rows } from "./rows"
export const L = () => <ul>{rows.map((r) => <li key={r.id}>{r.id}</li>)}</ul>
`
    expect(findImportBinding(src, 'rows')).toEqual({
      specifier: './rows',
      importedName: 'rows',
      via: 'import',
    })
  })

  it("works on a Vue <script> block's plain-TS content (no surrounding tags)", () => {
    // `findImportBinding` is handed the CONTENT of the script block, not the
    // SFC itself — plain ES module text, no `<script setup>` wrapper.
    const src = `import { rows } from "./rows"
const total = rows.length
`
    expect(findImportBinding(src, 'rows')).toEqual({
      specifier: './rows',
      importedName: 'rows',
      via: 'import',
    })
  })
})

describe('findExportedArrayLiteral', () => {
  it('finds `export const X = [ … ]` and reports the `[` at 1-based line/column plus entry count', () => {
    const src = `export const X = [a, b, c]\n`
    // "export const X = " is 17 characters (0-based indices 0..16), so the
    // `[` sits at 0-based index 17 — 1-based column 18.
    expect(findExportedArrayLiteral(src, 'X')).toEqual({
      arrayLocation: { line: 1, column: 18 },
      entryCount: 3,
    })
  })

  it('finds `export let X = [ … ]`', () => {
    const src = `export let X = [a, b]\n`
    const result = findExportedArrayLiteral(src, 'X')
    expect(result).not.toBeNull()
    expect(result?.entryCount).toBe(2)
    expect(result?.arrayLocation.line).toBe(1)
  })

  it('returns null for a non-exported const later re-exported via `export { X }`', () => {
    const src = `const X = []
export { X }
`
    expect(findExportedArrayLiteral(src, 'X')).toBeNull()
  })

  it('returns null for `export default [ … ]` (not a named export)', () => {
    const src = `export default [1, 2, 3]\n`
    expect(findExportedArrayLiteral(src, 'X')).toBeNull()
  })

  it('returns null for `export const X = [ … ] as const` (as-const is out of scope for the deterministic hop)', () => {
    const src = `export const X = [1, 2, 3] as const\n`
    expect(findExportedArrayLiteral(src, 'X')).toBeNull()
  })

  it('returns null for a name that is not exported at all', () => {
    const src = `export const X = [1]\n`
    expect(findExportedArrayLiteral(src, 'Y')).toBeNull()
  })

  it('returns null when the same name is exported twice (ambiguous, refuse rather than guess)', () => {
    const src = `export const X = [1]
export const X = [2, 3]
`
    expect(findExportedArrayLiteral(src, 'X')).toBeNull()
  })
})

describe('importsRelativeFile', () => {
  it('matches an extensionless import against the .tsx file it names', () => {
    expect(importsRelativeFile('import { Row } from "../components/Row"', 'src/pages/Home.tsx', 'src/components/Row.tsx')).toBe(true)
  })
  it('matches a .vue import from a script block', () => {
    expect(importsRelativeFile('import Row from "./Row.vue"', 'src/Page.vue', 'src/Row.vue')).toBe(true)
  })
  it('treats a directory import as its index file', () => {
    expect(importsRelativeFile('import { Row } from "./row"', 'src/Page.tsx', 'src/row/index.tsx')).toBe(true)
  })
  it('does not match an unrelated file, a bare specifier, or a same-named file elsewhere', () => {
    expect(importsRelativeFile('import { x } from "./other"', 'src/Page.tsx', 'src/Row.tsx')).toBe(false)
    expect(importsRelativeFile('import { Row } from "row"', 'src/Page.tsx', 'src/Row.tsx')).toBe(false)
    expect(importsRelativeFile('import { Row } from "./Row"', 'src/pages/Page.tsx', 'src/Row.tsx')).toBe(false)
  })
})
