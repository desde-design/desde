/**
 * Cross-pipeline control-classifier contract test (audit Task 20, item 6).
 *
 * Three independent classifiers map a prop's TYPE to a `ManifestControl`:
 *   - `component-meta/normalize.ts`'s `classifyControl` (private; driven here
 *     through the exported `normalizeComponentMeta`) — consumes
 *     vue-component-meta's `PropertyMetaSchema` JSON, itself reused by the
 *     `vue-dts-meta`/`react-dts-meta` TS-checker extractors.
 *   - `local-vue`'s `inferControl` (private; driven through the exported
 *     `extractProps`) — consumes a `ts.TypeNode` from `@vue/compiler-sfc` +
 *     the TS compiler over a `defineProps<{...}>()` literal.
 *   - `local-react`'s `inferControl` (private; driven through
 *     `LocalReactManifestSource`) — consumes a Babel `TSTypeAnnotation`
 *     node over a component's first-param type.
 *
 * This is NOT a unification — the three take fundamentally different
 * input representations (a runtime JSON schema vs. two different AST
 * shapes) and are expected to keep diverging on framework-specific detail
 * (see "Deliberately excluded" below). What this test pins is that for the
 * shapes ALL THREE pipelines can express, they agree on the resulting
 * `ManifestControl.kind` — so a future edit to one classifier that quietly
 * drifts the taxonomy (e.g. starts calling a mixed primitive union
 * `'text'` instead of `'unknown'`) fails loudly here instead of only
 * showing up as a UI inconsistency between library and first-party props.
 *
 * Overlapping semantic surface covered: string/number/boolean (required
 * and optional), string-literal unions (finite-choice), a `true | false`
 * literal union (boolean, not a 2-option finite-choice), a mixed
 * primitive union (unknown — the strict-buffer-preview hazard documented
 * in `normalize.ts`), arrays, and objects.
 *
 * Deliberately excluded (legitimate divergence, different domains):
 *   - Function-typed props: component-meta/local-react classify these as
 *     `'event'`; local-vue uses `'function'` — a real, intentional
 *     taxonomy difference (Vue's `ManifestControl` distinguishes the two;
 *     React callback props and Vue emit-style function props don't map
 *     1:1 in the framework-neutral model).
 *   - `children`/slot detection: React-only (`local-react`'s `inferControl`
 *     special-cases `propName === 'children'` / `ReactNode`); Vue and
 *     component-meta sources have no equivalent single-prop convention.
 *   - `kebabCase`/manifest-id naming — covered separately by
 *     `kebab-case.test.ts`, including the deliberate K-prefix divergence.
 *   - Exact `options`/`valueType` string formatting — each pipeline
 *     stringifies the source type differently (schema JSON vs. TS source
 *     text vs. Babel source text); only `.kind` (and, for finite-choice,
 *     the option VALUES) is asserted across all three.
 */
import { describe, expect, it } from 'vitest'
import { normalizeComponentMeta, type NormalizeOptions } from './component-meta/normalize'
import type { RawComponentMeta, RawPropertyMeta } from './component-meta/raw-manifest'
import { extractProps as extractVueProps } from './local-vue/index'
import { LocalReactManifestSource } from './local-react/index'
import type { ControlKind } from '../core'

// ── component-meta driver ──────────────────────────────────────────────────

function opts(componentName: string): NormalizeOptions {
  return { framework: 'vue3', designSystem: 'acme-ds', extractor: 'vue-component-meta', componentName }
}

function rawWithProp(prop: Partial<RawPropertyMeta> & { name: string }): RawComponentMeta {
  return {
    name: 'X',
    type: 1,
    props: [
      {
        name: prop.name,
        description: prop.description ?? '',
        type: prop.type ?? 'string',
        default: prop.default,
        global: prop.global ?? false,
        required: prop.required ?? true,
        tags: prop.tags ?? [],
        schema: prop.schema ?? 'string',
        declarations: prop.declarations ?? [],
      },
    ],
    events: [],
    slots: [],
    exposed: [],
  }
}

function controlKind(prop: Partial<RawPropertyMeta> & { name: string }): ControlKind {
  const manifest = normalizeComponentMeta(rawWithProp(prop), opts('X'))
  return manifest.props[0].control.kind
}

function optionValues(prop: Partial<RawPropertyMeta> & { name: string }): unknown[] {
  const manifest = normalizeComponentMeta(rawWithProp(prop), opts('X'))
  return (manifest.props[0].control.options ?? []).map((o) => o.value)
}

// ── local-vue driver ────────────────────────────────────────────────────

function vueKind(typeAnnotation: string): ControlKind {
  const props = extractVueProps(`defineProps<{ p${typeAnnotation} }>()`, true)
  const kind = props?.[0]?.control.kind
  if (!kind) throw new Error(`local-vue: extractProps returned no props for "p${typeAnnotation}"`)
  return kind
}

function vueOptionValues(typeAnnotation: string): unknown[] {
  const props = extractVueProps(`defineProps<{ p${typeAnnotation} }>()`, true)
  return (props?.[0]?.control.options ?? []).map((o) => o.value)
}

// ── local-react driver ──────────────────────────────────────────────────

async function reactKind(typeAnnotation: string): Promise<ControlKind> {
  const src = new LocalReactManifestSource({
    componentFiles: ['src/C.tsx'],
    readFile: () =>
      `export function C(props: { p${typeAnnotation} }) { return <div>{String(props.p)}</div> }`,
  })
  const m = await src.getComponent('C')
  const kind = m?.props[0]?.control.kind
  if (!kind) throw new Error(`local-react: getComponent returned no props for "p${typeAnnotation}"`)
  return kind
}

async function reactOptionValues(typeAnnotation: string): Promise<unknown[]> {
  const src = new LocalReactManifestSource({
    componentFiles: ['src/C.tsx'],
    readFile: () =>
      `export function C(props: { p${typeAnnotation} }) { return <div>{String(props.p)}</div> }`,
  })
  const m = await src.getComponent('C')
  return (m?.props[0]?.control.options ?? []).map((o) => o.value)
}

// ── shapes ───────────────────────────────────────────────────────────────

describe('control-classifier contract: string/number/boolean', () => {
  it('required string -> text', async () => {
    expect(controlKind({ name: 'p', type: 'string', schema: 'string', required: true })).toBe('text')
    expect(vueKind(': string')).toBe('text')
    expect(await reactKind(': string')).toBe('text')
  })

  it('optional string -> text', async () => {
    expect(
      controlKind({
        name: 'p',
        type: 'string | undefined',
        schema: { kind: 'enum', type: 'string | undefined', schema: ['undefined', 'string'] },
        required: false,
      }),
    ).toBe('text')
    expect(vueKind('?: string')).toBe('text')
    expect(await reactKind('?: string')).toBe('text')
  })

  it('optional number -> number', async () => {
    expect(
      controlKind({
        name: 'p',
        type: 'number | undefined',
        schema: { kind: 'enum', type: 'number | undefined', schema: ['undefined', 'number'] },
        required: false,
      }),
    ).toBe('number')
    expect(vueKind('?: number')).toBe('number')
    expect(await reactKind('?: number')).toBe('number')
  })

  it('optional boolean -> boolean', async () => {
    expect(
      controlKind({
        name: 'p',
        type: 'boolean | undefined',
        schema: { kind: 'enum', type: 'boolean | undefined', schema: ['undefined', 'boolean'] },
        required: false,
      }),
    ).toBe('boolean')
    expect(vueKind('?: boolean')).toBe('boolean')
    expect(await reactKind('?: boolean')).toBe('boolean')
  })
})

describe('control-classifier contract: literal unions', () => {
  it("string-literal union -> finite-choice with matching option values", async () => {
    expect(
      controlKind({
        name: 'p',
        type: '"a" | "b" | "c"',
        schema: { kind: 'enum', type: '"a" | "b" | "c"', schema: ['"a"', '"b"', '"c"'] },
        required: true,
      }),
    ).toBe('finite-choice')
    expect(vueKind(": 'a' | 'b' | 'c'")).toBe('finite-choice')
    expect(await reactKind(": 'a' | 'b' | 'c'")).toBe('finite-choice')

    const expected = ['a', 'b', 'c']
    expect(
      optionValues({
        name: 'p',
        type: '"a" | "b" | "c"',
        schema: { kind: 'enum', type: '"a" | "b" | "c"', schema: ['"a"', '"b"', '"c"'] },
        required: true,
      }),
    ).toEqual(expected)
    expect(vueOptionValues(": 'a' | 'b' | 'c'")).toEqual(expected)
    expect(await reactOptionValues(": 'a' | 'b' | 'c'")).toEqual(expected)
  })

  it('true | false literal union -> boolean, not a 2-option finite-choice', async () => {
    expect(
      controlKind({
        name: 'p',
        type: 'true | false',
        schema: { kind: 'enum', type: 'true | false', schema: ['true', 'false'] },
        required: true,
      }),
    ).toBe('boolean')
    expect(vueKind(': true | false')).toBe('boolean')
    expect(await reactKind(': true | false')).toBe('boolean')
  })

  it('mixed primitive union (string | number) -> unknown', async () => {
    // The strict-buffer-preview hazard documented in normalize.ts: a text
    // control would coerce a number prop's edited value to a string. All
    // three pipelines refuse to guess a widget here.
    expect(
      controlKind({
        name: 'p',
        type: 'string | number',
        schema: { kind: 'enum', type: 'string | number', schema: ['string', 'number'] },
        required: true,
      }),
    ).toBe('unknown')
    expect(vueKind(': string | number')).toBe('unknown')
    expect(await reactKind(': string | number')).toBe('unknown')
  })
})

describe('control-classifier contract: arrays and objects', () => {
  it('string[] -> array', async () => {
    expect(
      controlKind({
        name: 'p',
        type: 'string[]',
        schema: { kind: 'array', type: 'string[]', schema: [] },
        required: true,
      }),
    ).toBe('array')
    expect(vueKind(': string[]')).toBe('array')
    expect(await reactKind(': string[]')).toBe('array')
  })

  it('object type reference -> object', async () => {
    expect(
      controlKind({
        name: 'p',
        type: 'LabelAttributes',
        schema: { kind: 'object', type: 'LabelAttributes', schema: {} },
        required: true,
      }),
    ).toBe('object')
    // local-vue/react have no ambient `LabelAttributes` to resolve against;
    // an inline type literal is the representation-equivalent "object" shape
    // for an AST-driven classifier (no cross-file type resolution in V1).
    expect(vueKind(': { foo: string }')).toBe('object')
    expect(await reactKind(': { foo: string }')).toBe('object')
  })
})
