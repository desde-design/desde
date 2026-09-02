import { describe, expect, it } from 'vitest'
import { createHealthCollector } from './grounding-health'

describe('createHealthCollector', () => {
  it('sets root and builtAt at creation time', () => {
    const before = Date.now()
    const collector = createHealthCollector('/proto')
    const after = Date.now()
    expect(collector.health.root).toBe('/proto')
    expect(collector.health.sources).toEqual([])
    expect(collector.health.runtimeErrors).toEqual([])
    const builtAt = Date.parse(collector.health.builtAt)
    expect(builtAt).toBeGreaterThanOrEqual(before)
    expect(builtAt).toBeLessThanOrEqual(after)
  })

  it('accumulates recorded entries in order', () => {
    const collector = createHealthCollector('/proto')
    collector.record({ step: 'storybook', sourceId: 'storybook', discovered: 3, status: 'ok' })
    collector.record({
      step: 'vue-component-meta',
      sourceId: 'vue-component-meta',
      discovered: 0,
      status: 'skipped',
      reason: 'no tsconfig',
    })
    expect(collector.health.sources).toHaveLength(2)
    expect(collector.health.sources[0]).toMatchObject({ step: 'storybook', discovered: 3 })
    expect(collector.health.sources[1]).toMatchObject({ status: 'skipped', reason: 'no tsconfig' })
  })

  it('returns a mutable stored entry — mutating it updates health.sources', () => {
    const collector = createHealthCollector('/proto')
    const entry = collector.record({
      step: 'library-dts-auto-scan',
      sourceId: '@acme/ui-vue-dts',
      packageName: '@acme/ui',
      discovered: 5,
      status: 'ok',
    })
    expect(collector.health.sources[0].cache).toBeUndefined()
    entry.cache = 'hit'
    expect(collector.health.sources[0].cache).toBe('hit')
    // The returned entry IS the stored entry, not a detached copy.
    expect(collector.health.sources[0]).toBe(entry)
  })

  it('does not let the caller mutate health.sources by mutating the object literal passed to record()', () => {
    const collector = createHealthCollector('/proto')
    const literal = { step: 'storybook', sourceId: 'storybook', discovered: 0, status: 'ok' as const }
    collector.record(literal)
    literal.discovered = 99
    expect(collector.health.sources[0].discovered).toBe(0)
  })

  it('recordRuntimeError stringifies an Error', () => {
    const collector = createHealthCollector('/proto')
    collector.recordRuntimeError('composite', 'getComponent', new Error('boom'))
    expect(collector.health.runtimeErrors).toHaveLength(1)
    expect(collector.health.runtimeErrors[0]).toMatchObject({
      sourceId: 'composite',
      method: 'getComponent',
      message: 'boom',
    })
    expect(typeof collector.health.runtimeErrors[0].at).toBe('string')
    expect(Number.isNaN(Date.parse(collector.health.runtimeErrors[0].at))).toBe(false)
  })

  it('recordRuntimeError stringifies a non-Error thrown value', () => {
    const collector = createHealthCollector('/proto')
    collector.recordRuntimeError('composite', 'listComponents', 'plain string failure')
    expect(collector.health.runtimeErrors[0].message).toBe('plain string failure')

    collector.recordRuntimeError('composite', 'listComponents', { code: 42 })
    expect(collector.health.runtimeErrors[1].message).toBe('[object Object]')
  })
})
