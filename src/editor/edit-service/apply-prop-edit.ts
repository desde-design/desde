/**
 * Pure (filesystem-free) prop-edit applicator. Given a Vue SFC's source and
 * the build-time `(line, column)` of an element's start tag, produce a new
 * source with one prop set to a new value.
 *
 * Inputs use *SFC-absolute* line/column — the convention `vite-plugin-source-tag`
 * writes into `data-desde-src`. In `@vitejs/plugin-vue` v6 the node-transform
 * sees positions from the reused SFC parse, which carry SFC-absolute lines
 * regardless of where the `<template>` block sits relative to `<script>`.
 * (When `<template>` happens to be on line 1, SFC-absolute and template-content-
 * relative coincide; when `<script>` comes first they diverge — V1.3
 * regression confirmed.)
 *
 * To match elements, this module re-parses the template content with
 * `@vue/compiler-dom` (which emits template-content-relative loc) and shifts
 * those positions by the SFC's `<template>` block start before comparing
 * against the requested SFC-absolute coords.
 *
 * V1.3 scope: only PropEdit, only string / number / boolean values. Everything
 * else returns `{ ok: false, reason }`. The pure-function contract makes
 * future edit kinds (variant swaps, deletes, reorders) drop into the same
 * shape without coupling to filesystem or Next.js.
 */

import { parse as parseSfc } from '@vue/compiler-sfc'
import { compile as compileTemplate, NodeTypes } from '@vue/compiler-dom'
import { resolveTemplateTarget } from './resolve-template-target'

export type PropEditValue = string | number | boolean

export interface ApplyPropEditInput {
  /** Full SFC source text. */
  source: string
  /** 1-based line within the SFC (the same coords `data-desde-src` carries). */
  line: number
  /** 1-based column within the SFC. */
  column: number
  /** Name of the prop / attribute to set. */
  propName: string
  /** New value. String → quoted attribute. Number / boolean → `v-bind` shorthand. */
  value: PropEditValue
}

/**
 * Set on refusals where the source semantics are richer than this deterministic
 * applicator can safely rewrite, but a source-aware LLM pass *might* succeed
 * by tracing the binding to its definition (a local ref/const) and editing
 * there. The edit handler (`editor-cli/src/server/edit-handler.ts`) consumes
 * this hint to transparently fall back to the agent mini-turn
 * (`src/editor/agent-chat-sdk/edit-fix-mini-turn.ts`); the LLM can refuse too,
 * in which case the user sees the combined reason.
 *
 * Kinds:
 *  - `bound-binding`: existing prop is `:foo="expr"` where expr is non-literal.
 *  - `dynamic-vbind`:  target has `v-bind="…"` spread or `:[name]="…"` arg.
 *  - `v-model`:        target has a `v-model` that could supply this prop.
 */
export type PropEditFallbackHint =
  | { kind: 'bound-binding'; expression: string }
  | { kind: 'dynamic-vbind' }
  | { kind: 'v-model' }

export type ApplyPropEditResult =
  | { ok: true; source: string }
  | { ok: false; reason: string; fallback?: PropEditFallbackHint }

interface ElementLike {
  type: number
  tag: string
  loc: { start: { line: number; column: number; offset: number }; end: { offset: number } }
  props: Array<PropLike>
  children: Array<{ loc: { start: { offset: number } } }>
  isSelfClosing: boolean
}

interface AttributePropLike {
  type: typeof NodeTypes.ATTRIBUTE
  name: string
  loc: { start: { offset: number }; end: { offset: number } }
}

interface DirectivePropLike {
  type: typeof NodeTypes.DIRECTIVE
  name: string
  rawName?: string
  /**
   * The directive's argument node. For `:label="…"` the arg is a static
   * SimpleExpressionNode with `content: "label"` and `isStatic: true`. For
   * a dynamic arg `:[propName]="…"` the arg is non-static (`isStatic: false`,
   * `content: "propName"`). For a spread `v-bind="…"` the arg is missing.
   */
  arg?: { content: string; isStatic?: boolean } | null
  /**
   * The directive's expression node. For `:label="title"` the `exp.content`
   * is `title`; for `:variant="'primary'"` it's `'primary'` (with quotes).
   * Used to distinguish a v-bind to a literal expression (safe to convert to
   * a static attribute) from a v-bind to a variable/expression (unsafe —
   * converting destroys the binding).
   */
  exp?: { content: string } | null
  loc: { start: { offset: number }; end: { offset: number } }
}

type PropLike = AttributePropLike | DirectivePropLike

/**
 * Vue attribute names: identifier-style + optional dashes. Same regex
 * the route uses upstream for typed PropEdit bodies. Validating here
 * too gives defense in depth — the bridge attr-mutation fast-path
 * (route.ts) passes `m.target` straight through to this applicator
 * after a bare `typeof === 'string'` check, so a malformed mutation
 * payload could otherwise splice arbitrary characters into source
 * (Codex review P0).
 */
const SAFE_PROP_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/

/** Refuse a true no-op (patched === source) so the handler never writes an
 *  unchanged file and reports "committed". Deterministic applicators refuse
 *  no-ops upstream of the handler's batch-level no-op guard. Mirrors
 *  `okOrNoop` in the JSX sibling (apply-jsx-prop-edit.ts).
 *
 *  Also runs the post-splice validation (WS2 defense-in-depth, tasks/
 *  edit-pipeline-rearchitecture.md) on every genuinely-changed result —
 *  ordered AFTER the no-op check so a no-op never pays the re-parse cost
 *  and always gets the historical "unchanged" reason. Mirrors
 *  `apply-move-edit.ts`'s post-splice check: the splice operates on byte
 *  offsets and doesn't validate that the resulting markup is well-formed;
 *  re-parse the SFC and compile the template, refusing rather than writing
 *  a silently-broken file. */
function okOrNoop(source: string, next: string): ApplyPropEditResult {
  if (next === source) {
    return { ok: false, reason: 'Prop value is unchanged: no edit needed.' }
  }
  try {
    const newDescriptor = parseSfc(next).descriptor
    if (!newDescriptor.template) {
      return { ok: false, reason: 'Post-splice SFC lost its <template> block' }
    }
    compileTemplate(newDescriptor.template.content)
  } catch (err) {
    return {
      ok: false,
      reason: `Post-splice template compile failed: ${(err as Error).message}`,
    }
  }
  return { ok: true, source: next }
}

export function applyPropEdit(input: ApplyPropEditInput): ApplyPropEditResult {
  const { source, line, column, propName, value } = input

  if (!SAFE_PROP_NAME_RE.test(propName)) {
    return {
      ok: false,
      reason: `Refused: propName "${propName}" does not match the safe pattern /^[A-Za-z_][A-Za-z0-9_-]*$/. The applicator splices the name verbatim into source; arbitrary input would corrupt the SFC.`,
    }
  }

  // 1-3. Resolve the target element via the shared resolver (parse the SFC,
  //      re-parse the template content, shift template-content-relative loc
  //      to SFC-absolute, exact-match walk). See resolve-template-target.ts.
  const resolved = resolveTemplateTarget({ source, line, column })
  if (!resolved.ok) {
    return { ok: false, reason: resolved.failure.reason }
  }
  const target = resolved.node as unknown as ElementLike
  const { templateContent, templateOffset } = resolved.ctx

  // 4. Render the replacement attribute fragment.
  const fragment = renderAttribute(propName, value)
  if (fragment === null) {
    return {
      ok: false,
      reason: `Unsupported prop value type for "${propName}": ${typeof value}`,
    }
  }

  // 5. Refuse outright when the target carries a dynamic `v-bind` (object
  //    spread `v-bind="…"` or dynamic-arg `:[name]="…"`). Even if a static
  //    prop of the same name exists, the runtime value may have been
  //    supplied by the spread (Vue's prop resolution is order-dependent
  //    and we can't safely emulate it here). Conservative refusal across
  //    BOTH the existing-prop branch and the insert branch prevents source
  //    corruption (Codex review P0 round-3).
  const hasDynamicVBind = target.props.some(
    (p) => p.type === NodeTypes.DIRECTIVE && p.name === 'bind' && !p.arg,
  )
  const hasDynamicArgVBind = target.props.some(
    (p) =>
      p.type === NodeTypes.DIRECTIVE &&
      p.name === 'bind' &&
      p.arg !== null &&
      p.arg !== undefined &&
      p.arg.isStatic === false,
  )
  if (hasDynamicVBind || hasDynamicArgVBind) {
    return {
      ok: false,
      reason: `Cannot set prop "${propName}": target has a dynamic v-bind (spread or computed argument). Add the prop explicitly in source so the inspector can edit it deterministically.`,
      fallback: { kind: 'dynamic-vbind' },
    }
  }

  // 5b. Refuse when a `v-model` directive could supply the target prop
  //     (Codex review P0 round-4). `v-model` is sugar for a prop +
  //     listener pair: `v-model="x"` binds `modelValue`, `v-model:foo="x"`
  //     binds `foo`, `v-model:[name]="x"` binds whatever the dynamic arg
  //     evaluates to. Inserting a literal `prop="…"` next to the directive
  //     would either silently override the binding (breaking two-way data
  //     flow) or sit alongside it producing an undefined merge order.
  //     Refuse rather than guess.
  const kebabPropName = camelToKebab(propName)
  const vModelCouldSupply = target.props.some((p) => {
    if (p.type !== NodeTypes.DIRECTIVE) return false
    if (p.name !== 'model') return false
    // No arg → binds `modelValue`.
    if (!p.arg) return propName === 'modelValue'
    // Dynamic arg → could be any prop; we can't prove otherwise.
    if (p.arg.isStatic === false) return true
    // Static arg → matches when arg.content equals propName, or its
    // kebab-case form (Vue normalizes both at runtime — see propMatches).
    return p.arg.content === propName || p.arg.content === kebabPropName
  })
  if (vModelCouldSupply) {
    return {
      ok: false,
      reason: `Cannot set prop "${propName}": target uses v-model to bind this prop. Edit the bound expression at its source instead.`,
      fallback: { kind: 'v-model' },
    }
  }

  // 6. Look for an existing prop or directive carrying this name.
  const existing = target.props.find((p) => propMatches(p, propName))

  if (existing) {
    // Refuse to overwrite a `v-bind` directive bound to a non-literal
    // expression with any literal value (Codex review P0 round-7). The
    // replacement would silently destroy the dependency — e.g.
    //   `:label="title"`   replaced with `label="New"`  drops `title`
    //   `:disabled="isOn"` replaced with `:disabled="false"` drops `isOn`
    //   `:count="total"`   replaced with `:count="5"`     drops `total`
    // Bindings to literal expressions (`:variant="'primary'"`,
    // `:count="42"`) are safe to convert because the expression has no
    // external reference to break.
    if (
      existing.type === NodeTypes.DIRECTIVE &&
      !isLiteralExpression(existing.exp?.content)
    ) {
      const expression = existing.exp?.content ?? '<unknown>'
      return {
        ok: false,
        reason: `Cannot overwrite bound prop "${propName}": source uses v-bind to an expression (\`${expression}\`). Edit the bound expression at its source instead.`,
        fallback: { kind: 'bound-binding', expression },
      }
    }
    // Replace the existing attribute span (offsets relative to templateContent
    // → shift by templateOffset to land in SFC source coordinates).
    const start = templateOffset + existing.loc.start.offset
    const end = templateOffset + existing.loc.end.offset
    const newSource = source.slice(0, start) + fragment + source.slice(end)
    return okOrNoop(source, newSource)
  }

  // 7. Insert before the open-tag close. We compute the close position by
  //    scanning from after the last prop (or the tag name) for the first `>`
  //    or `/>`. This avoids miscounting `>` inside attribute values because
  //    we start past every attribute the parser reported.
  const closePos = findOpenTagClose(templateContent, target)
  if (closePos < 0) {
    return { ok: false, reason: 'Could not locate open-tag close' }
  }
  const insertAt = templateOffset + closePos
  // If the previous char is whitespace we insert "fragment ", otherwise " fragment".
  const prevChar = source[insertAt - 1]
  const insertion = prevChar && /\s/.test(prevChar) ? `${fragment} ` : ` ${fragment}`
  const newSource = source.slice(0, insertAt) + insertion + source.slice(insertAt)
  return okOrNoop(source, newSource)
}

function propMatches(prop: PropLike, name: string): boolean {
  const kebabName = camelToKebab(name)
  if (prop.type === NodeTypes.ATTRIBUTE) {
    return prop.name === name || prop.name === kebabName
  }
  // Directive: match `v-bind:foo` / `:foo` / `.foo` shorthand by arg content.
  // Vue accepts both camelCase (`:fooBar="…"`) and kebab-case
  // (`:foo-bar="…"`) at the callsite and normalizes to `instance.props.fooBar`
  // at runtime. Codex review P0 round-5: without kebab-case equivalence,
  // editing `instance.props.labelText` against source `:label-text="title"`
  // misses the existing directive and inserts a literal `labelText="…"`
  // beside the binding, breaking the bound source path.
  if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind') {
    return prop.arg?.content === name || prop.arg?.content === kebabName
  }
  return false
}

/**
 * Mirrors Vue's `hyphenate`: insert a hyphen at every non-word-boundary
 * uppercase letter, then lowercase. Maps `labelText` → `label-text`.
 * Idempotent on already-kebab strings (no uppercase letters → no hyphens
 * inserted).
 */
function camelToKebab(s: string): string {
  return s.replace(/\B([A-Z])/g, '-$1').toLowerCase()
}

function renderAttribute(name: string, value: PropEditValue): string | null {
  if (typeof value === 'string') {
    return `${name}="${escapeAttr(value)}"`
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `:${name}="${value}"`
  }
  if (typeof value === 'boolean') {
    return value ? `:${name}="true"` : `:${name}="false"`
  }
  return null
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/**
 * True when the given v-bind expression source is a self-contained literal:
 * a quoted string, a number, `true` / `false`, or `null`. Bound props whose
 * expression is a literal can be safely converted to a static attribute
 * because there's no external reference to break. Anything else (a variable
 * name, a property access, a call) carries a dependency and must not be
 * silently overwritten.
 */
function isLiteralExpression(content: string | undefined): boolean {
  if (!content) return false
  const trimmed = content.trim()
  if (trimmed.length === 0) return false
  // Quoted string: `'foo'`, `"foo"`, or template-literal with no
  // interpolation. We accept only the simple two-quote shapes; template
  // literals are uncommon for prop bindings.
  if (/^'[^'\\]*(?:\\.[^'\\]*)*'$/.test(trimmed)) return true
  if (/^"[^"\\]*(?:\\.[^"\\]*)*"$/.test(trimmed)) return true
  // Number, boolean, null
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return true
  if (trimmed === 'true' || trimmed === 'false' || trimmed === 'null') return true
  return false
}

/** Scan templateContent from after the last attribute (or the tag name) to
 *  find the position of the open-tag close character. Returns the offset of
 *  `>` or the offset of `/` in `/>`. */
function findOpenTagClose(templateContent: string, target: ElementLike): number {
  const startOffset = target.loc.start.offset
  let scanFrom: number
  if (target.props.length > 0) {
    const lastProp = target.props[target.props.length - 1]
    scanFrom = lastProp.loc.end.offset
  } else {
    // Skip past `<TagName`.
    scanFrom = startOffset + 1 + target.tag.length
  }
  for (let i = scanFrom; i < templateContent.length; i++) {
    const ch = templateContent[i]
    if (ch === '>') return i
    if (ch === '/' && templateContent[i + 1] === '>') return i
  }
  return -1
}
