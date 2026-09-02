/**
 * Tests for `detectManifestValueMismatch` — the honest delivery of Phase 5
 * carry-forward (g). See the module doc comment for why this is NOT hooked
 * to `PropEditFallbackHint`, and for why (review round 2, 2026-07-30) the
 * rule gates on manifest-existence + finite-choice + off-list value only —
 * NOT on rendering-hint trust, which is an unrelated pipeline (extraction
 * of `props`/`control.options` vs. hand-authored/probe-verified DOM
 * location hints). This mirrors `unknown-props`'s own posture in
 * `../attribution/detect-drift.ts`.
 */

import { describe, expect, it } from 'vitest'
import type { ComponentManifest } from '../core'
import { detectManifestValueMismatch } from './detect-manifest-value-mismatch'

const BASE_MANIFEST: ComponentManifest = {
  id: 'acme-ds.ui-button',
  name: 'UiButton',
  framework: 'vue3',
  designSystem: 'acme-ds',
  importPath: '@acme/design-system',
  props: [
    {
      name: 'appearance',
      type: 'string',
      required: false,
      control: {
        kind: 'finite-choice',
        options: [
          { label: 'primary', value: 'primary' },
          { label: 'secondary', value: 'secondary' },
          { label: 'danger', value: 'danger' },
        ],
      },
    },
    { name: 'label', type: 'string', required: false, control: { kind: 'text' } },
    { name: 'disabled', type: 'boolean', required: false, control: { kind: 'boolean' } },
  ],
  rendering: [
    {
      // Hand-authored: no `provenance` field at all — trusted by legacy
      // convention (see `isTrustedHint`). Present here only to prove the
      // rule doesn't care one way or the other, NOT because it's required.
      kind: 'dom',
      source: { kind: 'slot', name: 'default' },
      domTarget: { selector: ':root', field: 'textContent' },
      editability: 'literal',
    },
  ],
}

const UNVERIFIED_RENDERING_HINTS: ComponentManifest = {
  ...BASE_MANIFEST,
  rendering: [
    {
      kind: 'dom',
      source: { kind: 'slot', name: 'default' },
      domTarget: { selector: ':root', field: 'textContent' },
      editability: 'literal',
      provenance: 'generated',
      verified: false,
    },
  ],
}

const NO_RENDERING_AT_ALL: ComponentManifest = {
  ...BASE_MANIFEST,
  rendering: undefined,
}

describe('detectManifestValueMismatch', () => {
  it('records a signal when an edit sets a finite-choice prop to a value the manifest does not declare', () => {
    const signal = detectManifestValueMismatch({
      manifest: BASE_MANIFEST,
      propName: 'appearance',
      value: 'ghost',
    })

    expect(signal).not.toBeNull()
    expect(signal?.kind).toBe('manifest-value-mismatch')
    expect(signal?.component).toBe('UiButton')
    expect(signal?.importPath).toBe('@acme/design-system')
    expect(signal?.designSystem).toBe('acme-ds')
    expect(signal?.detail).toContain('ghost')
    expect(signal?.detail).toContain('primary')
    expect(signal?.detail).toContain('secondary')
    expect(signal?.detail).toContain('danger')
  })

  it('produces nothing when the value IS among the declared options', () => {
    expect(
      detectManifestValueMismatch({
        manifest: BASE_MANIFEST,
        propName: 'appearance',
        value: 'secondary',
      }),
    ).toBeNull()
  })

  it('still records a signal for an off-list value when the manifest only has UNVERIFIED rendering hints — prop/enum extraction (this rule) and rendering-hint provenance (hint-miss/selector-ambiguous) are unrelated pipelines, so hint trust is not a gate here', () => {
    const signal = detectManifestValueMismatch({
      manifest: UNVERIFIED_RENDERING_HINTS,
      propName: 'appearance',
      value: 'ghost',
    })
    expect(signal).not.toBeNull()
    expect(signal?.kind).toBe('manifest-value-mismatch')
  })

  it('still records a signal for an off-list value when the manifest has no rendering hints at all', () => {
    const signal = detectManifestValueMismatch({
      manifest: NO_RENDERING_AT_ALL,
      propName: 'appearance',
      value: 'ghost',
    })
    expect(signal).not.toBeNull()
    expect(signal?.kind).toBe('manifest-value-mismatch')
  })

  it('produces nothing for a non-finite-choice prop (text)', () => {
    expect(
      detectManifestValueMismatch({
        manifest: BASE_MANIFEST,
        propName: 'label',
        value: 'anything at all',
      }),
    ).toBeNull()
  })

  it('produces nothing for a non-finite-choice prop (boolean)', () => {
    expect(
      detectManifestValueMismatch({
        manifest: BASE_MANIFEST,
        propName: 'disabled',
        value: true,
      }),
    ).toBeNull()
  })

  it('produces nothing when the prop is not declared on the manifest at all', () => {
    expect(
      detectManifestValueMismatch({
        manifest: BASE_MANIFEST,
        propName: 'nonexistentProp',
        value: 'whatever',
      }),
    ).toBeNull()
  })

  it('produces nothing for a finite-choice prop with an empty options list', () => {
    const manifest: ComponentManifest = {
      ...BASE_MANIFEST,
      props: [
        {
          name: 'variant',
          type: 'string',
          required: false,
          control: { kind: 'finite-choice', options: [] },
        },
      ],
    }
    expect(
      detectManifestValueMismatch({ manifest, propName: 'variant', value: 'x' }),
    ).toBeNull()
  })

  it('caps the options preview in detail and appends an ellipsis for long lists', () => {
    const manifest: ComponentManifest = {
      ...BASE_MANIFEST,
      props: [
        {
          name: 'size',
          type: 'string',
          required: false,
          control: {
            kind: 'finite-choice',
            options: Array.from({ length: 12 }, (_, i) => ({
              label: `s${i}`,
              value: `s${i}`,
            })),
          },
        },
      ],
    }
    const signal = detectManifestValueMismatch({ manifest, propName: 'size', value: 'off-list' })
    expect(signal).not.toBeNull()
    expect(signal?.detail).toContain('s0')
    expect(signal?.detail).toContain('s7')
    expect(signal?.detail).not.toContain('s8')
    expect(signal?.detail).toContain('…')
  })
})
