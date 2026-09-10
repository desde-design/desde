/**
 * OverrideStore unit tests (WS3, tasks/edit-pipeline-rearchitecture.md).
 * The store is deliberately generic (apply/revert/isApplied closures), so
 * the tests model a "rendered value" as a plain mutable box — no DOM needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureBridgeRuntime } from './bridge-runtime'
import { OverrideStore } from './override-store'

interface Box {
  value: string
}

function makeHandle(
  box: Box,
  opts: { id?: string; before?: string; after?: string } = {},
) {
  const before = opts.before ?? 'before'
  const after = opts.after ?? 'after'
  return {
    id: opts.id ?? 'edit-1',
    kind: 'text' as const,
    selector: '.target',
    apply: () => {
      box.value = after
    },
    revert: () => {
      box.value = before
    },
    isApplied: () => box.value === after,
  }
}

describe('OverrideStore', () => {
  let sent: Array<{ type: string; payload?: unknown }>
  let store: OverrideStore

  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
    store = new OverrideStore({
      sendToShell: (m) => sent.push(m),
      reassertIntervalMs: 100,
      unverifiedAfterMs: 1_000,
      giveUpAfterMs: 5_000,
    })
  })

  afterEach(() => {
    store.releaseAll()
    vi.useRealTimers()
  })

  it('re-asserts the override when an unrelated re-render clobbers it', () => {
    const box: Box = { value: 'after' } // capture site already applied
    store.register(makeHandle(box))

    // Parent re-render passes the original value back down.
    box.value = 'before'
    vi.advanceTimersByTime(150)
    expect(box.value).toBe('after')

    // And again — the loop keeps owning the preview until resolved.
    box.value = 'before'
    vi.advanceTimersByTime(150)
    expect(box.value).toBe('after')
  })

  it('confirmed → releases without touching the DOM and stops re-asserting', () => {
    const box: Box = { value: 'after' }
    store.register(makeHandle(box))
    store.resolve('edit-1', 'confirmed')
    expect(store.size()).toBe(0)

    // No longer owned: a later change is NOT fought.
    box.value = 'something-else'
    vi.advanceTimersByTime(500)
    expect(box.value).toBe('something-else')
    expect(sent).toEqual([])
  })

  it('failed → reverts to before and emits OVERRIDE_REVERTED with the reason', () => {
    const box: Box = { value: 'after' }
    store.register(makeHandle(box))
    store.resolve('edit-1', 'failed', 'Stale target: file changed')
    expect(box.value).toBe('before')
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('OVERRIDE_REVERTED')
    expect(sent[0].payload).toMatchObject({
      id: 'edit-1',
      kind: 'text',
      selector: '.target',
      reason: 'Stale target: file changed',
    })
    expect(store.size()).toBe(0)
  })

  it('ineffective → releases WITHOUT reverting (post-HMR DOM is the truth)', () => {
    const box: Box = { value: 'rendered-from-new-source' }
    store.register(makeHandle(box))
    store.resolve('edit-1', 'ineffective')
    // Not reverted, not re-asserted — whatever the DOM shows stands.
    vi.advanceTimersByTime(500)
    expect(box.value).toBe('rendered-from-new-source')
    expect(sent).toEqual([])
    expect(store.size()).toBe(0)
  })

  it('emits OVERRIDE_UNVERIFIED once when no resolution arrives in time', () => {
    const box: Box = { value: 'after' }
    store.register(makeHandle(box))
    vi.advanceTimersByTime(1_200)
    const unverified = sent.filter((m) => m.type === 'OVERRIDE_UNVERIFIED')
    expect(unverified).toHaveLength(1)
    expect(store.get('edit-1')?.state).toBe('unverified')

    // Still re-asserting while unverified (until give-up).
    box.value = 'before'
    vi.advanceTimersByTime(150)
    expect(box.value).toBe('after')

    // No duplicate event.
    vi.advanceTimersByTime(1_000)
    expect(sent.filter((m) => m.type === 'OVERRIDE_UNVERIFIED')).toHaveLength(1)
  })

  it('gives up re-asserting after giveUpAfterMs but keeps the DOM as-is', () => {
    const box: Box = { value: 'after' }
    store.register(makeHandle(box))
    vi.advanceTimersByTime(5_200)
    box.value = 'before'
    vi.advanceTimersByTime(1_000)
    expect(box.value).toBe('before') // no longer fought
    expect(store.get('edit-1')?.state).toBe('unverified')
  })

  it('re-registering the same id lets the newest value own the preview', () => {
    const box: Box = { value: 'v1' }
    store.register(makeHandle(box, { before: 'orig', after: 'v1' }))
    store.register(makeHandle(box, { before: 'orig', after: 'v2' }))
    box.value = 'orig'
    vi.advanceTimersByTime(150)
    expect(box.value).toBe('v2')
    // Failure reverts to the ORIGINAL captured before.
    store.resolve('edit-1', 'failed')
    expect(box.value).toBe('orig')
  })

  it('failed revert survives a revert() that throws (element gone)', () => {
    const box: Box = { value: 'after' }
    const handle = makeHandle(box)
    handle.revert = () => {
      throw new Error('element detached')
    }
    store.register(handle)
    expect(() => store.resolve('edit-1', 'failed', 'network')).not.toThrow()
    expect(sent[0]?.type).toBe('OVERRIDE_REVERTED')
  })

  it('releaseAll drops everything without reverting or emitting', () => {
    const a: Box = { value: 'after' }
    const b: Box = { value: 'after' }
    store.register(makeHandle(a, { id: 'a' }))
    store.register(makeHandle(b, { id: 'b' }))
    store.releaseAll()
    expect(store.size()).toBe(0)
    a.value = 'x'
    vi.advanceTimersByTime(500)
    expect(a.value).toBe('x')
    expect(sent).toEqual([])
  })

  it('resolving an unknown id is a no-op', () => {
    expect(() => store.resolve('nope', 'failed')).not.toThrow()
    expect(sent).toEqual([])
  })
})

/**
 * Every message the page originates that leads to a write or an override
 * change names the document it came from, so the shell can drop one that
 * outlived its page (round 15 RULING, widened to the override family).
 *
 * The store is otherwise deliberately generic, and the document id is the one
 * thing it does NOT take as a constructor option: it is a property of the
 * bridge instance, not of a particular store, and reading it at send time from
 * the runtime binding is what keeps a store built before `init()` correct.
 */
describe('OverrideStore — the document id on its two events', () => {
  const DOCUMENT_ID = 'doc-under-test'
  let sent: Array<{ type: string; payload?: unknown }>
  let store: OverrideStore

  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
    configureBridgeRuntime({
      sendToShell: () => {},
      inspectElement: () => ({}),
      attributeElement: () => undefined,
      documentId: DOCUMENT_ID,
    })
    store = new OverrideStore({
      sendToShell: (m) => sent.push(m),
      reassertIntervalMs: 100,
      unverifiedAfterMs: 1_000,
      giveUpAfterMs: 5_000,
    })
  })

  afterEach(() => {
    store.releaseAll()
    vi.useRealTimers()
    configureBridgeRuntime({
      sendToShell: () => {},
      inspectElement: () => ({}),
      attributeElement: () => undefined,
      documentId: '',
    })
  })

  it('stamps OVERRIDE_REVERTED', () => {
    const box: Box = { value: 'after' }
    store.register(makeHandle(box))
    store.resolve('edit-1', 'failed', 'Stale target')
    expect(sent[0]?.payload).toMatchObject({ documentId: DOCUMENT_ID })
  })

  it('stamps OVERRIDE_UNVERIFIED', () => {
    const box: Box = { value: 'after' }
    store.register(makeHandle(box))
    vi.advanceTimersByTime(1_200)
    const unverified = sent.find((m) => m.type === 'OVERRIDE_UNVERIFIED')
    expect(unverified?.payload).toMatchObject({ documentId: DOCUMENT_ID })
  })
})
