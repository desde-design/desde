import { describe, expect, it, vi } from 'vitest'
import {
  parseStorybookUrls,
  isPrivateOrLoopbackHost,
} from './parse-storybook-urls'

// Silence the default console.warn in tests by passing a no-op
// onReject; specific tests that exercise rejection logic pass a spy.
const SILENT = { onReject: () => {} }

describe('parseStorybookUrls', () => {
  it('returns an empty array when the env var is unset', () => {
    expect(parseStorybookUrls(undefined, SILENT)).toEqual([])
    expect(parseStorybookUrls('', SILENT)).toEqual([])
    expect(parseStorybookUrls('   ', SILENT)).toEqual([])
  })

  it('parses a single bare URL with default designSystem', () => {
    expect(parseStorybookUrls('https://example.com', SILENT)).toEqual([
      {
        baseUrl: 'https://example.com',
        designSystem: 'storybook-url',
        importPath: undefined,
      },
    ])
  })

  it('parses a pipe-delimited triple', () => {
    expect(
      parseStorybookUrls(
        'https://acme-ds.example.com|acme-ds|@acme/design-system',
        SILENT,
      ),
    ).toEqual([
      {
        baseUrl: 'https://acme-ds.example.com',
        designSystem: 'acme-ds',
        importPath: '@acme/design-system',
      },
    ])
  })

  it('treats an empty designSystem segment as default', () => {
    expect(parseStorybookUrls('https://example.com||@example/pkg', SILENT)).toEqual([
      {
        baseUrl: 'https://example.com',
        designSystem: 'storybook-url',
        importPath: '@example/pkg',
      },
    ])
  })

  it('parses multiple comma-separated entries', () => {
    const raw =
      'https://a.example.com|a-ds, https://b.example.com|b-ds|@b/pkg'
    expect(parseStorybookUrls(raw, SILENT)).toEqual([
      {
        baseUrl: 'https://a.example.com',
        designSystem: 'a-ds',
        importPath: undefined,
      },
      {
        baseUrl: 'https://b.example.com',
        designSystem: 'b-ds',
        importPath: '@b/pkg',
      },
    ])
  })

  it('skips entries without an http(s) URL', () => {
    expect(
      parseStorybookUrls(
        'ftp://example.com,https://valid.example.com,not-a-url',
        SILENT,
      ),
    ).toEqual([
      {
        baseUrl: 'https://valid.example.com',
        designSystem: 'storybook-url',
        importPath: undefined,
      },
    ])
  })

  describe('SSRF mitigation', () => {
    it('rejects loopback hostnames', () => {
      expect(
        parseStorybookUrls('http://localhost:6006', SILENT),
      ).toEqual([])
      expect(parseStorybookUrls('http://127.0.0.1:6006', SILENT)).toEqual([])
      expect(parseStorybookUrls('http://[::1]:6006', SILENT)).toEqual([])
    })

    it('rejects RFC1918 private IPs', () => {
      expect(parseStorybookUrls('http://10.0.0.5', SILENT)).toEqual([])
      expect(parseStorybookUrls('http://172.16.0.1', SILENT)).toEqual([])
      expect(parseStorybookUrls('http://192.168.1.1', SILENT)).toEqual([])
    })

    it('rejects link-local IPs and *.local hostnames', () => {
      expect(parseStorybookUrls('http://169.254.169.254', SILENT)).toEqual([])
      expect(parseStorybookUrls('http://my-laptop.local', SILENT)).toEqual([])
    })

    it('rejects cloud metadata service hostnames', () => {
      expect(
        parseStorybookUrls('http://metadata.google.internal', SILENT),
      ).toEqual([])
      expect(
        parseStorybookUrls('http://metadata.aws.amazon.com', SILENT),
      ).toEqual([])
    })

    it('rejects *.internal hostnames', () => {
      expect(
        parseStorybookUrls('http://storybook.corp.internal', SILENT),
      ).toEqual([])
    })

    it('allows public DNS hostnames', () => {
      expect(
        parseStorybookUrls('https://acme-ds.example.com', SILENT).length,
      ).toBe(1)
      expect(
        parseStorybookUrls('https://primefaces.org', SILENT).length,
      ).toBe(1)
    })

    it('allows private targets when explicitly allowlisted', () => {
      const out = parseStorybookUrls('http://localhost:6006', {
        allowlist: ['localhost'],
        onReject: () => {},
      })
      expect(out).toEqual([
        {
          baseUrl: 'http://localhost:6006',
          designSystem: 'storybook-url',
          importPath: undefined,
        },
      ])
    })

    it('reports reasons via onReject for misconfigured entries', () => {
      const onReject = vi.fn()
      parseStorybookUrls(
        'http://localhost,https://valid.example.com,not-a-url',
        { onReject },
      )
      // Two rejections expected: localhost (private) and not-a-url (malformed).
      expect(onReject).toHaveBeenCalledTimes(2)
      const reasons = onReject.mock.calls.map(([, reason]) => reason)
      expect(reasons.some((r) => /loopback|private|link-local/.test(r))).toBe(
        true,
      )
      expect(reasons.some((r) => /malformed/.test(r))).toBe(true)
    })
  })
})

describe('isPrivateOrLoopbackHost (pure)', () => {
  it.each([
    ['localhost', true],
    ['my-app.localhost', true],
    ['my-laptop.local', true],
    ['cluster.corp.internal', true],
    ['metadata.google.internal', true],
    ['127.0.0.1', true],
    ['127.255.255.255', true],
    ['0.0.0.0', true],
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.0.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['::1', true],
    ['fe80::1', true],
    ['fc00::1', true],
    ['fd12:3456::', true],
    // IPv4-mapped IPv6 should re-apply IPv4 rules on the embedded
    // address. Closes the SSRF bypass codex flagged in re-review.
    ['::ffff:127.0.0.1', true],
    ['::ffff:10.0.0.1', true],
    ['::ffff:192.168.1.1', true],
    ['::ffff:169.254.169.254', true],
    // IPv4-translated IPv6
    ['::ffff:0:127.0.0.1', true],
    // IPv4-compatible (deprecated but accepted by some resolvers)
    ['::127.0.0.1', true],
    // Mapped IPv6 to a public IPv4 should still allow.
    ['::ffff:8.8.8.8', false],
    ['acme-ds.example.com', false],
    ['8.8.8.8', false],
    ['172.15.0.1', false], // just outside 172.16/12
    ['172.32.0.1', false], // just outside 172.16/12
    ['100.63.0.1', false], // just outside CGN
    ['100.128.0.1', false], // just outside CGN
    ['2001:db8::1', false], // documentation range — not denied
  ])('classifies %s as private=%s', (host, expected) => {
    expect(isPrivateOrLoopbackHost(host)).toBe(expected)
  })

  it('treats an empty hostname as private (deny by default)', () => {
    expect(isPrivateOrLoopbackHost('')).toBe(true)
  })
})
