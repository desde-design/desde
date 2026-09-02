/**
 * Swap-component edit applicator (Phase F2).
 *
 * Replaces a component reference at a call-site with a different
 * component, mapping props by name and updating the consumer's
 * `<script setup>` imports. Pure (no I/O); the route + CLI handler
 * call this with the consumer SFC source already read.
 *
 * Wire shape (StructuralEdit `kind: 'swap'`):
 *   from: SourceLocation (the call-site)
 *   to: { componentName, packageName?, file? }  // new component
 *   propMapping: Record<oldProp, newProp | null>
 *     — null = drop with a `<!-- swap: dropped {x}={...} -->` marker
 *     — keys NOT present in the mapping are passed through unchanged
 *
 * V1 refusals (return { ok: false, reason }):
 *   - Element at the source location isn't the expected old component
 *     name (PascalCase or kebab-case match required).
 *   - Required props on the new component aren't satisfied after
 *     mapping (caller didn't include a value or rename for them).
 *   - Old component had named slots the new one doesn't declare AND
 *     the slot content wasn't dropped via slotMapping.
 *   - Consumer SFC has no `<template>` block.
 *
 * Out of scope (V1):
 *   - Cross-file moves of slot content.
 *   - Type rewriting (e.g. mapping a string prop to a number).
 *   - Renaming local variable names that referenced the old component.
 *   - Updating `<script>` (Options API) `components: { ... }`
 *     registrations — V1 only handles `<script setup>`.
 */

import { parse as parseSfc, type SFCDescriptor } from '@vue/compiler-sfc'
import { parse as parseTemplate, NodeTypes } from '@vue/compiler-dom'
import { resolveTemplateTarget } from './resolve-template-target'

interface ElementLike {
  type: number
  tag: string
  props: Array<{
    type: number
    name: string
    value?: { content?: string }
    arg?: { content?: string }
    exp?: { content?: string }
    loc: { start: { offset: number }; end: { offset: number } }
  }>
  children: ElementLike[]
  isSelfClosing?: boolean
  loc: {
    start: { line: number; column: number; offset: number }
    end: { line: number; column: number; offset: number }
  }
}

export interface ApplySwapEditInput {
  /** Source of the consumer SFC. */
  consumerSource: string
  /** Call-site location (1-based, SFC-absolute). */
  callSiteLine: number
  callSiteColumn: number
  /** Existing component tag at the call-site (PascalCase). */
  fromComponentName: string
  /** New component tag to replace it with (PascalCase). */
  toComponentName: string
  /**
   * Per-prop mapping. Keys are old-component prop names.
   *  - string value: renames the prop (e.g. `{ type: 'variant' }`).
   *  - null: drops the prop with a `<!-- swap: dropped X="Y" -->` marker.
   *  - keys absent from the mapping: passed through unchanged.
   *    (Designer-side picker computes the default mapping; this lets
   *     it omit keys it considers identity-mapped.)
   */
  propMapping?: Readonly<Record<string, string | null>>
  /**
   * Required props the new component declares but the call-site
   * doesn't yet provide (after mapping). The applicator surfaces
   * these as a refusal so the picker can surface them to the
   * designer rather than the LLM/applicator silently emitting
   * a broken Vue file. Inferred from the new component's manifest
   * by the caller; pass an empty array (or omit) to skip the check.
   */
  newComponentRequiredProps?: ReadonlyArray<string>
  /** New import: package OR relative file path (one or the other). */
  toPackageName?: string
  toFile?: string
  /**
   * When provided, the applicator removes the import for this name
   * if no other call-sites reference it after the swap. Caller is
   * responsible for the "no other call-sites" check (we don't walk
   * the whole project here); this just trusts the hint and removes.
   */
  removeFromImport?: boolean
}

export type ApplySwapEditResult =
  | { ok: true; source: string; warnings: string[] }
  | { ok: false; reason: string }

export function applySwapEdit(input: ApplySwapEditInput): ApplySwapEditResult {
  const {
    consumerSource,
    callSiteLine,
    callSiteColumn,
    fromComponentName,
    toComponentName,
    propMapping = {},
    newComponentRequiredProps = [],
    toPackageName,
    toFile,
    removeFromImport,
  } = input

  if (toPackageName && toFile) {
    return {
      ok: false,
      reason:
        "swap: provide either toPackageName OR toFile, not both: pick one import source",
    }
  }
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(toComponentName)) {
    return {
      ok: false,
      reason: `toComponentName "${toComponentName}" must be PascalCase`,
    }
  }
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(fromComponentName)) {
    return {
      ok: false,
      reason: `fromComponentName "${fromComponentName}" must be PascalCase`,
    }
  }

  // Resolve the call-site via the shared resolver, mapping failure kinds to
  // this applicator's historical "Consumer …" reason strings.
  const resolved = resolveTemplateTarget({
    source: consumerSource,
    line: callSiteLine,
    column: callSiteColumn,
  })
  if (!resolved.ok) {
    const f = resolved.failure
    switch (f.kind) {
      case 'sfc-parse-error':
        return {
          ok: false,
          reason: f.reason.replace(/^SFC parse failed: /, 'Consumer SFC parse failed: '),
        }
      case 'no-template':
        return { ok: false, reason: 'Consumer SFC has no <template> block' }
      case 'template-parse-error':
        return {
          ok: false,
          reason: f.reason.replace(
            /^Template parse failed: /,
            'Consumer template parse failed: ',
          ),
        }
      default:
        return {
          ok: false,
          reason: `No call-site element found at consumer line ${callSiteLine}, column ${callSiteColumn}`,
        }
    }
  }
  const callSite = resolved.node as unknown as ElementLike
  const descriptor: SFCDescriptor = resolved.ctx.descriptor
  const { templateOffset } = resolved.ctx
  const expectedKebab = pascalToKebab(fromComponentName)
  if (
    callSite.tag !== fromComponentName &&
    callSite.tag !== expectedKebab
  ) {
    return {
      ok: false,
      reason: `Element at line ${callSiteLine}, column ${callSiteColumn} is <${callSite.tag}>, not <${fromComponentName}>; refusing to swap a different element`,
    }
  }

  // Re-render the open tag. We rewrite ONLY the open tag and (for
  // non-self-closing) the close tag — slot children pass through
  // verbatim. This sidesteps the slot-mapping complexity that the V1
  // plan listed; named-slot remapping is V2 work. Today we treat
  // slots as "passes through unchanged" and refuse if the caller
  // signals slot incompatibility (newComponentRequiredProps misses
  // a slot-mapped prop, etc.).
  const newTagText = renderNewOpenTag({
    callSite,
    consumerSource,
    templateOffset,
    fromComponentName,
    toComponentName,
    propMapping,
  })
  if (!newTagText.ok) return newTagText

  // Required-prop coverage check — we know the call-site's resulting
  // attribute name set after applying the mapping; compare against
  // `newComponentRequiredProps`.
  const resultingPropNames = newTagText.resultingPropNames
  const missingRequired = newComponentRequiredProps.filter(
    (name) => !resultingPropNames.has(name),
  )
  if (missingRequired.length > 0) {
    return {
      ok: false,
      reason: `Required prop(s) missing on new <${toComponentName}>: ${missingRequired.join(', ')}. Add a renaming entry to propMapping or pass them as new attrs.`,
    }
  }

  // Compute mutations to apply against the original source. Sort
  // descending by offset so earlier splices don't disturb later
  // offsets — same pattern as apply-detach-edit.
  const ops: Array<{ start: number; end: number; replacement: string }> = []

  // Open tag splice. The compiler-dom Element.loc covers the WHOLE
  // element (open through close) for non-self-closing tags, but the
  // first prop's loc.end gives us the cutoff between attribute list
  // and the `>` (or `/>`) that closes the open tag. We need a
  // smaller surgical edit, so re-compute the open-tag bounds:
  //   start = callSite.loc.start.offset
  //   end   = position of `>` (or `/>`) closing the open tag
  const openTagBounds = computeOpenTagBounds(callSite, consumerSource, templateOffset)
  if (!openTagBounds) {
    return {
      ok: false,
      reason: `Could not locate open-tag bounds for <${callSite.tag}>; aborting swap`,
    }
  }
  ops.push({
    start: openTagBounds.start,
    end: openTagBounds.end,
    replacement: newTagText.text,
  })

  // Close tag splice (only when not self-closing).
  if (!callSite.isSelfClosing) {
    const closeTagBounds = computeCloseTagBounds(
      callSite,
      consumerSource,
      templateOffset,
      fromComponentName,
      expectedKebab,
    )
    if (closeTagBounds) {
      // Preserve the writer's casing convention: if the open tag
      // used PascalCase, write `</NewName>`; if kebab-case,
      // `</new-name>`.
      const closeText =
        callSite.tag === fromComponentName
          ? `</${toComponentName}>`
          : `</${pascalToKebab(toComponentName)}>`
      ops.push({
        start: closeTagBounds.start,
        end: closeTagBounds.end,
        replacement: closeText,
      })
    }
  }

  // Imports: insert the new one (idempotent), optionally remove the
  // old. <script setup> only — Options API users get the new import
  // appended but the old import isn't pruned (designer fixes after).
  const importEdits = computeImportEdits({
    descriptor,
    consumerSource,
    fromComponentName,
    toComponentName,
    toPackageName,
    toFile,
    removeFromImport: !!removeFromImport,
  })
  if (!importEdits.ok) return { ok: false, reason: importEdits.reason }
  ops.push(...importEdits.ops)

  ops.sort((a, b) => b.start - a.start)
  let result = consumerSource
  for (const op of ops) {
    result = result.slice(0, op.start) + op.replacement + result.slice(op.end)
  }

  // Post-write parse — catch malformed splices before we tell the
  // caller the swap succeeded.
  try {
    const reparsed = parseSfc(result).descriptor
    if (reparsed.template) {
      parseTemplate(reparsed.template.content)
    }
  } catch (err) {
    return {
      ok: false,
      reason: `Patched source failed re-parse: ${(err as Error).message}`,
    }
  }

  return { ok: true, source: result, warnings: importEdits.warnings }
}

// ─────────────────────────── Helpers ───────────────────────────

function pascalToKebab(s: string): string {
  // Mirrors Vue's `hyphenate`: insert a hyphen at every non-word-
  // boundary uppercase letter, then lowercase. Maps `UiButton` →
  // `ui-button` (not `kbutton` — that misses the convention Vue
  // templates accept).
  return s.replace(/\B([A-Z])/g, '-$1').toLowerCase()
}

function renderNewOpenTag(args: {
  callSite: ElementLike
  consumerSource: string
  templateOffset: number
  fromComponentName: string
  toComponentName: string
  propMapping: Readonly<Record<string, string | null>>
}):
  | { ok: true; text: string; resultingPropNames: Set<string> }
  | { ok: false; reason: string } {
  const {
    callSite,
    consumerSource,
    templateOffset,
    fromComponentName,
    toComponentName,
    propMapping,
  } = args

  // Match the open tag's name casing convention so we don't churn
  // case for unrelated reasons (PascalCase consumer code stays
  // PascalCase).
  const usedKebab = callSite.tag === pascalToKebab(fromComponentName)
  const newTag = usedKebab ? pascalToKebab(toComponentName) : toComponentName

  // Reconstruct each existing prop, applying the mapping. Drops
  // emit a comment marker so the change is visible in the diff.
  const propParts: string[] = []
  const droppedComments: string[] = []
  const resultingPropNames = new Set<string>()

  for (const prop of callSite.props) {
    if (prop.type === NodeTypes.ATTRIBUTE) {
      const original = prop.name
      const mapping = propMapping[original]
      if (mapping === null) {
        // Drop with marker. Render the original attr verbatim so
        // the marker shows the value the designer is losing.
        const start = templateOffset + prop.loc.start.offset
        const end = templateOffset + prop.loc.end.offset
        droppedComments.push(
          `<!-- swap: dropped ${consumerSource.slice(start, end)} -->`,
        )
        continue
      }
      const newName = mapping ?? original
      const value = prop.value?.content ?? ''
      // Quote the value the same way Vue's compiler reads it back —
      // double quotes are universally safe.
      propParts.push(`${newName}="${escapeAttr(value)}"`)
      resultingPropNames.add(newName)
    } else if (prop.type === NodeTypes.DIRECTIVE) {
      // Slice the original directive verbatim so we don't try to
      // reconstruct v-bind:foo="someExpr" syntax. The mapping only
      // applies to the bound name (foo), not the expression.
      const start = templateOffset + prop.loc.start.offset
      const end = templateOffset + prop.loc.end.offset
      const original = consumerSource.slice(start, end)
      const boundName = prop.arg?.content
      if (prop.name === 'bind' && boundName !== undefined) {
        const mapping = propMapping[boundName]
        if (mapping === null) {
          droppedComments.push(`<!-- swap: dropped ${original} -->`)
          continue
        }
        if (mapping !== undefined && mapping !== boundName) {
          // Rewrite the bound name. We do this on the raw text since
          // reconstructing v-bind syntax (`:foo="x"` vs
          // `v-bind:foo="x"`) is fiddly. Replace the FIRST occurrence
          // of the bound name AFTER the `:` or `bind:` prefix.
          const rewritten = rewriteBoundName(original, boundName, mapping)
          propParts.push(rewritten)
          resultingPropNames.add(mapping)
          continue
        }
        propParts.push(original)
        resultingPropNames.add(boundName)
        continue
      }
      // Non-bind directives (v-if, v-for, v-on, v-model, etc) pass
      // through verbatim — they're framework-level, not prop-level.
      propParts.push(original)
    }
  }

  const propsText = propParts.length > 0 ? ' ' + propParts.join(' ') : ''
  const close = callSite.isSelfClosing ? ' />' : '>'
  // Drop comments are placed BEFORE the open tag so the resulting
  // source stays parseable (HTML attribute slot can't host comments).
  const droppedPrefix =
    droppedComments.length > 0 ? droppedComments.join('') + '\n' : ''
  return {
    ok: true,
    text: `${droppedPrefix}<${newTag}${propsText}${close}`,
    resultingPropNames,
  }
}

function rewriteBoundName(
  rawDirective: string,
  oldName: string,
  newName: string,
): string {
  // `:foo="..."` → `:newName="..."`
  // `v-bind:foo="..."` → `v-bind:newName="..."`
  const colonIdx = rawDirective.indexOf(':')
  if (colonIdx < 0) return rawDirective
  // Replace from colonIdx+1 to the next non-name char.
  let end = colonIdx + 1
  while (end < rawDirective.length && /[A-Za-z0-9_-]/.test(rawDirective[end])) {
    end++
  }
  const before = rawDirective.slice(0, colonIdx + 1)
  const matched = rawDirective.slice(colonIdx + 1, end)
  const after = rawDirective.slice(end)
  if (matched !== oldName) {
    // Defensive — caller's hint didn't match the source. Leave alone.
    return rawDirective
  }
  return `${before}${newName}${after}`
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function computeOpenTagBounds(
  callSite: ElementLike,
  consumerSource: string,
  templateOffset: number,
): { start: number; end: number } | null {
  const start = templateOffset + callSite.loc.start.offset
  // Search forward from the start for the first `>` that's NOT
  // inside an attribute value. We can do this by scanning and
  // tracking quote state.
  const limit = templateOffset + callSite.loc.end.offset
  let inQuote: '"' | "'" | null = null
  for (let i = start; i < limit; i++) {
    const ch = consumerSource[i]
    if (inQuote) {
      if (ch === inQuote) inQuote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch
      continue
    }
    if (ch === '>') {
      return { start, end: i + 1 }
    }
    if (ch === '/' && consumerSource[i + 1] === '>') {
      return { start, end: i + 2 }
    }
  }
  return null
}

function computeCloseTagBounds(
  callSite: ElementLike,
  consumerSource: string,
  templateOffset: number,
  fromComponentName: string,
  expectedKebab: string,
): { start: number; end: number } | null {
  const elementEnd = templateOffset + callSite.loc.end.offset
  // Walk back from elementEnd looking for `</NAME>` matching either
  // PascalCase or kebab-case form.
  for (const tag of [fromComponentName, expectedKebab]) {
    const close = `</${tag}>`
    const idx = consumerSource.lastIndexOf(close, elementEnd)
    if (idx >= templateOffset && idx + close.length === elementEnd) {
      return { start: idx, end: elementEnd }
    }
  }
  return null
}

interface ImportEdits {
  ops: Array<{ start: number; end: number; replacement: string }>
  warnings: string[]
}

function computeImportEdits(args: {
  descriptor: SFCDescriptor
  consumerSource: string
  fromComponentName: string
  toComponentName: string
  toPackageName?: string
  toFile?: string
  removeFromImport: boolean
}): { ok: true; ops: ImportEdits['ops']; warnings: string[] } | { ok: false; reason: string } {
  const {
    descriptor,
    fromComponentName,
    toComponentName,
    toPackageName,
    toFile,
    removeFromImport,
  } = args
  const warnings: string[] = []
  const ops: ImportEdits['ops'] = []
  const setup = descriptor.scriptSetup
  if (!setup) {
    warnings.push(
      `Consumer has no <script setup> block: caller must add the import for <${toComponentName}> manually.`,
    )
    return { ok: true, ops, warnings }
  }
  const setupContent = setup.content
  const setupOffset = setup.loc.start.offset

  // Skip the new-import injection if the consumer already imports the
  // target by the same name. Three forms to recognize:
  //   - default:           `import ToComp from 'x'`
  //   - named:             `import { ToComp } from 'x'` (also `Foo, ToComp`)
  //   - mixed default+named: `import Other, { ToComp } from 'x'`
  // Doesn't catch aliased imports (`import { Foo as ToComp }`) —
  // those are unusual enough for V1 to accept the dup as a designer-
  // noticed quirk.
  const safeName = toComponentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const alreadyImported =
    new RegExp(`import\\s+${safeName}(?:\\s*,|\\s+from)`).test(setupContent) ||
    new RegExp(`import\\s+\\{[^}]*\\b${safeName}\\b[^}]*\\}\\s+from`).test(setupContent) ||
    new RegExp(`import\\s+[A-Za-z_$][\\w$]*\\s*,\\s*\\{[^}]*\\b${safeName}\\b[^}]*\\}\\s+from`).test(setupContent)

  if (!alreadyImported) {
    // Build the import statement.
    const importStatement = (() => {
      if (toPackageName) {
        return `import { ${toComponentName} } from '${toPackageName}'\n`
      }
      if (toFile) {
        return `import ${toComponentName} from '${toFile}'\n`
      }
      // No package/file given — the new component is assumed to be
      // globally registered (e.g. via Vite plugin auto-import).
      // Emit a warning rather than fail; Acme DS-style globals
      // are common.
      warnings.push(
        `No toPackageName/toFile provided for <${toComponentName}>; assuming auto-import. Add the import manually if it's not registered.`,
      )
      return null
    })()
    if (importStatement) {
      // Insert at the very top of the script-setup body (after any
      // existing imports we don't analyze in detail; the convention
      // is for imports to live at the top, so this collocates).
      ops.push({
        start: setupOffset,
        end: setupOffset,
        replacement: importStatement,
      })
    }
  }

  if (removeFromImport) {
    // Find an import line that mentions fromComponentName as a named
    // or default specifier and remove just that mention. If it's the
    // only specifier in a named-imports list, remove the whole line.
    const removal = findImportRemoval(setupContent, fromComponentName)
    if (removal) {
      ops.push({
        start: setupOffset + removal.start,
        end: setupOffset + removal.end,
        replacement: removal.replacement,
      })
    } else {
      warnings.push(
        `Could not find import for <${fromComponentName}> to remove; left as-is.`,
      )
    }
  }
  return { ok: true, ops, warnings }
}

function findImportRemoval(
  setupContent: string,
  componentName: string,
): { start: number; end: number; replacement: string } | null {
  const safeName = componentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // Pure default-import: `import Foo from 'x'` → remove whole line.
  const defaultRe = new RegExp(
    `(?:^|\\n)\\s*import\\s+${safeName}\\s+from\\s+['"][^'"]+['"]\\s*\\n?`,
  )
  const defaultMatch = defaultRe.exec(setupContent)
  if (defaultMatch) {
    return {
      start: defaultMatch.index,
      end: defaultMatch.index + defaultMatch[0].length,
      replacement: '',
    }
  }

  // Mixed default+named: `import Foo, { Bar, Baz } from 'x'`
  //   - if componentName matches the default specifier:
  //     - keep named: `import { Bar, Baz } from 'x'`
  //   - if componentName matches a named specifier:
  //     - drop just that named specifier, keeping default
  //     - if it was the only named specifier, fall back to default-only
  //       form: `import Foo from 'x'`
  const mixedRe =
    /(import\s+)([A-Za-z_$][\w$]*)(\s*,\s*\{)([^}]+)(\}\s*from\s+['"][^'"]+['"])\s*(\n)?/g
  let mm: RegExpExecArray | null
  while ((mm = mixedRe.exec(setupContent)) !== null) {
    const fullStart = mm.index
    const fullEnd = mm.index + mm[0].length
    const trailingNewline = mm[6] ?? ''
    const defaultName = mm[2]
    const namedRaw = mm[4]
    const namedSpecifiers = namedRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    // Default removal?
    if (defaultName === componentName) {
      // Drop the default specifier; keep the named clause.
      return {
        start: fullStart,
        end: fullEnd - trailingNewline.length,
        replacement: `${mm[1]}{ ${namedSpecifiers.join(', ')} }${mm[5].slice(1)}`,
      }
    }

    // Named-list removal?
    const filtered = namedSpecifiers.filter((s) => {
      const parts = s.split(/\s+as\s+/)
      return parts[0] !== componentName && parts[parts.length - 1] !== componentName
    })
    if (filtered.length === namedSpecifiers.length) continue // not in this import
    if (filtered.length === 0) {
      // Drop the entire `, { … }` clause; default-only import remains.
      return {
        start: fullStart,
        end: fullEnd - trailingNewline.length,
        replacement: `${mm[1]}${defaultName}${mm[5].replace(/^\}\s*from/, ' from')}`,
      }
    }
    return {
      start: fullStart,
      end: fullEnd - trailingNewline.length,
      replacement: `${mm[1]}${defaultName}${mm[3]} ${filtered.join(', ')} ${mm[5]}`,
    }
  }

  // Pure named-imports: extract braces, count specifiers.
  // `import { Foo, Bar } from 'x'` → `import { Bar } from 'x'`
  // `import { Foo } from 'x'` → remove whole line.
  const namedRe = /(import\s*\{)([^}]+)(\}\s*from\s+['"][^'"]+['"])\s*(\n)?/g
  let m: RegExpExecArray | null
  while ((m = namedRe.exec(setupContent)) !== null) {
    const specifiers = m[2]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const filtered = specifiers.filter((s) => {
      // Handle `Foo as Bar` aliases — drop only when alias OR original
      // matches.
      const parts = s.split(/\s+as\s+/)
      return parts[0] !== componentName && parts[parts.length - 1] !== componentName
    })
    if (filtered.length === specifiers.length) continue // not in this import
    if (filtered.length === 0) {
      // Remove whole import statement (incl. trailing newline).
      return {
        start: m.index,
        end: m.index + m[0].length,
        replacement: '',
      }
    }
    return {
      start: m.index,
      end: m.index + m[0].length - (m[4] ?? '').length,
      replacement: `${m[1]} ${filtered.join(', ')} ${m[3]}`,
    }
  }
  return null
}
