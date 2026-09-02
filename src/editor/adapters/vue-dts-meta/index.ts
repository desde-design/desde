/**
 * `VueDtsMetaManifestSource` — full-fidelity component metadata extracted
 * from a Vue library's *shipped* `.d.ts` declarations using the real
 * TypeScript type checker.
 *
 * Why this exists: a customer's design system is installed via npm, so
 * only its compiled output + `.d.ts` declarations are on disk — not the
 * `.vue`/`.ts` source. Two existing sources cover libraries:
 *   - `Acme DSManifestSource` — pre-extracted JSON (full fidelity,
 *     but a per-version checked-in artifact, only the 7 sampled
 *     components, and Acme DS-specific).
 *   - `TsDeclarationManifestSource` — a hand-rolled `.d.ts` AST parser
 *     (any installed lib, no source) but lossy: it can't resolve
 *     imported type aliases, generics, or `Pick`/`Omit`, so variant
 *     props typed via those collapse to a non-editable `unknown` control.
 *
 * This source closes that gap. It builds a `ts.Program` over the
 * library's `.vue.d.ts` component declarations and walks each component's
 * resolved `$props` type through the checker. Because it's the real
 * compiler, imported aliases (`appearance?: ButtonAppearance` declared in
 * a sibling file), generics, and utility types all resolve — the same
 * fidelity as running vue-component-meta over source, but with no source
 * required. It generalizes to any installed Vue library that ships
 * per-component `.vue.d.ts` declarations.
 *
 * Why not vue-component-meta directly: its public `getComponentMeta`
 * extracts the component node from an export's *value-declaration
 * initializer* (`const C = defineComponent(...)`), which only exists in
 * source. Compiled `.vue.d.ts` files ship ambient declarations
 * (`declare const _default: …; export default _default`) with no
 * initializer, so it throws "Export 'default' not found". This source
 * goes straight to the export *type* via the checker, which is fully
 * resolvable from declarations.
 *
 * Scope (V1): props only. Slots/events are deferred — the inspector's
 * value is the prop panel, and emit-handler props are filtered out so
 * they don't pollute it. Output is normalized through the shared
 * `normalizeComponentMeta` so control classification (finite-choice /
 * boolean / text / number / unknown) stays in one place.
 */
import * as ts from 'typescript'
import type {
  ComponentManifest,
  ComponentManifestSource,
  DesignSystemId,
  FrameworkId,
} from '../../core'
import { normalizeComponentMeta } from '../component-meta/normalize'
import type {
  RawComponentMeta,
  RawPropertyMeta,
  RawTag,
} from '../component-meta/raw-manifest'
import { buildProgram } from '../ts-program'

/** A single component's `.vue.d.ts` declaration + its export name. */
export interface VueDtsComponent {
  /** Canonical component name as seen at runtime (`UiBadge`, `VBtn`, …). */
  componentName: string
  /** Absolute path to the component's `.vue.d.ts` (or `.d.ts`) file. */
  declarationFile: string
  /** Export to analyze. Defaults to `'default'` (the `.vue.d.ts` shape). */
  exportName?: string
}

export interface VueDtsMetaSourceOptions {
  id?: string
  /**
   * Absolute path to a tsconfig whose compilerOptions resolve the
   * library's modules (i.e. the prototype's tsconfig — its `node_modules`
   * is where the library is installed). Only the compilerOptions are
   * used; the file list is replaced with the component declarations.
   */
  tsconfigPath: string
  /** Components to ingest. Discovery is the preset's responsibility. */
  components: VueDtsComponent[]
  /** Framework id stamped on produced manifests. Defaults to `'vue3'`. */
  framework?: FrameworkId
  /** Design-system id stamped on produced manifests (required). */
  designSystem: DesignSystemId
  /** Bare-import path stamped on produced manifests. */
  importPath: string
}

export class VueDtsMetaManifestSource implements ComponentManifestSource {
  readonly id: string
  readonly framework: FrameworkId
  readonly designSystem: DesignSystemId

  private readonly options: VueDtsMetaSourceOptions
  private cache: Map<string, ComponentManifest> | null = null

  constructor(options: VueDtsMetaSourceOptions) {
    this.options = options
    this.id = options.id ?? 'vue-dts-meta'
    this.framework = options.framework ?? 'vue3'
    this.designSystem = options.designSystem
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

    const program = buildProgram(
      this.options.tsconfigPath,
      this.options.components.map((c) => c.declarationFile),
    )
    if (!program) {
      // No tsconfig / unreadable → emit nothing; the composite falls
      // through to the next source (e.g. the .d.ts AST parser).
      this.cache = cache
      return cache
    }
    const checker = program.getTypeChecker()

    for (const decl of this.options.components) {
      let raw: RawComponentMeta | null
      try {
        raw = extractComponent(program, checker, decl)
      } catch {
        // A single component that can't be analyzed must not poison the
        // rest of the listing — fall through, the composite covers it.
        continue
      }
      if (!raw) continue
      const manifest = normalizeComponentMeta(raw, {
        componentName: decl.componentName,
        framework: this.framework,
        designSystem: this.designSystem,
        extractor: this.id,
        importPath: this.options.importPath,
        declarations: [{ file: decl.declarationFile }],
      })
      cache.set(manifest.name, manifest)
    }

    this.cache = cache
    return cache
  }
}

// ────────────────── extraction ──────────────────

function extractComponent(
  program: ts.Program,
  checker: ts.TypeChecker,
  decl: VueDtsComponent,
): RawComponentMeta | null {
  const sf = program.getSourceFile(decl.declarationFile)
  if (!sf) return null
  const moduleSym = checker.getSymbolAtLocation(sf)
  if (!moduleSym) return null
  const exportName = decl.exportName ?? 'default'
  const exportSym = checker
    .getExportsOfModule(moduleSym)
    .find((e) => e.getName() === exportName)
  if (!exportSym) return null

  const componentType = checker.getTypeOfSymbolAtLocation(exportSym, sf)
  const propsType = getPropsType(checker, componentType, sf)
  if (!propsType) return null

  const props = checker
    .getPropertiesOfType(propsType)
    .map((sym) => buildRawProp(checker, sym, sf))

  return {
    name: decl.componentName,
    description: undefined,
    type: 1,
    props,
    events: [],
    slots: [],
    exposed: [],
  }
}

/**
 * Recover the resolved props type from a Vue component type. Vue
 * components are constructable; the instance exposes `$props` whose type
 * is the fully-resolved (post-`withDefaults`, imports expanded) public
 * props. Falls back to call signatures for functional components.
 *
 * Two component declaration shapes occur in practice:
 *  1. `DefineComponent<Props, …>` (the common case, e.g. `UiButton`) — the
 *     construct signature's return type (the instance) carries `$props`.
 *  2. The generic VLS function shape vue-tsc emits for components with
 *     generic type params (`<Header, Data>(__VLS_props: …) => VNode`,
 *     e.g. `UiTableView`/`UiTableData`). Here the call signature returns a
 *     bare `VNode` with NO `$props`; the resolved public props are the
 *     type of the first parameter (`__VLS_props`). Without this fallback
 *     every generic component is silently dropped from the manifest, so
 *     the inspector shows no props for it at all.
 */
function getPropsType(
  checker: ts.TypeChecker,
  componentType: ts.Type,
  location: ts.Node,
): ts.Type | null {
  const signatures = [
    ...componentType.getConstructSignatures(),
    ...componentType.getCallSignatures(),
  ]
  for (const sig of signatures) {
    const instance = sig.getReturnType()
    const dollarProps = instance.getProperty('$props')
    if (dollarProps) {
      const at = dollarProps.valueDeclaration ?? dollarProps.declarations?.[0]
      return checker.getTypeOfSymbolAtLocation(dollarProps, at ?? location)
    }
  }
  // Shape 2: generic VLS function component — props are the first
  // parameter's type. Prefer a parameter literally named `__VLS_props`
  // (the vue-tsc convention) so we don't misread a non-component call
  // signature; fall back to the first parameter of a call signature.
  for (const sig of componentType.getCallSignatures()) {
    const params = sig.getParameters()
    const propsParam =
      params.find((p) => p.getName() === '__VLS_props') ?? params[0]
    if (propsParam) {
      const at = propsParam.valueDeclaration ?? propsParam.declarations?.[0]
      return checker.getTypeOfSymbolAtLocation(propsParam, at ?? location)
    }
  }
  return null
}

function buildRawProp(
  checker: ts.TypeChecker,
  sym: ts.Symbol,
  location: ts.Node,
): RawPropertyMeta {
  const name = sym.getName()
  const decl = sym.valueDeclaration ?? sym.declarations?.[0]
  const declFile = decl?.getSourceFile().fileName ?? ''
  const propType = checker.getTypeOfSymbolAtLocation(sym, decl ?? location)
  const optional = !!(sym.flags & ts.SymbolFlags.Optional)
  const tags = buildTags(checker, sym)
  const description = ts.displayPartsToString(sym.getDocumentationComment(checker))
  const schema = buildSchemaFromType(checker, propType, optional)

  const cleanType = stripNullish(checker.typeToString(propType))
  return {
    name,
    description,
    type: optional ? `${cleanType} | undefined` : cleanType,
    default: undefined,
    // Framework/VNode props (key/ref/class/style/onVnode…), declared in
    // Vue's runtime types, and emit-handler props (`on[A-Z]…`) are not
    // editable value props — flag them `global` so `normalizeComponentMeta`
    // drops them from the inspector panel.
    global: isFrameworkProp(name, declFile),
    required: optional ? false : !tags.some((t) => t.name === 'default'),
    tags,
    schema,
    declarations: [],
  }
}

function isFrameworkProp(name: string, declFile: string): boolean {
  if (declFile.includes('/@vue/') || /\/node_modules\/vue\//.test(declFile)) {
    return true
  }
  // Vue's PascalCase event-handler props (`onUpdate:modelValue`,
  // `onToggle`, `onVnodeMounted`) — emits surfaced as props.
  if (/^on[A-Z]/.test(name)) return true
  // VNode / attribute props that may be declared outside @vue too.
  if (
    name === 'key' ||
    name === 'ref' ||
    name === 'ref_for' ||
    name === 'ref_key' ||
    name === 'class' ||
    name === 'style'
  ) {
    return true
  }
  return false
}

function buildTags(checker: ts.TypeChecker, sym: ts.Symbol): RawTag[] {
  const out: RawTag[] = []
  for (const tag of sym.getJsDocTags(checker)) {
    const text = tag.text ? ts.displayPartsToString(tag.text) : ''
    out.push(text ? { name: tag.name, text } : { name: tag.name })
  }
  return out
}

/**
 * Classify a resolved prop type into the `RawPropertyMeta['schema']`
 * shape the normalizer expects:
 *   - all-string-literal union → finite-choice enum (`['"a"', …]`)
 *   - boolean → boolean enum (`['true','false']`, formatting-independent)
 *   - single string / number primitive → scalar schema string
 *   - anything else → type text (→ normalizer scalar/unknown)
 */
function buildSchemaFromType(
  checker: ts.TypeChecker,
  type: ts.Type,
  optional: boolean,
): RawPropertyMeta['schema'] {
  const constituents = type.isUnion() ? type.types : [type]
  const concrete = constituents.filter(
    (c) => !(c.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)),
  )
  if (concrete.length === 0) return checker.typeToString(type)

  if (concrete.every((c) => c.isStringLiteral())) {
    const members = concrete.map((c) => `"${(c as ts.StringLiteralType).value}"`)
    const schema = optional ? ['undefined', ...members] : members
    return {
      kind: 'enum',
      type: checker.typeToString(type),
      schema: [...new Set(schema)],
    }
  }

  if (concrete.every((c) => !!(c.flags & ts.TypeFlags.BooleanLike))) {
    const schema = optional ? ['undefined', 'true', 'false'] : ['true', 'false']
    return { kind: 'enum', type: checker.typeToString(type), schema }
  }

  if (concrete.length === 1) {
    const c = concrete[0]
    if (c.flags & ts.TypeFlags.StringLike) return 'string'
    if (c.flags & ts.TypeFlags.NumberLike) return 'number'
  }

  return checker.typeToString(type)
}

function stripNullish(text: string): string {
  return text
    .replace(/\s*\|\s*undefined\b/g, '')
    .replace(/\bundefined\s*\|\s*/g, '')
    .replace(/\s*\|\s*null\b/g, '')
    .replace(/\bnull\s*\|\s*/g, '')
    .trim()
}
