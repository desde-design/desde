import { describe, expect, it } from 'vitest'

import { createCostGuard } from './cost-guard'

describe('createCostGuard', () => {
  it('is never exceeded when no ceiling is configured', () => {
    const guard = createCostGuard({ model: 'claude-opus-4-8', priorCostUsd: 0 })
    guard.record({ inputTokens: 10_000_000, outputTokens: 10_000_000 })
    expect(guard.exceeded).toBe(false)
  })

  it('accumulates usage into a rate-card estimate', () => {
    const guard = createCostGuard({ model: 'claude-opus-4-8', priorCostUsd: 0, ceilingUsd: 100 })
    guard.record({ inputTokens: 1000, outputTokens: 1000 })
    const afterOne = guard.turnCostUsd
    guard.record({ inputTokens: 1000, outputTokens: 1000 })
    expect(guard.turnCostUsd).toBeCloseTo(afterOne * 2, 10)
  })

  it('counts the session s prior spend, not just this turn s', () => {
    const guard = createCostGuard({ model: 'claude-opus-4-8', priorCostUsd: 9.99, ceilingUsd: 10 })
    expect(guard.exceeded).toBe(false)
    guard.record({ inputTokens: 100_000, outputTokens: 100_000 })
    expect(guard.exceeded).toBe(true)
  })

  it('names both numbers in its refusal, so the user can act on it', () => {
    const guard = createCostGuard({ model: 'claude-opus-4-8', priorCostUsd: 12, ceilingUsd: 10 })
    const message = guard.refusalMessage()
    expect(message).toContain('$12.00')
    expect(message).toContain('$10')
    expect(message).toMatch(/new session|raise the ceiling/)
    expect(message).not.toContain('—')
  })
})
