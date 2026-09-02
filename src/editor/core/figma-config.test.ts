/**
 * Tests for the Figma config loader + the pure `interpolateEnv`
 * helper. Drives a real temp config file because the loader reads
 * from disk.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_FIGMA_READ_PREFIXES,
  interpolateEnv,
  loadFigmaConfig,
} from './figma-config'

describe('loadFigmaConfig', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pt-fc-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function writeConfig(obj: unknown): Promise<void> {
    await writeFile(
      join(root, 'desde.config.json'),
      JSON.stringify(obj),
      'utf8',
    )
  }

  it('returns null config when no config file exists', async () => {
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config).toBeNull()
    expect(r.warnings).toEqual([])
  })

  it('returns null config when config has no figma block', async () => {
    await writeConfig({ readRoots: {} })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config).toBeNull()
  })

  it('returns null config when figma.enabled is false', async () => {
    await writeConfig({
      figma: { enabled: false, mcpServer: { command: 'whatever' } },
    })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config).toBeNull()
  })

  it('rejects malformed JSON', async () => {
    await writeFile(
      join(root, 'desde.config.json'),
      '{not json',
      'utf8',
    )
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/desde.config.json/)
  })

  it('errors when figma is not an object', async () => {
    await writeConfig({ figma: 'enabled' })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/"figma" must be an object/)
  })

  it('errors when figma.enabled is missing', async () => {
    await writeConfig({ figma: { mcpServer: { command: 'x' } } })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/"figma.enabled" is required/)
  })

  it('errors when figma.enabled is not a boolean', async () => {
    await writeConfig({ figma: { enabled: 'yes', mcpServer: { command: 'x' } } })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/"figma.enabled" must be a boolean/)
  })

  it('errors when enabled is true but mcpServer is missing', async () => {
    await writeConfig({ figma: { enabled: true } })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/"figma.mcpServer" is required/)
  })

  it('parses a minimal valid config', async () => {
    await writeConfig({
      figma: { enabled: true, mcpServer: { command: 'npx' } },
    })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config).toEqual({
      mcpServer: { type: 'stdio', command: 'npx' },
      allowedToolPrefixes: DEFAULT_FIGMA_READ_PREFIXES,
    })
  })

  it('parses a full config with args, env, alwaysLoad', async () => {
    await writeConfig({
      figma: {
        enabled: true,
        mcpServer: {
          command: 'npx',
          args: ['-y', 'figma-developer-mcp', '--stdio'],
          env: { FIGMA_API_KEY: '${FIGMA_TOKEN}' },
          alwaysLoad: true,
        },
      },
    })
    const r = await loadFigmaConfig({
      worktreeRoot: root,
      env: { FIGMA_TOKEN: 'figd_abc123' },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config).toEqual({
      mcpServer: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'figma-developer-mcp', '--stdio'],
        env: { FIGMA_API_KEY: 'figd_abc123' },
        alwaysLoad: true,
      },
      allowedToolPrefixes: DEFAULT_FIGMA_READ_PREFIXES,
    })
    // alwaysLoad: true should also surface a perf warning.
    expect(r.warnings.some((w) => w.includes('alwaysLoad'))).toBe(true)
  })

  it('interpolates env vars inside args', async () => {
    await writeConfig({
      figma: {
        enabled: true,
        mcpServer: { command: 'npx', args: ['--file', '${FIGMA_FILE_ID}'] },
      },
    })
    const r = await loadFigmaConfig({
      worktreeRoot: root,
      env: { FIGMA_FILE_ID: 'abc123' },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config?.mcpServer.args).toEqual(['--file', 'abc123'])
  })

  it('errors when an env var is unset', async () => {
    await writeConfig({
      figma: {
        enabled: true,
        mcpServer: {
          command: 'npx',
          env: { FIGMA_API_KEY: '${FIGMA_TOKEN}' },
        },
      },
    })
    const r = await loadFigmaConfig({ worktreeRoot: root, env: {} })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/FIGMA_TOKEN/)
    expect(r.errors[0]).toMatch(/env\.FIGMA_API_KEY/)
  })

  it('reports multiple missing env vars in a single value', async () => {
    await writeConfig({
      figma: {
        enabled: true,
        mcpServer: {
          command: 'npx',
          env: { COMBO: '${A}-${B}' },
        },
      },
    })
    const r = await loadFigmaConfig({ worktreeRoot: root, env: {} })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/\$A.*\$B/)
  })

  it('rejects shell metacharacters in command', async () => {
    await writeConfig({
      figma: {
        enabled: true,
        mcpServer: { command: 'npx; rm -rf /' },
      },
    })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/shell metacharacters/)
  })

  it('rejects non-string command', async () => {
    await writeConfig({
      figma: {
        enabled: true,
        mcpServer: { command: 42 },
      },
    })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/non-empty string/)
  })

  it('rejects non-stdio type', async () => {
    await writeConfig({
      figma: {
        enabled: true,
        mcpServer: { type: 'http', command: 'npx' },
      },
    })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/must be "stdio"/)
  })

  it('rejects non-array args', async () => {
    await writeConfig({
      figma: {
        enabled: true,
        mcpServer: { command: 'npx', args: 'not-an-array' },
      },
    })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/\.args" must be an array/)
  })

  it('rejects non-string arg entries', async () => {
    await writeConfig({
      figma: {
        enabled: true,
        mcpServer: { command: 'npx', args: ['ok', 42] },
      },
    })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/args\[1\]/)
  })

  it('rejects env that is an array', async () => {
    await writeConfig({
      figma: {
        enabled: true,
        mcpServer: { command: 'npx', env: ['FOO=bar'] },
      },
    })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/env" must be an object/)
  })

  it('rejects non-string env value', async () => {
    await writeConfig({
      figma: {
        enabled: true,
        mcpServer: { command: 'npx', env: { FOO: 42 } },
      },
    })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/env\.FOO" must be a string/)
  })

  it('warns when env value is a literal (no ${} reference)', async () => {
    await writeConfig({
      figma: {
        enabled: true,
        mcpServer: {
          command: 'npx',
          env: { FIGMA_API_KEY: 'figd_literal_token' },
        },
      },
    })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/literal string/)
    expect(r.warnings[0]).toMatch(/FIGMA_API_KEY/)
    // The literal value still flows through unchanged.
    expect(r.config?.mcpServer.env?.FIGMA_API_KEY).toBe('figd_literal_token')
  })

  it('rejects non-boolean alwaysLoad', async () => {
    await writeConfig({
      figma: {
        enabled: true,
        mcpServer: { command: 'npx', alwaysLoad: 'yes' },
      },
    })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/alwaysLoad" must be a boolean/)
  })

  it('omits optional fields from the result when absent', async () => {
    await writeConfig({
      figma: { enabled: true, mcpServer: { command: 'npx' } },
    })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const s = r.config?.mcpServer
    expect(s).toBeDefined()
    if (!s) return
    expect('args' in s).toBe(false)
    expect('env' in s).toBe(false)
    expect('alwaysLoad' in s).toBe(false)
  })

  it('treats figma: null the same as figma absent', async () => {
    await writeConfig({ figma: null })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/"figma" must be an object/)
  })

  it('errors when mcpServer is explicitly null', async () => {
    await writeConfig({ figma: { enabled: true, mcpServer: null } })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/"figma.mcpServer" is required/)
  })

  it('rejects control characters in command', async () => {
    await writeConfig({
      figma: { enabled: true, mcpServer: { command: 'npx\x00' } },
    })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/control characters/)
  })

  it('rejects control characters in an interpolated arg', async () => {
    await writeConfig({
      figma: {
        enabled: true,
        mcpServer: { command: 'npx', args: ['${VAL}'] },
      },
    })
    const r = await loadFigmaConfig({
      worktreeRoot: root,
      env: { VAL: 'before\x00after' },
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/args\[0\].*control characters/)
  })

  it('rejects control characters in an interpolated env value', async () => {
    await writeConfig({
      figma: {
        enabled: true,
        mcpServer: { command: 'npx', env: { TOKEN: '${SECRET}' } },
      },
    })
    const r = await loadFigmaConfig({
      worktreeRoot: root,
      env: { SECRET: 'has\x07bell' },
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/env\.TOKEN.*control characters/)
  })

  it('accepts a custom allowedToolPrefixes list', async () => {
    await writeConfig({
      figma: {
        enabled: true,
        mcpServer: { command: 'npx' },
        allowedToolPrefixes: ['query_', 'inspect_'],
      },
    })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config?.allowedToolPrefixes).toEqual(['query_', 'inspect_'])
  })

  it('rejects an empty allowedToolPrefixes list (disabling Figma the wrong way)', async () => {
    await writeConfig({
      figma: {
        enabled: true,
        mcpServer: { command: 'npx' },
        allowedToolPrefixes: [],
      },
    })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/cannot be empty/)
  })

  it('rejects non-array allowedToolPrefixes', async () => {
    await writeConfig({
      figma: {
        enabled: true,
        mcpServer: { command: 'npx' },
        allowedToolPrefixes: 'get_',
      },
    })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/allowedToolPrefixes" must be an array/)
  })

  it('rejects non-string entries in allowedToolPrefixes', async () => {
    await writeConfig({
      figma: {
        enabled: true,
        mcpServer: { command: 'npx' },
        allowedToolPrefixes: ['get_', 42],
      },
    })
    const r = await loadFigmaConfig({ worktreeRoot: root })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/allowedToolPrefixes\[1\]/)
  })

  it('does not interpolate bare $VAR references (only ${VAR})', async () => {
    await writeConfig({
      figma: {
        enabled: true,
        mcpServer: {
          command: 'npx',
          // No ${}; treated as a literal path. Should warn (literal),
          // not interpolate.
          env: { PATH_LIKE: '/usr/bin:$HOME/bin' },
        },
      },
    })
    const r = await loadFigmaConfig({
      worktreeRoot: root,
      env: { HOME: '/home/user' },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config?.mcpServer.env?.PATH_LIKE).toBe('/usr/bin:$HOME/bin')
  })
})

describe('interpolateEnv', () => {
  it('returns the value unchanged when no ${} references exist', () => {
    const r = interpolateEnv('hello world', { FOO: 'bar' })
    expect(r).toEqual({ ok: true, value: 'hello world' })
  })

  it('substitutes a single ${VAR} reference', () => {
    const r = interpolateEnv('token=${FIGMA_KEY}', { FIGMA_KEY: 'abc' })
    expect(r).toEqual({ ok: true, value: 'token=abc' })
  })

  it('substitutes multiple references including repeats', () => {
    const r = interpolateEnv('${A}-${B}-${A}', { A: 'x', B: 'y' })
    expect(r).toEqual({ ok: true, value: 'x-y-x' })
  })

  it('reports each missing var once, sorted', () => {
    const r = interpolateEnv('${B}-${A}-${B}', {})
    expect(r).toEqual({ ok: false, missing: ['A', 'B'] })
  })

  it('treats empty-string env values as present (not missing)', () => {
    const r = interpolateEnv('val=[${EMPTY}]', { EMPTY: '' })
    expect(r).toEqual({ ok: true, value: 'val=[]' })
  })

  it('does not substitute bare $VAR (only the ${VAR} form)', () => {
    const r = interpolateEnv('$HOME/bin', { HOME: '/home/user' })
    expect(r).toEqual({ ok: true, value: '$HOME/bin' })
  })
})
