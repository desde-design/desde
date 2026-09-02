import { describe, expect, it, vi } from 'vitest'
import {
  assetExtensionOf,
  checkDownloadRequest,
  downloadAsset,
  DOWNLOADABLE_ASSET_EXTENSIONS,
} from './download-asset'
import type { WebPolicy } from './web-policy'

const POLICY: WebPolicy = { webFetchAllowedHosts: ['cdn.example.com'], webSearchEnabled: false }

function res(
  body: Uint8Array | string,
  headers: Record<string, string>,
  init: { ok?: boolean; status?: number } = {},
): Response {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: 'OK',
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response
}

const PNG = res(new Uint8Array([137, 80, 78, 71]), { 'content-type': 'image/png' })

/** Public address — the default for tests that aren't about DNS. */
const publicDns = async () => ['93.184.216.34']

describe('assetExtensionOf', () => {
  it('lowercases and handles paths and query-free names', () => {
    expect(assetExtensionOf('public/hero.PNG')).toBe('.png')
    expect(assetExtensionOf('a/b/c.svg')).toBe('.svg')
    expect(assetExtensionOf('noext')).toBe('')
  })
})

describe('checkDownloadRequest — decided without touching the network', () => {
  it('refuses a non-image destination', () => {
    // The authoring allowlist is text-only on purpose; this one is images
    // only. Neither should ever admit an executable.
    for (const bad of ['x.sh', 'x.js', 'x.env', 'x.html', 'x']) {
      const r = checkDownloadRequest({ url: 'https://cdn.example.com/a', destPath: bad, policy: POLICY })
      expect(r.ok, bad).toBe(false)
      expect(!r.ok && r.code).toBe('bad-extension')
    }
  })

  it('accepts every extension it advertises', () => {
    for (const ext of DOWNLOADABLE_ASSET_EXTENSIONS) {
      const r = checkDownloadRequest({
        url: 'https://cdn.example.com/a',
        destPath: `public/img${ext}`,
        policy: POLICY,
      })
      expect(r.ok, ext).toBe(true)
    }
  })

  it('refuses a host outside the WebFetch allowlist', () => {
    const r = checkDownloadRequest({
      url: 'https://evil.example.net/a.png',
      destPath: 'a.png',
      policy: POLICY,
    })
    expect(!r.ok && r.code).toBe('not-allowed-host')
  })

  it('refuses when no policy is configured at all', () => {
    const r = checkDownloadRequest({ url: 'https://cdn.example.com/a.png', destPath: 'a.png', policy: undefined })
    expect(!r.ok && r.code).toBe('not-allowed-host')
  })

  it('refuses a private address EVEN IF allowlisted', () => {
    // An allowlist entry must never become a probe of the user's network.
    const localPolicy: WebPolicy = {
      webFetchAllowedHosts: ['localhost', '169.254.169.254', '10.0.0.5'],
      webSearchEnabled: false,
    }
    for (const host of ['localhost', '169.254.169.254', '10.0.0.5']) {
      const r = checkDownloadRequest({
        url: `https://${host}/a.png`,
        destPath: 'a.png',
        policy: localPolicy,
      })
      expect(r.ok, host).toBe(false)
      expect(!r.ok && r.code).toBe('private-address')
    }
  })

  it('allows an allowlisted public host', () => {
    const r = checkDownloadRequest({
      url: 'https://cdn.example.com/hero.png',
      destPath: 'public/hero.png',
      policy: POLICY,
    })
    expect(r.ok).toBe(true)
  })
})

describe('downloadAsset', () => {
  it('returns the bytes for a well-formed image response', async () => {
    const r = await downloadAsset({
      url: 'https://cdn.example.com/hero.png',
      destPath: 'public/hero.png',
      policy: POLICY,
      resolveHost: publicDns,
      fetchImpl: vi.fn().mockResolvedValue(PNG) as unknown as typeof fetch,
    })
    expect(r.ok).toBe(true)
    expect(r.ok && r.bytes.byteLength).toBe(4)
  })

  it('refuses to follow redirects', async () => {
    // A 302 could land on a host the user never allowlisted, or on a private
    // address — defeating both checks.
    const fetchImpl = vi.fn().mockResolvedValue(PNG) as unknown as typeof fetch
    await downloadAsset({
      url: 'https://cdn.example.com/hero.png',
      destPath: 'public/hero.png',
      policy: POLICY,
      resolveHost: publicDns,
      fetchImpl,
    })
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({
      redirect: 'error',
    })
  })

  it('refuses a non-image content type', async () => {
    const r = await downloadAsset({
      url: 'https://cdn.example.com/x.png',
      destPath: 'x.png',
      policy: POLICY,
      resolveHost: publicDns,
      fetchImpl: vi.fn().mockResolvedValue(res('<html>', { 'content-type': 'text/html' })) as never,
    })
    expect(!r.ok && r.code).toBe('wrong-content-type')
  })

  it('refuses a content type that contradicts the extension', async () => {
    // Saving PNG bytes as .jpg produces a file whose name lies about it.
    const r = await downloadAsset({
      url: 'https://cdn.example.com/x.jpg',
      destPath: 'x.jpg',
      policy: POLICY,
      resolveHost: publicDns,
      fetchImpl: vi.fn().mockResolvedValue(PNG) as never,
    })
    expect(!r.ok && r.code).toBe('wrong-content-type')
  })

  it('enforces the size cap even when Content-Length lies', async () => {
    const big = new Uint8Array(50)
    const r = await downloadAsset({
      url: 'https://cdn.example.com/x.png',
      destPath: 'x.png',
      policy: POLICY,
      maxBytes: 10,
      resolveHost: publicDns,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(res(big, { 'content-type': 'image/png', 'content-length': '1' })) as never,
    })
    expect(!r.ok && r.code).toBe('too-large')
  })

  it('rejects early on an honest oversized Content-Length', async () => {
    const r = await downloadAsset({
      url: 'https://cdn.example.com/x.png',
      destPath: 'x.png',
      policy: POLICY,
      maxBytes: 10,
      resolveHost: publicDns,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(res(new Uint8Array(4), { 'content-type': 'image/png', 'content-length': '9999' })) as never,
    })
    expect(!r.ok && r.code).toBe('too-large')
  })

  it('surfaces a non-2xx as a failure', async () => {
    const r = await downloadAsset({
      url: 'https://cdn.example.com/x.png',
      destPath: 'x.png',
      policy: POLICY,
      resolveHost: publicDns,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(res('', { 'content-type': 'image/png' }, { ok: false, status: 404 })) as never,
    })
    expect(!r.ok && r.code).toBe('fetch-failed')
  })

  it('never makes a request when the pre-check refuses', async () => {
    // A denied download should not tell a server the user exists.
    const fetchImpl = vi.fn()
    await downloadAsset({
      url: 'https://evil.example.net/x.png',
      destPath: 'x.png',
      policy: POLICY,
      resolveHost: publicDns,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('downloadAsset — SSRF via DNS', () => {
  it('refuses when an allowlisted hostname RESOLVES to a private address', async () => {
    // The hostname string looks public and passes the allowlist; only the
    // resolved address reveals it. Without this check fetch() would connect.
    const fetchImpl = vi.fn()
    const r = await downloadAsset({
      url: 'https://cdn.example.com/x.png',
      destPath: 'x.png',
      policy: POLICY,
      resolveHost: async () => ['127.0.0.1'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(!r.ok && r.code).toBe('private-address')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses cloud metadata even behind a public-looking name', async () => {
    const r = await downloadAsset({
      url: 'https://cdn.example.com/x.png',
      destPath: 'x.png',
      policy: POLICY,
      resolveHost: async () => ['169.254.169.254'],
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })
    expect(!r.ok && r.code).toBe('private-address')
  })

  it('refuses when ANY resolved address is private', async () => {
    const r = await downloadAsset({
      url: 'https://cdn.example.com/x.png',
      destPath: 'x.png',
      policy: POLICY,
      resolveHost: async () => ['93.184.216.34', '10.0.0.7'],
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })
    expect(!r.ok && r.code).toBe('private-address')
  })

  it('surfaces a DNS failure rather than fetching blind', async () => {
    const r = await downloadAsset({
      url: 'https://cdn.example.com/x.png',
      destPath: 'x.png',
      policy: POLICY,
      resolveHost: async () => {
        throw new Error('ENOTFOUND')
      },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })
    expect(!r.ok && r.code).toBe('fetch-failed')
  })
})

describe('downloadAsset — streaming size cap', () => {
  /** A streamed body that would exceed the cap if buffered whole. */
  function streamed(chunkCount: number, chunkSize: number, headers: Record<string, string>): Response {
    let sent = 0
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      body: {
        getReader: () => ({
          read: async () =>
            sent++ < chunkCount
              ? { done: false, value: new Uint8Array(chunkSize) }
              : { done: true, value: undefined },
          cancel: async () => {},
        }),
      },
      arrayBuffer: async () => new ArrayBuffer(chunkCount * chunkSize),
    } as unknown as Response
  }

  it('aborts mid-stream instead of buffering the whole body', async () => {
    // Content-Length absent, so the early-out cannot help: a hostile host
    // could otherwise stream unbounded data into memory.
    const r = await downloadAsset({
      url: 'https://cdn.example.com/x.png',
      destPath: 'x.png',
      policy: POLICY,
      maxBytes: 100,
      resolveHost: publicDns,
      fetchImpl: vi.fn().mockResolvedValue(streamed(50, 64, { 'content-type': 'image/png' })) as never,
    })
    expect(!r.ok && r.code).toBe('too-large')
  })

  it('accepts a streamed body within the cap', async () => {
    const r = await downloadAsset({
      url: 'https://cdn.example.com/x.png',
      destPath: 'x.png',
      policy: POLICY,
      maxBytes: 1000,
      resolveHost: publicDns,
      fetchImpl: vi.fn().mockResolvedValue(streamed(2, 8, { 'content-type': 'image/png' })) as never,
    })
    expect(r.ok && r.bytes.byteLength).toBe(16)
  })
})

describe('downloadAsset — connection pinning', () => {
  it('pins the connection to the vetted address', async () => {
    // Without a pinned dispatcher, fetch resolves the name a SECOND time and
    // an attacker controlling an allowlisted host can answer public on our
    // probe and private on theirs. The dispatcher removes that second lookup.
    const fetchImpl = vi.fn().mockResolvedValue(PNG)
    await downloadAsset({
      url: 'https://cdn.example.com/x.png',
      destPath: 'x.png',
      policy: POLICY,
      resolveHost: publicDns,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const init = fetchImpl.mock.calls[0]![1] as Record<string, unknown>
    expect(init.dispatcher, 'a dispatcher must be supplied').toBeTruthy()
  })

  it('FAILS CLOSED when the connection cannot be pinned', async () => {
    // Falling back to a plain fetch would re-open the exact rebinding window
    // the pin exists to close. A silent downgrade of a security boundary is
    // worse than a refused download.
    const fetchImpl = vi.fn().mockResolvedValue(PNG)
    const r = await downloadAsset({
      url: 'https://cdn.example.com/x.png',
      destPath: 'x.png',
      policy: POLICY,
      resolveHost: publicDns,
      dispatcher: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/rebinding/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

