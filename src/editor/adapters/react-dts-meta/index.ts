/**
 * `ReactDtsMetaManifestSource` — full-fidelity React component metadata
 * extracted from a library's shipped `.d.ts` using the real TypeScript
 * checker. The React sibling of `VueDtsMetaManifestSource`.
 *
 * This is the plan's framework-neutrality proof (Phase 4 of
 * `tasks/design-system-manifest-onboarding.md`): a different framework
 * front-end feeding the SAME `ComponentManifestSource` interface and the
 * SAME `normalizeComponentMeta` → `ComponentManifest` output as the Vue
 * extractor. Only two things are React-specific — how the props type is
 * recovered from a component, and which props count as framework/DOM
 * noise. Everything downstream (control classification, the manifest
 * shape the inspector consumes, the edit pipeline) is shared and unchanged.
 *
 * Props-type recovery, by component shape:
 *  1. Function components — `FC<P>`, `(props: P) => JSX.Element`,
 *     `ForwardRefExoticComponent<P & RefAttributes<…>>` (Radix's shape):
 *     all are callable; the first call-signature parameter is the props.
 *  2. Class components — `Component<P, S>`: the construct signature's
 *     return type (the instance) carries `props`.
 *
 * Framework/DOM filtering: a React component's props type includes every
 * inherited HTML/DOM/ARIA attribute (via `ComponentPropsWithoutRef<...>`),
 * declared in `@types/react` / `csstype`, plus `ref`/`key` from
 * `RefAttributes`. Those are dropped (flagged `global`) so the inspector
 * shows only the component's own authored props — the React analogue of
 * the Vue extractor dropping `@vue/*` runtime props. Crucially, library
 * callback props (`onCheckedChange`) are KEPT: unlike Vue emit-handler
 * props, React surfaces events as ordinary props.
 *
 * Scope (V1): props only, mirroring the Vue extractor.
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

export interface ReactDtsMetaSourceOptions {
  id?: string
  /** Absolute tsconfig path; only its compilerOptions are borrowed (for
   * module resolution + the DOM/React lib). `null` when the prototype ships
   * no config at all — a plain-JavaScript React app, which is an ordinary
   * shape — in which case `buildProgram` uses `DEFAULT_DTS_OPTIONS`. */
  tsconfigPath: string | null
  /**
   * Entry `.d.ts` file(s) whose exports are scanned for React components.
   * Unlike Vue (one `.vue.d.ts` per component), React has no per-component
   * file convention, so we enumerate a package entry's exported symbols
   * and keep those whose type resolves to a component.
   */
  entryFiles: string[]
  framework?: FrameworkId
  designSystem: DesignSystemId
  importPath: string
}

export class ReactDtsMetaManifestSource implements ComponentManifestSource {
  readonly id: string
  readonly framework: FrameworkId
  readonly designSystem: DesignSystemId

  private readonly options: ReactDtsMetaSourceOptions
  private cache: Map<string, ComponentManifest> | null = null

  constructor(options: ReactDtsMetaSourceOptions) {
    this.options = options
    this.id = options.id ?? 'react-dts-meta'
    this.framework = options.framework ?? 'react'
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

    const program = buildProgram(this.options.tsconfigPath, this.options.entryFiles)
    if (!program) {
      this.cache = cache
      return cache
    }
    const checker = program.getTypeChecker()

    for (const entry of this.options.entryFiles) {
      const sf = program.getSourceFile(entry)
      if (!sf) continue
      const moduleSym = checker.getSymbolAtLocation(sf)
      if (!moduleSym) continue

      for (const exportSym of checker.getExportsOfModule(moduleSym)) {
        const name = exportSym.getName()
        if (cache.has(name)) continue
        let raw: RawComponentMeta | null
        try {
          raw = extractComponent(checker, exportSym, sf, name)
        } catch {
          // One bad export must not poison the listing.
          continue
        }
        if (!raw) continue
        const manifest = normalizeComponentMeta(raw, {
          componentName: name,
          framework: this.framework,
          designSystem: this.designSystem,
          extractor: this.id,
          importPath: this.options.importPath,
          declarations: [{ file: entry }],
        })
        cache.set(manifest.name, manifest)
      }
    }

    this.cache = cache
    return cache
  }
}

// ────────────────── extraction ──────────────────

function extractComponent(
  checker: ts.TypeChecker,
  exportSym: ts.Symbol,
  location: ts.Node,
  name: string,
): RawComponentMeta | null {
  const type = checker.getTypeOfSymbolAtLocation(exportSym, location)
  const propsType = getReactPropsType(checker, type, location, name)
  if (!propsType) return null

  const props = checker
    .getPropertiesOfType(propsType)
    .map((sym) => buildRawProp(checker, sym, location))

  // A component with zero own props after filtering is still a valid
  // component (e.g. a styled wrapper); keep it so the catalog lists it.
  return {
    name,
    description: undefined,
    type: 1,
    props,
    events: [],
    slots: [],
    exposed: [],
  }
}

/**
 * React's naming convention is the reliable component signal: components
 * are PascalCase; hooks (`useFoo`), render helpers (`renderRow`), and HOCs
 * (`withX`) are camelCase, and SCREAMING_CASE is a constant. Gating on this
 * (rather than the return type) avoids both directions of error — a
 * `(value: number) => ReactNode` helper is rejected, and a component typed
 * to return `null`/`string` is still accepted.
 */
function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name) && !/^[A-Z0-9_]+$/.test(name)
}

/** Props must be an object-like type — not a primitive (rejects helpers
 * whose first arg is a `number`/`string`, which aren't props). Objects,
 * interfaces, and `Props & RefAttributes` intersections all qualify. */
function isObjectLikePropsType(type: ts.Type): boolean {
  const primitive =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.EnumLike |
    ts.TypeFlags.ESSymbolLike |
    ts.TypeFlags.VoidLike |
    ts.TypeFlags.Null
  return (type.flags & primitive) === 0
}

/**
 * Recover the props type from a React component, or null if the export
 * isn't a component. Gated on a PascalCase name. Function components (incl.
 * `forwardRef`/`memo`, any return type): the first call-signature parameter,
 * required to be object-like so non-component callables are rejected. Class
 * components: the construct signature's instance `props`.
 */
function getReactPropsType(
  checker: ts.TypeChecker,
  type: ts.Type,
  fallback: ts.Node,
  name: string,
): ts.Type | null {
  if (!isComponentName(name)) return null

  for (const sig of type.getCallSignatures()) {
    const param = sig.getParameters()[0]
    if (!param) continue
    const at = param.valueDeclaration ?? param.declarations?.[0] ?? fallback
    const propsType = checker.getTypeOfSymbolAtLocation(param, at)
    if (isObjectLikePropsType(propsType)) return propsType
  }
  for (const sig of type.getConstructSignatures()) {
    const instance = sig.getReturnType()
    const propsSym = instance.getProperty('props')
    if (propsSym) {
      const at = propsSym.valueDeclaration ?? propsSym.declarations?.[0] ?? fallback
      return checker.getTypeOfSymbolAtLocation(propsSym, at)
    }
  }
  return null
}

function buildRawProp(
  checker: ts.TypeChecker,
  sym: ts.Symbol,
  fallback: ts.Node,
): RawPropertyMeta {
  const name = sym.getName()
  const decl = sym.valueDeclaration ?? sym.declarations?.[0]
  const declFile = decl?.getSourceFile().fileName ?? ''
  const propType = checker.getTypeOfSymbolAtLocation(sym, decl ?? fallback)
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
    global: isReactFrameworkProp(name, declFile),
    required: optional ? false : !tags.some((t) => t.name === 'default'),
    tags,
    schema,
    declarations: [],
  }
}

/**
 * Props that are React/DOM noise rather than the component's own API:
 * everything inherited from `@types/react` (HTML/DOM/ARIA attributes,
 * DOM event handlers like `onClick`) or `csstype`, plus `key`/`ref`.
 * Library-authored props — including callbacks like `onCheckedChange`
 * declared in the library's own `.d.ts` — are kept.
 */
function isReactFrameworkProp(name: string, declFile: string): boolean {
  // Normalize Windows backslashes so the path match works cross-platform.
  const f = declFile.replace(/\\/g, '/')
  if (
    /\/node_modules\/@types\/react\//.test(f) ||
    /\/node_modules\/react\//.test(f) ||
    /\/node_modules\/csstype\//.test(f)
  ) {
    return true
  }
  return name === 'key' || name === 'ref'
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
 * Classify a resolved prop type into the `RawPropertyMeta['schema']` shape
 * the normalizer expects. Identical policy to the Vue extractor (kept in
 * lockstep): string-literal union → enum, boolean → enum, single
 * string/number primitive → scalar, else type text.
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
