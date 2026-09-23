import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_CATALOG,
  computeEnabledCapabilityIds,
  describeDisabledCapabilities,
  detectCapabilityGaps,
  findCapability,
  runtimeSupportsCapability,
} from './capability-catalog'

const NONE = { enabledExtensionIds: [], webFetchAllowedHosts: [], webSearchEnabled: false }

describe('catalog shape', () => {
  it('gives every entry a unique id', () => {
    const ids = CAPABILITY_CATALOG.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every mcp-extension entry a concrete server spec', () => {
    // The enable route accepts an id and NOTHING else, so the spec has to come
    // from here or there is nothing to write.
    for (const c of CAPABILITY_CATALOG) {
      if (c.target === 'mcp-extension') {
        expect(c.mcpServer?.command, `${c.id} needs a command`).toBeTruthy()
      }
    }
  })

  it('writes env values as UNinterpolated ${VAR} references', () => {
    // A literal secret here would end up committed in the user's repo.
    for (const c of CAPABILITY_CATALOG) {
      for (const value of Object.values(c.mcpServer?.env ?? {})) {
        expect(value).toMatch(/^\$\{[A-Z0-9_]+\}$/)
      }
    }
  })

  it('names the env var whenever the server spec references one', () => {
    for (const c of CAPABILITY_CATALOG) {
      const refs = Object.values(c.mcpServer?.env ?? {})
      if (refs.length > 0) {
        expect(c.requiresEnv, `${c.id} must declare requiresEnv`).toBeTruthy()
      }
    }
  })
})

describe('computeEnabledCapabilityIds', () => {
  it('reports nothing enabled on a bare prototype', () => {
    expect([...computeEnabledCapabilityIds(NONE)]).toEqual([])
  })

  it('counts an mcp extension as enabled when it is registered', () => {
    const on = computeEnabledCapabilityIds({ ...NONE, enabledExtensionIds: ['figma'] })
    expect(on.has('figma')).toBe(true)
  })

  it('counts web-search from the policy flag', () => {
    expect(computeEnabledCapabilityIds({ ...NONE, webSearchEnabled: true }).has('web-search')).toBe(
      true,
    )
  })

  it('ignores an extension that is not in the catalog', () => {
    const on = computeEnabledCapabilityIds({ ...NONE, enabledExtensionIds: ['some-custom-thing'] })
    expect([...on]).toEqual([])
  })

  it('reports Figma as on for the neutral lane, which connects MCP servers itself', () => {
    // The neutral lane spawns `.mcp.json` servers through its own stdio
    // client (`agent-chat-neutral/mcp-client-tools.ts`), under the same
    // `mcp__figma__*` names the SDK lane registers.
    const on = computeEnabledCapabilityIds({
      ...NONE,
      enabledExtensionIds: ['figma'],
      chatRuntime: 'neutral',
    })
    expect(on.has('figma')).toBe(true)
  })

  it('reports web search OFF on the neutral lane when the provider serves no server tools', () => {
    const on = computeEnabledCapabilityIds({
      ...NONE,
      webSearchEnabled: true,
      chatRuntime: 'neutral',
      serverToolIds: [],
    })
    expect(on.has('web-search')).toBe(false)
    const withSearch = computeEnabledCapabilityIds({
      ...NONE,
      webSearchEnabled: true,
      chatRuntime: 'neutral',
      serverToolIds: ['web_search'],
    })
    expect(withSearch.has('web-search')).toBe(true)
  })

  it('reports web search as on for the neutral lane, which declares it as a provider server tool', () => {
    const on = computeEnabledCapabilityIds({
      ...NONE,
      webSearchEnabled: true,
      chatRuntime: 'neutral',
    })
    expect(on.has('web-search')).toBe(true)
  })

  it('is unchanged on the SDK lane, which does register them', () => {
    const on = computeEnabledCapabilityIds({
      ...NONE,
      enabledExtensionIds: ['figma'],
      chatRuntime: 'claude-agent-sdk',
    })
    expect(on.has('figma')).toBe(true)
  })
})

describe('runtimeSupportsCapability', () => {
  it('serves every entry on both lanes', () => {
    for (const c of CAPABILITY_CATALOG) {
      expect(runtimeSupportsCapability(c, 'claude-agent-sdk'), c.id).toBe(true)
      expect(runtimeSupportsCapability(c, 'neutral'), c.id).toBe(true)
    }
  })

  it('makes every entry state its runtimes rather than defaulting', () => {
    for (const c of CAPABILITY_CATALOG) {
      expect(c.runtimes.length, `${c.id} must name its runtimes`).toBeGreaterThan(0)
    }
  })
})

describe('detectCapabilityGaps', () => {
  it('flags a pasted Figma URL', () => {
    const gaps = detectCapabilityGaps(
      'recreate this: https://figma.com/file/abc123/Checkout?node-id=1-2',
      new Set(),
    )
    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.capabilityId).toBe('figma')
    expect(gaps[0]!.detail).toContain('figma.com/file/abc123')
  })

  it('matches www and http variants', () => {
    expect(detectCapabilityGaps('see http://www.figma.com/design/x', new Set())).toHaveLength(1)
  })

  it('does NOT fire on the bare word figma — keyword matching is a false-positive engine', () => {
    expect(detectCapabilityGaps('match our figma mockups please', new Set())).toEqual([])
    expect(detectCapabilityGaps('the design in Figma', new Set())).toEqual([])
  })

  it('stays silent when the capability is already enabled', () => {
    expect(
      detectCapabilityGaps('https://figma.com/file/abc', new Set(['figma'])),
    ).toEqual([])
  })

  it('stays silent when the user dismissed it', () => {
    expect(
      detectCapabilityGaps('https://figma.com/file/abc', new Set(), new Set(['figma'])),
    ).toEqual([])
  })

  it('returns nothing for an ordinary message', () => {
    expect(detectCapabilityGaps('make the button blue', new Set())).toEqual([])
  })
})

describe('describeDisabledCapabilities', () => {
  it('returns null when everything is on, so the prompt is unchanged', () => {
    const all = new Set(CAPABILITY_CATALOG.map((c) => c.id))
    expect(describeDisabledCapabilities(all)).toBeNull()
  })

  it('names each disabled capability and points at the panel', () => {
    const block = describeDisabledCapabilities(new Set())!
    expect(block).toContain('Figma')
    expect(block).toContain('Extensions panel')
  })

  it('tells the model it has no tool to try — the reason it would fail blindly', () => {
    const block = describeDisabledCapabilities(new Set())!
    expect(block).toMatch(/NOT in your tool list/i)
  })

  it('tells the model not to edit config itself', () => {
    // It is denied at the permission layer anyway; saying so avoids a wasted
    // turn spent attempting it.
    expect(describeDisabledCapabilities(new Set())!).toMatch(/denied write access/i)
  })

  it('omits capabilities that are already on', () => {
    const block = describeDisabledCapabilities(new Set(['figma']))
    expect(block).not.toContain('**Figma**')
  })

  it('lists Figma and web search on the neutral lane under available-but-OFF, with no cannot-be-used section', () => {
    const block = describeDisabledCapabilities(new Set(), 'neutral')!
    expect(block).toContain('**Figma**')
    expect(block).toContain('**Web search**')
    expect(block).toContain('Extensions panel')
    expect(block).not.toMatch(/cannot be used with the model/i)
  })

  it('moves web search under cannot-be-used when the provider serves no server tools, leaving Figma enableable', () => {
    const block = describeDisabledCapabilities(new Set(), 'neutral', [])!
    const [enableable, unavailable] = block.split(/cannot be used with the model/i)
    expect(enableable).not.toContain('**Web search**')
    expect(enableable).toContain('**Figma**')
    expect(unavailable).toContain('**Web search**')
    expect(unavailable).not.toContain('**Figma**')
  })

  it('names no vendor in the unavailable remedy', () => {
    const block = describeDisabledCapabilities(new Set(), 'neutral', [])!
    expect(block).not.toMatch(/Claude/)
    // The prompt wraps at ~76 columns, so the phrase is read with line breaks folded.
    expect(block.replace(/\s+/g, ' ')).toContain('a model from a provider that offers them')
  })

  it('keeps the panel wording on the SDK lane', () => {
    const block = describeDisabledCapabilities(new Set(), 'claude-agent-sdk')!
    expect(block).toContain('Extensions panel')
  })
})

describe('findCapability', () => {
  it('finds a known id and rejects an unknown one', () => {
    expect(findCapability('figma')?.label).toBe('Figma')
    expect(findCapability('definitely-not-real')).toBeUndefined()
  })
})

describe('legacy figma config counts as enabled', () => {
  it('a legacy `figma` block loads as an extension, so it is not reported as a gap', async () => {
    // Regression guard: a review round claimed the legacy path was invisible
    // to the capability state. It is not — loadExtensions reads that block —
    // and treating it as disabled would raise a gap banner offering to enable
    // something already on, then write a duplicate .mcp.json entry.
    const { promises: fs } = await import('node:fs')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { loadExtensions } = await import('./extensions-config')

    const dir = await mkdtemp(join(tmpdir(), 'pt-legacy-'))
    try {
      await fs.writeFile(
        join(dir, 'desde.config.json'),
        JSON.stringify({ figma: { enabled: true, mcpServer: { command: 'npx' } } }),
      )
      const loaded = await loadExtensions({ worktreeRoot: dir, env: {} })
      expect(loaded.ok && loaded.extensions.map((e) => e.id)).toEqual(['figma'])

      const enabled = computeEnabledCapabilityIds({
        enabledExtensionIds: loaded.ok ? loaded.extensions.map((e) => e.id) : [],
        webFetchAllowedHosts: [],
        webSearchEnabled: false,
      })
      expect(enabled.has('figma')).toBe(true)
      expect(detectCapabilityGaps('https://figma.com/file/abc', enabled)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

