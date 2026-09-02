/**
 * Tests for the component catalog projection. Pure function — no I/O,
 * just manifest in / catalog entry out.
 */

import { describe, expect, it } from 'vitest'
import {
  buildCatalog,
  buildCatalogEntry,
} from './component-catalog'
import type {
  ComponentManifest,
  ComponentPropManifest,
} from '../core/manifest'

function makeManifest(over: Partial<ComponentManifest> = {}): ComponentManifest {
  return {
    id: 'first-party.ui-button',
    name: 'UiButton',
    framework: 'vue3',
    designSystem: 'first-party',
    props: [],
    slots: [],
    events: [],
    ...over,
  }
}

function makeProp(over: Partial<ComponentPropManifest> = {}): ComponentPropManifest {
  return {
    name: 'variant',
    type: 'string',
    required: false,
    control: { kind: 'unknown' },
    ...over,
  }
}

describe('buildCatalogEntry', () => {
  it('passes through name + id + manifest', () => {
    const manifest = makeManifest({ name: 'UiCard' })
    const entry = buildCatalogEntry(manifest)
    expect(entry.name).toBe('UiCard')
    expect(entry.id).toBe('first-party.ui-button') // id from `over` doesn't override
    expect(entry.manifest).toBe(manifest)
  })

  it("marks first-party manifests as not design-system", () => {
    const entry = buildCatalogEntry(makeManifest({ designSystem: 'first-party' }))
    expect(entry.isDesignSystem).toBe(false)
  })

  it("marks non-first-party manifests (e.g. acme-ds) as design-system", () => {
    const entry = buildCatalogEntry(makeManifest({ designSystem: 'acme-ds' }))
    expect(entry.isDesignSystem).toBe(true)
  })

  it("treats 'unknown' designSystem as not design-system (won't surface for swap-into)", () => {
    const entry = buildCatalogEntry(makeManifest({ designSystem: 'unknown' }))
    expect(entry.isDesignSystem).toBe(false)
  })

  it("extracts file from source.declarations[0].file", () => {
    const entry = buildCatalogEntry(
      makeManifest({
        source: {
          framework: 'vue3',
          designSystem: 'first-party',
          extractor: 'local-vue-sfc',
          declarations: [{ file: 'src/components/UiButton.vue' }],
        },
      }),
    )
    expect(entry.file).toBe('src/components/UiButton.vue')
  })

  it("leaves file undefined when source.declarations is missing", () => {
    const entry = buildCatalogEntry(makeManifest({ source: undefined }))
    expect(entry.file).toBeUndefined()
  })

  it("populates packageName from importPath", () => {
    const entry = buildCatalogEntry(
      makeManifest({ importPath: '@acme/design-system' }),
    )
    expect(entry.packageName).toBe('@acme/design-system')
  })
})

describe('buildCatalogEntry — variantHints', () => {
  it("derives a [false, true] axis for boolean props (control.kind)", () => {
    const entry = buildCatalogEntry(
      makeManifest({
        props: [
          makeProp({ name: 'disabled', type: 'boolean', control: { kind: 'boolean' } }),
        ],
      }),
    )
    expect(entry.variantHints).toEqual([
      { prop: 'disabled', values: [false, true], label: 'disabled' },
    ])
  })

  it("derives a [false, true] axis for boolean type even without control.kind", () => {
    const entry = buildCatalogEntry(
      makeManifest({
        props: [makeProp({ name: 'loading', type: 'boolean' })],
      }),
    )
    expect(entry.variantHints).toEqual([
      { prop: 'loading', values: [false, true], label: 'loading' },
    ])
  })

  it("derives an axis from finite-choice options", () => {
    const entry = buildCatalogEntry(
      makeManifest({
        props: [
          makeProp({
            name: 'variant',
            type: 'string',
            control: {
              kind: 'finite-choice',
              options: [
                { label: 'Primary', value: 'primary' },
                { label: 'Danger', value: 'danger' },
                { label: 'Secondary', value: 'secondary' },
              ],
            },
          }),
        ],
      }),
    )
    expect(entry.variantHints).toEqual([
      {
        prop: 'variant',
        values: ['primary', 'danger', 'secondary'],
        label: 'variant',
      },
    ])
  })

  it("filters out non-primitive option values (objects, arrays)", () => {
    const entry = buildCatalogEntry(
      makeManifest({
        props: [
          makeProp({
            control: {
              kind: 'finite-choice',
              options: [
                { label: 'Simple', value: 'simple' },
                { label: 'Complex', value: { foo: 'bar' } },
                { label: 'Array', value: [1, 2] },
              ],
            },
          }),
        ],
      }),
    )
    expect(entry.variantHints[0].values).toEqual(['simple'])
  })

  it("skips finite-choice props when option count exceeds 12 (grid blowup guard)", () => {
    const manyOptions = Array.from({ length: 15 }, (_, i) => ({
      label: `opt-${i}`,
      value: `opt-${i}`,
    }))
    const entry = buildCatalogEntry(
      makeManifest({
        props: [
          makeProp({
            control: { kind: 'finite-choice', options: manyOptions },
          }),
        ],
      }),
    )
    expect(entry.variantHints).toEqual([])
  })

  it("doesn't surface 'text' / 'number' / 'unknown' control kinds as variant axes", () => {
    const entry = buildCatalogEntry(
      makeManifest({
        props: [
          makeProp({ name: 'label', control: { kind: 'text' } }),
          makeProp({ name: 'count', control: { kind: 'number' } }),
          makeProp({ name: 'mystery', control: { kind: 'unknown' } }),
        ],
      }),
    )
    expect(entry.variantHints).toEqual([])
  })

  it("returns empty variantHints when no props are enumerable", () => {
    const entry = buildCatalogEntry(makeManifest({ props: [] }))
    expect(entry.variantHints).toEqual([])
  })

  it("derives axes for multiple props in declaration order", () => {
    const entry = buildCatalogEntry(
      makeManifest({
        props: [
          makeProp({ name: 'disabled', type: 'boolean' }),
          makeProp({
            name: 'variant',
            control: {
              kind: 'finite-choice',
              options: [
                { label: 'Primary', value: 'primary' },
                { label: 'Danger', value: 'danger' },
              ],
            },
          }),
        ],
      }),
    )
    expect(entry.variantHints.map((a) => a.prop)).toEqual([
      'disabled',
      'variant',
    ])
  })
})

describe('buildCatalog', () => {
  it('projects each manifest and preserves order', () => {
    const a = makeManifest({ id: 'a', name: 'A' })
    const b = makeManifest({ id: 'b', name: 'B' })
    const catalog = buildCatalog([a, b])
    expect(catalog.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('returns an empty array for an empty manifest list', () => {
    expect(buildCatalog([])).toEqual([])
  })
})
