/**
 * Staleness checks for registered design systems (Phase 3 attach/refresh,
 * task 5) — "is there a newer version of this than what we extracted?"
 *
 * Checks are SIDE-EFFECT-FREE: no clone, no install, no write to the
 * registry or the filesystem. Each check is a single read-only subprocess
 * call (`git ls-remote` / `npm view`) that never throws — any failure
 * (network, malformed remote, bad ref) degrades to `state: 'unknown'` with a
 * human-readable `reason`, so one flaky check can never break the panel's
 * `GET …/updates` route, which runs every registered entry concurrently.
 *
 * Per-kind semantics:
 * - `installed`: always `'fresh'` — version-keyed cache invalidation
 *   (`src/editor/adapters/cached/`) already owns freshness for a package
 *   the prototype's own `node_modules`/lockfile controls.
 * - `repo`: compares `git ls-remote <url> <ref-or-HEAD>`'s resolved sha
 *   against `entry.resolvedCommit` (the FULL sha recorded at onboard/refresh
 *   time — never the `+git.<sha12>` fold in `entry.version`, which is a
 *   truncated cache-busting suffix, not a comparable identity). Entries
 *   onboarded before `resolvedCommit` existed (or where the orchestrator
 *   couldn't resolve one) report `'unknown'` rather than guessing.
 * - `npm`: compares `npm view <original spec> version --json` (re-resolved
 *   from the ORIGINAL spec, so a range like `^2` re-resolves to whatever is
 *   newest under that range today) against `entry.version` by exact string
 *   equality — the entry's version IS the concrete resolved version from the
 *   onboard-time install, so any difference is a real update.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { sanitizedGitEnv } from '@/editor/core/read-roots'
import { parseRepoSource, RepoIngestError } from '@/editor/ingest/git-repo'
import { parsePackageSpec } from '@/editor/ingest/npm-package'
import type { DesignSystemSource, RegisteredDesignSystem } from './types'

const execFileP = promisify(execFile)

/** Injectable subprocess runner shape — matches `promisify(execFile)`. */
type ExecFileFn = typeof execFileP

const CHECK_TIMEOUT_MS = 10_000

export interface StalenessResult {
  /** Registry entry id (mirrors `RegisteredDesignSystem.id`). */
  id: string
  state: 'fresh' | 'update-available' | 'unknown'
  /** resolvedCommit (repo) / version (npm) — omitted for `installed`. */
  current?: string
  /** Remote sha (repo) / registry version (npm) — omitted when unresolved. */
  latest?: string
  /** Why `state === 'unknown'`, or informational context for `'fresh'`. */
  reason?: string
}

export interface CheckDesignSystemStalenessDeps {
  /** Injected for tests — no real network. Defaults to the real `execFile`. */
  execFile?: ExecFileFn
}

/**
 * Check one registered entry for staleness. Never throws — every failure
 * mode is folded into `state: 'unknown'` + `reason`.
 */
export async function checkDesignSystemStaleness(
  entry: RegisteredDesignSystem,
  deps: CheckDesignSystemStalenessDeps = {},
): Promise<StalenessResult> {
  const run = deps.execFile ?? execFileP
  const { id, source } = entry

  if (source.kind === 'installed') {
    return { id, state: 'fresh', reason: 'tracked by package version' }
  }
  if (source.kind === 'repo') {
    return checkRepoStaleness(id, source, entry.resolvedCommit, run)
  }
  return checkNpmStaleness(id, source, entry.version, run)
}

async function checkRepoStaleness(
  id: string,
  source: Extract<DesignSystemSource, { kind: 'repo' }>,
  resolvedCommit: string | undefined,
  run: ExecFileFn,
): Promise<StalenessResult> {
  if (!resolvedCommit) {
    return { id, state: 'unknown', reason: 'no recorded commit: refresh once to record it' }
  }

  // `.desde/design-systems.json` is registry data, not a trust
  // boundary the ingest-time validators already crossed — a hostile cloned
  // repo can commit an entry with an arbitrary `url`/`ref`, and boot warm-up
  // runs this check unprompted. Re-validate through the SAME validators the
  // ingest lane uses (`parseRepoSource`) before it ever reaches `execFile` —
  // never trust a registry-supplied value as already-safe.
  let parsed: { url: string; ref?: string }
  try {
    parsed = parseRepoSource({ url: source.url, ref: source.ref })
  } catch (err) {
    const field = err instanceof RepoIngestError && /invalid ref/i.test(err.message) ? 'ref' : 'url'
    return { id, state: 'unknown', current: resolvedCommit, reason: `invalid ${field} in registry entry` }
  }
  // Defense-in-depth: even though the validators above already reject a
  // leading `-` (it would otherwise be read as a git/ssh flag rather than a
  // positional), refuse again explicitly here so this guard doesn't rely
  // solely on staying in sync with `git-repo.ts`'s regexes.
  if (parsed.url.startsWith('-')) {
    return { id, state: 'unknown', current: resolvedCommit, reason: 'invalid url in registry entry' }
  }
  if (parsed.ref !== undefined && parsed.ref.startsWith('-')) {
    return { id, state: 'unknown', current: resolvedCommit, reason: 'invalid ref in registry entry' }
  }

  const ref = parsed.ref ?? 'HEAD'
  try {
    // `--end-of-options` (git ≥2.24) terminates flag parsing before the url/ref
    // positionals — belt-and-suspenders over the validators above, mirroring
    // `ingestRepo`'s own `--` before its clone positionals.
    const { stdout } = await run('git', ['ls-remote', '--end-of-options', parsed.url, ref], {
      timeout: CHECK_TIMEOUT_MS,
      env: sanitizedGitEnv(),
      encoding: 'utf8',
    })
    const firstLine = String(stdout)
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0)
    const sha = firstLine?.split(/\s+/)[0]
    if (!sha) {
      return {
        id,
        state: 'unknown',
        current: resolvedCommit,
        reason: `no ref '${ref}' found on the remote`,
      }
    }
    return {
      id,
      state: sha === resolvedCommit ? 'fresh' : 'update-available',
      current: resolvedCommit,
      latest: sha,
    }
  } catch (err) {
    return {
      id,
      state: 'unknown',
      current: resolvedCommit,
      reason: `couldn't check the remote: ${errorMessage(err)}`,
    }
  }
}

async function checkNpmStaleness(
  id: string,
  source: Extract<DesignSystemSource, { kind: 'npm' }>,
  version: string,
  run: ExecFileFn,
): Promise<StalenessResult> {
  // Same registry-data trust boundary as the repo case above — re-validate
  // the spec through the ingest lane's own validator before it ever reaches
  // `execFile`.
  try {
    parsePackageSpec(source.spec)
  } catch {
    return { id, state: 'unknown', current: version, reason: 'invalid spec in registry entry' }
  }
  // Defense-in-depth: the validator above already rejects a name/whole-spec
  // starting with `-` (npm would otherwise read it as a CLI flag rather than
  // the package-spec positional), but refuse again explicitly so this guard
  // doesn't rely solely on staying in sync with `npm-package.ts`'s regexes.
  if (source.spec.trim().startsWith('-')) {
    return { id, state: 'unknown', current: version, reason: 'invalid spec in registry entry' }
  }

  try {
    const { stdout } = await run('npm', ['view', source.spec, 'version', '--json'], {
      timeout: CHECK_TIMEOUT_MS,
      encoding: 'utf8',
    })
    const trimmed = String(stdout).trim()
    if (!trimmed) {
      return { id, state: 'unknown', current: version, reason: 'no matching version found in registry' }
    }
    const parsed: unknown = JSON.parse(trimmed)
    // `npm view <range> version --json` returns a single string for an
    // exact/singleton match, or an array of every version satisfying the
    // range when the range matches several. The array is in REGISTRY
    // PUBLISH-TIME order, not semver order (a patch backport can publish
    // after a later minor) — so the true latest must be picked by numeric
    // comparison, never `[length - 1]`.
    const latest = Array.isArray(parsed) ? pickLatestVersion(parsed) : parsed
    if (typeof latest !== 'string' || !latest) {
      return { id, state: 'unknown', current: version, reason: 'no matching version found in registry' }
    }
    return {
      id,
      state: latest === version ? 'fresh' : 'update-available',
      current: version,
      latest,
    }
  } catch (err) {
    return {
      id,
      state: 'unknown',
      current: version,
      reason: `couldn't resolve the latest version: ${errorMessage(err)}`,
    }
  }
}

/**
 * Pick the true max from a `npm view <range> version --json` array. The
 * registry returns matches in PUBLISH-TIME order, not semver order (a patch
 * backport can publish after a later minor already shipped) — so this can't
 * be `[length - 1]`. Prereleases are excluded from consideration unless
 * EVERY candidate is a prerelease (a stable release always outranks a
 * prerelease of a numerically higher version — we're checking "is there a
 * real update", not doing full semver precedence).
 */
function pickLatestVersion(values: unknown[]): string | undefined {
  const versions = values.filter((v): v is string => typeof v === 'string' && v.length > 0)
  if (versions.length === 0) return undefined
  const stable = versions.filter((v) => !v.includes('-'))
  const candidates = stable.length > 0 ? stable : versions
  return candidates.reduce((best, v) => (isNewerVersion(v, best) ? v : best))
}

/** Numeric major.minor.patch tuple, ignoring any `-prerelease`/`+build` suffix. */
function parseVersionTuple(v: string): [number, number, number] | null {
  const parts = v.split(/[-+]/, 1)[0].split('.').map(Number)
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return null
  const [major = 0, minor = 0, patch = 0] = parts
  return [major, minor, patch]
}

/** Is `a` a newer release than `b`? A non-numeric version never outranks a numeric one. */
function isNewerVersion(a: string, b: string): boolean {
  const ta = parseVersionTuple(a)
  const tb = parseVersionTuple(b)
  if (!ta) return false
  if (!tb) return true
  for (let i = 0; i < 3; i++) {
    if (ta[i] !== tb[i]) return ta[i] > tb[i]
  }
  return false
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
