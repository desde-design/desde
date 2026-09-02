import { describe, expect, it } from 'vitest'

import { resolveCostCeilingUsd } from './chat-cost-ceiling'

describe('resolveCostCeilingUsd', () => {
  it('is unlimited when the config key is unset', () => {
    expect(resolveCostCeilingUsd(undefined)).toBeUndefined()
  })

  it('treats explicit null as unlimited', () => {
    expect(resolveCostCeilingUsd(null)).toBeUndefined()
  })

  it('treats explicit 0 as unlimited', () => {
    expect(resolveCostCeilingUsd(0)).toBeUndefined()
  })

  it('honours an explicit positive ceiling', () => {
    expect(resolveCostCeilingUsd(5)).toBe(5)
    expect(resolveCostCeilingUsd(0.5)).toBe(0.5)
  })

  it('never returns null or Infinity for unlimited', () => {
    // Both enforcement points downstream are `typeof === 'number'` guards and
    // the SDK's own maxBudgetUsd is spread conditionally, so absence is the
    // only shape that means "no ceiling" the whole way down.
    for (const input of [undefined, null, 0] as const) {
      const resolved = resolveCostCeilingUsd(input)
      expect(resolved).toBeUndefined()
      expect(resolved).not.toBeNull()
    }
  })
})
