/**
 * Pure (filesystem-free) InsertEdit applicator for React/JSX — the `.tsx`/`.jsx`
 * sibling of [apply-insert-edit.ts](./apply-insert-edit.ts). Given a JSX
 * module's source, the `(line, column)` of a destination parent element, an
 * insertion index, and a literal snippet, produce a new source with the snippet
 * inserted as a child of that parent.
 *
 * Coordinate convention: Babel 1-based line, 0-based column (see
 * apply-jsx-prop-edit.ts). Babel offsets are absolute — no template shift.
 *
 * Content kinds (mirrors the Vue applicator):
 *   - `'element'` (default): a single JSX element snippet (`<UiCard>Hi</UiCard>`,
 *     `<button className="btn">Go</button>`). Validated up front to be exactly
 *     one JSX root, and again by the post-splice re-parse.
 *   - `'text'`: a plain text node, JSX-escaped (`<`, `{`, `&`, …) before splice.
 *
 * `componentImport` (element only): the React analog of the Vue applicator's
 * `<script setup>` auto-import — adds a top-level ES `import` to the module so
 * an inserted component tag resolves. Named (`import { X } from '…'`) vs default
 * (`import X from '…'`) follows `named`, defaulting to default-import for
 * relative paths (single-component files) and named for package specifiers.
 *
 * V1 simplifications mirror the Vue applicator: snippet inserted verbatim with
 * heuristic indentation; only JSXElement children count toward `destIndex`.
 */

import { parse } from "@babel/parser"

import { parseJsxModule, findJsxElementAt, type JsxNode } from "./resolve-jsx-target"

export interface ComponentImportSpec {
  /** Imported binding / tag name, e.g. `UiCard`. */
  name: string
  /** Module specifier, e.g. `@acme/design-system` or `./Foo`. */
  importPath: string
  /**
   * Named (`import { X } from '…'`) vs default (`import X from '…'`). When
   * omitted: relative paths (`./`, `../`, `/`) default-import; bare package
   * specifiers use a named import.
   */
  named?: boolean
}

export interface ApplyJsxInsertEditInput {
  /** Full `.tsx`/`.jsx` source text. */
  source: string
  /** Destination parent opening-tag location — Babel 1-based line / 0-based column. */
  destParentLine: number
  destParentColumn: number
  /** Final 0-based index among the parent's JSXElement children. -1 = append. */
  destIndex: number
  /** Payload — a single JSX element (default) or plain text (`contentKind:'text'`). */
  snippet: string
  contentKind?: "element" | "text"
  /** Optional: add a top-level import so an inserted component tag resolves. */
  componentImport?: ComponentImportSpec
}

export type ApplyJsxInsertEditResult =
  | { ok: true; source: string; warnings?: string[] }
  | { ok: false; reason: string }

type BabelNode = JsxNode

interface SpliceOp {
  start: number
  end: number
  replacement: string
}

export function applyJsxInsertEdit(input: ApplyJsxInsertEditInput): ApplyJsxInsertEditResult {
  const { source, destParentLine, destParentColumn, destIndex, snippet } = input
  const contentKind = input.contentKind ?? "element"

  if (!snippet || snippet.trim().length === 0) {
    return { ok: false, reason: "Insert payload must be non-empty" }
  }

  // Resolve the literal spliced as the parent's child.
  let payload: string
  if (contentKind === "text") {
    payload = escapeJsxText(snippet.trim())
  } else {
    const check = validateSingleJsxElement(snippet)
    if (!check.ok) return check
    payload = snippet.trim()
  }

  const parsedModule = parseJsxModule(source)
  if (!parsedModule.ok) return { ok: false, reason: parsedModule.reason }
  const ast: BabelNode = parsedModule.ast

  const destEl = findJsxElementAt(ast, destParentLine, destParentColumn)
  if (!destEl) {
    return {
      ok: false,
      reason: `No destination parent found at ${destParentLine}:${destParentColumn}`,
    }
  }
  if (destEl.openingElement?.selfClosing) {
    return { ok: false, reason: "Cannot insert into a self-closing element" }
  }

  const destElementChildren = elementChildren(destEl)

  let finalIndex = destIndex
  if (finalIndex < 0) finalIndex = destElementChildren.length + 1 + finalIndex
  if (finalIndex < 0) finalIndex = 0
  if (finalIndex > destElementChildren.length) finalIndex = destElementChildren.length

  const insertOffset = computeInsertionOffset(destEl, destElementChildren, finalIndex)
  if (insertOffset < 0) {
    return { ok: false, reason: "Could not compute destination insertion offset" }
  }

  const indent = computeIndent(source, destEl, destElementChildren, finalIndex)

  const ops: SpliceOp[] = [
    { start: insertOffset, end: insertOffset, replacement: `\n${indent}${payload}` },
  ]

  const warnings: string[] = []
  if (contentKind === "element" && input.componentImport) {
    const importResult = computeImportOp(ast, source, input.componentImport)
    if (importResult.op) ops.push(importResult.op)
    if (importResult.warning) warnings.push(importResult.warning)
  }

  // Apply descending so earlier offsets stay valid (matches apply-insert-edit).
  ops.sort((a, b) => b.start - a.start)
  let newSource = source
  for (const op of ops) {
    newSource = newSource.slice(0, op.start) + op.replacement + newSource.slice(op.end)
  }

  // Post-splice parse check.
  try {
    parse(newSource, { sourceType: "module", plugins: ["jsx", "typescript"] })
  } catch (err) {
    return {
      ok: false,
      reason: `Post-splice JSX parse failed (likely malformed snippet): ${(err as Error).message}`,
    }
  }

  return warnings.length > 0
    ? { ok: true, source: newSource, warnings }
    : { ok: true, source: newSource }
}

/** JSXElement children only (text / expression / fragments excluded). */
function elementChildren(el: BabelNode): BabelNode[] {
  return (el.children ?? []).filter((c) => c.type === "JSXElement")
}

function computeInsertionOffset(
  dest: BabelNode,
  destElementChildren: BabelNode[],
  finalIndex: number,
): number {
  if (finalIndex < destElementChildren.length) {
    const target = destElementChildren[finalIndex]
    return typeof target.start === "number" ? target.start : -1
  }
  if (destElementChildren.length > 0) {
    const last = destElementChildren[destElementChildren.length - 1]
    return typeof last.end === "number" ? last.end : -1
  }
  const openEnd = dest.openingElement?.end
  return typeof openEnd === "number" ? openEnd : -1
}

/** Heuristic indent: copy the leading whitespace of the sibling we insert near;
 *  empty parent falls back to the parent's column + 2. */
function computeIndent(
  source: string,
  dest: BabelNode,
  destElementChildren: BabelNode[],
  finalIndex: number,
): string {
  const ref =
    finalIndex < destElementChildren.length
      ? destElementChildren[finalIndex]
      : destElementChildren[destElementChildren.length - 1]
  if (ref && typeof ref.start === "number") {
    const refStart = ref.start
    let lineStart = refStart
    while (lineStart > 0 && source[lineStart - 1] !== "\n") lineStart--
    let i = lineStart
    while (i < refStart && (source[i] === " " || source[i] === "\t")) i++
    return source.slice(lineStart, i)
  }
  const parentCol = dest.openingElement?.loc?.start?.column ?? 0
  return " ".repeat(Math.max(parentCol + 2, 2))
}

/** Escape text for a JSXText node — `<`/`{`/`}` are structural, `&` an entity. */
function escapeJsxText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;")
}

/**
 * Validate that an element snippet is exactly ONE JSX root element. Parse it as
 * a parenthesized expression (`(SNIPPET)`) and check the resulting node is a
 * single JSXElement/JSXFragment. The post-splice re-parse alone can't catch a
 * multi-sibling snippet (`<a/><b/>`) because both are valid as adjacent
 * children — this up-front check keeps `contentKind:'element'` to one element.
 */
function validateSingleJsxElement(
  snippet: string,
): { ok: true } | { ok: false; reason: string } {
  let ast
  try {
    ast = parse(`(\n${snippet}\n)`, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
    })
  } catch (err) {
    return {
      ok: false,
      reason: `Insert snippet did not parse as a JSX element: ${(err as Error).message}`,
    }
  }
  const body = (ast as unknown as { program: { body: Array<{ type: string; expression?: { type?: string } }> } }).program.body
  if (body.length !== 1 || body[0].type !== "ExpressionStatement") {
    return {
      ok: false,
      reason:
        "Insert snippet must be a SINGLE JSX element. Wrap multiple siblings in one parent or a fragment first.",
    }
  }
  const exprType = body[0].expression?.type
  if (exprType !== "JSXElement" && exprType !== "JSXFragment") {
    return {
      ok: false,
      reason:
        'Insert snippet has no root JSX element. For bare text use contentKind:"text"; otherwise wrap the content in a single element.',
    }
  }
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/* Top-level import insertion (the React `<script setup>` analog)       */
/* ------------------------------------------------------------------ */

const DEFAULT_IMPORT = "*default*"

interface ImportBinding {
  source: string
  imported: string
}

interface ModuleBindings {
  importsByName: Map<string, ImportBinding[]>
  declared: Set<string>
  /** end offset of the last top-level ImportDeclaration, or null. */
  lastImportEnd: number | null
  /** end offset of the last top-level directive prologue (`'use client'`), or null. */
  lastDirectiveEnd: number | null
  parseError: boolean
}

/**
 * Compute the splice op that adds `spec`'s import to the module's top level, or
 * a warning when it can't be added cleanly. Mirrors the Vue applicator's
 * `computeImportOp`, but operates on ES module top-level imports rather than a
 * `<script setup>` block. The element is inserted regardless; this only governs
 * the import line. Never writes invalid JS — returns a warning instead.
 */
function computeImportOp(
  ast: BabelNode,
  source: string,
  spec: ComponentImportSpec,
): { op: SpliceOp | null; warning?: string } {
  if (!isValidIdentifier(spec.name) || !isSafeModulePath(spec.importPath)) {
    return {
      op: null,
      warning: `Could not auto-import ${spec.name}: invalid import name or module path; add the import manually.`,
    }
  }
  const bindings = analyzeModuleBindings(ast)
  if (bindings.parseError) {
    return {
      op: null,
      warning: `Could not auto-import ${spec.name}: module bindings could not be analyzed; add the import for '${spec.importPath}' manually.`,
    }
  }
  const isRelative =
    spec.importPath.startsWith("./") ||
    spec.importPath.startsWith("../") ||
    spec.importPath.startsWith("/")
  const named = spec.named ?? !isRelative
  const wantImported = named ? spec.name : DEFAULT_IMPORT
  const existing = bindings.importsByName.get(spec.name)
  const idempotent = existing?.some(
    (e) => e.source === spec.importPath && e.imported === wantImported,
  )
  if (idempotent) {
    return { op: null }
  }
  if (bindings.declared.has(spec.name)) {
    return {
      op: null,
      warning: `Could not auto-import ${spec.name} from '${spec.importPath}': a binding named ${spec.name} already exists. Verify the inserted <${spec.name}> resolves to the intended component.`,
    }
  }
  const statement = named
    ? `import { ${spec.name} } from '${spec.importPath}'`
    : `import ${spec.name} from '${spec.importPath}'`
  // Insert after the last existing import (own line). With no imports, insert
  // after any directive prologue (`'use client'`/`'use server'`) — inserting at
  // byte 0 would push the import above the directive, demoting it from a
  // prologue directive to a normal statement (silently flipping a Next.js
  // client component to a server component). With neither, at the file top.
  let insertAt: number
  let replacement: string
  if (typeof bindings.lastImportEnd === "number") {
    insertAt = bindings.lastImportEnd
    replacement = `\n${statement}`
  } else if (typeof bindings.lastDirectiveEnd === "number") {
    insertAt = bindings.lastDirectiveEnd
    replacement = `\n${statement}`
  } else {
    insertAt = 0
    replacement = `${statement}\n`
  }
  return { op: { start: insertAt, end: insertAt, replacement } }
}

/** Collect top-level imports + declared bindings from a parsed module. */
function analyzeModuleBindings(ast: BabelNode): ModuleBindings {
  const importsByName = new Map<string, ImportBinding[]>()
  const declared = new Set<string>()
  let lastImportEnd: number | null = null

  const program = (ast as unknown as {
    program?: { body?: BabelNode[]; directives?: BabelNode[] }
  }).program
  const body = program?.body
  if (!Array.isArray(body)) {
    return { importsByName, declared, lastImportEnd, lastDirectiveEnd: null, parseError: true }
  }
  // Directive prologues (`'use client'`, …) live in program.directives, not
  // body. Track the last one's end so an inserted import lands after it.
  let lastDirectiveEnd: number | null = null
  const directives = program?.directives
  if (Array.isArray(directives)) {
    for (const d of directives) {
      if (typeof d.end === "number") lastDirectiveEnd = d.end
    }
  }

  for (const raw of body) {
    const node =
      (raw.type === "ExportNamedDeclaration" || raw.type === "ExportDefaultDeclaration") &&
      raw.declaration
        ? (raw.declaration as BabelNode)
        : raw
    if (node.type === "ImportDeclaration") {
      if (typeof node.end === "number") lastImportEnd = node.end
      const src = (node.source as { value?: string } | undefined)?.value
      const declTypeOnly = node.importKind === "type"
      for (const spec of (node.specifiers as BabelNode[]) ?? []) {
        const local = (spec.local as { name?: string } | undefined)?.name
        if (!local) continue
        declared.add(local)
        const typeOnly = declTypeOnly || spec.importKind === "type"
        if (typeOnly || typeof src !== "string") continue
        let imported: string | null = null
        if (spec.type === "ImportDefaultSpecifier") {
          imported = DEFAULT_IMPORT
        } else if (spec.type === "ImportSpecifier") {
          const impNode = spec.imported as { name?: string; value?: string } | undefined
          imported = impNode?.name ?? impNode?.value ?? null
        }
        if (imported === null) continue
        let list = importsByName.get(local)
        if (!list) {
          list = []
          importsByName.set(local, list)
        }
        list.push({ source: src, imported })
      }
    } else {
      addDeclaredNames(node, declared)
    }
  }
  return { importsByName, declared, lastImportEnd, lastDirectiveEnd, parseError: false }
}

function addDeclaredNames(node: BabelNode, declared: Set<string>): void {
  switch (node.type) {
    case "VariableDeclaration":
      for (const d of (node.declarations as BabelNode[]) ?? []) {
        collectPatternNames(d.id as BabelNode | undefined, declared)
      }
      break
    case "FunctionDeclaration":
    case "ClassDeclaration":
    case "TSEnumDeclaration":
    case "TSModuleDeclaration": {
      const id = node.id as { type?: string; name?: string } | undefined
      if (id?.type === "Identifier" && id.name) declared.add(id.name)
      break
    }
  }
}

function collectPatternNames(node: BabelNode | undefined, out: Set<string>): void {
  if (!node) return
  switch (node.type) {
    case "Identifier":
      out.add(node.name as string)
      break
    case "ObjectPattern":
      for (const p of (node.properties as BabelNode[]) ?? []) {
        if (p.type === "RestElement") collectPatternNames(p.argument as BabelNode, out)
        else collectPatternNames(p.value as BabelNode, out)
      }
      break
    case "ArrayPattern":
      for (const el of (node.elements as (BabelNode | null)[]) ?? []) {
        collectPatternNames(el ?? undefined, out)
      }
      break
    case "AssignmentPattern":
      collectPatternNames(node.left as BabelNode, out)
      break
    case "RestElement":
      collectPatternNames(node.argument as BabelNode, out)
      break
  }
}

function isValidIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)
}

function isSafeModulePath(value: string): boolean {
  if (value.trim().length === 0) return false
  for (const ch of value) {
    if (ch === "'" || ch === '"' || ch === "\\") return false
    const code = ch.charCodeAt(0)
    if (code === 0x00 || code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) {
      return false
    }
  }
  return true
}
