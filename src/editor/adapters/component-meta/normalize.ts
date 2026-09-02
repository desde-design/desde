/**
 * Pure normalization: raw vue-component-meta JSON → ComponentManifest.
 *
 * Shared by every adapter that produces vue-component-meta-shaped raw
 * output (`vue-component-meta`, `vue-dts-meta`, `react-dts-meta`) — it is
 * design-system-neutral; the caller supplies `framework` / `designSystem` /
 * `extractor` / `importPath`.
 *
 * Normalization rules:
 * - Drop `'undefined'` from finite-choice options (it represents the
 *   optional state, communicated via `required: false` on the prop).
 * - JSON-parse the `default` field (extractor outputs it as a quoted
 *   JSON string like `"\"primary\""`).
 * - Classify control kinds: boolean enums become `kind: 'boolean'`;
 *   string-literal enums become `'finite-choice'`; object/array/event
 *   schemas pass through with their kind; everything else is `unknown`.
 * - Surface `@deprecated` JSDoc tags as `deprecated: true` on props.
 * - Slot scope payloads (`schema.kind === 'object'`) become
 *   `ComponentPropManifest[]` arrays.
 * - Skip props with `global: true` (Vue framework / DOM-inherited props).
 */

import type { PropertyMetaSchema } from 'vue-component-meta'
import type {
  ComponentEventManifest,
  ComponentManifest,
  ComponentPropManifest,
  ComponentSlotManifest,
  ControlOption,
  DesignSystemId,
  FrameworkId,
  ManifestControl,
  ManifestDefaultValue,
  ManifestValue,
  SourceDeclaration,
} from '../../core'
import type {
  RawComponentMeta,
  RawEventMeta,
  RawPropertyMeta,
  RawSlotMeta,
} from './raw-manifest'

export interface NormalizeOptions {
  /** Component name (used for the manifest id when `raw.name` is absent). */
  componentName: string
  /** Framework id stamped onto the manifest and source records. */
  framework: FrameworkId
  /** Design-system id stamped onto the manifest and source records. */
  designSystem: DesignSystemId
  /** Extractor identifier recorded in `source.extractor`. */
  extractor: string
  /** Optional package import path (e.g., '@acme/design-system'). */
  importPath?: string
  /**
   * Optional source declarations (typically the file the manifest was
   * extracted from). Recorded once on the manifest's `source` field;
   * per-prop declarations come from the raw extractor output.
   */
  declarations?: SourceDeclaration[]
}

export function normalizeComponentMeta(
  raw: RawComponentMeta,
  options: NormalizeOptions,
): ComponentManifest {
  const name = raw.name ?? options.componentName
  const slots = raw.slots.map(normalizeSlot)
  const events = raw.events.map(normalizeEvent)

  return {
    id: `${options.designSystem}.${kebabCase(options.componentName)}`,
    name,
    framework: options.framework,
    designSystem: options.designSystem,
    importPath: options.importPath,
    description: nonEmpty(raw.description),
    props: raw.props.filter((p) => !p.global).map(normalizeProp),
    slots: slots.length > 0 ? slots : undefined,
    events: events.length > 0 ? events : undefined,
    source: {
      framework: options.framework,
      designSystem: options.designSystem,
      extractor: options.extractor,
      declarations: options.declarations,
    },
  }
}

function normalizeProp(prop: RawPropertyMeta): ComponentPropManifest {
  return {
    name: prop.name,
    type: prop.type,
    required: prop.required,
    description: nonEmpty(prop.description),
    deprecated: prop.tags.some((t) => t.name === 'deprecated') ? true : undefined,
    defaultValue: extractDefault(prop),
    control: classifyControl(prop),
  }
}

function extractDefault(prop: RawPropertyMeta): ManifestDefaultValue | undefined {
  // The extractor emits `default` as a JSON-encoded literal (e.g. `"\"primary\""`,
  // `"false"`, `"null"`). Runtime takes precedence over the @default JSDoc tag
  // when both are present (the design doc + findings.md call this out — runtime
  // and JSDoc can disagree, e.g. KModal.actionButtonText).
  if (prop.default !== undefined) {
    return { value: parseJsonValue(prop.default), source: 'runtime' }
  }
  const defaultTag = prop.tags.find((t) => t.name === 'default')
  if (defaultTag?.text !== undefined) {
    return { value: parseTagDefault(defaultTag.text), source: 'documentation' }
  }
  return undefined
}

function parseJsonValue(raw: string): ManifestValue {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (isManifestValue(parsed)) return parsed
    return raw
  } catch {
    return raw
  }
}

function isManifestValue(value: unknown): value is ManifestValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true
  }
  if (Array.isArray(value)) {
    return value.every(isManifestValue)
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every(isManifestValue)
  }
  return false
}

function parseTagDefault(raw: string): ManifestValue {
  // JSDoc @default tags often use single-quoted strings (e.g. "'primary'");
  // rewrite to JSON before parsing.
  const jsonish = raw.trim().replace(/^'(.*)'$/, '"$1"')
  return parseJsonValue(jsonish)
}

function classifyControl(prop: RawPropertyMeta): ManifestControl {
  const schema = prop.schema
  if (typeof schema === 'string') {
    return scalarControl(prop.type)
  }

  if (schema.kind === 'enum') {
    const values = schema.schema ?? []
    if (isBooleanEnum(values)) {
      return { kind: 'boolean' }
    }
    if (isFiniteChoiceEnum(values)) {
      return {
        kind: 'finite-choice',
        options: values
          .filter((v) => !isUndefinedSchema(v))
          .map(toControlOption),
      }
    }
    // Optional-wrapper: vue-component-meta wraps optional non-literal types as
    // an enum with [undefined, X] where X carries its own kind. Unwrap so the
    // inspector still gets the correct control kind for KInput.labelAttributes
    // (object), KSelect.items (array), etc.
    const concrete = values.filter((v) => !isUndefinedSchema(v))
    if (concrete.length === 1) {
      const inner = concrete[0]
      if (typeof inner === 'object' && inner !== null) {
        if (inner.kind === 'object') return { kind: 'object', valueType: inner.type }
        if (inner.kind === 'array') return { kind: 'array', valueType: inner.type }
        if (inner.kind === 'event') return { kind: 'event', valueType: inner.type }
      }
    }
    // Primitive-union: vue-component-meta emits each member of a union
    // like `string | undefined`, `number | undefined`, or
    // `string | number | undefined` as a bare type-name string
    // (`'string'`, `'number'`, `'boolean'` — NOT the quoted literal form
    // `'"primary"'`). The optional-wrapper-single-concrete branch above
    // misses these because the inner is a string, not an object. Without
    // this branch, every `string | undefined` prop ends up as a
    // disabled, read-only `unknown` control — that's the
    // EntityFormBlock.title / .description / .step rendering bug.
    if (concrete.length > 0 && concrete.every(isPrimitiveTypeNameSchema)) {
      const primitives = new Set(concrete as readonly string[])
      // Single primitive only: pick the matching control kind.
      // Mixed primitive unions fall through to `unknown` — see
      // multi-round codex review notes below.
      if (primitives.size === 1) {
        if (primitives.has('number')) return { kind: 'number', valueType: schema.type }
        if (primitives.has('boolean')) return { kind: 'boolean', valueType: schema.type }
        if (primitives.has('string')) return { kind: 'text', valueType: schema.type }
      }
      // Why mixed primitive unions stay `unknown`:
      //
      // The editor's strict-buffer preview pipeline writes the
      // editor's emitted value DIRECTLY into `instance.props` via
      // `APPLY_PROP_OVERRIDE` (see `applyPropOverride` in the bridge).
      // Vue's template-bind coercion does NOT run on that path — it
      // only runs when a parent re-renders and the value flows down a
      // template binding. So a text control emitting `"6"` for a
      // `string | number` prop ends up with `instance.props.value =
      // "6"` (string), not `6` (number). Downstream consumers doing
      // `typeof value === 'number'` or numeric arithmetic break
      // silently. Same hazard for `string | boolean` and any other
      // mixed shape.
      //
      // Read-only `unknown` is the only safe fallback until either
      // (a) the override path coerces values to a declared primitive
      // before assigning to `instance.props`, or (b) we ship typed
      // multi-primitive controls (e.g. radio between text-input and
      // number-input modes).
    }
    return { kind: 'unknown', valueType: schema.type }
  }

  if (schema.kind === 'object') return { kind: 'object', valueType: schema.type }
  if (schema.kind === 'array') return { kind: 'array', valueType: schema.type }
  if (schema.kind === 'event') return { kind: 'event', valueType: schema.type }

  return { kind: 'unknown', valueType: prop.type }
}

function scalarControl(type: string): ManifestControl {
  if (type === 'boolean' || type === 'boolean | undefined') {
    return { kind: 'boolean' }
  }
  if (type === 'string' || type === 'string | undefined') {
    return { kind: 'text' }
  }
  if (type === 'number' || type === 'number | undefined') {
    return { kind: 'number' }
  }
  return { kind: 'unknown', valueType: type }
}

function isBooleanEnum(values: PropertyMetaSchema[]): boolean {
  const concrete = values.filter((v) => !isUndefinedSchema(v))
  return concrete.length > 0 && concrete.every((v) => v === 'true' || v === 'false')
}

function isFiniteChoiceEnum(values: PropertyMetaSchema[]): boolean {
  const concrete = values.filter((v) => !isUndefinedSchema(v))
  return concrete.length > 0 && concrete.every(isStringLiteralSchema)
}

function isStringLiteralSchema(value: PropertyMetaSchema): boolean {
  return typeof value === 'string' && /^"[^"]*"$/.test(value)
}

function isPrimitiveTypeNameSchema(value: PropertyMetaSchema): boolean {
  return (
    typeof value === 'string' &&
    (value === 'string' || value === 'number' || value === 'boolean')
  )
}

function isUndefinedSchema(value: PropertyMetaSchema): boolean {
  return value === 'undefined'
}

function toControlOption(value: PropertyMetaSchema): ControlOption {
  if (typeof value === 'string') {
    const literal = value.match(/^"(.*)"$/)?.[1] ?? value
    return { label: literal, value: literal }
  }
  return { label: value.type, value: value.type }
}

function normalizeSlot(slot: RawSlotMeta): ComponentSlotManifest {
  return {
    name: slot.name,
    description: nonEmpty(slot.description),
    scope: extractSlotScope(slot.schema),
  }
}

function extractSlotScope(schema: PropertyMetaSchema): ComponentPropManifest[] | undefined {
  if (typeof schema === 'string') return undefined
  if (schema.kind !== 'object' || !schema.schema) return undefined
  // schema.schema is Record<string, PropertyMeta> in vue-component-meta's types.
  // Inside the JSON output the function methods are absent (stripped by jsonReplacer);
  // structurally each entry matches our RawPropertyMeta apart from those methods,
  // so coerce to RawPropertyMeta and reuse normalizeProp.
  const entries = Object.entries(schema.schema as Record<string, RawPropertyMeta>)
  return entries.map(([key, propMeta]) =>
    normalizeProp({ ...propMeta, name: propMeta.name || key }),
  )
}

function normalizeEvent(event: RawEventMeta): ComponentEventManifest {
  return {
    name: event.name,
    description: nonEmpty(event.description),
    payloadType: event.type,
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined
}

/**
 * Exported for the cross-adapter contract test pinning its deliberate
 * divergence from `local-vue`/`local-react`'s shared `kebabCase`
 * (audit Task 20 item 3) — see `../kebab-case.ts`'s doc comment.
 */
export function kebabCase(value: string): string {
  return value
    .replace(/([A-Z])/g, '-$1')
    .toLowerCase()
    .replace(/^-/, '')
}
