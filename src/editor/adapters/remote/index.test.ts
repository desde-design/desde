import { describe, expect, it, vi } from 'vitest'
import type { ComponentManifest } from '../../core'
import { NON_IDENTIFYING_COMPONENT_NAME } from '../../attribution/types'
import { RemoteManifestSource } from './index'

function manifest(name: string): ComponentManifest {
  return {
    id: `remote.${name.toLowerCase()}`,
    name,
    framework: 'vue3',
    designSystem: 'remote',
    props: [],
    slots: [],
    events: [],
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('RemoteManifestSource', () => {
  it('GETs the endpoint and parses array on listComponents', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse([manifest('Button'), manifest('Card')]))
    const source = new RemoteManifestSource({
      endpoint: '/api/editor/manifest',
      fetchFn,
    })
    const list = await source.listComponents()
    expect(list.map((m) => m.name)).toEqual(['Button', 'Card'])
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/editor/manifest',
      expect.objectContaining({
        headers: { Accept: 'application/json' },
      }),
    )
  })

  it('GETs ?name=<name> on getComponent', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(manifest('Button')))
    const source = new RemoteManifestSource({
      endpoint: '/api/editor/manifest',
      fetchFn,
    })
    const m = await source.getComponent('Button')
    expect(m?.name).toBe('Button')
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/editor/manifest?name=Button',
      expect.any(Object),
    )
  })

  it('URL-encodes component names with special characters', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(null, 404))
    const source = new RemoteManifestSource({
      endpoint: '/api/editor/manifest',
      fetchFn,
    })
    await source.getComponent('Some/Path?Name')
    const calledUrl = fetchFn.mock.calls[0]?.[0]
    expect(calledUrl).toBe(
      '/api/editor/manifest?name=Some%2FPath%3FName',
    )
  })

  it('returns null on 404 from getComponent', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(null, 404))
    const source = new RemoteManifestSource({
      endpoint: '/api/editor/manifest',
      fetchFn,
    })
    expect(await source.getComponent('Nope')).toBeNull()
  })

  it('returns null when body is JSON null even with 200', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(null, 200))
    const source = new RemoteManifestSource({
      endpoint: '/api/editor/manifest',
      fetchFn,
    })
    expect(await source.getComponent('X')).toBeNull()
  })

  it('throws on non-2xx (and non-404) for getComponent', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: 'boom' }, 500))
    const source = new RemoteManifestSource({
      endpoint: '/api/editor/manifest',
      fetchFn,
    })
    await expect(source.getComponent('X')).rejects.toThrow(/500/)
  })

  it('throws when listComponents body is not an array', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ not: 'array' }))
    const source = new RemoteManifestSource({
      endpoint: '/api/editor/manifest',
      fetchFn,
    })
    await expect(source.listComponents()).rejects.toThrow(/non-array/)
  })

  it('throws on non-2xx for listComponents', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({}, 503))
    const source = new RemoteManifestSource({
      endpoint: '/api/editor/manifest',
      fetchFn,
    })
    await expect(source.listComponents()).rejects.toThrow(/503/)
  })

  it('never issues a request for a non-identifying component name (F9)', async () => {
    // The bridge names an unidentifiable component `<anonymous>` so the chain
    // entry keeps its index. That placeholder can never match a manifest, so
    // fetching it is a guaranteed 404 — the only console error observed in two
    // live sessions.
    const fetchFn = vi.fn<typeof fetch>()
    const source = new RemoteManifestSource({
      endpoint: '/api/editor/manifest',
      fetchFn,
    })
    expect(await source.getComponent(NON_IDENTIFYING_COMPONENT_NAME)).toBeNull()
    expect(await source.getComponent('  ')).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })

})
