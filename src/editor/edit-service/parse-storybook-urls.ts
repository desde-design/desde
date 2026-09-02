/**
 * Parser for the `EDITOR_STORYBOOK_URLS` env var, with built-in
 * SSRF mitigation.
 *
 * Format: comma-separated list. Each entry is either a bare URL
 * (designSystem defaults to `'storybook-url'`) or a pipe-delimited
 * triple `<url>|<designSystem>|<importPath>` where importPath is
 * optional. Invalid entries are skipped silently and logged via the
 * `onReject` callback.
 *
 * Why SSRF matters: the `/api/editor/manifest` route is dev-only
 * by claim, but the StorybookUrlManifestSource fetches whatever URLs
 * end up in this env. If the route is ever exposed (intentionally or
 * by accident) and the env is influenced (e.g. a shared dev box, a
 * misconfigured deploy), arbitrary URL fetches turn into an SSRF
 * primitive that can probe internal services from the server's
 * network context. Rejecting loopback / private-IP / link-local
 * targets at the parser level is cheap insurance.
 *
 * The default policy rejects:
 *   - IPv4 loopback (127.0.0.0/8) and unspecified (0.0.0.0)
 *   - IPv4 RFC1918 private (10/8, 172.16/12, 192.168/16)
 *   - IPv4 link-local (169.254/16) and CGN (100.64/10)
 *   - IPv6 loopback (::1) and link-local (fe80::/10)
 *   - IPv6 ULA (fc00::/7)
 *   - Hostnames: localhost, *.localhost, *.local, *.internal,
 *     metadata.google.internal, metadata.aws.amazon.com
 *
 * Customers who DO want to point at internal Storybook deployments
 * can opt in via `EDITOR_STORYBOOK_HOST_ALLOWLIST` (comma-separated
 * exact-match hostnames). Use sparingly — every entry is a bypass of
 * the default protections.
 */
export interface StorybookUrlConfig {
  baseUrl: string
  designSystem: string
  importPath?: string
}

export interface ParseStorybookUrlsOptions {
  /**
   * Allowlist of hostnames that bypass the default deny-list. Pulled
   * from `EDITOR_STORYBOOK_HOST_ALLOWLIST` at the call site; tests
   * pass it explicitly. Exact-match.
   */
  allowlist?: readonly string[]
  /**
   * Callback for rejected entries. Defaults to a console.warn so
   * misconfiguration surfaces in dev logs. Pass `() => {}` to silence.
   */
  onReject?: (entry: string, reason: string) => void
}

export function parseStorybookUrls(
  raw: string | undefined,
  options: ParseStorybookUrlsOptions = {},
): StorybookUrlConfig[] {
  if (!raw) return []
  const allowlist = new Set(options.allowlist ?? [])
  const onReject =
    options.onReject ??
    ((entry, reason) => {
      console.warn(
        `[editor-manifest] Rejected EDITOR_STORYBOOK_URLS entry "${entry}": ${reason}`,
      )
    })

  const out: StorybookUrlConfig[] = []
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const parts = entry.split('|').map((s) => s.trim())
    const baseUrl = parts[0]
    if (!baseUrl) {
      onReject(entry, 'missing URL')
      continue
    }

    let parsed: URL
    try {
      parsed = new URL(baseUrl)
    } catch {
      onReject(entry, 'malformed URL')
      continue
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      onReject(entry, `unsupported protocol "${parsed.protocol}"`)
      continue
    }
    if (!allowlist.has(parsed.hostname) && isPrivateOrLoopbackHost(parsed.hostname)) {
      onReject(
        entry,
        `host "${parsed.hostname}" is loopback/private/link-local — set EDITOR_STORYBOOK_HOST_ALLOWLIST to override`,
      )
      continue
    }

    const designSystem =
      parts[1] && parts[1].length > 0 ? parts[1] : 'storybook-url'
    const importPath =
      parts[2] && parts[2].length > 0 ? parts[2] : undefined
    out.push({ baseUrl, designSystem, importPath })
  }
  return out
}

/**
 * Classify a hostname as loopback/private/link-local. Conservative:
 * any string we can't classify (e.g. weird unicode hostnames) returns
 * `true` — better to reject than to leak. Customers who need internal
 * targets opt in via the allowlist.
 *
 * Exported for tests; not part of the route's public surface.
 */
export function isPrivateOrLoopbackHost(host: string): boolean {
  if (!host) return true
  const lower = host.toLowerCase()

  // Bracketed IPv6 — `URL` strips the brackets, but normalize either way.
  const stripped = lower.replace(/^\[|\]$/g, '')

  // Hostname-pattern denylist.
  if (stripped === 'localhost') return true
  if (stripped.endsWith('.localhost')) return true
  if (stripped.endsWith('.local')) return true
  if (stripped.endsWith('.internal')) return true
  if (stripped === 'metadata.google.internal') return true
  if (stripped === 'metadata.aws.amazon.com') return true

  // IPv4 literal?
  if (isPrivateIpv4(stripped)) return true

  // IPv6 literal? Coarse classification — exact CIDR matching for
  // every reserved IPv6 range would be overkill here; the hostname
  // denylist covers the common cases and any reachable production
  // Storybook will use a plain DNS hostname anyway.
  if (stripped.includes(':')) {
    if (stripped === '::1') return true // loopback
    if (stripped === '::') return true // unspecified
    if (stripped.startsWith('fe8') || stripped.startsWith('fe9')) return true // fe80::/10
    if (stripped.startsWith('fea') || stripped.startsWith('feb')) return true // fe80::/10
    if (stripped.startsWith('fc') || stripped.startsWith('fd')) return true // fc00::/7

    // IPv4-mapped IPv6 (`::ffff:127.0.0.1`) and IPv4-translated IPv6
    // (`::ffff:0:127.0.0.1`) — these resolve to the embedded IPv4 at
    // socket time, so re-run IPv4 rules on the tail. The legacy
    // IPv4-compatible form (`::127.0.0.1`, no `ffff`) is deprecated
    // but still accepted by some resolvers; same handling.
    const ipv4InIpv6 = extractEmbeddedIpv4(stripped)
    if (ipv4InIpv6) return isPrivateIpv4(ipv4InIpv6)

    return false
  }

  // Plain DNS hostname not on the denylist — allow.
  return false
}

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = m.slice(1).map((s) => parseInt(s, 10))
  // Reject zero-padded octets that some resolvers interpret as octal —
  // we don't want a zero-padded `010.0.0.1` to slip past as 10.0.0.1
  // depending on resolver behavior. parseInt drops the leading zero
  // either way, but the rule below is conservative.
  if (a === 0) return true // 0.0.0.0/8
  if (a === 127) return true // loopback
  if (a === 10) return true // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
  if (a === 192 && b === 168) return true // RFC1918
  if (a === 169 && b === 254) return true // link-local
  if (a === 100 && b >= 64 && b <= 127) return true // CGN
  return false
}

/**
 * Extract an embedded IPv4 dotted-quad from an IPv6 literal, if
 * present. Handles the three legacy forms:
 *   - IPv4-mapped:    `::ffff:a.b.c.d`
 *   - IPv4-translated: `::ffff:0:a.b.c.d`
 *   - IPv4-compatible: `::a.b.c.d` (deprecated)
 *
 * Returns the dotted-quad as a string, or `null` if no embedded IPv4
 * is present.
 */
function extractEmbeddedIpv4(host: string): string | null {
  const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host)
  if (!m) return null
  return m[1]
}
