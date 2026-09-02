/**
 * Local React manifest source. Reads first-party `.tsx`/`.jsx` components from
 * the prototype repo, extracts each component's name + prop names via
 * `@babel/parser`, and infers `dom` rendering hints from its JSX
 * ([infer-jsx-rendering-hints.ts](./infer-jsx-rendering-hints.ts)) — the React
 * analog of [local-vue](../local-vue/index.ts).
 *
 * Why: the attribution moat needs `rendering` hints to map a clicked DOM node →
 * the prop that produced it. Library components get them from their manifest
 * source; the prototype's OWN React components had no source at all. This makes
 * them attributable for the common "prop rendered as element text" pattern.
 *
 * Scope:
 * - Prop NAMES **and TYPES → controls** from the first param's type annotation,
 *   resolved against same-file `interface`/`type` declarations (the React analog
 *   of Vue's `defineProps<{…}>`). Covers `function C({ title, variant }: Props)`,
 *   `({ title }: { title: string }) => …`, AND non-destructured
 *   `(props: Props)` (the prop names come from the type, not the pattern).
 *   Union-literal types → `finite-choice`; primitives → text/number/boolean;
 *   function props → `event`; `children`/`ReactNode` → `slot`. An untyped
 *   destructured param falls back to prop NAMES with `unknown` controls.
 *   Cross-file imported types aren't resolved (V1) — they degrade to `unknown`.
 *   Full library-grade extraction (generics, `Pick`/`Omit`) remains
 *   `react-dts-meta`'s job.
 * - **cva-style variant axes** — `VariantProps<typeof buttonVariants>` in the
 *   props type (as an intersection member, an interface `extends`, a type
 *   alias, or an indexed access `P["size"]`) resolves against the
 *   `cva({ variants: … })` object literal, so `variant` / `size` surface as
 *   finite-choice controls carrying their real options plus the
 *   `defaultVariants` default. See [cva-variants.ts](./cva-variants.ts) for the
 *   pattern and for why this is read syntactically rather than through the TS
 *   checker. Also mirrored onto `extensions.variants` for variant-aware UI.
 * - **Cross-component prop forwarding** — `React.ComponentProps<typeof Button>`
 *   (bare, or narrowed by `Pick`/`Omit`) resolves against the OTHER first-party
 *   component of that name, so the ubiquitous "button-shaped wrapper"
 *   (`PaginationLink`, `CarouselNext`, `AlertDialogAction`, …) inherits the
 *   base's props and variant axes instead of degrading to `unknown`. Resolution
 *   is by exported NAME across the scanned file set, not by module specifier —
 *   see {@link resolveForwards} for why, and for the bounds.
 * - One or more top-level exported components per file (function decl, arrow
 *   const, `export default`, **or a `forwardRef` / `memo`-wrapped render
 *   function** — the dominant shadcn/Radix authoring shape, and the reason a
 *   first-party `Button` used to be invisible to the catalog entirely). Each
 *   component's hints are inferred from ITS OWN source slice, so
 *   multi-component files don't cross-attribute.
 * - Pure-input-friendly: pass file contents via the reader (defaults to
 *   `readFileSync`) so the source stays testable.
 */
import { parse } from "@babel/parser"
import { readFileSync } from "node:fs"
import type {
  ComponentManifest,
  ComponentManifestSource,
  ComponentPropManifest,
  ControlOption,
  DesignSystemId,
  FrameworkId,
  ManifestControl,
  ManifestValue,
  VariantGroupManifest,
} from "../../core"
import { inferJsxRenderingHints } from "./infer-jsx-rendering-hints"
import {
  buildVariantConfigRegistry,
  variantPropsTarget,
  type VariantConfigRegistry,
  type VariantGroup,
} from "./cva-variants"
import { kebabCase } from "../kebab-case"

export interface LocalReactManifestSourceOptions {
  /** Explicit list of `.tsx`/`.jsx` file paths to ingest. */
  componentFiles: string[]
  /** Design-system id stamped on produced manifests. Defaults `'first-party'`. */
  designSystem?: DesignSystemId
  /** File reader (injectable for tests). Defaults to `readFileSync`. */
  readFile?: (filePath: string) => string
}

interface BabelNode {
  type?: string
  start?: number | null
  end?: number | null
  [key: string]: unknown
}

export class LocalReactManifestSource implements ComponentManifestSource {
  readonly id = "local-react"
  readonly framework: FrameworkId = "react"
  readonly designSystem: DesignSystemId

  private readonly options: LocalReactManifestSourceOptions
  private readonly readFile: (filePath: string) => string
  private cache: Map<string, ComponentManifest> | null = null

  constructor(options: LocalReactManifestSourceOptions) {
    this.options = options
    this.designSystem = options.designSystem ?? "first-party"
    this.readFile = options.readFile ?? ((p) => readFileSync(p, "utf8"))
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

  /**
   * Two passes over the file set. Pass 1 parses each file in isolation and
   * leaves cross-file references (`VariantProps<typeof importedVariants>`,
   * `ComponentProps<typeof OtherComponent>`) recorded but unresolved; pass 2
   * closes them against the whole-set indexes, then builds the manifests. The
   * split exists because those references routinely point FORWARD — a file
   * listed before `button.tsx` can already forward Button's props.
   */
  private populate(): Map<string, ComponentManifest> {
    if (this.cache) return this.cache

    const extracted: ExtractedComponent[] = []
    const byName = new Map<string, ExtractedComponent>()
    const variantConfigs: VariantConfigRegistry = new Map()
    for (const filePath of this.options.componentFiles) {
      for (const comp of this.tryExtract(filePath, variantConfigs)) {
        extracted.push(comp)
        // First-writer wins on name collisions across files (stable order).
        if (!byName.has(comp.name)) byName.set(comp.name, comp)
      }
    }

    const cache = new Map<string, ComponentManifest>()
    for (const comp of extracted) {
      if (byName.get(comp.name) !== comp) continue
      resolveForwards(comp, byName, variantConfigs)
      cache.set(comp.name, this.toManifest(comp))
    }
    this.cache = cache
    return cache
  }

  private toManifest(comp: ExtractedComponent): ComponentManifest {
    const rendering = inferJsxRenderingHints({
      source: comp.componentSource,
      propNames: comp.props.map((p) => p.name),
    })
    const manifest: ComponentManifest = {
      id: `${this.designSystem}.${kebabCase(comp.name)}`,
      name: comp.name,
      framework: this.framework,
      designSystem: this.designSystem,
      props: comp.props,
      slots: [],
      events: [],
      source: {
        framework: this.framework,
        designSystem: this.designSystem,
        extractor: "local-react-jsx",
        declarations: [{ file: comp.filePath }],
      },
    }
    if (rendering) manifest.rendering = rendering
    if (comp.variantGroups.length > 0) manifest.extensions = { variants: comp.variantGroups }
    return manifest
  }

  /**
   * Parse one file. Also folds this module's `cva(…)` declarations into the
   * shared `variantConfigs` index so a LATER file's
   * `VariantProps<typeof toggleVariants>` can find them (the import specifier
   * is deliberately not resolved — see {@link resolveForwards}).
   */
  private tryExtract(
    filePath: string,
    variantConfigs: VariantConfigRegistry,
  ): ExtractedComponent[] {
    let source: string
    try {
      source = this.readFile(filePath)
    } catch {
      return []
    }
    let ast: BabelNode
    try {
      ast = parse(source, {
        sourceType: "module",
        plugins: ["jsx", "typescript"],
        errorRecovery: true,
      }) as unknown as BabelNode
    } catch {
      return []
    }

    const localCva = buildVariantConfigRegistry(ast)
    for (const [name, config] of localCva) {
      if (!variantConfigs.has(name)) variantConfigs.set(name, config)
    }
    const ctx: Ctx = { registry: buildTypeRegistry(ast), cva: localCva, source }
    const out: ExtractedComponent[] = []
    for (const comp of findComponents(ast, ctx)) {
      if (typeof comp.node.start !== "number" || typeof comp.node.end !== "number") continue
      out.push({
        name: comp.name,
        filePath,
        componentSource: source.slice(comp.node.start, comp.node.end),
        props: comp.props,
        variantGroups: comp.variantGroups,
        forwards: comp.forwards,
        pendingVariants: comp.pendingVariants,
      })
    }
    // No filename fallback: a file with no Capitalized exported component
    // (hooks, utils, types) produces no manifest — avoids polluting the
    // catalog. Anonymous default-export components can't be looked up by the
    // bridge's component name anyway.
    return out
  }
}

/** One component as parsed in pass 1, before cross-file references close. */
interface ExtractedComponent {
  name: string
  filePath: string
  componentSource: string
  props: ComponentPropManifest[]
  variantGroups: VariantGroupManifest[]
  /** `ComponentProps<typeof X>` references awaiting the whole-set index. */
  forwards: ForwardedProps[]
  /** `VariantProps<typeof x>` whose `cva(…)` wasn't in the same file. */
  pendingVariants: string[]
  resolved?: boolean
}

/**
 * Close a component's cross-file references against the whole-set indexes.
 *
 * **Resolution is by exported NAME, not by module specifier.** Following the
 * import would mean re-implementing Node + tsconfig `paths` resolution inside
 * an adapter whose entire contract today is "a string of source in, a manifest
 * out" — and the prototype's tsconfig isn't even plumbed here. Name lookup gets
 * the same answer for the conventions these patterns come with (`buttonVariants`
 * next to `Button`, one `Button` per repo) and degrades to today's behaviour
 * when it doesn't: a name that isn't in the index stays unresolved, so the
 * destructured-name fallback still surfaces the prop with an `unknown` control.
 * The cost of a wrong guess is bounded to prop metadata on a first-party
 * component, never a wrong edit — attribution routes on `rendering` hints,
 * which are never copied across components here.
 *
 * `visited` breaks the cycle two components that forward each other would form.
 */
function resolveForwards(
  comp: ExtractedComponent,
  byName: Map<string, ExtractedComponent>,
  variantConfigs: VariantConfigRegistry,
  visited: Set<string> = new Set(),
): void {
  if (comp.resolved || visited.has(comp.name)) return
  visited.add(comp.name)
  comp.resolved = true

  const claimed = new Set(comp.props.map((p) => p.name))
  const groups: VariantGroup[] = []

  for (const name of comp.pendingVariants) {
    const config = variantConfigs.get(name)
    if (config) groups.push(...config.groups)
  }

  for (const forward of comp.forwards) {
    const target = byName.get(forward.component)
    if (!target || target === comp) continue
    resolveForwards(target, byName, variantConfigs, visited)
    for (const prop of target.props) {
      if (!keyAllowed(prop.name, forward)) continue
      if (claimed.has(prop.name)) {
        upgradeProp(comp, prop)
        continue
      }
      claimed.add(prop.name)
      comp.props.push({ ...prop })
    }
    for (const group of target.variantGroups) {
      if (keyAllowed(group.name, forward)) groups.push(toVariantGroup(group))
    }
  }

  if (groups.length === 0) return
  // A destructured `{ variant, size }` already surfaced these names in pass 1
  // with an `unknown` control. Upgrade those in place rather than skipping the
  // axis — the placeholder must not shadow the real resolution.
  const upgraded = propsFromVariants(groups, new Set())
  for (const prop of upgraded) {
    if (claimed.has(prop.name)) upgradeProp(comp, prop)
    else {
      claimed.add(prop.name)
      comp.props.push(prop)
    }
  }
  const seen = new Set(comp.variantGroups.map((g) => g.name))
  for (const manifestGroup of variantGroupManifests(groups)) {
    if (!seen.has(manifestGroup.name)) comp.variantGroups.push(manifestGroup)
  }
}

/**
 * Replace a pass-1 `unknown` placeholder with a resolved prop's real
 * type/control. Only ever upgrades: a prop the component itself declared with a
 * concrete control keeps it, so a wrapper narrowing its base's type wins.
 */
function upgradeProp(comp: ExtractedComponent, resolved: ComponentPropManifest): void {
  const existing = comp.props.find((p) => p.name === resolved.name)
  if (!existing || existing.control.kind !== "unknown") return
  if (resolved.control.kind === "unknown") return
  existing.type = resolved.type
  existing.control = resolved.control
  if (resolved.defaultValue) existing.defaultValue = resolved.defaultValue
}

function keyAllowed(name: string, forward: ForwardedProps): boolean {
  if (forward.pick) return forward.pick.includes(name)
  if (forward.omit) return !forward.omit.includes(name)
  return true
}

/** `VariantGroupManifest` (the public mirror) back to the internal axis shape,
 *  so a forwarded axis produces the same control as a directly-declared one. */
function toVariantGroup(group: VariantGroupManifest): VariantGroup {
  const valueType = group.values.map((v) => JSON.stringify(v.value)).join(" | ")
  const axis: VariantGroup = {
    name: group.name,
    options: group.values,
    boolean: group.values.length === 0,
    valueType: group.values.length === 0 ? "boolean" : valueType,
  }
  if (group.defaultValue !== undefined) axis.defaultValue = group.defaultValue
  return axis
}

interface FoundComponent {
  name: string
  node: BabelNode
  props: ComponentPropManifest[]
  variantGroups: VariantGroupManifest[]
  forwards: ForwardedProps[]
  pendingVariants: string[]
}

/**
 * `React.ComponentProps<typeof Button>`, optionally narrowed:
 * `Pick<…, 'variant' | 'size'>` → `pick`, `Omit<…, 'children'>` → `omit`.
 */
interface ForwardedProps {
  component: string
  pick?: string[]
  omit?: string[]
}

/** Same-file `interface`/`type` declarations, used to resolve a component's
 *  prop type when the first param is annotated with a named type reference. */
interface TypeRegistry {
  /** interface name → its declaration node (members + `extends` clause). */
  interfaces: Map<string, BabelNode>
  /** type-alias name → its aliased type node. */
  aliases: Map<string, BabelNode>
}

/** Everything a props resolution needs from the enclosing module. */
interface Ctx {
  registry: TypeRegistry
  /** `const xVariants = cva(…)` declarations in this module. */
  cva: VariantConfigRegistry
  /** Module source, for slicing type text out of AST ranges. */
  source: string
}

/** Find top-level exported React components (Capitalized) and resolve each
 *  one's props (names + types → controls). Covers function decls, arrow
 *  consts, `forwardRef`/`memo`-wrapped render functions, and `export default`. */
function findComponents(ast: BabelNode, ctx: Ctx): FoundComponent[] {
  const program = ast.program as BabelNode | undefined
  const body = (program?.body as BabelNode[] | undefined) ?? []
  const out: FoundComponent[] = []

  for (const stmt of body) {
    // export function / function declaration
    const decl = stmt.type === "ExportNamedDeclaration" ? (stmt.declaration as BabelNode | null) : stmt
    if (decl && decl.type === "FunctionDeclaration") {
      const name = (decl.id as BabelNode | undefined)?.name
      if (typeof name === "string" && isComponentName(name)) {
        out.push(component(name, decl, decl.params as BabelNode[], undefined, ctx))
      }
      continue
    }
    // export const X = (...) => … / const X = (...) => …
    // export const X = forwardRef<Ref, Props>((...) => …) / memo(…)
    if (decl && decl.type === "VariableDeclaration") {
      for (const d of (decl.declarations as BabelNode[] | undefined) ?? []) {
        const name = (d.id as BabelNode | undefined)?.name
        const init = d.init as BabelNode | undefined
        if (typeof name !== "string" || !isComponentName(name) || !init) continue
        if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") {
          out.push(component(name, init, init.params as BabelNode[], undefined, ctx))
          continue
        }
        const wrapped = unwrapComponentCall(init)
        if (wrapped) {
          out.push(
            component(
              name,
              wrapped.render ?? init,
              (wrapped.render?.params as BabelNode[] | undefined) ?? [],
              wrapped.propsType,
              ctx,
            ),
          )
        }
      }
      continue
    }
    // export default function Name(...) / export default (...) => …
    if (stmt.type === "ExportDefaultDeclaration") {
      const d = stmt.declaration as BabelNode
      if (d?.type === "FunctionDeclaration") {
        const name = (d.id as BabelNode | undefined)?.name
        if (typeof name === "string" && isComponentName(name)) {
          out.push(component(name, d, d.params as BabelNode[], undefined, ctx))
        }
      }
      // anonymous default → handled by the filename fallback in tryExtract
    }
  }
  return out
}

function component(
  name: string,
  node: BabelNode,
  params: BabelNode[] | undefined,
  explicitPropsType: BabelNode | undefined,
  ctx: Ctx,
): FoundComponent {
  const resolved = resolveProps(params, ctx, explicitPropsType)
  return { name, node, ...resolved }
}

/**
 * A React component name is Capitalized (`App`, `MetricsCard`).
 *
 * Note this also matches a Capitalized non-component const. That was already
 * true for arrow consts and is harmless: a non-component const with no props
 * and no JSX yields a manifest with no props and no hints.
 */
function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name)
}

/**
 * Higher-order component wrappers whose FIRST argument is the render function.
 * The value is the index of the PROPS type in the call's type arguments —
 * `forwardRef<TRef, TProps>` puts props second, `memo<TProps>` first.
 *
 * These two cover the overwhelming majority of first-party React components in
 * the wild (every shadcn/ui primitive that forwards a ref, every memoized list
 * row). Before they were recognized, such a component produced NO manifest at
 * all — so a bare-name lookup for `Button` fell through to whatever npm
 * library also exports a `Button`.
 */
const COMPONENT_WRAPPERS: Record<string, number> = { forwardRef: 1, memo: 0 }

interface UnwrappedComponent {
  /** The inner render function, when it is an inline function expression. */
  render?: BabelNode
  /** Props type from the wrapper's type arguments, when given explicitly. */
  propsType?: BabelNode
}

/**
 * Peel `forwardRef(…)` / `memo(…)` / `React.forwardRef(…)` — including nested
 * `memo(forwardRef(…))` — down to the render function and, when the call site
 * spells them, the explicit props type arguments.
 *
 * Returns null for a call that isn't a recognized wrapper, so an ordinary
 * `const X = makeThing()` never masquerades as a component definition.
 */
function unwrapComponentCall(node: BabelNode, depth = 0): UnwrappedComponent | null {
  if (depth > 4 || node.type !== "CallExpression") return null
  const wrapperName = calleeName(node.callee as BabelNode | undefined)
  if (!wrapperName || !(wrapperName in COMPONENT_WRAPPERS)) return null

  const typeParams = (node.typeParameters ?? node.typeArguments) as BabelNode | undefined
  const typeArgs = (typeParams?.params as BabelNode[] | undefined) ?? []
  const propsType = typeArgs[COMPONENT_WRAPPERS[wrapperName]]

  const first = (node.arguments as BabelNode[] | undefined)?.[0]
  if (first?.type === "ArrowFunctionExpression" || first?.type === "FunctionExpression") {
    return { render: first, propsType }
  }
  if (first?.type === "CallExpression") {
    const inner = unwrapComponentCall(first, depth + 1)
    if (inner) return { render: inner.render, propsType: propsType ?? inner.propsType }
  }
  // `memo(SomeAlreadyDeclaredComponent)` — nothing new to extract; the
  // underlying declaration is found on its own pass.
  return propsType ? { propsType } : null
}

/** `forwardRef` / `React.forwardRef` → `"forwardRef"`. */
function calleeName(callee: BabelNode | undefined): string | null {
  if (!callee) return null
  if (callee.type === "Identifier" && typeof callee.name === "string") return callee.name
  if (callee.type === "MemberExpression") {
    const prop = callee.property as BabelNode | undefined
    if (!callee.computed && prop?.type === "Identifier" && typeof prop.name === "string") {
      return prop.name
    }
  }
  return null
}

/** Collect same-file `interface`/`type` declarations (incl. `export`ed ones). */
function buildTypeRegistry(ast: BabelNode): TypeRegistry {
  const interfaces = new Map<string, BabelNode>()
  const aliases = new Map<string, BabelNode>()
  const program = ast.program as BabelNode | undefined
  const body = (program?.body as BabelNode[] | undefined) ?? []
  for (const stmt of body) {
    const decl =
      stmt.type === "ExportNamedDeclaration" ? (stmt.declaration as BabelNode | null) : stmt
    if (!decl) continue
    if (decl.type === "TSInterfaceDeclaration") {
      const name = (decl.id as BabelNode | undefined)?.name
      if (typeof name === "string") interfaces.set(name, decl)
    } else if (decl.type === "TSTypeAliasDeclaration") {
      const name = (decl.id as BabelNode | undefined)?.name
      const aliased = decl.typeAnnotation as BabelNode | undefined
      if (typeof name === "string" && aliased) aliases.set(name, aliased)
    }
  }
  return { interfaces, aliases }
}

/**
 * What a props type resolved to: TS member signatures plus any cva variant
 * axes contributed by a `VariantProps<typeof …>` member. Both halves are
 * needed because a shadcn-style props type is exactly the union of the two.
 */
interface ResolvedShape {
  members: BabelNode[]
  variants: VariantGroup[]
  /** `ComponentProps<typeof X>` references, closed in pass 2. */
  forwards: ForwardedProps[]
  /** `VariantProps<typeof x>` names whose `cva(…)` wasn't in this file. */
  pendingVariants: string[]
}

function emptyShape(): ResolvedShape {
  return { members: [], variants: [], forwards: [], pendingVariants: [] }
}

/**
 * Resolve a component's props from its first param (or an explicit props type
 * supplied by a `forwardRef<Ref, Props>` call site). Returns a full
 * `ComponentPropManifest[]` (names + types → controls) when the type resolves
 * to an object shape and/or a cva variant config; otherwise falls back to prop
 * NAMES from a destructured pattern (control `unknown`); otherwise `[]`.
 */
function resolveProps(
  params: BabelNode[] | undefined,
  ctx: Ctx,
  explicitPropsType?: BabelNode,
): {
  props: ComponentPropManifest[]
  variantGroups: VariantGroupManifest[]
  forwards: ForwardedProps[]
  pendingVariants: string[]
} {
  const first = params?.[0]
  const typeNode = explicitPropsType ?? (first ? paramTypeNode(first) : undefined)
  const shape = typeNode ? resolveShape(typeNode, ctx, 0) : null
  const destructured = first ? destructuredPropNames(first) : []
  if (shape) {
    const typed = propsFromMembers(shape.members, ctx)
    // cva axes go AFTER the explicit members, so an authored `variant?: 'a'|'b'`
    // declaration wins over the inferred one (propsFromVariants skips names the
    // member list already claimed).
    const claimed = new Set(typed.map((p) => p.name))
    typed.push(...propsFromVariants(shape.variants, claimed))
    // Belt-and-suspenders: never drop a destructured name the type path
    // couldn't surface (a cross-file `extends`/intersection member, an exotic
    // member node). Add such names with an unknown control so attribution +
    // the inspector still see them. A name that a pass-2 forward later
    // resolves gets upgraded in place (see `resolveForwards`).
    const covered = new Set(typed.map((p) => p.name))
    for (const name of destructured) {
      if (!covered.has(name)) {
        typed.push({ name, type: "", required: false, control: { kind: "unknown" } })
      }
    }
    return {
      props: typed,
      variantGroups: variantGroupManifests(shape.variants),
      forwards: shape.forwards,
      pendingVariants: shape.pendingVariants,
    }
  }
  // Fallback: destructured names with unknown controls (untyped or
  // unresolvable-type param).
  return {
    props: destructured.map((name) => ({
      name,
      type: "",
      required: false,
      control: { kind: "unknown" as const },
    })),
    variantGroups: [],
    forwards: [],
    pendingVariants: [],
  }
}

/** The type node annotating a param (`{ x }: Props` / `props: Props`). */
function paramTypeNode(param: BabelNode): BabelNode | undefined {
  const ta = param.typeAnnotation as BabelNode | undefined
  return ta?.typeAnnotation as BabelNode | undefined
}

/** Prop names from a destructured object-pattern param (fallback path). */
function destructuredPropNames(param: BabelNode): string[] {
  if (param.type !== "ObjectPattern") return []
  const names: string[] = []
  for (const p of (param.properties as BabelNode[] | undefined) ?? []) {
    if (p.type !== "ObjectProperty") continue
    const key = p.key as BabelNode | undefined
    if (key?.type === "Identifier" && typeof key.name === "string") names.push(key.name)
  }
  return names
}

/**
 * Resolve a TS type node to its object-shape member list (TSPropertySignature[])
 * plus any cva variant axes, following same-file type references and merging
 * intersections. Returns null for a shape that yields neither (a primitive, a
 * cross-file import, etc.). `depth` guards against cyclic type aliases.
 */
function resolveShape(typeNode: BabelNode, ctx: Ctx, depth: number): ResolvedShape | null {
  if (depth > 8) return null
  if (typeNode.type === "TSTypeLiteral") {
    return { ...emptyShape(), members: (typeNode.members as BabelNode[] | undefined) ?? [] }
  }
  if (typeNode.type === "TSTypeReference") {
    const typeParams = (typeNode.typeParameters ?? typeNode.typeArguments) as BabelNode | undefined
    const referenced = rightmostTypeName(typeNode.typeName as BabelNode | undefined)

    // `VariantProps<typeof buttonVariants>`
    const variantTarget = variantPropsTarget(typeNode.typeName as BabelNode | undefined, typeParams)
    if (variantTarget) {
      const local = ctx.cva.get(variantTarget)
      return local
        ? { ...emptyShape(), variants: local.groups }
        : { ...emptyShape(), pendingVariants: [variantTarget] }
    }

    // `ComponentProps<typeof Button>` / `ComponentPropsWithoutRef<typeof X>`
    const forwarded = componentPropsTarget(referenced, typeParams)
    if (forwarded) return { ...emptyShape(), forwards: [{ component: forwarded }] }

    // `Pick<T, 'a' | 'b'>` / `Omit<T, 'a'>` — narrow whatever T resolves to.
    if (referenced === "Pick" || referenced === "Omit") {
      const params = (typeParams?.params as BabelNode[] | undefined) ?? []
      const inner = params[0] ? resolveShape(params[0], ctx, depth + 1) : null
      const keys = stringLiteralKeys(params[1])
      if (!inner) return null
      return keys ? narrowShape(inner, keys, referenced === "Pick") : inner
    }

    if (typeof referenced !== "string") return null
    const iface = ctx.registry.interfaces.get(referenced)
    if (iface) return resolveInterfaceShape(iface, ctx, depth + 1)
    const alias = ctx.registry.aliases.get(referenced)
    if (alias) return resolveShape(alias, ctx, depth + 1)
    return null
  }
  if (typeNode.type === "TSIntersectionType") {
    const merged = emptyShape()
    let any = false
    for (const sub of (typeNode.types as BabelNode[] | undefined) ?? []) {
      const subShape = resolveShape(sub, ctx, depth + 1)
      if (subShape) {
        any = true
        mergeShape(merged, subShape)
      }
      // Unresolvable members of an intersection (cross-file `HTMLProps`,
      // `React.ComponentProps<'button'>`, etc.) are skipped — we surface what
      // we can rather than refusing the whole.
    }
    return any ? merged : null
  }
  return null
}

function mergeShape(into: ResolvedShape, from: ResolvedShape): void {
  into.members.push(...from.members)
  into.variants.push(...from.variants)
  into.forwards.push(...from.forwards)
  into.pendingVariants.push(...from.pendingVariants)
}

/** Apply `Pick`/`Omit` keys: filter the concrete halves now, and record the
 *  narrowing on any pending forward so pass 2 applies the same rule. */
function narrowShape(
  shape: ResolvedShape,
  keys: string[],
  isPick: boolean,
): ResolvedShape {
  const allow = (name: string) => (isPick ? keys.includes(name) : !keys.includes(name))
  return {
    members: shape.members.filter((m) => {
      const name = memberName(m)
      return name === null ? !isPick : allow(name)
    }),
    variants: shape.variants.filter((v) => allow(v.name)),
    pendingVariants: shape.pendingVariants,
    forwards: shape.forwards.map((f) =>
      isPick ? { ...f, pick: keys } : { ...f, omit: [...(f.omit ?? []), ...keys] },
    ),
  }
}

/** `'a' | 'b'` or `'a'` → `['a','b']` / `['a']`; anything else → null. */
function stringLiteralKeys(node: BabelNode | undefined): string[] | null {
  if (!node) return null
  if (node.type === "TSLiteralType") {
    const lit = node.literal as BabelNode | undefined
    return lit?.type === "StringLiteral" && typeof lit.value === "string" ? [lit.value] : null
  }
  if (node.type === "TSUnionType") {
    const out: string[] = []
    for (const member of (node.types as BabelNode[] | undefined) ?? []) {
      const one = stringLiteralKeys(member)
      if (!one) return null
      out.push(...one)
    }
    return out.length > 0 ? out : null
  }
  return null
}

/**
 * `ComponentProps<typeof Button>` → `"Button"`. Only a BARE Capitalized
 * identifier qualifies: `ComponentProps<'button'>` (an intrinsic element) and
 * `ComponentProps<typeof Radix.Root>` (a library component we have no manifest
 * for here) both correctly return null.
 */
const COMPONENT_PROPS_TYPES = new Set([
  "ComponentProps",
  "ComponentPropsWithoutRef",
  "ComponentPropsWithRef",
])

function componentPropsTarget(
  referenced: string | null,
  typeParams: BabelNode | undefined,
): string | null {
  if (!referenced || !COMPONENT_PROPS_TYPES.has(referenced)) return null
  const first = ((typeParams?.params as BabelNode[] | undefined) ?? [])[0]
  if (first?.type !== "TSTypeQuery") return null
  const exprName = first.exprName as BabelNode | undefined
  if (exprName?.type !== "Identifier" || typeof exprName.name !== "string") return null
  return isComponentName(exprName.name) ? exprName.name : null
}

function rightmostTypeName(node: BabelNode | undefined): string | null {
  if (!node) return null
  if (node.type === "Identifier" && typeof node.name === "string") return node.name
  if (node.type === "TSQualifiedName") return rightmostTypeName(node.right as BabelNode | undefined)
  return null
}

/** An interface's shape = its own members + those of every same-file interface
 *  or alias it `extends` (own members win on name collision), plus any cva
 *  axes contributed by `extends VariantProps<typeof …>`. Cross-file extends is
 *  skipped. */
function resolveInterfaceShape(decl: BabelNode, ctx: Ctx, depth: number): ResolvedShape {
  const own = ((decl.body as BabelNode | undefined)?.body as BabelNode[] | undefined) ?? []
  const extendsArr = (decl.extends as BabelNode[] | undefined) ?? []
  if (depth > 8 || extendsArr.length === 0) return { ...emptyShape(), members: own }
  const inherited = emptyShape()
  for (const ext of extendsArr) {
    const expr = ext.expression as BabelNode | undefined
    const extTypeParams = (ext.typeParameters ?? ext.typeArguments) as BabelNode | undefined
    // `interface Props extends VariantProps<typeof buttonVariants>` — the
    // shadcn-with-an-interface spelling of the same pattern.
    const target = variantPropsTarget(expr, extTypeParams)
    if (target) {
      const config = ctx.cva.get(target)
      if (config) inherited.variants.push(...config.groups)
      else inherited.pendingVariants.push(target)
      continue
    }
    const extName = expr?.type === "Identifier" ? (expr.name as string | undefined) : undefined
    if (typeof extName !== "string") continue
    // `interface Props extends ComponentProps<typeof Button>` — same forward
    // as the intersection spelling.
    const forwarded = componentPropsTarget(extName, extTypeParams)
    if (forwarded) {
      inherited.forwards.push({ component: forwarded })
      continue
    }
    const base = ctx.registry.interfaces.get(extName)
    if (base) {
      mergeShape(inherited, resolveInterfaceShape(base, ctx, depth + 1))
      continue
    }
    // An interface can also extend a same-file object type alias
    // (`type Base = { id: string }; interface Props extends Base`). Resolve
    // it through the alias path.
    const alias = ctx.registry.aliases.get(extName)
    if (alias) {
      const shape = resolveShape(alias, ctx, depth + 1)
      if (shape) mergeShape(inherited, shape)
    }
    // Cross-file / unresolvable extends → skipped; the destructured-name merge
    // in resolveProps keeps those props from disappearing entirely.
  }
  // Own members first so they override inherited ones with the same name
  // (propsFromMembers keeps first-seen).
  return { ...inherited, members: [...own, ...inherited.members] }
}

/** A member signature's declared name (`title`, `"aria-label"`), or null for a
 *  computed / index signature. */
function memberName(member: BabelNode): string | null {
  const key = member.key as BabelNode | undefined
  if (key?.type === "Identifier" && typeof key.name === "string") return key.name
  if (key?.type === "StringLiteral" && typeof key.value === "string") return key.value
  return null
}

/** Build prop manifests from resolved member nodes (property + method
 *  signatures). First-seen wins on name collision. */
function propsFromMembers(members: BabelNode[], ctx: Ctx): ComponentPropManifest[] {
  const props: ComponentPropManifest[] = []
  const seen = new Set<string>()
  for (const member of members) {
    const isProp = member.type === "TSPropertySignature"
    const isMethod = member.type === "TSMethodSignature"
    if (!isProp && !isMethod) continue
    const name = memberName(member)
    if (!name || seen.has(name)) continue
    seen.add(name)
    const required = !member.optional
    if (isMethod) {
      // `onClick(): void` — a callback declared method-style. Surface as an
      // event prop (the same control a `onClick: () => void` field gets).
      const typeText =
        typeof member.start === "number" && typeof member.end === "number"
          ? ctx.source.slice(member.start, member.end).trim()
          : ""
      props.push({ name, type: typeText, required, control: { kind: "event", valueType: typeText } })
      continue
    }
    const typeNode = (member.typeAnnotation as BabelNode | undefined)?.typeAnnotation as
      | BabelNode
      | undefined
    const typeText =
      typeNode && typeof typeNode.start === "number" && typeof typeNode.end === "number"
        ? ctx.source.slice(typeNode.start, typeNode.end).trim()
        : ""
    props.push({
      name,
      type: typeText,
      required,
      control: inferControl(typeNode, typeText, name, ctx),
    })
  }
  return props
}

/**
 * cva axes → props. Always optional (cva variants fall back to
 * `defaultVariants`), always finite-choice (or boolean for a `true`/`false`
 * axis). `claimed` holds names an explicit member signature already produced.
 */
function propsFromVariants(
  variants: VariantGroup[],
  claimed: Set<string>,
): ComponentPropManifest[] {
  const out: ComponentPropManifest[] = []
  for (const group of variants) {
    if (claimed.has(group.name)) continue
    claimed.add(group.name)
    const prop: ComponentPropManifest = {
      name: group.name,
      type: group.valueType,
      required: false,
      control: controlForVariant(group),
    }
    if (group.defaultValue !== undefined) {
      prop.defaultValue = { value: group.defaultValue, source: "documentation" }
    }
    out.push(prop)
  }
  return out
}

function controlForVariant(group: VariantGroup): ManifestControl {
  if (group.boolean) return { kind: "boolean", valueType: group.valueType }
  return { kind: "finite-choice", valueType: group.valueType, options: group.options }
}

/** Mirror the axes onto `extensions.variants` — the manifest model's declared
 *  home for machine-readable variant config (see `VariantGroupManifest`). */
function variantGroupManifests(variants: VariantGroup[]): VariantGroupManifest[] {
  const seen = new Set<string>()
  const out: VariantGroupManifest[] = []
  for (const group of variants) {
    if (seen.has(group.name)) continue
    seen.add(group.name)
    const entry: VariantGroupManifest = {
      name: group.name,
      propName: group.name,
      values: group.options,
    }
    if (group.defaultValue !== undefined) entry.defaultValue = group.defaultValue
    out.push(entry)
  }
  return out
}

/**
 * Babel-AST type → inspector control, mirroring local-vue's TS-compiler
 * `inferControl`. React tweaks: function props → `event`; `children` /
 * `ReactNode`-typed props → `slot` (per the ComponentManifest React convention).
 */
function inferControl(
  typeNode: BabelNode | undefined,
  typeText: string,
  propName: string,
  ctx: Ctx,
  depth = 0,
): ManifestControl {
  if (!typeNode) return { kind: "unknown" }

  // React content props surface as slots.
  if (propName === "children" || isReactNodeType(typeNode)) {
    return { kind: "slot", valueType: typeText }
  }

  if (typeNode.type === "TSStringKeyword") return { kind: "text", valueType: typeText }
  if (typeNode.type === "TSNumberKeyword") return { kind: "number", valueType: typeText }
  if (typeNode.type === "TSBooleanKeyword") return { kind: "boolean", valueType: typeText }

  // Function props are React callbacks → event.
  if (typeNode.type === "TSFunctionType") return { kind: "event", valueType: typeText }

  // `TextVariantProps['color']` — an indexed access into a cva variant config.
  // The common spelling when a component re-declares its variant props by hand
  // instead of intersecting the whole `VariantProps<…>`.
  const indexed = variantFromIndexedAccess(typeNode, ctx)
  if (indexed) return controlForVariant(indexed)

  // Union of literals → finite-choice (dropping null/undefined).
  if (typeNode.type === "TSUnionType") {
    const literalValues: ManifestValue[] = []
    let allLiteralOrNullish = true
    for (const member of (typeNode.types as BabelNode[] | undefined) ?? []) {
      if (member.type === "TSUndefinedKeyword" || member.type === "TSNullKeyword") continue
      if (member.type === "TSLiteralType") {
        const lit = member.literal as BabelNode | undefined
        if (lit?.type === "NullLiteral") continue
        const v = literalValue(lit)
        if (v !== UNRESOLVED) {
          literalValues.push(v)
          continue
        }
      }
      allLiteralOrNullish = false
      break
    }
    if (allLiteralOrNullish && literalValues.length > 0) {
      const allBool =
        literalValues.length === 2 &&
        literalValues.includes(true) &&
        literalValues.includes(false)
      if (allBool) return { kind: "boolean", valueType: typeText }
      const options: ControlOption[] = literalValues.map((v) => ({ value: v, label: String(v) }))
      return { kind: "finite-choice", valueType: typeText, options }
    }
    return { kind: "unknown", valueType: typeText }
  }

  // Arrays.
  if (typeNode.type === "TSArrayType") return { kind: "array", valueType: typeText }
  if (
    typeNode.type === "TSTypeOperator" &&
    typeNode.operator === "readonly" &&
    (typeNode.typeAnnotation as BabelNode | undefined)?.type === "TSArrayType"
  ) {
    return { kind: "array", valueType: typeText }
  }

  // References / object literals → object, with primitive-wrapper special cases.
  if (
    typeNode.type === "TSTypeLiteral" ||
    typeNode.type === "TSTypeReference" ||
    typeNode.type === "TSIntersectionType"
  ) {
    if (typeNode.type === "TSTypeReference") {
      const refName = (typeNode.typeName as BabelNode | undefined)?.name
      if (refName === "String") return { kind: "text", valueType: typeText }
      if (refName === "Number") return { kind: "number", valueType: typeText }
      if (refName === "Boolean") return { kind: "boolean", valueType: typeText }
      if (refName === "Array" || refName === "ReadonlyArray") {
        return { kind: "array", valueType: typeText }
      }
      // A same-file alias to a literal union (`type HeadingTag = 'h1' | 'h2'`)
      // is a finite choice, not an opaque object. Keep the ALIAS as the
      // displayed `valueType` — it is what the author wrote — while inferring
      // the control from what it expands to.
      const alias = typeof refName === "string" ? ctx.registry.aliases.get(refName) : undefined
      if (alias && depth < 8) {
        const resolved = inferControl(alias, typeText, propName, ctx, depth + 1)
        if (resolved.kind !== "unknown") return resolved
      }
    }
    return { kind: "object", valueType: typeText }
  }

  return { kind: "unknown", valueType: typeText }
}

/**
 * `P['size']` where `P` resolves (directly or through one same-file alias) to
 * `VariantProps<typeof someVariants>` → that axis. Returns null for any other
 * indexed access, so a `Foo['bar']` over an ordinary type is untouched.
 */
function variantFromIndexedAccess(typeNode: BabelNode, ctx: Ctx): VariantGroup | null {
  if (typeNode.type !== "TSIndexedAccessType") return null
  const indexType = typeNode.indexType as BabelNode | undefined
  if (indexType?.type !== "TSLiteralType") return null
  const lit = indexType.literal as BabelNode | undefined
  if (lit?.type !== "StringLiteral" || typeof lit.value !== "string") return null
  const axis = lit.value

  const groups = resolveVariantGroups(typeNode.objectType as BabelNode | undefined, ctx, 0)
  if (!groups) return null
  return groups.find((g) => g.name === axis) ?? null
}

/**
 * Follow same-file aliases until a `VariantProps<typeof …>` reference.
 *
 * Same-file only: unlike the whole-shape path this runs while building a single
 * prop's control, before the whole-set index exists. An indexed access into an
 * IMPORTED variants config therefore stays `unknown` — a bounded gap, since the
 * spelling only appears next to the `cva(…)` it indexes.
 */
function resolveVariantGroups(
  node: BabelNode | undefined,
  ctx: Ctx,
  depth: number,
): VariantGroup[] | null {
  if (!node || depth > 8 || node.type !== "TSTypeReference") return null
  const target = variantPropsTarget(
    node.typeName as BabelNode | undefined,
    (node.typeParameters ?? node.typeArguments) as BabelNode | undefined,
  )
  if (target) return ctx.cva.get(target)?.groups ?? null
  const name = (node.typeName as BabelNode | undefined)?.name
  if (typeof name !== "string") return null
  const alias = ctx.registry.aliases.get(name)
  return alias ? resolveVariantGroups(alias, ctx, depth + 1) : null
}

/** `children`-style content type: `ReactNode` / `React.ReactNode` / `ReactElement`. */
function isReactNodeType(typeNode: BabelNode): boolean {
  if (typeNode.type !== "TSTypeReference") return false
  const tn = typeNode.typeName as BabelNode | undefined
  // Bare identifier `ReactNode`.
  if (tn?.type === "Identifier") {
    return tn.name === "ReactNode" || tn.name === "ReactElement"
  }
  // Qualified `React.ReactNode`.
  if (tn?.type === "TSQualifiedName") {
    const right = (tn.right as BabelNode | undefined)?.name
    return right === "ReactNode" || right === "ReactElement"
  }
  return false
}

const UNRESOLVED = Symbol("unresolved")
type ResolvedLiteral = ManifestValue | typeof UNRESOLVED

/** Read a literal value from a TSLiteralType's `.literal` Babel node. */
function literalValue(lit: BabelNode | undefined): ResolvedLiteral {
  if (!lit) return UNRESOLVED
  if (lit.type === "StringLiteral") return lit.value as string
  if (lit.type === "NumericLiteral") return lit.value as number
  if (lit.type === "BooleanLiteral") return lit.value as boolean
  // `-1` etc. in a literal type is a UnaryExpression around a NumericLiteral.
  if (
    lit.type === "UnaryExpression" &&
    (lit.operator === "-" || lit.operator === "+") &&
    (lit.argument as BabelNode | undefined)?.type === "NumericLiteral"
  ) {
    const n = (lit.argument as BabelNode).value as number
    return lit.operator === "-" ? -n : n
  }
  return UNRESOLVED
}
