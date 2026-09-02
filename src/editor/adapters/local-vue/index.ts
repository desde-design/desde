/**
 * Local Vue 3 SFC manifest source. Reads first-party `.vue` files from
 * the prototype repo, parses `defineProps<{...}>()` via @vue/compiler-sfc
 * + the TypeScript compiler, and emits a `ComponentManifest` per file.
 *
 * Why this exists: design-system extractors (Storybook, .d.ts walkers)
 * cover library components. Prototype-authored components (the ones a
 * designer composes from primitives — `ProtoCatalogCard`, `MetricsCard`,
 * etc.) have no manifest source. They live in the user's repo as plain
 * `.vue` files. This source ingests them via the same `defineProps`
 * type literal that already drives Vue's type-checking.
 *
 * V1 scope:
 * - Type-form `defineProps<{...}>()` only — runtime form
 *   (`defineProps({ name: { type: String, default: 'x' } })`) is
 *   recognized as a valid SFC but skipped (returns null) because the
 *   type information is in a different shape and there's not yet a
 *   compelling demand for it.
 * - Defaults read from `withDefaults(defineProps<...>(), { ... })`.
 *   Bare `defineProps<...>()` produces props with no default.
 * - JSDoc comments above each property field become the prop's
 *   `description`.
 * - Union literal types (`'plain' | 'highlighted' | 'danger'`) become
 *   `kind: 'finite-choice'`. Primitives (string/number/boolean) map to
 *   their kinds. Anything else falls back to `kind: 'unknown'`.
 *
 * Out of scope:
 * - `defineSlots<>()` and `defineEmits<>()` — small follow-up
 * - Imported types (`import type { CardMetric } from './types'`) — V1
 *   stringifies the type without resolving across files
 * - `defineProps({ ... })` runtime form
 */
import * as ts from 'typescript'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type {
  ComponentManifest,
  ComponentManifestSource,
  ComponentPropManifest,
  ControlOption,
  DesignSystemId,
  FrameworkId,
  ManifestControl,
  ManifestValue,
} from '../../core'
import { inferRenderingHints } from './infer-rendering-hints'
import { kebabCase } from '../kebab-case'

export interface LocalVueManifestSourceOptions {
  /**
   * Explicit list of `.vue` file paths to ingest. Callers handle
   * globbing with whichever tool they prefer (fast-glob, fs.glob, manual
   * readdir) — the source stays pure-input for testability.
   */
  componentFiles: string[]
  /**
   * Component name resolution. Default precedence:
   * 1. `name` field on a `<script>` (non-setup) block, if present
   * 2. File basename minus `.vue`
   * 3. null (the file is silently skipped)
   */
  componentNameResolver?: (filePath: string) => string | null
  /**
   * Design-system id stamped onto produced manifests. Defaults to
   * `'first-party'` to distinguish from external-DS manifests in
   * downstream filtering. Free-form per project.
   */
  designSystem?: DesignSystemId
}

export class LocalVueManifestSource implements ComponentManifestSource {
  readonly id = 'local-vue'
  readonly framework: FrameworkId = 'vue3'
  readonly designSystem: DesignSystemId

  private readonly options: LocalVueManifestSourceOptions
  private cache: Map<string, ComponentManifest> | null = null

  constructor(options: LocalVueManifestSourceOptions) {
    this.options = options
    this.designSystem = options.designSystem ?? 'first-party'
  }

  async listComponents(): Promise<ComponentManifest[]> {
    return Array.from(this.populate().values())
  }

  async getComponent(name: string): Promise<ComponentManifest | null> {
    return this.populate().get(name) ?? null
  }

  invalidate(): void {
    this.cache = null
  }

  private populate(): Map<string, ComponentManifest> {
    if (this.cache) return this.cache
    const cache = new Map<string, ComponentManifest>()
    for (const filePath of this.options.componentFiles) {
      const manifest = this.tryExtract(filePath)
      if (manifest) cache.set(manifest.name, manifest)
    }
    this.cache = cache
    return cache
  }

  private tryExtract(filePath: string): ComponentManifest | null {
    let source: string
    try {
      source = readFileSync(filePath, 'utf8')
    } catch {
      return null
    }

    let descriptor: ReturnType<typeof parseSfc>['descriptor']
    try {
      descriptor = parseSfc(source).descriptor
    } catch {
      return null
    }
    const block = descriptor.scriptSetup ?? descriptor.script
    if (!block) return null
    const isSetup = !!descriptor.scriptSetup

    // Component name precedence (matches the documented options-resolver
    // contract):
    //   1. user-supplied componentNameResolver
    //   2. SFC runtime name (defineOptions / options-API `name:`) — this
    //      is what the iframe bridge selects against, so a filename-only
    //      key would mismatch and the inspector would show no manifest
    //   3. file basename minus `.vue`
    const sfcDeclaredName = readSfcDeclaredName(descriptor, isSetup)
    const name =
      this.options.componentNameResolver?.(filePath) ??
      sfcDeclaredName ??
      defaultResolveName(filePath)
    if (!name) return null

    const props = extractProps(block.content, isSetup)
    if (props === null) return null

    // Infer `dom` rendering hints from the template so first-party
    // components (EntityFormBlock, EntityFormSection, …) become
    // attributable for the "prop rendered as element text" pattern. Only
    // declared prop names are eligible — see `infer-rendering-hints.ts`.
    // Absent template / no inferable pattern leaves `rendering` unset and
    // attribution falls back to heuristic behavior (graceful degradation).
    const templateSource = descriptor.template?.content
    const rendering = templateSource
      ? inferRenderingHints({
          templateSource,
          propNames: props.map((p) => p.name),
        })
      : undefined

    const manifest: ComponentManifest = {
      id: `${this.designSystem}.${kebabCase(name)}`,
      name,
      framework: this.framework,
      designSystem: this.designSystem,
      props,
      slots: [],
      events: [],
      source: {
        framework: this.framework,
        designSystem: this.designSystem,
        extractor: 'local-vue-sfc',
        declarations: [{ file: filePath }],
      },
    }
    if (rendering) manifest.rendering = rendering
    return manifest
  }
}

function defaultResolveName(filePath: string): string | null {
  const base = basename(filePath)
  const stripped = base.replace(/\.vue$/i, '')
  return stripped || null
}

/**
 * Read the component's runtime name from the SFC, if declared.
 *
 * Vue exposes a runtime component name via:
 * - `<script setup>` — `defineOptions({ name: 'Foo' })`
 * - `<script>` (options API) — `export default { name: 'Foo' }` or
 *   `export default defineComponent({ name: 'Foo' })`
 *
 * The bridge's component-detection runtime resolves selections to this
 * name, NOT the filename. Returning `null` here lets the caller fall
 * back to the filename — which is fine when the two agree but causes
 * silent manifest-lookup misses when they don't.
 */
function readSfcDeclaredName(
  descriptor: ReturnType<typeof parseSfc>['descriptor'],
  isSetup: boolean,
): string | null {
  const content = isSetup
    ? descriptor.scriptSetup?.content
    : descriptor.script?.content
  if (!content) return null
  const sf = ts.createSourceFile(
    'name-probe.ts',
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )

  if (isSetup) {
    // defineOptions({ name: 'Foo', ... })
    let found: string | null = null
    const visit = (node: ts.Node): void => {
      if (found) return
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'defineOptions' &&
        node.arguments.length === 1 &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        const name = readNamePropFromObjectLiteral(node.arguments[0])
        if (name) {
          found = name
          return
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return found
  }

  // Options API: export default { name: 'Foo', ... }
  // or export default defineComponent({ name: 'Foo', ... })
  for (const stmt of sf.statements) {
    if (!ts.isExportAssignment(stmt) || stmt.isExportEquals) continue
    let expr: ts.Expression = stmt.expression
    while (
      ts.isAsExpression(expr) ||
      ts.isParenthesizedExpression(expr) ||
      ts.isSatisfiesExpression(expr)
    ) {
      expr = (expr as { expression: ts.Expression }).expression
    }
    if (
      ts.isCallExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === 'defineComponent' &&
      expr.arguments.length === 1 &&
      ts.isObjectLiteralExpression(expr.arguments[0])
    ) {
      const name = readNamePropFromObjectLiteral(expr.arguments[0])
      if (name) return name
    }
    if (ts.isObjectLiteralExpression(expr)) {
      const name = readNamePropFromObjectLiteral(expr)
      if (name) return name
    }
  }
  return null
}

function readNamePropFromObjectLiteral(
  obj: ts.ObjectLiteralExpression,
): string | null {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const k = ts.isIdentifier(prop.name)
      ? prop.name.text
      : ts.isStringLiteral(prop.name)
        ? prop.name.text
        : null
    if (k !== 'name') continue
    if (
      ts.isStringLiteral(prop.initializer) ||
      ts.isNoSubstitutionTemplateLiteral(prop.initializer)
    ) {
      return prop.initializer.text
    }
  }
  return null
}

// ─────────────────────── defineProps extraction ───────────────────────

interface ParsedDefaults {
  /** Map prop name → literal default value (when statically resolvable). */
  values: Map<string, ManifestValue>
}

/**
 * Extract props from the script content. Returns null when the script
 * has no recognizable `defineProps<{...}>()` call. (Runtime-form
 * `defineProps({ ... })` is intentionally returned as `null` so the
 * source can fall through to a different manifest source.)
 *
 * Exported for tests.
 */
export function extractProps(
  scriptContent: string,
  isSetup: boolean,
): ComponentPropManifest[] | null {
  const sf = ts.createSourceFile(
    'script.ts',
    scriptContent,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  )

  const definePropsCall = findDefinePropsCall(sf, isSetup)
  if (!definePropsCall) return null

  const typeArg = definePropsCall.typeArguments?.[0]
  if (!typeArg || !ts.isTypeLiteralNode(typeArg)) {
    // Runtime form (`defineProps({ ... })`) — out of V1 scope.
    return null
  }

  // Defaults are scoped to the SPECIFIC `defineProps` call we matched.
  // Walking the AST for any `withDefaults` would let an unrelated helper
  // call (or a multi-composable file) attach foreign defaults to our
  // props.
  const defaults = readDefaultsFor(definePropsCall)

  const props: ComponentPropManifest[] = []
  for (const member of typeArg.members) {
    if (!ts.isPropertySignature(member)) continue
    if (!member.name) continue
    const name = readMemberName(member.name)
    if (!name) continue

    const required = !member.questionToken
    const description = readJsDocDescription(member)
    const typeText = member.type ? scriptContent.slice(member.type.pos, member.type.end).trim() : ''
    const control = inferControl(member.type, typeText)
    const defaultValue = defaults.values.has(name)
      ? {
          value: defaults.values.get(name)! as ManifestValue,
          source: 'runtime' as const,
        }
      : undefined

    props.push({
      name,
      type: typeText,
      required,
      description,
      defaultValue,
      control,
    })
  }
  return props
}

function readMemberName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text
  }
  return null
}

/**
 * Walk the script, looking for `defineProps<...>()` (possibly wrapped
 * inside `withDefaults(defineProps<...>(), { ... })` or the LHS of a
 * variable declarator).
 */
function findDefinePropsCall(
  sf: ts.SourceFile,
  isSetup: boolean,
): ts.CallExpression | null {
  let found: ts.CallExpression | null = null
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'defineProps'
      ) {
        found = node
        return
      }
      // withDefaults(defineProps<...>(), { ... })
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'withDefaults' &&
        node.arguments.length > 0 &&
        ts.isCallExpression(node.arguments[0]) &&
        ts.isIdentifier(node.arguments[0].expression) &&
        node.arguments[0].expression.text === 'defineProps'
      ) {
        found = node.arguments[0]
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  // For non-setup `<script>`, defineProps isn't a compiler macro, but
  // some authoring conventions still use it — we still scan for it.
  visit(sf)
  // Avoid unused-param warning when isSetup is false: we don't restrict
  // search yet; the macro just won't resolve at runtime in non-setup
  // scripts and the manifest is informational.
  void isSetup
  return found
}

/**
 * Read defaults for the *specific* `defineProps` call passed in. Returns
 * an empty map unless the call's parent is exactly
 * `withDefaults(defineProps<...>(), defaultsObject)`.
 *
 * The earlier broader search (which walked the whole AST for any
 * `withDefaults`) could bind defaults from an unrelated helper call to
 * our props. Anchoring on the parent node guarantees correctness even
 * in scripts that contain multiple `withDefaults`-named calls.
 */
function readDefaultsFor(definePropsCall: ts.CallExpression): ParsedDefaults {
  const out: ParsedDefaults = { values: new Map() }
  const parent = definePropsCall.parent
  if (!parent) return out
  if (!ts.isCallExpression(parent)) return out
  if (
    !ts.isIdentifier(parent.expression) ||
    parent.expression.text !== 'withDefaults'
  ) {
    return out
  }
  if (parent.arguments.length < 2) return out
  if (parent.arguments[0] !== definePropsCall) return out
  const obj = parent.arguments[1]
  if (!ts.isObjectLiteralExpression(obj)) return out
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const key = ts.isIdentifier(prop.name)
      ? prop.name.text
      : ts.isStringLiteral(prop.name)
        ? prop.name.text
        : null
    if (!key) continue
    const v = readLiteralValue(prop.initializer)
    if (v !== UNRESOLVED) out.values.set(key, v)
  }
  return out
}

function readJsDocDescription(node: ts.Node): string | undefined {
  // ts.getJSDocCommentsAndTags returns parsed JSDoc nodes. The leading
  // text before any `@tag` is the description.
  const tags = (
    ts as unknown as {
      getJSDocCommentsAndTags: (n: ts.Node) => readonly ts.Node[]
    }
  ).getJSDocCommentsAndTags?.(node)
  if (!tags || tags.length === 0) return undefined
  for (const tag of tags) {
    if ('comment' in tag) {
      const c = (tag as { comment?: string | ts.NodeArray<ts.JSDocComment> }).comment
      if (typeof c === 'string' && c.trim()) return c.trim()
      if (Array.isArray(c) && c.length > 0) {
        const text = c
          .map((n) => (typeof (n as { text?: string }).text === 'string' ? (n as { text: string }).text : ''))
          .join('')
          .trim()
        if (text) return text
      }
    }
  }
  return undefined
}

const UNRESOLVED = Symbol('unresolved')
type ResolvedValue = ManifestValue | typeof UNRESOLVED

function readLiteralValue(node: ts.Expression): ResolvedValue {
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
      const k = ts.isIdentifier(prop.name)
        ? prop.name.text
        : ts.isStringLiteral(prop.name)
          ? prop.name.text
          : null
      if (!k) continue
      const v = readLiteralValue(prop.initializer)
      if (v === UNRESOLVED) return UNRESOLVED
      obj[k] = v
    }
    return obj
  }
  // Arrow function defaults (`() => []`) are common for object/array
  // props in Vue 3. We can't statically resolve the result; treat as
  // "no default known."
  return UNRESOLVED
}

// ─────────────────────── Type → control inference ───────────────────────

function inferControl(
  typeNode: ts.TypeNode | undefined,
  typeText: string,
): ManifestControl {
  if (!typeNode) return { kind: 'unknown' }

  // Direct primitive keywords.
  if (typeNode.kind === ts.SyntaxKind.StringKeyword) {
    return { kind: 'text', valueType: typeText }
  }
  if (typeNode.kind === ts.SyntaxKind.NumberKeyword) {
    return { kind: 'number', valueType: typeText }
  }
  if (typeNode.kind === ts.SyntaxKind.BooleanKeyword) {
    return { kind: 'boolean', valueType: typeText }
  }

  // Union of literals → finite-choice (drop null/undefined per the
  // ComponentManifest contract).
  if (ts.isUnionTypeNode(typeNode)) {
    const literalValues: ManifestValue[] = []
    let allLiteralOrNullish = true
    for (const member of typeNode.types) {
      if (
        member.kind === ts.SyntaxKind.UndefinedKeyword ||
        member.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isLiteralTypeNode(member) &&
          member.literal.kind === ts.SyntaxKind.NullKeyword)
      ) {
        continue
      }
      if (ts.isLiteralTypeNode(member)) {
        const lit = member.literal
        if (ts.isStringLiteral(lit) || ts.isNoSubstitutionTemplateLiteral(lit)) {
          literalValues.push(lit.text)
          continue
        }
        if (ts.isNumericLiteral(lit)) {
          literalValues.push(Number(lit.text))
          continue
        }
        if (lit.kind === ts.SyntaxKind.TrueKeyword) {
          literalValues.push(true)
          continue
        }
        if (lit.kind === ts.SyntaxKind.FalseKeyword) {
          literalValues.push(false)
          continue
        }
      }
      // Anything that isn't a literal or nullish member disqualifies
      // the whole union from being a finite-choice.
      allLiteralOrNullish = false
      break
    }
    if (allLiteralOrNullish && literalValues.length > 0) {
      // Special case: a `true | false` union should render as a
      // boolean toggle, not a 2-option select. Authors who wrote that
      // explicitly probably meant boolean; the toggle is more ergonomic.
      const allBool =
        literalValues.length === 2 &&
        literalValues.includes(true) &&
        literalValues.includes(false)
      if (allBool) return { kind: 'boolean', valueType: typeText }
      const options: ControlOption[] = literalValues.map((v) => ({
        value: v,
        label: String(v),
      }))
      return { kind: 'finite-choice', valueType: typeText, options }
    }
    // Mixed unions like `string | { ... }` fall through to unknown.
    return { kind: 'unknown', valueType: typeText }
  }

  // Array types → array.
  if (ts.isArrayTypeNode(typeNode) || isReadonlyArrayType(typeNode)) {
    return { kind: 'array', valueType: typeText }
  }

  // Function types → event/function.
  if (ts.isFunctionTypeNode(typeNode)) {
    return { kind: 'function', valueType: typeText }
  }

  // Object literals / interfaces / type references → object.
  if (
    ts.isTypeLiteralNode(typeNode) ||
    ts.isTypeReferenceNode(typeNode) ||
    ts.isIntersectionTypeNode(typeNode)
  ) {
    // A bare `boolean` reference resolves as TypeReferenceNode in some
    // shapes, but the keyword check above usually wins. Heuristic:
    // single identifier whose lowercase text is a primitive.
    if (
      ts.isTypeReferenceNode(typeNode) &&
      ts.isIdentifier(typeNode.typeName)
    ) {
      const name = typeNode.typeName.text
      if (name === 'String') return { kind: 'text', valueType: typeText }
      if (name === 'Number') return { kind: 'number', valueType: typeText }
      if (name === 'Boolean') return { kind: 'boolean', valueType: typeText }
      if (name === 'Array' || name === 'ReadonlyArray') {
        return { kind: 'array', valueType: typeText }
      }
    }
    return { kind: 'object', valueType: typeText }
  }

  return { kind: 'unknown', valueType: typeText }
}

function isReadonlyArrayType(node: ts.TypeNode): boolean {
  return (
    ts.isTypeOperatorNode(node) &&
    node.operator === ts.SyntaxKind.ReadonlyKeyword &&
    ts.isArrayTypeNode(node.type)
  )
}
