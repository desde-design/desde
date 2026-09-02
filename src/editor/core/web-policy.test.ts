/**
 * Tests for the web-policy loader + the pure `isWebFetchAllowed`
 * decision function. Drives a real temp config file because the
 * loader reads from disk.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_WEB_POLICY,
  extractHostForWebFetch,
  isWebFetchAllowed,
  loadWebPolicy,
} from './web-policy'

describe('loadWebPolicy', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pt-wp-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('returns DEFAULT_WEB_POLICY when no config file exists', async () => {
    const r = await loadWebPolicy({ worktreeRoot: root })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.policy).toEqual(DEFAULT_WEB_POLICY)
    expect(r.warnings).toEqual([])
  })

  it('returns DEFAULT_WEB_POLICY when config exists but lacks web sections', async () => {
    await writeFile(
      join(root, 'desde.config.json'),
      JSON.stringify({ readRoots: {} }),
      'utf8',
    )
    const r = await loadWebPolicy({ worktreeRoot: root })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.policy).toEqual(DEFAULT_WEB_POLICY)
  })

  it('parses webFetch.allowedHosts, lowercasing entries', async () => {
    await writeFile(
      join(root, 'desde.config.json'),
      JSON.stringify({
        webFetch: { allowedHosts: ['Vuejs.org', 'docs.acme-ds.example.com'] },
      }),
      'utf8',
    )
    const r = await loadWebPolicy({ worktreeRoot: root })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.policy.webFetchAllowedHosts).toEqual([
      'vuejs.org',
      'docs.acme-ds.example.com',
    ])
  })

  it('parses webSearch.enabled', async () => {
    await writeFile(
      join(root, 'desde.config.json'),
      JSON.stringify({ webSearch: { enabled: true } }),
      'utf8',
    )
    const r = await loadWebPolicy({ worktreeRoot: root })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.policy.webSearchEnabled).toBe(true)
  })

  it('rejects allowedHosts entries containing a scheme', async () => {
    await writeFile(
      join(root, 'desde.config.json'),
      JSON.stringify({ webFetch: { allowedHosts: ['https://example.com'] } }),
      'utf8',
    )
    const r = await loadWebPolicy({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/bare hostname/)
  })

  it('rejects allowedHosts entries containing a wildcard', async () => {
    await writeFile(
      join(root, 'desde.config.json'),
      JSON.stringify({ webFetch: { allowedHosts: ['*.example.com'] } }),
      'utf8',
    )
    const r = await loadWebPolicy({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/bare hostname/)
  })

  it('rejects allowedHosts not being an array', async () => {
    await writeFile(
      join(root, 'desde.config.json'),
      JSON.stringify({ webFetch: { allowedHosts: 'example.com' } }),
      'utf8',
    )
    const r = await loadWebPolicy({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/must be an array/)
  })

  it('rejects webSearch.enabled not being a boolean', async () => {
    await writeFile(
      join(root, 'desde.config.json'),
      JSON.stringify({ webSearch: { enabled: 'yes' } }),
      'utf8',
    )
    const r = await loadWebPolicy({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/must be a boolean/)
  })

  it('handles invalid JSON gracefully', async () => {
    await writeFile(
      join(root, 'desde.config.json'),
      '{not json',
      'utf8',
    )
    const r = await loadWebPolicy({ worktreeRoot: root })
    expect(r.ok).toBe(false)
  })
})

describe('extractHostForWebFetch', () => {
  it('extracts and lowercases the host', () => {
    expect(extractHostForWebFetch('https://Vuejs.org/guide')).toBe('vuejs.org')
  })

  it('returns null for non-http(s) schemes', () => {
    expect(extractHostForWebFetch('file:///etc/passwd')).toBeNull()
    expect(extractHostForWebFetch('ftp://example.com')).toBeNull()
    expect(extractHostForWebFetch('javascript:alert(1)')).toBeNull()
  })

  it('returns null for unparseable URLs', () => {
    expect(extractHostForWebFetch('not a url')).toBeNull()
    expect(extractHostForWebFetch('')).toBeNull()
    expect(extractHostForWebFetch(42)).toBeNull()
    expect(extractHostForWebFetch(null)).toBeNull()
  })
})

describe('isWebFetchAllowed', () => {
  it('denies when the allowlist is empty', () => {
    const r = isWebFetchAllowed(DEFAULT_WEB_POLICY, 'https://example.com')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/WebFetch is disabled/)
  })

  it('allows hosts on the allowlist', () => {
    const policy = { webFetchAllowedHosts: ['vuejs.org'], webSearchEnabled: false }
    const r = isWebFetchAllowed(policy, 'https://vuejs.org/guide/intro')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.host).toBe('vuejs.org')
  })

  it('denies hosts not on the allowlist', () => {
    const policy = { webFetchAllowedHosts: ['vuejs.org'], webSearchEnabled: false }
    const r = isWebFetchAllowed(policy, 'https://evil.example/foo')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/not in the allowlist/)
    expect(r.reason).toMatch(/evil\.example/)
  })

  it('denies non-http(s) schemes even if the host name matches', () => {
    const policy = { webFetchAllowedHosts: ['vuejs.org'], webSearchEnabled: false }
    const r = isWebFetchAllowed(policy, 'file://vuejs.org/etc/passwd')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/invalid or non-http/)
  })

  it('case-insensitive host match', () => {
    const policy = { webFetchAllowedHosts: ['vuejs.org'], webSearchEnabled: false }
    const r = isWebFetchAllowed(policy, 'https://VueJS.ORG/')
    expect(r.ok).toBe(true)
  })
})
