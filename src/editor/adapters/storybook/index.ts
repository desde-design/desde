/**
 * Storybook CSF (Component Story Format) static manifest source.
 *
 * Why this exists: Storybook is the lingua franca for design systems —
 * Vue, React, Svelte, Angular all converge on the same `Meta`/`StoryObj`
 * shape with `argTypes` (prop schema + control kind) and `args` (default
 * values). A single ingestion path covers many (framework × design-system)
 * pairs the per-pair extractors cannot.
 *
 * V1 scope: parses `*.stories.{ts,tsx,js,jsx}` files via the TypeScript
 * compiler API, extracts `meta.argTypes` and `meta.args`, normalizes to
 * `ComponentManifest`. No runtime import — safe to run in any environment
 * with read access to the source files.
 *
 * Out of scope (deferred to follow-ups):
 * - MDX docs files (`*.mdx`) — different parser, separate task
 * - Per-story argType overrides — the inspector surfaces a single
 *   canonical schema; story-level snapshots live one layer up
 * - Live HTTP ingestion of a deployed Storybook's `index.json`
 * - Type-driven options inference (an argType with no `options` and no
 *   string-union TS type cannot be widened from CSF alone — chain a
 *   TypeDeclarationManifestSource for that)
 */
import * as ts from 'typescript'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type {
  ComponentManifest,
  ComponentManifestSource,
  ComponentPropManifest,
  DefaultValueSource,
  DesignSystemId,
  FrameworkId,
  ManifestControl,
  ManifestValue,
} from '../../core'
import { kebabCase } from '../kebab-case'

export interface StorybookManifestSourceOptions {
  /**
   * Explicit list of story file paths to parse. Callers glob however
   * they prefer (fast-glob, fs.glob, manual readdir) — this source stays
   * pure-input so it remains testable without filesystem fixtures.
   */
  storyFiles: string[]
  /** Framework-id stamped onto produced manifests. Defaults to 'vue3'. */
  framework?: FrameworkId
  /** Design-system id stamped onto produced manifests. Defaults to 'unknown'. */
  designSystem?: DesignSystemId
  /**
   * Override the import path baked into produced manifests. When
   * omitted, derived per-component from the parsed CSF file's import
   * statement that brought in `meta.component`.
   */
  importPath?: string
  /**
   * Override how a component name is resolved from a meta block.
   * Default precedence: `meta.component` identifier → last segment of
   * `meta.title` → file basename minus `.stories.<ext>`.
   */
  componentNameResolver?: (ctx: ComponentNameContext) => string | null
}

export interface ComponentNameContext {
  filePath: string
  metaTitle?: string
  metaComponentName?: string
  metaComponentImportPath?: string
}

export class StorybookManifestSource implements ComponentManifestSource {
  readonly id = 'storybook'
  readonly framework: FrameworkId
  readonly designSystem: DesignSystemId

  private readonly options: StorybookManifestSourceOptions
  private cache: Map<string, ComponentManifest> | null = null

  constructor(options: StorybookManifestSourceOptions) {
    this.options = options
    this.framework = options.framework ?? 'vue3'
    this.designSystem = options.designSystem ?? 'unknown'
  }

  async listComponents(): Promise<ComponentManifest[]> {
    return Array.from(this.populate().values())
  }

  async getComponent(name: string): Promise<ComponentManifest | null> {
    return this.populate().get(name) ?? null
  }

  /**
   * Force-rebuild the cache. Call after a story file is edited if the
   * source instance is being reused across edits.
   */
  invalidate(): void {
    this.cache = null
  }

  private populate(): Map<string, ComponentManifest> {
    if (this.cache) return this.cache
    const cache = new Map<string, ComponentManifest>()
    for (const filePath of this.options.storyFiles) {
      let source: string
      try {
        source = readFileSync(filePath, 'utf8')
      } catch {
        continue
      }
      const parsed = parseStoryFile(filePath, source)
      if (!parsed) continue
      const manifest = this.toManifest(filePath, parsed)
      if (!manifest) continue
      // Last-writer-wins on duplicate names. Stable ordering of
      // storyFiles is the caller's responsibility.
      cache.set(manifest.name, manifest)
    }
    this.cache = cache
    return cache
  }

  private toManifest(
    filePath: string,
    parsed: ParsedStoryFile,
  ): ComponentManifest | null {
    const ctx: ComponentNameContext = {
      filePath,
      metaTitle: parsed.title,
      metaComponentName: parsed.componentImportName,
      metaComponentImportPath: parsed.componentImportPath,
    }
    const name = this.options.componentNameResolver?.(ctx) ?? defaultResolveName(ctx)
    if (!name) return null

    const importPath = this.options.importPath ?? parsed.componentImportPath

    const props = parsed.argTypes.map((at) =>
      argTypeToProp(at, parsed.args, filePath, this.framework, this.designSystem),
    )

    return {
      id: `${this.designSystem}.${kebabCase(name)}`,
      name,
      framework: this.framework,
      designSystem: this.designSystem,
      importPath,
      description: parsed.description,
      props,
      slots: [],
      events: [],
      source: {
        framework: this.framework,
        designSystem: this.designSystem,
        extractor: 'storybook-csf-static',
        declarations: [{ file: filePath }],
      },
    }
  }
}

function defaultResolveName(ctx: ComponentNameContext): string | null {
  if (ctx.metaComponentName) return ctx.metaComponentName
  if (ctx.metaTitle) {
    const parts = ctx.metaTitle.split('/').filter((s) => s.length > 0)
    if (parts.length > 0) return parts[parts.length - 1]
  }
  const base = basename(ctx.filePath)
  const stripped = base.replace(/\.stories\.[a-z]+$/i, '')
  return stripped || null
}

// ────────────────────────── CSF parsing ──────────────────────────

interface ParsedStoryFile {
  componentImportName?: string
  componentImportPath?: string
  title?: string
  description?: string
  argTypes: ArgTypeDef[]
  args: Record<string, ManifestValue>
}

interface ArgTypeDef {
  name: string
  description?: string
  control?: ParsedControl
  options?: ManifestValue[]
  type?: string
  required?: boolean
  defaultValue?: ManifestValue
}

interface ParsedControl {
  type?: string
  options?: ManifestValue[]
}

const UNRESOLVED = Symbol('unresolved')
type ResolvedValue = ManifestValue | typeof UNRESOLVED

export function parseStoryFile(
  filePath: string,
  source: string,
): ParsedStoryFile | null {
  const sf = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  )

  // Build map: import name → import specifier path.
  const imports = new Map<string, string>()
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const specPath = stmt.moduleSpecifier.text
    const clauses = stmt.importClause
    if (!clauses) continue
    if (clauses.name) imports.set(clauses.name.text, specPath)
    const named = clauses.namedBindings
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) imports.set(el.name.text, specPath)
    }
  }

  // Find the default export. Two shapes:
  // - `export default { ... } [satisfies/as Meta<...>]`
  // - `const meta: Meta<...> = { ... }; export default meta`
  let metaObject: ts.ObjectLiteralExpression | null = null
  for (const stmt of sf.statements) {
    if (!ts.isExportAssignment(stmt) || stmt.isExportEquals) continue
    const expr = unwrap(stmt.expression)
    if (ts.isObjectLiteralExpression(expr)) {
      metaObject = expr
    } else if (ts.isIdentifier(expr)) {
      const found = findVariable(sf, expr.text)
      if (found && ts.isObjectLiteralExpression(found)) metaObject = found
    }
  }
  if (!metaObject) return null

  const result: ParsedStoryFile = { argTypes: [], args: {} }

  for (const prop of metaObject.properties) {
    // Shorthand property assignments: `{ component }` desugars to
    // `{ component: component }`. Common in CSF when a writer pulls
    // the component identifier in via import and references it bare.
    if (ts.isShorthandPropertyAssignment(prop)) {
      const key = prop.name.text
      if (key === 'component') {
        result.componentImportName = key
        result.componentImportPath = imports.get(key)
      }
      continue
    }
    if (!ts.isPropertyAssignment(prop)) continue
    const key = propertyKeyName(prop.name)
    if (!key) continue

    if (key === 'title') {
      const v = readLiteralValue(prop.initializer)
      if (typeof v === 'string') result.title = v
    } else if (key === 'component' && ts.isIdentifier(prop.initializer)) {
      result.componentImportName = prop.initializer.text
      result.componentImportPath = imports.get(prop.initializer.text)
    } else if (key === 'args' && ts.isObjectLiteralExpression(prop.initializer)) {
      result.args = parseObjectLiteralAsValueMap(prop.initializer)
    } else if (key === 'argTypes' && ts.isObjectLiteralExpression(prop.initializer)) {
      result.argTypes = parseArgTypesObject(prop.initializer)
    } else if (key === 'parameters' && ts.isObjectLiteralExpression(prop.initializer)) {
      const docs = parseObjectLiteralAsValueMap(prop.initializer)['docs']
      if (docs && typeof docs === 'object' && !Array.isArray(docs)) {
        const desc = (docs as Record<string, ManifestValue>)['description']
        if (desc && typeof desc === 'object' && !Array.isArray(desc)) {
          const componentDesc = (desc as Record<string, ManifestValue>)['component']
          if (typeof componentDesc === 'string') result.description = componentDesc
        }
      }
    }
  }

  return result
}

function unwrap(expr: ts.Expression): ts.Expression {
  while (
    ts.isAsExpression(expr) ||
    ts.isParenthesizedExpression(expr) ||
    ts.isSatisfiesExpression(expr)
  ) {
    expr = (expr as { expression: ts.Expression }).expression
  }
  return expr
}

function findVariable(sf: ts.SourceFile, name: string): ts.Expression | null {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.name.text === name &&
        decl.initializer
      ) {
        return unwrap(decl.initializer)
      }
    }
  }
  return null
}

function propertyKeyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text
  }
  return null
}

function parseObjectLiteralAsValueMap(
  obj: ts.ObjectLiteralExpression,
): Record<string, ManifestValue> {
  const result: Record<string, ManifestValue> = {}
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const key = propertyKeyName(prop.name)
    if (!key) continue
    const value = readLiteralValue(prop.initializer)
    if (value !== UNRESOLVED) result[key] = value
  }
  return result
}

function readLiteralValue(node: ts.Expression): ResolvedValue {
  // Negated numeric literals.
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken
  ) {
    const inner = readLiteralValue(node.operand)
    if (typeof inner === 'number') return -inner
    return UNRESOLVED
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isArrayLiteralExpression(node)) {
    const arr: ManifestValue[] = []
    for (const el of node.elements) {
      const v = readLiteralValue(el)
      if (v === UNRESOLVED) return UNRESOLVED
      arr.push(v)
    }
    return arr
  }
  if (ts.isObjectLiteralExpression(node)) {
    const obj: { [k: string]: ManifestValue } = {}
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) continue
      const key = propertyKeyName(prop.name)
      if (!key) continue
      const v = readLiteralValue(prop.initializer)
      if (v === UNRESOLVED) return UNRESOLVED
      obj[key] = v
    }
    return obj
  }
  return UNRESOLVED
}

function parseArgTypesObject(obj: ts.ObjectLiteralExpression): ArgTypeDef[] {
  const out: ArgTypeDef[] = []
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const propName = propertyKeyName(prop.name)
    if (!propName) continue
    const init = prop.initializer
    if (!ts.isObjectLiteralExpression(init)) continue

    const def: ArgTypeDef = { name: propName }
    for (const inner of init.properties) {
      if (!ts.isPropertyAssignment(inner)) continue
      const k = propertyKeyName(inner.name)
      if (!k) continue
      switch (k) {
        case 'description': {
          const v = readLiteralValue(inner.initializer)
          if (typeof v === 'string') def.description = v
          break
        }
        case 'control': {
          if (ts.isStringLiteral(inner.initializer)) {
            def.control = { type: inner.initializer.text }
          } else if (ts.isObjectLiteralExpression(inner.initializer)) {
            const ctrl: ParsedControl = {}
            for (const cp of inner.initializer.properties) {
              if (!ts.isPropertyAssignment(cp)) continue
              const ck = propertyKeyName(cp.name)
              if (!ck) continue
              if (ck === 'type') {
                const v = readLiteralValue(cp.initializer)
                if (typeof v === 'string') ctrl.type = v
              } else if (
                ck === 'options' &&
                ts.isArrayLiteralExpression(cp.initializer)
              ) {
                const v = readLiteralValue(cp.initializer)
                if (Array.isArray(v)) ctrl.options = v
              }
            }
            def.control = ctrl
          }
          break
        }
        case 'options': {
          const v = readLiteralValue(inner.initializer)
          if (Array.isArray(v)) def.options = v
          break
        }
        case 'type': {
          if (ts.isStringLiteral(inner.initializer)) {
            def.type = inner.initializer.text
          } else if (ts.isObjectLiteralExpression(inner.initializer)) {
            for (const tp of inner.initializer.properties) {
              if (!ts.isPropertyAssignment(tp)) continue
              const tk = propertyKeyName(tp.name)
              if (tk === 'name' && ts.isStringLiteral(tp.initializer)) {
                def.type = tp.initializer.text
              } else if (
                tk === 'required' &&
                tp.initializer.kind === ts.SyntaxKind.TrueKeyword
              ) {
                def.required = true
              }
            }
          }
          break
        }
        case 'defaultValue': {
          const v = readLiteralValue(inner.initializer)
          if (v !== UNRESOLVED) def.defaultValue = v
          break
        }
      }
    }
    out.push(def)
  }
  return out
}

// ────────────────────────── Normalization ──────────────────────────

function argTypeToProp(
  at: ArgTypeDef,
  args: Record<string, ManifestValue>,
  filePath: string,
  framework: FrameworkId,
  designSystem: DesignSystemId,
): ComponentPropManifest {
  const control = inferControl(at)
  const explicit = at.defaultValue
  const fromArgs = args[at.name]
  // Provenance order: an explicit `defaultValue` on the argType is doc
  // intent; `args` on the meta is the runtime default the story renders
  // with. Prefer the documented one when both are present.
  const defaultValue =
    explicit !== undefined
      ? { value: explicit, source: 'documentation' as DefaultValueSource }
      : fromArgs !== undefined
        ? { value: fromArgs, source: 'runtime' as DefaultValueSource }
        : undefined

  return {
    name: at.name,
    type: at.type ?? '',
    required: at.required ?? false,
    description: at.description,
    defaultValue,
    control,
    source: {
      framework,
      designSystem,
      extractor: 'storybook-csf-static',
      declarations: [{ file: filePath }],
    },
  }
}

function inferControl(at: ArgTypeDef): ManifestControl {
  const typeName = at.control?.type
  // argType.options trumps control.options when both present.
  const options = at.options ?? at.control?.options

  if (!typeName) {
    if (options && options.length > 0) {
      return finiteChoice(options, at.type)
    }
    return inferFromTypeString(at.type)
  }

  switch (typeName) {
    case 'text':
      return { kind: 'text', valueType: at.type }
    case 'number':
    case 'range':
      return { kind: 'number', valueType: at.type }
    case 'boolean':
      return { kind: 'boolean', valueType: at.type ?? 'boolean' }
    case 'select':
    case 'multi-select':
    case 'radio':
    case 'inline-radio':
    case 'check':
    case 'inline-check': {
      if (options && options.length > 0) return finiteChoice(options, at.type)
      // A select/radio without options is degenerate — schema is an
      // inspector-side problem; fall back to text so the user can at
      // least type something.
      return { kind: 'text', valueType: at.type }
    }
    case 'color':
      return { kind: 'text', valueType: at.type ?? 'color' }
    case 'date':
      return { kind: 'text', valueType: at.type ?? 'date' }
    case 'object':
      return { kind: 'object', valueType: at.type }
    default:
      return { kind: 'unknown', valueType: at.type ?? typeName }
  }
}

function finiteChoice(options: ManifestValue[], typeName?: string): ManifestControl {
  // Per the ComponentManifest contract: drop undefined/null from
  // options; the unset state is `required: false`, not a value-list
  // member.
  const cleaned = options.filter((v) => v !== null && v !== undefined)
  return {
    kind: 'finite-choice',
    valueType: typeName,
    options: cleaned.map((v) => ({ value: v, label: String(v) })),
  }
}

function inferFromTypeString(type?: string): ManifestControl {
  if (!type) return { kind: 'unknown' }
  const t = type.toLowerCase()
  if (t === 'boolean') return { kind: 'boolean', valueType: type }
  if (t === 'number') return { kind: 'number', valueType: type }
  if (t === 'string') return { kind: 'text', valueType: type }
  return { kind: 'unknown', valueType: type }
}
