/**
 * Tests for `checkDesignSystemStaleness` — the read-only "is there a newer
 * version of this than what we extracted?" check (Phase 3 attach/refresh,
 * task 5). All subprocess calls are injected fakes — no real network.
 */
import { describe, expect, it, vi } from 'vitest'
import { checkDesignSystemStaleness, type CheckDesignSystemStalenessDeps } from './staleness'
import type { RegisteredDesignSystem } from './types'

function repoEntry(over: Partial<RegisteredDesignSystem> = {}): RegisteredDesignSystem {
  return {
    id: 'acme-ds',
    source: { kind: 'repo', url: 'https://github.com/acme/ds', ref: 'main' },
    package: 'acme-ds',
    version: '1.0.0+git.abcdef012345',
    framework: 'vue3',
    designSystem: 'acme-ds',
    importPath: 'acme-ds',
    resolvedCommit: 'abcdef0123456789abcdef0123456789abcdef01',
    addedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  }
}

function npmEntry(over: Partial<RegisteredDesignSystem> = {}): RegisteredDesignSystem {
  return {
    id: '@acme/widgets',
    source: { kind: 'npm', spec: '@acme/widgets@^2' },
    package: '@acme/widgets',
    version: '2.3.0',
    framework: 'vue3',
    designSystem: '@acme/widgets',
    importPath: '@acme/widgets',
    addedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  }
}

function installedEntry(over: Partial<RegisteredDesignSystem> = {}): RegisteredDesignSystem {
  return {
    id: '@acme/design-system',
    source: { kind: 'installed', package: '@acme/design-system' },
    package: '@acme/design-system',
    version: '9.0.0',
    framework: 'vue3',
    designSystem: '@acme/design-system',
    importPath: '@acme/design-system',
    addedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  }
}

/** Minimal shape matching `promisify(execFile)`'s resolved value. */
function execFileFake(
  impl: (file: string, args?: readonly string[]) => { stdout: string; stderr: string },
): CheckDesignSystemStalenessDeps['execFile'] {
  return vi.fn(async (file: string, args?: readonly string[]) => impl(file, args)) as unknown as CheckDesignSystemStalenessDeps['execFile']
}

describe('checkDesignSystemStaleness — installed', () => {
  it('is always fresh and never calls execFile', async () => {
    const execFile = vi.fn()
    const result = await checkDesignSystemStaleness(installedEntry(), {
      execFile: execFile as unknown as CheckDesignSystemStalenessDeps['execFile'],
    })
    expect(result).toEqual({
      id: '@acme/design-system',
      state: 'fresh',
      reason: 'tracked by package version',
    })
    expect(execFile).not.toHaveBeenCalled()
  })
})

describe('checkDesignSystemStaleness — repo', () => {
  it('reports unknown (no network call) when the entry has no resolvedCommit', async () => {
    const execFile = vi.fn()
    const entry = repoEntry({ resolvedCommit: undefined })
    const result = await checkDesignSystemStaleness(entry, {
      execFile: execFile as unknown as CheckDesignSystemStalenessDeps['execFile'],
    })
    expect(result).toEqual({
      id: 'acme-ds',
      state: 'unknown',
      reason: 'no recorded commit: refresh once to record it',
    })
    expect(execFile).not.toHaveBeenCalled()
  })

  it('reports fresh when the remote sha matches resolvedCommit', async () => {
    const entry = repoEntry()
    const execFile = execFileFake(() => ({
      stdout: `${entry.resolvedCommit}\trefs/heads/main\n`,
      stderr: '',
    }))
    const result = await checkDesignSystemStaleness(entry, { execFile })
    expect(result).toEqual({
      id: 'acme-ds',
      state: 'fresh',
      current: entry.resolvedCommit,
      latest: entry.resolvedCommit,
    })
  })

  it('reports update-available when the remote sha differs, using the FULL resolvedCommit (never the version fold)', async () => {
    const entry = repoEntry()
    const newerSha = 'fedcba9876543210fedcba9876543210fedcba98'
    const execFile = execFileFake(() => ({ stdout: `${newerSha}\trefs/heads/main\n`, stderr: '' }))
    const result = await checkDesignSystemStaleness(entry, { execFile })
    expect(result).toEqual({
      id: 'acme-ds',
      state: 'update-available',
      current: entry.resolvedCommit,
      latest: newerSha,
    })
  })

  it('parses only the FIRST line of ls-remote output', async () => {
    const entry = repoEntry()
    const newerSha = 'fedcba9876543210fedcba9876543210fedcba98'
    const execFile = execFileFake(() => ({
      stdout: `${newerSha}\trefs/heads/main\nsomeothersha\trefs/tags/main\n`,
      stderr: '',
    }))
    const result = await checkDesignSystemStaleness(entry, { execFile })
    expect(result.latest).toBe(newerSha)
  })

  it('defaults the ref to HEAD when the source has none', async () => {
    const entry = repoEntry({ source: { kind: 'repo', url: 'https://github.com/acme/ds' } })
    const execFile = execFileFake((_file, args) => {
      expect(args).toEqual(['ls-remote', '--end-of-options', 'https://github.com/acme/ds', 'HEAD'])
      return { stdout: `${entry.resolvedCommit}\tHEAD\n`, stderr: '' }
    })
    const result = await checkDesignSystemStaleness(entry, { execFile })
    expect(result.state).toBe('fresh')
  })

  it('reports unknown with a reason when ls-remote fails', async () => {
    const entry = repoEntry()
    const execFile: CheckDesignSystemStalenessDeps['execFile'] = vi.fn(async () => {
      throw new Error('ssh: connect to host github.com port 22: Connection timed out')
    }) as unknown as CheckDesignSystemStalenessDeps['execFile']
    const result = await checkDesignSystemStaleness(entry, { execFile })
    expect(result.state).toBe('unknown')
    expect(result.current).toBe(entry.resolvedCommit)
    expect(result.reason).toContain('Connection timed out')
  })

  it('reports unknown when ls-remote returns no matching ref', async () => {
    const entry = repoEntry()
    const execFile = execFileFake(() => ({ stdout: '', stderr: '' }))
    const result = await checkDesignSystemStaleness(entry, { execFile })
    expect(result.state).toBe('unknown')
    expect(result.reason).toMatch(/no ref/)
  })

  it('calls git ls-remote argv-only with --end-of-options, a timeout, and sanitized env', async () => {
    const entry = repoEntry()
    const execFile = vi.fn(async () => ({
      stdout: `${entry.resolvedCommit}\trefs/heads/main\n`,
      stderr: '',
    })) as unknown as CheckDesignSystemStalenessDeps['execFile']
    await checkDesignSystemStaleness(entry, { execFile })
    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['ls-remote', '--end-of-options', 'https://github.com/acme/ds', 'main'],
      expect.objectContaining({ timeout: 10_000, env: expect.any(Object) }),
    )
    const callEnv = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2].env
    expect(callEnv.GIT_DIR).toBeUndefined()
  })

  it('reports unknown and never calls execFile for a flag-injection url (--upload-pack=…)', async () => {
    const entry = repoEntry({
      source: { kind: 'repo', url: '--upload-pack=touch /tmp/pwned', ref: 'main' },
    })
    const execFile = vi.fn()
    const result = await checkDesignSystemStaleness(entry, {
      execFile: execFile as unknown as CheckDesignSystemStalenessDeps['execFile'],
    })
    expect(result.state).toBe('unknown')
    expect(result.reason).toMatch(/invalid url/i)
    expect(execFile).not.toHaveBeenCalled()
  })

  it('reports unknown and never calls execFile for a flag-injection ref (-oProxyCommand=…)', async () => {
    const entry = repoEntry({
      source: { kind: 'repo', url: 'https://github.com/acme/ds', ref: '-oProxyCommand=x' },
    })
    const execFile = vi.fn()
    const result = await checkDesignSystemStaleness(entry, {
      execFile: execFile as unknown as CheckDesignSystemStalenessDeps['execFile'],
    })
    expect(result.state).toBe('unknown')
    expect(result.reason).toMatch(/invalid ref/i)
    expect(execFile).not.toHaveBeenCalled()
  })
})

describe('checkDesignSystemStaleness — npm', () => {
  it('reports fresh when the resolved latest matches entry.version', async () => {
    const entry = npmEntry()
    const execFile = execFileFake(() => ({ stdout: JSON.stringify('2.3.0'), stderr: '' }))
    const result = await checkDesignSystemStaleness(entry, { execFile })
    expect(result).toEqual({ id: '@acme/widgets', state: 'fresh', current: '2.3.0', latest: '2.3.0' })
  })

  it('reports update-available when the resolved latest differs', async () => {
    const entry = npmEntry()
    const execFile = execFileFake(() => ({ stdout: JSON.stringify('2.4.1'), stderr: '' }))
    const result = await checkDesignSystemStaleness(entry, { execFile })
    expect(result).toEqual({
      id: '@acme/widgets',
      state: 'update-available',
      current: '2.3.0',
      latest: '2.4.1',
    })
  })

  it('picks the numeric max when npm view returns an array of matching versions', async () => {
    const entry = npmEntry()
    const execFile = execFileFake(() => ({
      stdout: JSON.stringify(['2.3.0', '2.3.1', '2.4.1']),
      stderr: '',
    }))
    const result = await checkDesignSystemStaleness(entry, { execFile })
    expect(result.state).toBe('update-available')
    expect(result.latest).toBe('2.4.1')
  })

  it('picks the numeric max, NOT the last-published entry, when the registry array is publish-order-inverted', async () => {
    // Real registries return matches in publish-time order, not semver order
    // (e.g. next@12.2.6 was published as a backport AFTER 12.3.1 shipped).
    const entry = npmEntry({ version: '12.3.1' })
    const execFile = execFileFake(() => ({
      stdout: JSON.stringify(['12.3.1', '12.2.6']),
      stderr: '',
    }))
    const result = await checkDesignSystemStaleness(entry, { execFile })
    expect(result.state).toBe('fresh')
    expect(result.latest).toBe('12.3.1')
  })

  it('picks the highest minor even when a higher-index patch of an older minor follows it', async () => {
    const entry = npmEntry({ version: '1.9.0' })
    const execFile = execFileFake(() => ({
      stdout: JSON.stringify(['1.9.0', '2.0.0', '1.9.1']),
      stderr: '',
    }))
    const result = await checkDesignSystemStaleness(entry, { execFile })
    expect(result.state).toBe('update-available')
    expect(result.latest).toBe('2.0.0')
  })

  it('excludes a prerelease from "latest" when a stable release is also in the matched set', async () => {
    const entry = npmEntry({ version: '1.5.0' })
    const execFile = execFileFake(() => ({
      stdout: JSON.stringify(['2.0.0-beta.1', '1.5.0']),
      stderr: '',
    }))
    const result = await checkDesignSystemStaleness(entry, { execFile })
    expect(result.state).toBe('fresh')
    expect(result.latest).toBe('1.5.0')
  })

  it('re-resolves from the ORIGINAL spec, not the resolved package name', async () => {
    const entry = npmEntry({ source: { kind: 'npm', spec: '@acme/widgets@^2' } })
    const execFile = execFileFake((_file, args) => {
      expect(args).toEqual(['view', '@acme/widgets@^2', 'version', '--json'])
      return { stdout: JSON.stringify('2.3.0'), stderr: '' }
    })
    await checkDesignSystemStaleness(entry, { execFile })
  })

  it('reports unknown with a reason when npm view fails', async () => {
    const entry = npmEntry()
    const execFile: CheckDesignSystemStalenessDeps['execFile'] = vi.fn(async () => {
      throw new Error('E404 Not Found')
    }) as unknown as CheckDesignSystemStalenessDeps['execFile']
    const result = await checkDesignSystemStaleness(entry, { execFile })
    expect(result.state).toBe('unknown')
    expect(result.current).toBe('2.3.0')
    expect(result.reason).toContain('E404 Not Found')
  })

  it('reports unknown when npm view returns no matching version', async () => {
    const entry = npmEntry()
    const execFile = execFileFake(() => ({ stdout: '', stderr: '' }))
    const result = await checkDesignSystemStaleness(entry, { execFile })
    expect(result.state).toBe('unknown')
    expect(result.reason).toMatch(/no matching version/)
  })

  it('calls npm view argv-only with a timeout', async () => {
    const entry = npmEntry()
    const execFile = vi.fn(async () => ({ stdout: JSON.stringify('2.3.0'), stderr: '' })) as unknown as CheckDesignSystemStalenessDeps['execFile']
    await checkDesignSystemStaleness(entry, { execFile })
    expect(execFile).toHaveBeenCalledWith(
      'npm',
      ['view', '@acme/widgets@^2', 'version', '--json'],
      expect.objectContaining({ timeout: 10_000 }),
    )
  })

  it('reports unknown and never calls execFile for a flag-injection spec (--userconfig=…)', async () => {
    const entry = npmEntry({ source: { kind: 'npm', spec: '--userconfig=/x' } })
    const execFile = vi.fn()
    const result = await checkDesignSystemStaleness(entry, {
      execFile: execFile as unknown as CheckDesignSystemStalenessDeps['execFile'],
    })
    expect(result.state).toBe('unknown')
    expect(result.reason).toMatch(/invalid spec/i)
    expect(execFile).not.toHaveBeenCalled()
  })
})
