/**
 * Contract tests for the vue-component-meta → ComponentManifest normalizer.
 *
 * Each test pins one normalization rule from `normalize.ts`'s header. They
 * use small, hand-built `RawComponentMeta` fixtures so a regression is easy
 * to attribute; the adapters that consume the normalizer (vue-component-meta,
 * vue-dts-meta, react-dts-meta) cover it end-to-end against real packages.
 */

import { describe, expect, it } from 'vitest'
import { normalizeComponentMeta, type NormalizeOptions } from './normalize'
import type { RawComponentMeta, RawPropertyMeta } from './raw-manifest'

// The generalized signature requires framework/designSystem/extractor on
// every call; this helper keeps the per-test option literals focused on
// what each test is actually exercising.
function opts(extra: Partial<NormalizeOptions> & { componentName: string }): NormalizeOptions {
  return {
    framework: 'vue3',
    designSystem: 'acme-ds',
    extractor: 'vue-component-meta',
    ...extra,
  }
}

function rawWithProp(prop: Partial<RawPropertyMeta> & { name: string }): RawComponentMeta {
  return {
    name: 'X',
    type: 1,
    props: [
      {
        name: prop.name,
        description: prop.description ?? '',
        type: prop.type ?? 'string | undefined',
        default: prop.default,
        global: prop.global ?? false,
        required: prop.required ?? false,
        tags: prop.tags ?? [],
        schema: prop.schema ?? 'string | undefined',
        declarations: prop.declarations ?? [],
      },
    ],
    events: [],
    slots: [],
    exposed: [],
  }
}

describe('normalizeComponentMeta — finite-choice props', () => {
  it("drops 'undefined' from optional enum schemas", () => {
    const raw = rawWithProp({
      name: 'appearance',
      type: 'Appearance | undefined',
      schema: {
        kind: 'enum',
        type: 'Appearance | undefined',
        schema: ['undefined', '"primary"', '"secondary"'],
      },
    })

    const manifest = normalizeComponentMeta(raw, opts({ componentName: 'X' }))
    expect(manifest.props[0].control.kind).toBe('finite-choice')
    expect(manifest.props[0].control.options).toEqual([
      { label: 'primary', value: 'primary' },
      { label: 'secondary', value: 'secondary' },
    ])
  })

  it('classifies a true|false enum as boolean, not finite-choice', () => {
    const raw = rawWithProp({
      name: 'disabled',
      type: 'boolean | undefined',
      schema: {
        kind: 'enum',
        type: 'boolean | undefined',
        schema: ['undefined', 'false', 'true'],
      },
    })

    const manifest = normalizeComponentMeta(raw, opts({ componentName: 'X' }))
    expect(manifest.props[0].control.kind).toBe('boolean')
    expect(manifest.props[0].control.options).toBeUndefined()
  })

  it("classifies optional non-literal wrappers (['undefined', { kind: 'object' }]) as 'object'", () => {
    const raw = rawWithProp({
      name: 'labelAttributes',
      type: 'LabelAttributes | undefined',
      schema: {
        kind: 'enum',
        type: 'LabelAttributes | undefined',
        schema: [
          'undefined',
          { kind: 'object', type: 'LabelAttributes', schema: {} },
        ],
      },
    })

    const manifest = normalizeComponentMeta(raw, opts({ componentName: 'X' }))
    expect(manifest.props[0].control.kind).toBe('object')
    expect(manifest.props[0].control.valueType).toBe('LabelAttributes')
  })

  it("classifies optional non-literal wrappers (['undefined', { kind: 'array' }]) as 'array'", () => {
    const raw = rawWithProp({
      name: 'items',
      type: 'SelectEntry<T>[] | undefined',
      schema: {
        kind: 'enum',
        type: 'SelectEntry<T>[] | undefined',
        schema: ['undefined', { kind: 'array', type: 'SelectEntry<T>[]', schema: [] }],
      },
    })

    const manifest = normalizeComponentMeta(raw, opts({ componentName: 'X' }))
    expect(manifest.props[0].control.kind).toBe('array')
    expect(manifest.props[0].control.valueType).toBe('SelectEntry<T>[]')
  })

  it("classifies primitive optionals (['undefined', 'string']) as 'text'", () => {
    // EntityFormBlock.title-style props were rendering as disabled
    // unknown boxes because the optional-wrapper-single-concrete branch
    // only handled object/array/event inners, never bare primitive
    // type-name strings. Regression guard.
    const raw = rawWithProp({
      name: 'title',
      type: 'string | undefined',
      schema: {
        kind: 'enum',
        type: 'string | undefined',
        schema: ['undefined', 'string'],
      },
    })
    const manifest = normalizeComponentMeta(raw, opts({ componentName: 'X' }))
    expect(manifest.props[0].control.kind).toBe('text')
    expect(manifest.props[0].control.valueType).toBe('string | undefined')
  })

  it("classifies primitive optionals (['undefined', 'number']) as 'number'", () => {
    const raw = rawWithProp({
      name: 'step',
      type: 'number | undefined',
      schema: {
        kind: 'enum',
        type: 'number | undefined',
        schema: ['undefined', 'number'],
      },
    })
    const manifest = normalizeComponentMeta(raw, opts({ componentName: 'X' }))
    expect(manifest.props[0].control.kind).toBe('number')
  })

  it("classifies primitive optionals (['undefined', 'boolean']) as 'boolean'", () => {
    const raw = rawWithProp({
      name: 'expanded',
      type: 'boolean | undefined',
      schema: {
        kind: 'enum',
        type: 'boolean | undefined',
        schema: ['undefined', 'boolean'],
      },
    })
    const manifest = normalizeComponentMeta(raw, opts({ componentName: 'X' }))
    expect(manifest.props[0].control.kind).toBe('boolean')
  })

  it("falls back to unknown for mixed primitive unions like string | number", () => {
    // The override pipeline writes the editor's emitted value directly
    // into `instance.props`, skipping Vue's template-bind coercion. A
    // text control would land `"6"` (string) on a `string | number`
    // prop and break `typeof value === 'number'` checks downstream.
    // Codex flagged this on the third review pass.
    const raw = rawWithProp({
      name: 'value',
      type: 'string | number | undefined',
      schema: {
        kind: 'enum',
        type: 'string | number | undefined',
        schema: ['undefined', 'string', 'number'],
      },
    })
    const manifest = normalizeComponentMeta(raw, opts({ componentName: 'X' }))
    expect(manifest.props[0].control.kind).toBe('unknown')
  })

  it("falls back to unknown when a primitive union mixes boolean with other types", () => {
    // `string | boolean` would silently mistype `"false"` as truthy
    // for downstream strict-equality boolean checks. The text control
    // can only emit strings, and unlike numeric coercion (`"5"` → 5),
    // Vue does not coerce string `"false"` back to boolean `false`.
    // Codex P1 re-review regression guard.
    const raw = rawWithProp({
      name: 'mixedBool',
      type: 'string | boolean | undefined',
      schema: {
        kind: 'enum',
        type: 'string | boolean | undefined',
        schema: ['undefined', 'string', 'boolean'],
      },
    })
    const manifest = normalizeComponentMeta(raw, opts({ componentName: 'X' }))
    expect(manifest.props[0].control.kind).toBe('unknown')
  })

  it("falls back to unknown for non-string primitive unions like number | boolean", () => {
    // Without `string` in the union, a text control would emit `"5"` /
    // `"false"` and break downstream strict-equality checks. Keep
    // these as read-only unknown rather than invent a widget.
    const raw = rawWithProp({
      name: 'oddball',
      type: 'number | boolean | undefined',
      schema: {
        kind: 'enum',
        type: 'number | boolean | undefined',
        schema: ['undefined', 'number', 'boolean'],
      },
    })
    const manifest = normalizeComponentMeta(raw, opts({ componentName: 'X' }))
    expect(manifest.props[0].control.kind).toBe('unknown')
  })

  it("falls back to unknown when the union contains non-primitive members", () => {
    // Mixed primitive + opaque type (e.g. `string | LabelAttributes`)
    // — we can't safely render a single editable widget, so unknown is
    // still the right answer.
    const raw = rawWithProp({
      name: 'mixed',
      type: 'string | LabelAttributes | undefined',
      schema: {
        kind: 'enum',
        type: 'string | LabelAttributes | undefined',
        schema: ['undefined', 'string', { kind: 'object', type: 'LabelAttributes', schema: {} }],
      },
    })
    const manifest = normalizeComponentMeta(raw, opts({ componentName: 'X' }))
    expect(manifest.props[0].control.kind).toBe('unknown')
  })
})

describe('normalizeComponentMeta — defaults', () => {
  it('JSON-parses runtime defaults emitted as quoted strings', () => {
    const raw = rawWithProp({
      name: 'appearance',
      default: '"primary"',
    })

    const manifest = normalizeComponentMeta(raw, opts({ componentName: 'X' }))
    expect(manifest.props[0].defaultValue).toEqual({ value: 'primary', source: 'runtime' })
  })

  it('parses runtime boolean and null defaults', () => {
    const rawBool = rawWithProp({ name: 'a', default: 'false' })
    const rawNull = rawWithProp({ name: 'b', default: 'null' })

    expect(
      normalizeComponentMeta(rawBool, opts({ componentName: 'X' })).props[0].defaultValue,
    ).toEqual({ value: false, source: 'runtime' })
    expect(
      normalizeComponentMeta(rawNull, opts({ componentName: 'X' })).props[0].defaultValue,
    ).toEqual({ value: null, source: 'runtime' })
  })

  it('preserves runtime object and array defaults instead of stringifying them', () => {
    const rawObj = rawWithProp({ name: 'labelAttributes', default: '{}' })
    const rawArr = rawWithProp({ name: 'items', default: '[]' })
    const rawNested = rawWithProp({
      name: 'config',
      default: '{"items":[1,2],"label":"x"}',
    })

    expect(
      normalizeComponentMeta(rawObj, opts({ componentName: 'X' })).props[0].defaultValue,
    ).toEqual({ value: {}, source: 'runtime' })
    expect(
      normalizeComponentMeta(rawArr, opts({ componentName: 'X' })).props[0].defaultValue,
    ).toEqual({ value: [], source: 'runtime' })
    expect(
      normalizeComponentMeta(rawNested, opts({ componentName: 'X' })).props[0].defaultValue,
    ).toEqual({ value: { items: [1, 2], label: 'x' }, source: 'runtime' })
  })

  it('falls back to @default JSDoc tag when no runtime default is present', () => {
    const raw = rawWithProp({
      name: 'appearance',
      tags: [{ name: 'default', text: "'primary'" }],
    })

    const manifest = normalizeComponentMeta(raw, opts({ componentName: 'X' }))
    expect(manifest.props[0].defaultValue).toEqual({
      value: 'primary',
      source: 'documentation',
    })
  })

  it('runtime default takes precedence over @default tag', () => {
    const raw = rawWithProp({
      name: 'actionButtonText',
      default: '"Submit"',
      tags: [{ name: 'default', text: "''" }],
    })

    const manifest = normalizeComponentMeta(raw, opts({ componentName: 'X' }))
    expect(manifest.props[0].defaultValue).toEqual({ value: 'Submit', source: 'runtime' })
  })
})

describe('normalizeComponentMeta — JSDoc tags', () => {
  it('surfaces @deprecated as a boolean true on props', () => {
    const raw = rawWithProp({
      name: 'icon',
      tags: [{ name: 'deprecated' }],
    })

    const manifest = normalizeComponentMeta(raw, opts({ componentName: 'X' }))
    expect(manifest.props[0].deprecated).toBe(true)
  })

  it('surfaces descriptions verbatim, including multi-line', () => {
    const raw = rawWithProp({
      name: 'appearance',
      description: 'Base styling.\nOne of [primary, secondary].',
    })

    const manifest = normalizeComponentMeta(raw, opts({ componentName: 'X' }))
    expect(manifest.props[0].description).toBe('Base styling.\nOne of [primary, secondary].')
  })
})

describe('normalizeComponentMeta — slots and events', () => {
  it('expands slot scope payloads to ComponentPropManifest[]', () => {
    // The slot.schema 'object' branch's nested `schema` is typed as
    // Record<string, PropertyMeta> (vue-component-meta's live type with function
    // methods), but the JSON output strips those methods. Cast through unknown.
    const raw = {
      name: 'X',
      type: 1,
      props: [],
      events: [],
      slots: [
        {
          name: 'item-template',
          description: 'Use this slot to pass custom content.',
          type: '{ item: SelectItem<Value>; }',
          tags: [],
          schema: {
            kind: 'object',
            type: '{ item: SelectItem<Value>; }',
            schema: {
              item: {
                name: 'item',
                description: '',
                type: 'SelectItem<Value>',
                global: false,
                required: true,
                tags: [],
                schema: 'SelectItem<Value>',
                declarations: [],
              },
            },
          },
          declarations: [],
        },
      ],
      exposed: [],
    } as unknown as RawComponentMeta

    const manifest = normalizeComponentMeta(raw, opts({ componentName: 'X' }))
    expect(manifest.slots).toHaveLength(1)
    expect(manifest.slots?.[0].name).toBe('item-template')
    expect(manifest.slots?.[0].scope).toEqual([
      expect.objectContaining({
        name: 'item',
        type: 'SelectItem<Value>',
        required: true,
      }),
    ])
  })

  it('omits slots[] entirely when there are no slots', () => {
    const raw = rawWithProp({ name: 'a' })
    const manifest = normalizeComponentMeta(raw, opts({ componentName: 'X' }))
    expect(manifest.slots).toBeUndefined()
  })

  it('captures event names and payload types', () => {
    const raw: RawComponentMeta = {
      name: 'X',
      type: 1,
      props: [],
      events: [
        {
          name: 'change',
          description: '',
          type: '[value: string]',
          signature: '(evt: "change", ...args: [value: string]): void',
          tags: [],
          schema: [],
          declarations: [],
        },
      ],
      slots: [],
      exposed: [],
    }

    const manifest = normalizeComponentMeta(raw, opts({ componentName: 'X' }))
    expect(manifest.events).toHaveLength(1)
    expect(manifest.events?.[0]).toEqual({
      name: 'change',
      description: undefined,
      payloadType: '[value: string]',
    })
  })
})

describe('normalizeComponentMeta — manifest top level', () => {
  it('skips global props (Vue framework / DOM-inherited)', () => {
    const raw: RawComponentMeta = {
      name: 'X',
      type: 1,
      props: [
        {
          name: 'class',
          description: '',
          type: 'string',
          global: true,
          required: false,
          tags: [],
          schema: 'string',
          declarations: [],
        },
        {
          name: 'appearance',
          description: '',
          type: 'string',
          global: false,
          required: false,
          tags: [],
          schema: 'string',
          declarations: [],
        },
      ],
      events: [],
      slots: [],
      exposed: [],
    }

    const manifest = normalizeComponentMeta(raw, opts({ componentName: 'X' }))
    expect(manifest.props.map((p) => p.name)).toEqual(['appearance'])
  })

  it('builds a kebab-cased manifest id from the component name', () => {
    const raw = rawWithProp({ name: 'a' })
    const manifest = normalizeComponentMeta(raw, opts({ componentName: 'AcmeButton' }))
    expect(manifest.id).toBe('acme-ds.acme-button')
  })

  it('sets framework, designSystem, and importPath on the manifest', () => {
    const raw = rawWithProp({ name: 'a' })
    const manifest = normalizeComponentMeta(
      raw,
      opts({ componentName: 'AcmeButton', importPath: '@acme/ds' }),
    )

    expect(manifest.framework).toBe('vue3')
    expect(manifest.designSystem).toBe('acme-ds')
    expect(manifest.importPath).toBe('@acme/ds')
    expect(manifest.source).toEqual({
      framework: 'vue3',
      designSystem: 'acme-ds',
      extractor: 'vue-component-meta',
    })
  })
})
