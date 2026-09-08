/**
 * Pure helpers for iteration data that lives in ANOTHER module.
 *
 * Both iteration resolvers (`resolve-iteration-data-vue.ts`,
 * `resolve-iteration-data-jsx.ts`) end with "trace the iteratee's name to an
 * array literal in this file". When that misses, the name is very often bound
 * by an import — `import { METRICS } from "../data"` — and the array literal
 * sits in the imported module. These two functions answer the two halves of
 * that case without touching the filesystem, so the CLI handler can do the
 * file walk (with its path-containment guards) and keep the resolvers pure:
 *
 *   1. `findImportBinding(moduleSource, name)` — is `name` bound by a
 *      relative import (or re-export) in this ES module, and if so from which
 *      specifier and under which exported name?
 *   2. `findExportedArrayLiteral(moduleSource, exportedName)` — where is
 *      `export const <exportedName> = [ … ]` in the imported module?
 *
 * Both take a plain ES module source: a `.ts`/`.tsx`/`.js`/`.jsx` file, or the
 * content of a Vue `<script>` / `<script setup>` block. Framework-neutral on
 * purpose — the module graph is ES imports in every framework we serve.
 *
 * Scope (decided 2026-09-08, "option A"): named imports and `export const`
 * array literals. `findImportBinding` also reads re-exports
 * (`export { X } from "./y"`) so the AI lane can follow a chain, but the
 * deterministic hop refuses anything that is not `export const NAME = [ … ]`
 * (default exports, `export { NAME }` of a local, JSON modules) and leaves it
 * to the AI lane with the bundle.
 */

import { parse } from '@babel/parser'
import type { File, Node, Statement } from '@babel/types'

export interface ImportBinding {
  /** The import specifier as written: `"../data"`, `"./rows.js"`. */
  specifier: string
  /** The exported name on the OTHER side: `METRICS` for `import { METRICS as m }`. */
  importedName: string
  /** Whether the binding came from an `import` or an `export … from` statement. */
  via: 'import' | 're-export'
}

/** Only relative specifiers are followed. A bare specifier (`react`,
 *  `@scope/pkg`) is a dependency, and dependencies are never edited. */
export function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../')
}

function parseModule(source: string): File | null {
  try {
    return parse(source, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      errorRecovery: true,
      allowReturnOutsideFunction: true,
    })
  } catch {
    return null
  }
}

function identifierName(node: Node | null | undefined): string | null {
  if (!node) return null
  if (node.type === 'Identifier') return node.name
  if (node.type === 'StringLiteral') return node.value
  return null
}

/**
 * Find the relative import (or re-export) that binds `name` at module scope.
 *
 * Handles:
 *   import { NAME } from "./x"            → { importedName: NAME }
 *   import { OTHER as NAME } from "./x"   → { importedName: OTHER }
 *   export { NAME } from "./x"            → re-export, { importedName: NAME }
 *   export { OTHER as NAME } from "./x"   → re-export, { importedName: OTHER }
 *
 * Refuses (returns null) for default and namespace imports, bare specifiers,
 * type-only imports, and anything the parser cannot read. Returns the FIRST
 * match: a name can only be bound once at module scope, so there is no
 * ambiguity to guard against here.
 */
export function findImportBinding(
  moduleSource: string,
  name: string,
): ImportBinding | null {
  const ast = parseModule(moduleSource)
  if (!ast) return null
  for (const stmt of ast.program.body as Statement[]) {
    if (stmt.type === 'ImportDeclaration') {
      if (stmt.importKind === 'type') continue
      if (!isRelativeSpecifier(stmt.source.value)) continue
      for (const spec of stmt.specifiers) {
        if (spec.type !== 'ImportSpecifier') continue
        if (spec.importKind === 'type') continue
        if (spec.local.name !== name) continue
        const imported = identifierName(spec.imported)
        if (!imported) continue
        return { specifier: stmt.source.value, importedName: imported, via: 'import' }
      }
      continue
    }
    if (stmt.type === 'ExportNamedDeclaration' && stmt.source) {
      if (stmt.exportKind === 'type') continue
      if (!isRelativeSpecifier(stmt.source.value)) continue
      for (const spec of stmt.specifiers) {
        if (spec.type !== 'ExportSpecifier') continue
        const exported = identifierName(spec.exported)
        if (exported !== name) continue
        return {
          specifier: stmt.source.value,
          importedName: spec.local.name,
          via: 're-export',
        }
      }
    }
  }
  return null
}

/**
 * What a same-file resolver hands back when the iteratee's name is bound by
 * a relative import instead of a local array literal. The resolver has done
 * everything it can without the filesystem: it found the loop, named the
 * array (`iterateeRoot`), the loop variable and the key property, and read
 * the import. The CLI handler resolves the specifier to a file, reads it,
 * and calls `findExportedArrayLiteral` on it.
 */
export interface IterateeImportCandidate {
  iterateeRoot: string
  itemVar?: string
  keyProperty: string | null
  binding: ImportBinding
}

export interface ExportedArrayLiteral {
  /** Position of the `[` token — 1-based line, 1-based column (the array
   *  rewriter's convention; Babel's 0-based column is bumped by one). */
  arrayLocation: { line: number; column: number }
  /** Number of entries in the literal. */
  entryCount: number
}

/**
 * Find `export const NAME = [ … ]` (also `let` / `var`) at module scope.
 *
 * Deliberately narrow. A `const NAME = [ … ]` that is exported on a later
 * line (`export { NAME }`), a default export, a `satisfies` / `as const`
 * wrapper, or a re-export all return null: the caller refuses and the AI
 * lane, which sees the whole file, takes over. Returns null on zero OR
 * multiple matches (a module cannot legally export one name twice, but
 * `errorRecovery` parsing of a broken file could surface two — refuse
 * rather than guess).
 */
export function findExportedArrayLiteral(
  moduleSource: string,
  exportedName: string,
): ExportedArrayLiteral | null {
  const ast = parseModule(moduleSource)
  if (!ast) return null
  const matches: ExportedArrayLiteral[] = []
  for (const stmt of ast.program.body as Statement[]) {
    if (stmt.type !== 'ExportNamedDeclaration') continue
    const decl = stmt.declaration
    if (!decl || decl.type !== 'VariableDeclaration') continue
    for (const d of decl.declarations) {
      if (d.id.type !== 'Identifier' || d.id.name !== exportedName) continue
      const init = d.init
      if (!init || init.type !== 'ArrayExpression' || !init.loc) continue
      matches.push({
        arrayLocation: { line: init.loc.start.line, column: init.loc.start.column + 1 },
        entryCount: init.elements.length,
      })
    }
  }
  return matches.length === 1 ? matches[0] : null
}

/**
 * Does this module import `targetPath` through a relative specifier? Used to
 * decide whether a client-supplied "page" file is actually related to the
 * loop file before it becomes a legal rewrite target in the AI bundle
 * (codex round 2: any in-root file could be claimed as the page). Compares
 * with extensions stripped on both sides and treats `dir` as `dir/index`.
 * `fromPath` and `targetPath` are repo-relative, POSIX separators.
 */
export function importsRelativeFile(
  moduleSource: string,
  fromPath: string,
  targetPath: string,
): boolean {
  const ast = parseModule(moduleSource)
  if (!ast) return false
  const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : ''
  const target = stripModuleExtension(targetPath)
  for (const stmt of ast.program.body as Statement[]) {
    // Only a VALUE import is evidence of rendering. `import type` and
    // re-exports (`export { default as Row } from "./Row"`) name the file
    // without rendering anything from it (codex round 3).
    if (stmt.type !== 'ImportDeclaration') continue
    if (stmt.importKind === 'type') continue
    if (stmt.specifiers.length > 0 && stmt.specifiers.every((s) => s.type === 'ImportSpecifier' && s.importKind === 'type')) continue
    const specifier = stmt.source.value
    if (!isRelativeSpecifier(specifier)) continue
    const normalized = normalizePosix(fromDir ? `${fromDir}/${specifier}` : specifier)
    if (normalized === null) continue
    if (/\.[A-Za-z0-9]+$/.test(specifier)) {
      // Written with an extension: it names ONE file. `./Row.ts` is not
      // `Row.vue` even though the stems agree (codex round 4).
      if (normalized === targetPath) return true
      continue
    }
    if (normalized === target || `${normalized}/index` === target) return true
  }
  return false
}

function stripModuleExtension(p: string): string {
  return p.replace(/\.(vue|tsx?|jsx?|mts|mjs|cjs)$/, '')
}

/** `a/b/../c/./d` → `a/c/d`, without touching the filesystem. Null when the
 *  path climbs above its root (`src/../../x`): an escape is never a match. */
function normalizePosix(p: string): string | null {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out.join('/')
}

/** One file on an import chain, as the AI lane's bundle wants it. */
export interface ImportChainFile {
  /** Repo-relative path. */
  path: string
  /** Full file source (the whole file, not just a script block). */
  source: string
}

export interface CollectImportChainOptions {
  /** Repo-relative path of the file the chain starts in. */
  startPath: string
  /** Full source of that file. */
  startSource: string
  /** The binding to follow — the iteratee's root identifier. */
  name: string
  /**
   * Resolve a relative specifier from a file to the file it names, and read
   * it. The CLI supplies this with its containment guards; `null` ends the
   * chain. This function never touches the filesystem itself.
   */
  resolve: (fromPath: string, specifier: string) => Promise<ImportChainFile | null>
  /**
   * Turn a file into the ES-module text the import scanner should read. The
   * default is the identity; the caller passes a Vue-aware version that
   * returns the `<script>` block of a `.vue` file.
   */
  moduleSourceOf?: (file: ImportChainFile) => string
  /** Upper bound on files followed (not counting the start file). Default 5. */
  maxHops?: number
}

/**
 * Follow `name` through relative imports and re-exports, file by file, until
 * one of: a file defines it as `export const NAME = [ … ]` (found), the name
 * is not imported (a local binding, or something the scanner does not read),
 * the resolver returns null (outside the project, a package, missing), or
 * `maxHops` is reached. Returns every file visited AFTER the start file, in
 * order. The caller puts these behind the loop file in the AI lane's bundle,
 * so the model sees exactly the files a person would open to find the array.
 *
 * A cycle (`a` imports from `b`, `b` re-exports from `a`) terminates on the
 * visited set, not the hop budget.
 */
export async function collectImportChain(
  opts: CollectImportChainOptions,
): Promise<ImportChainFile[]> {
  const moduleSourceOf = opts.moduleSourceOf ?? ((f: ImportChainFile) => f.source)
  const maxHops = opts.maxHops ?? 5
  const visited = new Set<string>([opts.startPath])
  const chain: ImportChainFile[] = []
  let current: ImportChainFile = { path: opts.startPath, source: opts.startSource }
  let name = opts.name
  for (let hop = 0; hop < maxHops; hop++) {
    const binding = findImportBinding(moduleSourceOf(current), name)
    if (!binding) break
    const next = await opts.resolve(current.path, binding.specifier)
    if (!next || visited.has(next.path)) break
    visited.add(next.path)
    chain.push(next)
    if (findExportedArrayLiteral(moduleSourceOf(next), binding.importedName)) break
    current = next
    name = binding.importedName
  }
  return chain
}
