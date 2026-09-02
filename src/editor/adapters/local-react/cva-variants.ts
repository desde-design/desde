/**
 * Variant-config extraction for first-party React components — the
 * `cva({ variants: … })` / `VariantProps<typeof …>` pattern.
 *
 * ## Why this exists
 *
 * `class-variance-authority` (and its lookalikes: `tailwind-variants`'s `tv`,
 * `cva`-style helpers people hand-roll) is the dominant way a React design
 * system declares a component's finite choice axes. The canonical shadcn/ui
 * primitive looks like this:
 *
 * ```tsx
 * const buttonVariants = cva("…base…", {
 *   variants: {
 *     variant: { default: "…", destructive: "…", outline: "…" },
 *     size: { default: "…", sm: "…", lg: "…", icon: "…" },
 *   },
 *   defaultVariants: { variant: "default", size: "default" },
 * })
 *
 * function Button({ className, variant, size, …props }:
 *   React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) { … }
 * ```
 *
 * The prop types `variant` and `size` exist ONLY as an inference off the object
 * literal. A purely syntactic prop-type reader sees `VariantProps<typeof
 * buttonVariants>`, cannot resolve it, and degrades both props to
 * `control: 'unknown'` with no options — which is what
 * `LocalReactManifestSource` did before this module: measured on a vendored
 * shadcn/ui catalogue (61 primitives), 30 components declared a `variant` prop
 * and only 5 of them produced a finite-choice control.
 *
 * ## Why syntactic and not the TypeScript checker
 *
 * `vue-dts-meta` / `react-dts-meta` use the real TS checker, and that is the
 * right call *there*: they read a LIBRARY's shipped `.d.ts`, where the props
 * type is the product of generics, `Pick`/`Omit`, and cross-file aliases that
 * only a checker can collapse. This case is different in three ways that all
 * point the other way:
 *
 * 1. **The information is already local and literal.** The variant keys and
 *    their option keys are string keys of an object literal in the SAME module
 *    as the component — colocation is the pattern's whole convention. There is
 *    nothing to resolve; a checker would re-derive by inference what is sitting
 *    right there as source text.
 * 2. **A checker changes this source's contract.** `LocalReactManifestSource`
 *    is a pure, injectable-reader, per-file Babel parse with no I/O beyond
 *    `readFile`. Going through the checker would require the prototype's
 *    tsconfig, a TS program over first-party source, and
 *    `class-variance-authority` to be resolvable from `node_modules` — turning
 *    a millisecond-scale per-file parse into a program build, and making
 *    extraction fail on a prototype whose types don't compile. First-party
 *    prototype source is exactly the code most likely to be mid-edit.
 * 3. **A checker would over-collect.** It would expand
 *    `React.ComponentProps<"button">` into ~250 DOM attributes, drowning the
 *    handful of props the user actually authored. The current deliberate
 *    behaviour is to skip unresolvable platform-prop bases; a checker would
 *    have to re-introduce that filter by hand.
 *
 * The trade is stated honestly: a cva object built in another module, or
 * assembled dynamically (spread, computed keys), is NOT recovered here — those
 * fall back to the same `unknown` control as before. That is the correct
 * split of labour with the dts extractors, which own the hard cases.
 *
 * Pure: AST + source string in, variant config out. No I/O.
 */
import type { ControlOption, ManifestValue } from "../../core"

interface BabelNode {
  type?: string
  start?: number | null
  end?: number | null
  [key: string]: unknown
}

/** One variant axis: a key of the `variants` object (`variant`, `size`, …). */
export interface VariantGroup {
  /** The prop name this axis surfaces as. */
  name: string
  /**
   * The axis's choices, in declaration order. Empty for a boolean axis
   * (`variants: { disabled: { true: …, false: … } }`), which surfaces as a
   * boolean control instead.
   */
  options: ControlOption[]
  /** True when the axis's keys are only `true`/`false` (cva boolean variant). */
  boolean: boolean
  /** From `defaultVariants`, when declared. */
  defaultValue?: ManifestValue
  /** Rendered union for display, e.g. `"default" | "destructive"`. */
  valueType: string
}

/** A `const xVariants = cva(…)` declaration's parsed variant axes. */
export interface VariantConfig {
  /** Declaration name, e.g. `buttonVariants` — the `typeof` target. */
  name: string
  groups: VariantGroup[]
}

/** Declaration name → its parsed variant axes, for one module. */
export type VariantConfigRegistry = Map<string, VariantConfig>

/**
 * Collect every top-level `const X = <call>(…)` in the module whose call
 * carries an object argument with a `variants` object property.
 *
 * Deliberately callee-agnostic: `cva(base, config)`, `cva(config)`,
 * `tv(config)`, and any project-local wrapper with the same shape all match.
 * The discriminator is the SHAPE of the config object, not the imported
 * symbol's name — which keeps this from being an adapter for one npm package.
 */
export function buildVariantConfigRegistry(ast: BabelNode): VariantConfigRegistry {
  const registry: VariantConfigRegistry = new Map()
  const program = ast.program as BabelNode | undefined
  const body = (program?.body as BabelNode[] | undefined) ?? []
  for (const stmt of body) {
    const decl = stmt.type === "ExportNamedDeclaration" ? (stmt.declaration as BabelNode | null) : stmt
    if (!decl || decl.type !== "VariableDeclaration") continue
    for (const d of (decl.declarations as BabelNode[] | undefined) ?? []) {
      const name = (d.id as BabelNode | undefined)?.name
      const init = d.init as BabelNode | undefined
      if (typeof name !== "string" || !init || init.type !== "CallExpression") continue
      const config = parseVariantCall(init)
      if (config) registry.set(name, { name, groups: config })
    }
  }
  return registry
}

/** The first argument that looks like a variant config, parsed. */
function parseVariantCall(call: BabelNode): VariantGroup[] | null {
  for (const arg of (call.arguments as BabelNode[] | undefined) ?? []) {
    if (arg?.type !== "ObjectExpression") continue
    const variants = objectProperty(arg, "variants")
    if (!variants || variants.type !== "ObjectExpression") continue
    const defaults = objectProperty(arg, "defaultVariants")
    const groups = parseVariantsObject(variants, defaults)
    if (groups.length > 0) return groups
  }
  return null
}

function parseVariantsObject(
  variants: BabelNode,
  defaults: BabelNode | undefined,
): VariantGroup[] {
  const defaultsByKey = new Map<string, ManifestValue>()
  if (defaults?.type === "ObjectExpression") {
    for (const prop of (defaults.properties as BabelNode[] | undefined) ?? []) {
      if (prop.type !== "ObjectProperty") continue
      const key = propertyKey(prop)
      if (key === null) continue
      const value = literalValue(prop.value as BabelNode | undefined)
      if (value !== UNRESOLVED) defaultsByKey.set(String(key), value)
    }
  }

  const groups: VariantGroup[] = []
  for (const prop of (variants.properties as BabelNode[] | undefined) ?? []) {
    if (prop.type !== "ObjectProperty") continue
    const axis = propertyKey(prop)
    if (axis === null) continue
    const value = prop.value as BabelNode | undefined
    if (value?.type !== "ObjectExpression") continue
    // An axis is all-or-nothing: a `...spread` or a computed key means the
    // real option set is larger than what is statically readable here, and a
    // PARTIAL finite-choice is worse than none — the picker would present the
    // survivors as the complete set and could overwrite a valid value living
    // in the part we could not see.
    //
    // HONEST NOTE ON THIS GUARD: it is defence in depth, not a bug fix. Both
    // shapes already degrade to `unknown` today — MEASURED by removing this
    // block and re-probing: `variants: { variant: { ...shared, primary: "p" } }`
    // and `{ [KEY]: "x", primary: "p" }` both yield kind:"unknown" with or
    // without it, while a fully-readable sibling axis still resolves. It is
    // kept because it states the invariant at the point that owns it rather
    // than relying on a downstream layer to keep enforcing it, and it is six
    // lines. The colocated tests pin the BEHAVIOUR, so they stay meaningful
    // whichever layer provides it.
    const keys: ManifestValue[] = []
    let axisFullyReadable = true
    for (const optionProp of (value.properties as BabelNode[] | undefined) ?? []) {
      if (optionProp.type !== "ObjectProperty") {
        axisFullyReadable = false
        break
      }
      const key = propertyKey(optionProp)
      if (key === null) {
        axisFullyReadable = false
        break
      }
      keys.push(key)
    }
    if (!axisFullyReadable) continue
    if (keys.length === 0) continue
    const name = String(axis)
    const isBoolean = keys.every((k) => k === "true" || k === "false" || typeof k === "boolean")
    const options: ControlOption[] = isBoolean
      ? []
      : keys.map((k) => ({ value: k, label: String(k) }))
    const valueType = isBoolean
      ? "boolean"
      : keys.map((k) => (typeof k === "number" ? String(k) : JSON.stringify(k))).join(" | ")
    const group: VariantGroup = { name, options, boolean: isBoolean, valueType }
    const dflt = defaultsByKey.get(name)
    if (dflt !== undefined) group.defaultValue = normalizeDefault(dflt, isBoolean)
    groups.push(group)
  }
  return groups
}

/** `defaultVariants: { disabled: true }` on a boolean axis stays boolean; a
 *  string default on a string axis stays as written. */
function normalizeDefault(value: ManifestValue, isBoolean: boolean): ManifestValue {
  if (!isBoolean) return value
  if (value === "true") return true
  if (value === "false") return false
  return value
}

/**
 * When `typeName`/`typeParams` spell `VariantProps<typeof someVariants>`,
 * return `"someVariants"`. Otherwise null.
 *
 * Accepts both the bare `VariantProps` identifier and a qualified
 * `cva.VariantProps`-style reference (the right-most name is what matters).
 */
export function variantPropsTarget(
  typeName: BabelNode | undefined,
  typeParams: BabelNode | undefined,
): string | null {
  const referenced = rightmostName(typeName)
  if (referenced !== "VariantProps") return null
  const params = (typeParams?.params as BabelNode[] | undefined) ?? []
  const first = params[0]
  if (first?.type !== "TSTypeQuery") return null
  const exprName = first.exprName as BabelNode | undefined
  const target = rightmostName(exprName)
  return target ?? null
}

function rightmostName(node: BabelNode | undefined): string | null {
  if (!node) return null
  if (node.type === "Identifier" && typeof node.name === "string") return node.name
  if (node.type === "TSQualifiedName") return rightmostName(node.right as BabelNode | undefined)
  return null
}

function objectProperty(obj: BabelNode, name: string): BabelNode | undefined {
  for (const prop of (obj.properties as BabelNode[] | undefined) ?? []) {
    if (prop.type !== "ObjectProperty") continue
    if (propertyKey(prop) === name) return prop.value as BabelNode | undefined
  }
  return undefined
}

/** An object-literal property key as a value: `a:` → `"a"`, `"icon-xs":` →
 *  `"icon-xs"`, `1:` → `1`. Computed keys are unresolvable → null. */
function propertyKey(prop: BabelNode): ManifestValue | null {
  if (prop.computed) return null
  const key = prop.key as BabelNode | undefined
  if (!key) return null
  if (key.type === "Identifier" && typeof key.name === "string") return key.name
  if (key.type === "StringLiteral" && typeof key.value === "string") return key.value
  if (key.type === "NumericLiteral" && typeof key.value === "number") return key.value
  return null
}

const UNRESOLVED = Symbol("unresolved")

function literalValue(node: BabelNode | undefined): ManifestValue | typeof UNRESOLVED {
  if (!node) return UNRESOLVED
  if (node.type === "StringLiteral") return node.value as string
  if (node.type === "NumericLiteral") return node.value as number
  if (node.type === "BooleanLiteral") return node.value as boolean
  return UNRESOLVED
}
