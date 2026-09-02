/**
 * Pure (filesystem-free) InsertEdit applicator. Given a Vue SFC's
 * source, the build-time `(line, column)` of a destination parent
 * element, an insertion index, and a literal template snippet,
 * produces a new SFC source with the snippet inserted as a child of
 * that parent at the given index.
 *
 * Coordinates follow {@link import('./apply-move-edit').applyMoveEdit}:
 * line/column are SFC-absolute. Internally we re-parse the template
 * with `@vue/compiler-dom` (template-content-relative loc) and shift
 * by the SFC's template block start when matching.
 *
 * V1 simplifications:
 *   - The snippet is inserted verbatim. Indentation matches the
 *     destination's first child (or the parent's open-tag column +
 *     2 if the parent is empty). Designer running prettier afterward
 *     normalizes any drift. Same trade-off as the other structural
 *     applicators.
 *   - The snippet is REQUIRED to be a single Vue template element
 *     (validated post-splice via re-parse). Plain text or multiple
 *     siblings are out of scope for V1; if a future palette wants
 *     to insert `<div /><div />` as a unit, wrap them in a single
 *     parent first.
 *
 * Refusal cases:
 *   - The (line, column) doesn't match any element.
 *   - The destination is a self-closing element (no children possible).
 *   - The snippet doesn't parse as Vue template after splice.
 */

import { parse as parseSfc, babelParse } from '@vue/compiler-sfc'
import { parse as parseTemplate, NodeTypes } from '@vue/compiler-dom'
import { resolveTemplateTarget } from './resolve-template-target'

export interface ApplyInsertEditInput {
  /** Full SFC source text. */
  source: string
  /** Destination parent element location — 1-based SFC-absolute. */
  destParentLine: number
  destParentColumn: number
  /**
   * Final 0-based index the new element should occupy in the
   * destination parent's children list. Negative values count from
   * the end (-1 means "append at the tail").
   */
  destIndex: number
  /**
   * Payload to insert. Interpreted per {@link contentKind}:
   *   - `'element'` (default): a single Vue template ELEMENT, validated up
   *     front (exactly one root element) AND again by the post-splice
   *     template re-parse. Examples: `<div></div>`, `<UiCard>Hello</UiCard>`,
   *     `<button class="btn">Go</button>`.
   *   - `'text'`: a plain text node spliced as the parent's child. The text
   *     is HTML-escaped (`&`, `<`) before insertion; Vue interpolation
   *     delimiters (`{{` / `}}`) are refused (use Edit for expression text).
   */
  snippet: string
  /**
   * Whether {@link snippet} is a single element (default) or a plain text
   * node. Text mode lets a designer/agent drop bare text into a container
   * (the element-only path can't represent a text child).
   */
  contentKind?: 'element' | 'text'
  /**
   * Optional: ensure the inserted component is imported in the SFC's
   * `<script setup>`. When inserting a design-system component (e.g.
   * `<UiCard>` from `@acme/design-system`) the snippet alone leaves the
   * tag unresolved; this adds the matching import if it isn't already
   * present.
   *
   * V1 only handles `<script setup>` (matching the swap applicator).
   * If the SFC has no `<script setup>` block (Options API / no script)
   * the element is still inserted and a warning is returned — the
   * import is the designer's to add.
   */
  componentImport?: ComponentImportSpec
  /**
   * Component names the PROJECT resolves without a local import — globally
   * registered (`app.component(…)`, `app.use(SomeLibrary)`) or supplied by an
   * auto-import plugin (unplugin-vue-components' generated `components.d.ts`).
   *
   * Supplying this turns on the unresolvable-component check: an inserted
   * component tag that is neither bound in this SFC nor in this set gets a
   * warning instead of a silent `ok: true` (see
   * {@link checkComponentResolution}).
   *
   * **Omit it and the check stays off, deliberately.** The applicator is
   * pure — it sees one SFC and cannot see `components.d.ts` or the app
   * bootstrap — and inferring the answer from the SFC alone was measured to
   * be wrong far too often to act on: on the dogfood substrate 129 of 176
   * SFCs import every component they use while the design system is *also*
   * registered globally, so "this file imports its components" does not
   * imply "an unimported tag here is broken". Since the agent tools escalate
   * any warning to a hard refusal, a false warning is a false refusal — so
   * with no ground truth the applicator says nothing.
   */
  resolvableComponents?: readonly string[]
}

export interface ComponentImportSpec {
  /** Imported binding / tag name, e.g. `UiCard`. */
  name: string
  /** Module specifier, e.g. `@acme/design-system` or `./Foo.vue`. */
  importPath: string
  /**
   * Named (`import { X } from '…'`) vs default (`import X from '…'`).
   * When omitted, inferred: `.vue` paths default-export (single-file
   * components), everything else (libraries) is treated as named.
   */
  named?: boolean
}

export type ApplyInsertEditResult =
  | { ok: true; source: string; warnings?: string[] }
  | { ok: false; reason: string }

interface ElementLike {
  type: number
  tag: string
  loc: {
    start: { line: number; column: number; offset: number }
    end: { offset: number }
  }
  props: Array<{ loc?: { end?: { offset?: number } } }>
  children: ElementLike[]
  isSelfClosing: boolean
}

export function applyInsertEdit(input: ApplyInsertEditInput): ApplyInsertEditResult {
  const { source, destParentLine, destParentColumn, destIndex, snippet } = input
  const contentKind = input.contentKind ?? 'element'

  if (!snippet || snippet.trim().length === 0) {
    return { ok: false, reason: 'Insert payload must be non-empty' }
  }

  // Resolve the literal string that gets spliced as the parent's child,
  // validated per content kind. Element: exactly one root element. Text:
  // HTML-escaped, no Vue interpolation.
  let payload: string
  let rootElement: ElementLike | null = null
  if (contentKind === 'text') {
    if (snippet.includes('{{') || snippet.includes('}}')) {
      return {
        ok: false,
        reason:
          'Text content contains Vue interpolation delimiters ({{ or }}). Insert plain text, then use Edit for interpolation/expression content.',
      }
    }
    payload = escapeTemplateText(snippet.trim())
  } else {
    const elementCheck = validateSingleElementSnippet(snippet)
    if (!elementCheck.ok) return elementCheck
    rootElement = elementCheck.root
    payload = snippet.trim()
  }

  // Resolve the destination parent via the shared resolver. The historical
  // not-found reason names the "destination parent" — preserve it.
  const resolved = resolveTemplateTarget({
    source,
    line: destParentLine,
    column: destParentColumn,
  })
  if (!resolved.ok) {
    const reason =
      resolved.failure.kind === 'not-found'
        ? `No destination parent found at SFC line ${destParentLine}, column ${destParentColumn}`
        : resolved.failure.reason
    return { ok: false, reason }
  }
  const destEl = resolved.node as unknown as ElementLike
  const { descriptor, templateContent, templateOffset } = resolved.ctx

  if (destEl.isSelfClosing) {
    return {
      ok: false,
      reason: 'Cannot insert into a self-closing element',
    }
  }

  // Element-only children for stable indexing; mirrors MoveEdit.
  const destElementChildren = (destEl.children as ElementLike[]).filter(
    (c) => c.type === NodeTypes.ELEMENT,
  )

  let finalIndex = destIndex
  if (finalIndex < 0) finalIndex = destElementChildren.length + 1 + finalIndex
  if (finalIndex < 0) finalIndex = 0
  if (finalIndex > destElementChildren.length) finalIndex = destElementChildren.length

  const insertOffset = computeInsertionOffset(
    destEl,
    destElementChildren,
    finalIndex,
    templateContent,
    templateOffset,
  )
  if (insertOffset < 0) {
    return { ok: false, reason: 'Could not compute destination insertion offset' }
  }

  // Compute indent: copy the indent of the sibling we're inserting
  // before (or, if appending to the tail, the prior sibling's). Empty
  // parent uses parent's indent + 2 spaces. The indent string is
  // PREPENDED with a newline so the snippet ends up on its own line.
  const indent = computeIndent(
    source,
    destEl,
    destElementChildren,
    finalIndex,
    templateOffset,
  )

  // Build a list of splice ops. The element op always exists; the
  // import op is added when a componentImport is requested and the SFC
  // has a `<script setup>` that doesn't already import the binding.
  // Pattern (element op): insert "<NEWLINE><INDENT><SNIPPET>" before the
  // next sibling (or before the close tag for tail-append).
  const ops: SpliceOp[] = [
    { start: insertOffset, end: insertOffset, replacement: `\n${indent}${payload}` },
  ]

  const warnings: string[] = []
  // Auto-import only applies to an element that references a component; a
  // text node never needs one.
  if (contentKind === 'element' && input.componentImport) {
    const importResult = computeImportOp(descriptor, source, input.componentImport)
    if (importResult.op) ops.push(importResult.op)
    if (importResult.warning) warnings.push(importResult.warning)
  }

  // Will the inserted tag actually resolve to a component at runtime? An
  // unresolvable tag renders as an inert element and Vue logs "Failed to
  // resolve component" — but the insert itself succeeds, so without this the
  // API reports ok:true for an edit the user can see is broken.
  if (contentKind === 'element' && rootElement) {
    const resolutionWarning = checkComponentResolution(
      rootElement,
      descriptor,
      input.componentImport,
      input.resolvableComponents,
    )
    if (resolutionWarning) warnings.push(resolutionWarning)
  }

  // Apply ops sorted by start offset DESCENDING so earlier offsets stay
  // valid as later splices are applied (the convention in
  // apply-detach-edit.ts). Insertions at the same offset are stable.
  ops.sort((a, b) => b.start - a.start)
  let newSource = source
  for (const op of ops) {
    newSource = newSource.slice(0, op.start) + op.replacement + newSource.slice(op.end)
  }

  // Post-splice parse check.
  try {
    const newDescriptor = parseSfc(newSource).descriptor
    if (!newDescriptor.template) {
      return { ok: false, reason: 'Post-splice SFC lost its <template> block' }
    }
    parseTemplate(newDescriptor.template.content)
  } catch (err) {
    return {
      ok: false,
      reason: `Post-splice template parse failed (likely malformed snippet): ${(err as Error).message}`,
    }
  }

  return warnings.length > 0
    ? { ok: true, source: newSource, warnings }
    : { ok: true, source: newSource }
}

interface SpliceOp {
  start: number
  end: number
  replacement: string
}

/**
 * Compute the splice op that adds `spec`'s import to the SFC's
 * `<script setup>`, or returns a warning when the import can't be added
 * automatically. Mirrors `computeImportMergeOp` in apply-detach-edit.ts.
 *
 * The element is always inserted by the caller regardless; this only
 * governs whether (and how) the import line is added. It never produces
 * invalid script — when it can't add the import cleanly it returns a
 * warning so the failure is surfaced rather than silently writing broken
 * or wrong-binding code:
 *
 *  - No `<script setup>` block → no op, warning (V1 doesn't touch Options
 *    API `components: {}` registration, matching swap).
 *  - `name` is not a valid JS identifier, or `importPath` can't be safely
 *    placed in a string literal → no op, warning.
 *  - `name` already imported FROM THE SAME module path → no op, no
 *    warning (idempotent).
 *  - `name` already bound in the block (imported from a DIFFERENT module,
 *    or declared as a local const/let/var/function/class) → no op,
 *    warning. Adding the import would either shadow with a wrong binding
 *    or duplicate a top-level binding (invalid JS the template-only
 *    post-splice re-parse can't catch).
 *  - Otherwise → an insertion op at the start of the script-setup
 *    content, just past `<script setup …>`.
 */
function computeImportOp(
  descriptor: { scriptSetup?: { content: string; loc: { start: { offset: number } } } | null },
  source: string,
  spec: ComponentImportSpec,
): { op: SpliceOp | null; warning?: string } {
  const scriptSetup = descriptor.scriptSetup
  if (!scriptSetup) {
    return {
      op: null,
      warning: `Could not auto-import ${spec.name}: SFC has no <script setup> block; add the import for '${spec.importPath}' manually.`,
    }
  }
  if (!isValidIdentifier(spec.name) || !isSafeModulePath(spec.importPath)) {
    return {
      op: null,
      warning: `Could not auto-import ${spec.name}: invalid import name or module path; add the import manually.`,
    }
  }
  const content = scriptSetup.content
  const bindings = analyzeScriptBindings(content)
  if (bindings.parseError) {
    return {
      op: null,
      warning: `Could not auto-import ${spec.name}: <script setup> could not be parsed; add the import for '${spec.importPath}' manually.`,
    }
  }
  // The import KIND we'd add: named (`import { X }`) vs default
  // (`import X from`). `.vue` files single-default-export their component;
  // libraries use named exports. The caller can force it via `named`.
  const named = spec.named ?? !spec.importPath.endsWith('.vue')
  const wantImported = named ? spec.name : DEFAULT_IMPORT
  // Idempotent: the local name `spec.name` is ALREADY bound to the
  // matching export from this exact module, AND of the SAME kind we'd
  // add — an unaliased named import of `spec.name` (`import { UiCard }`,
  // combined `import Foo, { UiCard }`) when named, or a default import
  // (`import UiCard from './UiCard.vue'`) when default. A kind mismatch
  // (existing named vs requested default, or vice-versa) is NOT
  // idempotent — `<UiCard>` would resolve to the wrong export — so it
  // falls through to the conflict branch. An ALIAS reusing the name
  // (`import { UiButton as UiCard }`) likewise isn't idempotent.
  const existing = bindings.importsByName.get(spec.name)
  const idempotent = existing?.some(
    (e) => e.source === spec.importPath && e.imported === wantImported,
  )
  if (idempotent) {
    return { op: null }
  }
  // Conflict: the binding name is already taken (imported from a
  // different module, aliased to this name, a namespace import, a
  // type-only import, or a local const/let/var/function/class/enum).
  // Don't add — it would bind the inserted tag to the wrong thing or
  // emit a duplicate top-level binding (invalid JS the template-only
  // post-splice re-parse can't catch).
  if (bindings.declared.has(spec.name)) {
    return {
      op: null,
      warning: `Could not auto-import ${spec.name} from '${spec.importPath}': a binding named ${spec.name} already exists in <script setup>. Verify the inserted <${spec.name}> resolves to the intended component.`,
    }
  }
  const statement = named
    ? `import { ${spec.name} } from '${spec.importPath}'`
    : `import ${spec.name} from '${spec.importPath}'`
  // Insert at the start of the FIRST statement (which sits after any
  // leading comments/pragmas like `// @ts-nocheck` or `@jsxImportSource`),
  // so the import never jumps above a directive and changes how the file
  // is interpreted. With no statements but leading comments, insert after
  // the last comment (keep the pragma first). Empty block → content start.
  const within = bindings.firstStatementStart ?? bindings.lastLeadingCommentEnd ?? 0
  const insertAt = scriptSetup.loc.start.offset + within
  // Keep the import on its own line: add a leading newline unless we're
  // already at a line start, and a trailing newline unless the next char
  // already is one (so a compact `<script setup>const n = 1` doesn't get
  // the import glued onto the next statement).
  const prevChar = insertAt > 0 ? source[insertAt - 1] : '\n'
  const nextChar = insertAt < source.length ? source[insertAt] : ''
  const lead = prevChar === '\n' ? '' : '\n'
  const trail = nextChar === '\n' ? '' : '\n'
  const replacement = `${lead}${statement}${trail}`
  return { op: { start: insertAt, end: insertAt, replacement } }
}

/** Sentinel for a default import's "imported name" (no named export). */
const DEFAULT_IMPORT = '*default*'

/** A runtime-value import binding: where it came from and what it imports. */
interface ImportBinding {
  /** Module specifier (`from '…'`). */
  source: string
  /** The IMPORTED export name, or {@link DEFAULT_IMPORT} for a default import. */
  imported: string
}

interface ScriptBindings {
  /** local binding name → the runtime-value import(s) that bind it. */
  importsByName: Map<string, ImportBinding[]>
  /** every top-level binding name that would collide with a value import. */
  declared: Set<string>
  /**
   * The subset of {@link declared} that binds a RUNTIME VALUE — so it could
   * actually resolve a component tag. Excludes type-only imports and
   * type-only declarations, which occupy the identifier but render nothing.
   * (`declared` can't serve double duty: it deliberately includes type-only
   * imports so the auto-import conflict check stays correct.)
   */
  valueBindings: Set<string>
  /** offset (within script content) of the first statement, or null if none. */
  firstStatementStart: number | null
  /** end offset (within content) of the last leading comment, or null. */
  lastLeadingCommentEnd: number | null
  /** true when the script couldn't be parsed (degrade: skip + warn). */
  parseError: boolean
}

type AstNode = { type: string; [k: string]: unknown }

/**
 * Parse a `<script setup>` body and collect its top-level bindings via a
 * real AST (regex import-matching misses combined `import Foo, { Bar }`
 * clauses and mishandles `{ Bar as Baz }` aliases). Uses `@vue/compiler-sfc`'s
 * re-exported babel parser so no extra dependency is pulled in. On parse
 * failure we report it so the caller degrades gracefully instead of guessing.
 */
function analyzeScriptBindings(content: string): ScriptBindings {
  const importsByName = new Map<string, ImportBinding[]>()
  const declared = new Set<string>()
  const valueBindings = new Set<string>()
  // Parse TS first (preserves `<Type>` angle-bracket cast support); if
  // that fails, retry with JSX enabled for `<script setup lang="tsx">` /
  // JSX-bearing blocks. Only when both fail do we report parseError.
  let ast
  try {
    ast = babelParse(content, {
      sourceType: 'module',
      plugins: ['typescript'],
      allowAwaitOutsideFunction: true,
    })
  } catch {
    try {
      ast = babelParse(content, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx'],
        allowAwaitOutsideFunction: true,
      })
    } catch {
      return {
        importsByName,
        declared,
        valueBindings,
        firstStatementStart: null,
        lastLeadingCommentEnd: null,
        parseError: true,
      }
    }
  }
  const body = ast.program.body as unknown as AstNode[]
  const firstStatementStart =
    typeof body[0]?.start === 'number' ? (body[0].start as number) : null
  const comments = (ast.comments as unknown as Array<{ end?: number }>) ?? []
  const lastLeadingCommentEnd =
    comments.length > 0 && typeof comments[comments.length - 1].end === 'number'
      ? (comments[comments.length - 1].end as number)
      : null
  for (const raw of body) {
    // Unwrap `export <decl>` (uncommon in <script setup> but cheap) so an
    // exported const/function/enum still registers as a declared binding.
    const node =
      (raw.type === 'ExportNamedDeclaration' || raw.type === 'ExportDefaultDeclaration') &&
      raw.declaration
        ? (raw.declaration as AstNode)
        : raw
    if (node.type === 'ImportDeclaration') {
      const source = (node.source as { value?: string } | undefined)?.value
      // `import type { … }` (whole-declaration) brings only type-space
      // bindings — no runtime value. Such a binding does NOT satisfy a
      // component import, but it DOES occupy the identifier (adding a
      // value import of the same name is a duplicate-identifier error).
      const declTypeOnly = node.importKind === 'type'
      for (const spec of (node.specifiers as AstNode[]) ?? []) {
        const local = (spec.local as { name?: string } | undefined)?.name
        if (!local) continue
        declared.add(local)
        // Only DEFAULT and (non-type) NAMED specifiers yield a runtime
        // value bound to `local` that can resolve a component tag.
        // Namespace imports (`* as X`) bind the module object, not the
        // component export; type-only specifiers bind nothing at runtime.
        // Both still occupy the identifier (→ `declared`) but must NOT
        // be recorded as a usable value import.
        const typeOnly = declTypeOnly || spec.importKind === 'type'
        // A namespace import binds the module object, so `<X/>` can't resolve
        // through it (only `<X.Foo/>`, which the resolution check skips).
        if (!typeOnly && spec.type !== 'ImportNamespaceSpecifier') valueBindings.add(local)
        if (typeOnly || typeof source !== 'string') continue
        let imported: string | null = null
        if (spec.type === 'ImportDefaultSpecifier') {
          imported = DEFAULT_IMPORT
        } else if (spec.type === 'ImportSpecifier') {
          // `import { Foo as Local }` → imported = "Foo". Babel models the
          // imported name as an Identifier (or StringLiteral for
          // `import { "x" as Local }`).
          const impNode = spec.imported as { name?: string; value?: string } | undefined
          imported = impNode?.name ?? impNode?.value ?? null
        }
        // ImportNamespaceSpecifier → imported stays null (skip).
        if (imported === null) continue
        let list = importsByName.get(local)
        if (!list) {
          list = []
          importsByName.set(local, list)
        }
        list.push({ source, imported })
      }
    } else {
      addDeclaredNames(node, declared)
      // `addDeclaredNames` already admits only runtime-value declarations
      // (interface/type are excluded), so the two sets agree here.
      addDeclaredNames(node, valueBindings)
    }
  }
  return {
    importsByName,
    declared,
    valueBindings,
    firstStatementStart,
    lastLeadingCommentEnd,
    parseError: false,
  }
}

/**
 * Record the top-level RUNTIME-VALUE binding name(s) a declaration
 * introduces into `declared`. Only value bindings collide with an added
 * value import (TS2440): var/let/const, function, class, enum, and a
 * value-producing namespace/module. Type-only declarations (`interface`,
 * `type`) are deliberately EXCLUDED — TypeScript lets a value import and
 * a same-named interface/type alias coexist (verified against tsc), so
 * treating them as conflicts would wrongly suppress a valid import.
 */
function addDeclaredNames(node: AstNode, declared: Set<string>): void {
  switch (node.type) {
    case 'VariableDeclaration':
      for (const d of (node.declarations as AstNode[]) ?? []) {
        collectPatternNames(d.id as AstNode | undefined, declared)
      }
      break
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
    case 'TSEnumDeclaration':
    case 'TSModuleDeclaration': {
      const id = node.id as { type?: string; name?: string } | undefined
      if (id?.type === 'Identifier' && id.name) declared.add(id.name)
      break
    }
  }
}

/** Collect every identifier bound by a (possibly destructuring) pattern. */
function collectPatternNames(node: AstNode | undefined, out: Set<string>): void {
  if (!node) return
  switch (node.type) {
    case 'Identifier':
      out.add(node.name as string)
      break
    case 'ObjectPattern':
      for (const p of (node.properties as AstNode[]) ?? []) {
        if (p.type === 'RestElement') collectPatternNames(p.argument as AstNode, out)
        else collectPatternNames(p.value as AstNode, out)
      }
      break
    case 'ArrayPattern':
      for (const el of (node.elements as (AstNode | null)[]) ?? []) {
        collectPatternNames(el ?? undefined, out)
      }
      break
    case 'AssignmentPattern':
      collectPatternNames(node.left as AstNode, out)
      break
    case 'RestElement':
      collectPatternNames(node.argument as AstNode, out)
      break
  }
}

/** A bare JS identifier — safe to interpolate into an import clause. */
function isValidIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)
}

/**
 * A module specifier safe to place inside a single-quoted string literal:
 * no quotes, backslashes, line terminators, or NUL.
 */
function isSafeModulePath(value: string): boolean {
  if (value.trim().length === 0) return false
  // Reject anything that can't sit inside a single-quoted string literal:
  // quotes, backslash, NUL, and any line terminator (\n \r U+2028 U+2029).
  for (const ch of value) {
    if (ch === "'" || ch === '"' || ch === '\\') return false
    const code = ch.charCodeAt(0)
    if (code === 0x00 || code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) {
      return false
    }
  }
  return true
}

/**
 * Escape a plain-text payload for insertion as a Vue template text node.
 * Only `&` and `<` are structurally significant in element content (`>` and
 * quotes are fine in text); `{{`/`}}` are refused upstream, not escaped.
 */
function escapeTemplateText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}

/**
 * Validate that an element snippet is exactly ONE root element. The
 * applicator's post-splice re-parse only proves the WHOLE template still
 * parses — a multi-sibling snippet (`<div/><div/>`) or a bare-text snippet
 * would slip through there because both are valid template content. This
 * up-front check keeps `contentKind:'element'` to a single element (use
 * `contentKind:'text'` for bare text).
 */
function validateSingleElementSnippet(
  snippet: string,
): { ok: true; root: ElementLike } | { ok: false; reason: string } {
  let ast
  try {
    ast = parseTemplate(snippet.trim())
  } catch (err) {
    return { ok: false, reason: `Insert snippet did not parse as a Vue template: ${(err as Error).message}` }
  }
  const roots = (ast.children as ElementLike[]) ?? []
  const elementRoots = roots.filter((n) => n.type === NodeTypes.ELEMENT)
  // Ignore whitespace-only text roots (e.g. a trailing newline); anything
  // else at the root besides the single element is rejected.
  const nonWhitespaceNonElementRoots = roots.filter(
    (n) =>
      n.type !== NodeTypes.ELEMENT &&
      !(n.type === NodeTypes.TEXT && String((n as unknown as { content?: string }).content ?? '').trim() === ''),
  )
  if (elementRoots.length === 0) {
    return {
      ok: false,
      reason:
        'Insert snippet has no root element. For bare text use contentKind:"text"; otherwise wrap the content in a single element.',
    }
  }
  if (elementRoots.length > 1 || nonWhitespaceNonElementRoots.length > 0) {
    return {
      ok: false,
      reason:
        'Insert snippet must be a SINGLE root element. Wrap multiple siblings in one parent element first.',
    }
  }
  return { ok: true, root: elementRoots[0] }
}

/**
 * `ElementTypes.COMPONENT` — the Vue parser's own verdict that a tag is not a
 * native HTML/SVG element. Using it beats a hand-rolled tag list: the parser
 * already carries the authoritative `isNativeTag` set, and it classifies
 * `<my-el/>` (dashed) as a component the same way Vue's runtime resolution
 * does. (`<slot>` is SLOT, `<template>` is ELEMENT — both fall out for free.)
 */
const TAG_TYPE_COMPONENT = 1

/**
 * Tags the parser reports as components but that the RUNTIME resolves itself,
 * so they never need an import or a registration.
 */
const VUE_BUILT_IN_COMPONENTS = new Set([
  'component',
  'Transition',
  'transition',
  'TransitionGroup',
  'transition-group',
  'KeepAlive',
  'keep-alive',
  'Teleport',
  'teleport',
  'Suspense',
  'suspense',
])

/**
 * Report an inserted component tag that will not resolve to anything.
 *
 * Resolution has three legitimate sources and we check all three:
 *   1. the import this very call is adding (`componentImport`),
 *   2. a binding already in the SFC — `<script setup>` value binding, or the
 *      name appearing in an Options-API `<script>` block,
 *   3. project-level registration, which the applicator CANNOT see and the
 *      caller must supply via `resolvableComponents`.
 *
 * Returns `null` (silent) whenever the answer isn't knowable — most
 * importantly when `resolvableComponents` was not supplied, since the agent
 * tools turn any warning into a refusal and a wrong refusal is worse than the
 * silence this replaces. See the field's doc comment for the measurement.
 */
function checkComponentResolution(
  root: ElementLike,
  descriptor: {
    scriptSetup?: { content: string } | null
    script?: { content: string } | null
  },
  componentImport: ComponentImportSpec | undefined,
  resolvableComponents: readonly string[] | undefined,
): string | null {
  const tag = root.tag
  if ((root as { tagType?: number }).tagType !== TAG_TYPE_COMPONENT) return null
  if (VUE_BUILT_IN_COMPONENTS.has(tag)) return null
  // `<Ns.Foo/>` resolves through a member expression on an existing binding;
  // the base name is what matters and that is not this check's business.
  if (tag.includes('.')) return null
  // `<component :is="…">` is dynamic — already excluded by the built-in set,
  // but a tag carrying an `is` binding is dynamic too.
  if (root.props.some((p) => (p as { name?: string; arg?: unknown }).name === 'is')) return null

  // 1. The import being added right now.
  if (componentImport && tagMatchesName(tag, componentImport.name)) return null

  // 2. Already bound in this SFC.
  if (descriptor.scriptSetup) {
    const bindings = analyzeScriptBindings(descriptor.scriptSetup.content)
    // A script we couldn't parse tells us nothing — don't guess.
    if (bindings.parseError) return null
    for (const name of bindings.valueBindings) {
      if (tagMatchesName(tag, name)) return null
    }
  }
  if (descriptor.script) {
    // Options-API `components: { Foo }`. Rather than parse the block we take
    // the conservative reading: if the name appears at all, assume it's
    // registered. Over-suppressing beats a false refusal here.
    const pascal = kebabToPascal(tag)
    if (
      new RegExp(`\\b${escapeRegExp(tag)}\\b`).test(descriptor.script.content) ||
      new RegExp(`\\b${escapeRegExp(pascal)}\\b`).test(descriptor.script.content)
    ) {
      return null
    }
  }

  // 3. Project-level registration. Without the caller's ground truth we stop
  // here — see `resolvableComponents`.
  if (!resolvableComponents) return null
  if (resolvableComponents.some((name) => tagMatchesName(tag, name))) return null

  return `<${tag}> will not resolve: it is not imported or declared in this file, and the project does not register or auto-import a component by that name. Vue will render an inert element and log "Failed to resolve component: ${tag}". Check the spelling, or insert it with an import.`
}

/** Vue accepts PascalCase and kebab-case for the same component. */
function tagMatchesName(tag: string, name: string): boolean {
  if (tag === name) return true
  return pascalToKebab(tag) === pascalToKebab(name)
}

function pascalToKebab(value: string): string {
  return value.replace(/\B([A-Z])/g, '-$1').toLowerCase()
}

function kebabToPascal(value: string): string {
  return value.replace(/(^|-)([a-z])/g, (_m, _dash, ch: string) => ch.toUpperCase())
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Returns the SFC-absolute byte offset where a new child should be
 *  inserted such that, after insertion, it occupies index N among
 *  `dest`'s element children. */
function computeInsertionOffset(
  dest: ElementLike,
  destElementChildren: ElementLike[],
  preIndex: number,
  templateContent: string,
  templateOffset: number,
): number {
  if (preIndex < destElementChildren.length) {
    const target = destElementChildren[preIndex]
    return templateOffset + target.loc.start.offset
  }
  if (destElementChildren.length > 0) {
    const last = destElementChildren[destElementChildren.length - 1]
    return templateOffset + last.loc.end.offset
  }
  // No children — insert right after the open tag's `>`.
  const openTagClose = findOpenTagClose(templateContent, dest)
  if (openTagClose < 0) return -1
  if (dest.isSelfClosing) return -1
  return templateOffset + openTagClose + 1
}

function findOpenTagClose(templateContent: string, target: ElementLike): number {
  const startOffset = target.loc.start.offset
  const propsArr = target.props
  let scanFrom: number
  if (propsArr.length > 0) {
    const lastProp = propsArr[propsArr.length - 1]
    scanFrom = lastProp.loc?.end?.offset ?? startOffset + 1 + target.tag.length
  } else {
    scanFrom = startOffset + 1 + target.tag.length
  }
  for (let i = scanFrom; i < templateContent.length; i++) {
    const ch = templateContent[i]
    if (ch === '>') return i
    if (ch === '/' && templateContent[i + 1] === '>') return i
  }
  return -1
}

/**
 * Heuristic indent: look at the sibling we're inserting near and
 * copy its leading whitespace. For an empty parent, fall back to
 * the parent's column + 2.
 */
function computeIndent(
  source: string,
  dest: ElementLike,
  destElementChildren: ElementLike[],
  finalIndex: number,
  templateOffset: number,
): string {
  // Reference sibling — the next one if not appending, else the last.
  const ref =
    finalIndex < destElementChildren.length
      ? destElementChildren[finalIndex]
      : destElementChildren[destElementChildren.length - 1]
  if (ref) {
    const refStart = templateOffset + ref.loc.start.offset
    // Walk backward to find the start of the line, then count spaces.
    let lineStart = refStart
    while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--
    let i = lineStart
    while (i < refStart && (source[i] === ' ' || source[i] === '\t')) i++
    return source.slice(lineStart, i)
  }
  // Empty parent — guess at parent's column + 2 spaces (4-space
  // indent isn't worth detecting; many projects normalize).
  const parentCol = dest.loc.start.column
  return ' '.repeat(Math.max(parentCol + 1, 2))
}
