/**
 * Tests for the editorFetch wrapper.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { editorFetch } from './editor-fetch'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('editorFetch', () => {
  it('passes the request through to fetch unchanged', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(''))
    const init = { method: 'POST' } as const
    await editorFetch('/api/editor/edit', init)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('/api/editor/edit', init)
  })

  it('does not add a session header', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(''))
    await editorFetch('/api/editor/edit', { method: 'POST' })
    const [, init] = spy.mock.calls[0]
    const headers = new Headers(init?.headers)
    expect(headers.has('X-Editor-Session')).toBe(false)
  })
})
