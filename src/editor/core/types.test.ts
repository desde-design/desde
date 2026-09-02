/**
 * Contract tests for the editor core types. The assertions here go
 * beyond shape-aliasing — they pin down behaviors that should fail to
 * compile if the contracts regress (renamed fields, relaxed required
 * flags, accidentally-permissive unions). When you add a test, prefer
 * patterns that catch a real refactor mistake over patterns that only
 * restate what TypeScript already enforced at the assignment site.
 */

import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  AgentRequest,
  ComponentManifest,
  EditResult,
  FrameworkAdapter,
  PropEdit,
  Selection,
  StructuralEdit,
} from './index'

describe('ComponentManifest contract', () => {
  it('requires id, name, framework, designSystem, and props', () => {
    // satisfies pins the value to ComponentManifest without widening, so
    // accidental added/removed required fields surface here at compile time.
    const manifest = {
      id: 'acme-ds.ui-button',
      name: 'UiButton',
      framework: 'vue3',
      designSystem: 'acme-ds',
      props: [
        {
          name: 'appearance',
          type: 'ButtonAppearance',
          required: false,
          control: { kind: 'finite-choice' as const, options: [{ label: 'primary', value: 'primary' }] },
        },
      ],
    } satisfies ComponentManifest

    expect(manifest.props[0].control.kind).toBe('finite-choice')
  })

  it('rejects manifests missing required fields', () => {
    // @ts-expect-error props[] is required on ComponentManifest
    const _missingProps: ComponentManifest = {
      id: 'x',
      name: 'X',
      framework: 'vue3',
      designSystem: 'acme-ds',
    }
    void _missingProps
  })
})

describe('Selection contract', () => {
  it('requires ancestry as a present (possibly empty) array', () => {
    const sel = {
      targetId: 't1',
      selector: '#button',
      componentName: 'UiButton',
      ancestry: [
        { targetId: 't1-parent', componentName: 'UiCard' },
      ],
    } satisfies Selection

    // satisfies enforces the contract; runtime read confirms the field travels through.
    expect(sel.ancestry[0].componentName).toBe('UiCard')
  })

  it('rejects Selection objects that omit ancestry', () => {
    // @ts-expect-error ancestry is required on Selection
    const _bad: Selection = {
      targetId: 't1',
      selector: '#button',
    }
    void _bad
  })
})

describe('StructuralEdit discriminates by kind', () => {
  it('narrows PropEdit to its kind-specific fields', () => {
    const edit: StructuralEdit = {
      id: 'edit-1',
      kind: 'prop',
      target: { targetId: 't1', selector: '#b' },
      propName: 'appearance',
      value: 'primary',
    }

    if (edit.kind === 'prop') {
      // After narrowing, propName and value must be reachable without further checks.
      expectTypeOf(edit).toEqualTypeOf<PropEdit>()
      expectTypeOf(edit.propName).toEqualTypeOf<string>()
    } else {
      throw new Error('expected kind === "prop"')
    }
  })

  it('rejects edits without a kind discriminator', () => {
    // @ts-expect-error kind is required on every StructuralEdit variant
    const _bad: StructuralEdit = {
      id: 'edit-x',
      target: { targetId: 't1', selector: '#x' },
    }
    void _bad
  })

  it('does NOT include AgentRequest in StructuralEdit', () => {
    const agentReq: AgentRequest = {
      id: 'req-1',
      prompt: 'Split this section into two columns',
    }
    // @ts-expect-error AgentRequest must not satisfy StructuralEdit
    const _bad: StructuralEdit = agentReq
    void _bad
  })
})

describe('EditResult contract', () => {
  it('carries appliedEditId and affectedTargetIds when applied', () => {
    const applied: EditResult = {
      kind: 'applied',
      appliedEditId: 'edit-1',
      affectedTargetIds: ['t1'],
    }
    if (applied.kind === 'applied') {
      expectTypeOf(applied.appliedEditId).toEqualTypeOf<string>()
      expectTypeOf(applied.affectedTargetIds).toEqualTypeOf<string[]>()
      // inverse is optional (some edits aren't invertible)
      expectTypeOf(applied.inverse).toEqualTypeOf<StructuralEdit | undefined>()
    }
  })

  it('rejects an applied result missing appliedEditId', () => {
    // @ts-expect-error appliedEditId is required when kind === 'applied'
    const _bad: EditResult = {
      kind: 'applied',
      affectedTargetIds: [],
    }
    void _bad
  })
})

describe('FrameworkAdapter contract', () => {
  it('applyEdit accepts only StructuralEdit, not AgentRequest', () => {
    // Compile-time: the parameter type of applyEdit is StructuralEdit. AgentRequest
    // values must not be assignable to it. The expectTypeOf below holds the line.
    type ApplyEditParam = Parameters<FrameworkAdapter['applyEdit']>[0]
    expectTypeOf<ApplyEditParam>().toEqualTypeOf<StructuralEdit>()
  })

  it('exposes the expected method surface (regression sentinel)', () => {
    type AdapterMethods = keyof FrameworkAdapter
    // Updating this list is fine when intentionally evolving the surface;
    // tripping it means an unintentional drift.
    const expected: AdapterMethods[] = [
      'framework',
      'init',
      'dispose',
      'selectParent',
      'clearSelection',
      'applyEdit',
      'onSelectionChange',
      'onTreeUpdate',
    ]
    expectTypeOf(expected).toEqualTypeOf<AdapterMethods[]>()
  })
})
