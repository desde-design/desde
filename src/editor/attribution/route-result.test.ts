import { describe, expect, it } from 'vitest'
import {
  isAttributionOverrideCandidate,
  routeAttributionResult,
} from './route-result'
import type { AttributionResult } from './types'
import type { EditableTextField } from '@/types/bridge'

const field = (id: string, kind: EditableTextField['kind'] = 'prop'): EditableTextField => ({
  id,
  kind,
  label: 'x',
  value: 'x',
})

describe('isAttributionOverrideCandidate — Stage A only re-routes the right fields', () => {
  it('routes the element-own text and the legacy upward-walk prop fields', () => {
    expect(isAttributionOverrideCandidate(field('dom-text', 'dom-text'))).toBe(true)
    expect(isAttributionOverrideCandidate(field('prop:label'))).toBe(true)
    expect(
      isAttributionOverrideCandidate(field('ancestor-prop:step@src/Form.vue:3:5')),
    ).toBe(true)
  })

  it('leaves the deterministic same-component fields (Walk 1/2) on legacy dispatch', () => {
    // slot-text:* (slot leaves) and child-prop:* (library-component prop
    // attribution) carry their own editTarget — re-routing them would risk
    // regressing paths Stage B retains.
    expect(
      isAttributionOverrideCandidate(field('slot-text:div.foo', 'dom-text')),
    ).toBe(false)
    expect(
      isAttributionOverrideCandidate(field('child-prop:label@src/Form.vue:9:1')),
    ).toBe(false)
  })
})

describe('routeAttributionResult — one decision per AttributionResult kind', () => {
  it('routes direct/prop to a prop-edit at the resolved loc', () => {
    const result: AttributionResult = {
      kind: 'direct',
      targetFile: 'src/views/Form.vue',
      sourceLoc: { file: 'src/views/Form.vue', line: 19, column: 11 },
      editKind: 'prop',
      propName: 'label',
      currentValue: 'Name',
      valueType: 'string',
    }
    expect(routeAttributionResult(result)).toEqual({
      kind: 'prop-edit',
      targetFile: 'src/views/Form.vue',
      line: 19,
      column: 11,
      propName: 'label',
      currentValue: 'Name',
      valueType: 'string',
    })
  })

  it('preserves valueType for number props (so the prop edit emits a bound number)', () => {
    const result: AttributionResult = {
      kind: 'direct',
      targetFile: 'f.vue',
      sourceLoc: { file: 'f.vue', line: 3, column: 5 },
      editKind: 'prop',
      propName: 'step',
      currentValue: '2',
      valueType: 'number',
    }
    const decision = routeAttributionResult(result)
    expect(decision.kind).toBe('prop-edit')
    if (decision.kind === 'prop-edit') expect(decision.valueType).toBe('number')
  })

  it('falls back for direct/slot (legacy slot-text path handles it)', () => {
    const result: AttributionResult = {
      kind: 'direct',
      targetFile: 'f.vue',
      sourceLoc: { file: 'f.vue', line: 7, column: 1 },
      editKind: 'slot',
      slotName: 'default',
      currentValue: 'Paths',
      valueType: 'string',
    }
    const decision = routeAttributionResult(result)
    expect(decision.kind).toBe('fallback')
  })

  it('falls back for cross-file (legacy LLM lane), not a prop-edit', () => {
    const result: AttributionResult = {
      kind: 'cross-file',
      targetFile: 'setup.ts',
      sourceLoc: { file: 'setup.ts', line: 14, column: 1 },
      pattern: 'ref',
      currentValue: '',
      meta: { identifier: 'defaultPath' },
    }
    const decision = routeAttributionResult(result)
    expect(decision.kind).toBe('fallback')
    if (decision.kind === 'fallback') expect(decision.reason).toContain('cross-file:ref')
  })

  it('falls back for llm, carrying the reason through', () => {
    const result: AttributionResult = {
      kind: 'llm',
      estimatedSeconds: 30,
      reason: 'bound to a computed property',
    }
    const decision = routeAttributionResult(result)
    expect(decision).toEqual({ kind: 'fallback', reason: 'bound to a computed property' })
  })

  it('falls back for refuse, carrying the reason through (load-bearing legacy fallback)', () => {
    const result: AttributionResult = {
      kind: 'refuse',
      reason: 'No rendering hints for Navbar.',
    }
    const decision = routeAttributionResult(result)
    expect(decision).toEqual({ kind: 'fallback', reason: 'No rendering hints for Navbar.' })
  })

  it('falls back for a malformed direct/prop missing propName (never a prop-edit without a name)', () => {
    const result = {
      kind: 'direct',
      targetFile: 'f.vue',
      sourceLoc: { file: 'f.vue', line: 1, column: 1 },
      editKind: 'prop',
      currentValue: 'x',
      valueType: 'string',
    } as AttributionResult
    expect(routeAttributionResult(result).kind).toBe('fallback')
  })
})
