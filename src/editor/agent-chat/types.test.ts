import { describe, expect, it } from 'vitest'
import { EFFORT_LEVELS, type EffortLevel } from '../core/model-catalog'
import type { ChatTurn } from './types'

/**
 * `ChatTurn.effort` and `ChatSession.modelConfig.effort` used to re-declare
 * the five-value union by hand. Two declarations of one ladder drift the
 * moment a provider needs a sixth level, and the persisted schema is the copy
 * nobody would remember to update.
 */
describe('the persisted effort field is the catalog\'s EffortLevel', () => {
  it('accepts every level the catalog validates', () => {
    for (const level of EFFORT_LEVELS) {
      const turn = { effort: level } as Pick<ChatTurn, 'effort'>
      expect(turn.effort).toBe(level)
    }
  })

  it('is assignable from EffortLevel without a cast', () => {
    const level: EffortLevel = 'xhigh'
    const turn: Pick<ChatTurn, 'effort'> = { effort: level }
    expect(turn.effort).toBe('xhigh')
  })
})
