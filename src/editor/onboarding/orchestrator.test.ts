import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ComponentManifestSource } from '@/editor/core/manifest'
import { onboardDesignSystem, type OnboardDeps } from './orchestrator'
import type { FrameworkDetection } from './detect-framework'
import type { CoverageReport, RegisteredDesignSystem, RegistryStore } from './types'

function fakeSource(): ComponentManifestSource {
  return {
    id: 'fake',
    framework: 'vue3',
    designSystem: 'fake',
    listComponents: async () => [],
    getComponent: async () => null,
  }
}

const coverage: CoverageReport = {
  discovered: 5,
  extracted: 4,
  empty: 1,
  failedComponents: [],
  sampleProps: { UiButton: ['label'] },
}

function makeStore(): { store: RegistryStore; added: RegisteredDesignSystem[] } {
  const added: RegisteredDesignSystem[] = []
  return {
    added,
    store: {
      list: async () => added,
      add: async (e) => {
        added.push(e)
      },
      remove: async () => {},
    },
  }
}

function deps(over: Partial<OnboardDeps> = {}): { deps: OnboardDeps; added: RegisteredDesignSystem[] } {
  const { store, added } = makeStore()
  return {
    added,
    deps: {
      detectFramework: vi.fn(
        (): FrameworkDetection => ({
          framework: 'vue3',
          via: 'vue-dts',
          dtsRoot: 'dist/types/components',
        }),
      ),
      resolvePackageVersion: vi.fn(() => '9.0.0'),
      resolveTsconfig: vi.fn(async () => '/proto/tsconfig.json'),
      ingestNpm: vi.fn(async () => ({
        package: '@acme/widgets',
        version: '2.1.0',
        packageRoot: '/proto/.desde/ingested/acme-widgets/node_modules/@acme/widgets',
        tsconfigPath: '/proto/.desde/ingested/acme-widgets/tsconfig.json',
      })),
      ingestRepo: vi.fn(async () => ({
        package: '@acme/from-repo',
        version: '0.0.0',
        packageRoot: '/proto/.desde/ingested/acme-repo/repo',
        tsconfigPath: '/proto/.desde/ingested/acme-repo/repo/tsconfig.desde.json',
        commit: 'abc123def456789',
      })),
      buildSource: vi.fn(() => fakeSource()),
      computeCoverage: vi.fn(async () => coverage),
      store,
      now: () => '2026-06-10T00:00:00.000Z',
      ...over,
    },
  }
}

const req = (over = {}) => ({
  source: { kind: 'installed' as const, package: '@acme/design-system' },
  prototypeRoot: '/proto',
  ...over,
})

describe('onboardDesignSystem', () => {
  it('onboards an installed Vue package end-to-end and registers it', async () => {
    const { deps: d, added } = deps()
    const res = await onboardDesignSystem(req(), d)
    expect(res).toMatchObject({
      package: '@acme/design-system',
      version: '9.0.0',
      framework: 'vue3',
      designSystem: '@acme/design-system',
      importPath: '@acme/design-system',
      registryEntryId: '@acme/design-system',
      coverage,
    })
    // Registered with the discovered dtsRoot.
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({
      id: '@acme/design-system',
      framework: 'vue3',
      dtsRoots: ['dist/types/components'],
      addedAt: '2026-06-10T00:00:00.000Z',
    })
    // Installed (non-repo) entries do not have resolvedCommit.
    expect(added[0].resolvedCommit).toBeUndefined()
  })

  it('emits progress stages in order', async () => {
    const { deps: d } = deps()
    const stages: string[] = []
    await onboardDesignSystem(req(), d, (s) => stages.push(s))
    expect(stages).toEqual([
      'ingesting',
      'detecting',
      'extracting',
      'computing-coverage',
      'registering',
    ])
  })

  it('honors an explicit designSystem label', async () => {
    const { deps: d, added } = deps()
    const res = await onboardDesignSystem(req({ designSystem: 'acme-custom' }), d)
    expect(res.designSystem).toBe('acme-custom')
    expect(added[0].designSystem).toBe('acme-custom')
  })

  it('builds a React entry from detected entry files (made package-relative)', async () => {
    const { deps: d, added } = deps({
      detectFramework: vi.fn((): FrameworkDetection => ({ framework: 'react',
        entryFiles: ['/proto/node_modules/@radix-ui/react-switch/dist/index.d.ts'],
      })),
    })
    const res = await onboardDesignSystem(
      req({ source: { kind: 'installed', package: '@radix-ui/react-switch' } }),
      d,
    )
    expect(res.framework).toBe('react')
    expect(added[0].dtsRoots).toEqual(['dist/index.d.ts'])
  })

  it('onboards an npm spec: ingests, records the scratch packageRoot, registers', async () => {
    const { deps: d, added } = deps()
    const res = await onboardDesignSystem(
      { source: { kind: 'npm', spec: '@acme/widgets@2.1.0' }, prototypeRoot: '/proto' },
      d,
    )
    expect(d.ingestNpm).toHaveBeenCalledWith({
      spec: '@acme/widgets@2.1.0',
      scratchRoot: '/proto/.desde/ingested',
    })
    expect(res).toMatchObject({ package: '@acme/widgets', version: '2.1.0', framework: 'vue3' })
    // The ingest tsconfig (not the prototype's) anchors extraction.
    expect((d.buildSource as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe(
      '/proto/.desde/ingested/acme-widgets/tsconfig.json',
    )
    // The scratch packageRoot is persisted (prototype-relative) so serving finds it.
    expect(added[0].packageRoot).toBe(
      '.desde/ingested/acme-widgets/node_modules/@acme/widgets',
    )
    // …and the scratch tsconfig, so a cache-miss re-extraction at serve time
    // doesn't fall back to the prototype tsconfig (which can't see scratch deps).
    expect(added[0].tsconfigPath).toBe('.desde/ingested/acme-widgets/tsconfig.json')
  })

  it('does NOT persist a tsconfigPath for an installed package (uses the prototype tsconfig)', async () => {
    const { deps: d, added } = deps()
    await onboardDesignSystem(req(), d)
    expect(added[0].tsconfigPath).toBeUndefined()
    expect(added[0].packageRoot).toBeUndefined()
  })

  it('refuses npm when no ingest runner is wired', async () => {
    const { deps: d } = deps({ ingestNpm: undefined })
    await expect(
      onboardDesignSystem({ source: { kind: 'npm', spec: 'x' }, prototypeRoot: '/proto' }, d),
    ).rejects.toThrow(/not available/i)
  })

  it('onboards a repo: ingests (passing allowBuild), persists scratch root + tsconfig', async () => {
    const { deps: d, added } = deps()
    const res = await onboardDesignSystem(
      {
        source: { kind: 'repo', url: 'https://github.com/acme/ui.git', ref: 'v3' },
        prototypeRoot: '/proto',
        allowBuild: true,
      },
      d,
    )
    expect(d.ingestRepo).toHaveBeenCalledWith({
      url: 'https://github.com/acme/ui.git',
      ref: 'v3',
      subdir: undefined,
      scratchRoot: '/proto/.desde/ingested',
      allowBuild: true,
    })
    expect(res).toMatchObject({ package: '@acme/from-repo', framework: 'vue3' })
    expect(added[0].packageRoot).toBe('.desde/ingested/acme-repo/repo')
    expect(added[0].tsconfigPath).toBe(
      '.desde/ingested/acme-repo/repo/tsconfig.desde.json',
    )
    // Repo-sourced entries record the resolved commit for freshness checks.
    expect(added[0].resolvedCommit).toBe('abc123def456789')
    // …and the build consent, so a later refresh can reuse it without re-asking.
    expect(added[0].allowBuild).toBe(true)
  })

  it('persists allowBuild:false on a repo entry (consent recorded verbatim, not defaulted)', async () => {
    const { deps: d, added } = deps()
    await onboardDesignSystem(
      {
        source: { kind: 'repo', url: 'https://github.com/acme/ui.git', ref: 'v3' },
        prototypeRoot: '/proto',
        allowBuild: false,
      },
      d,
    )
    expect(added[0].allowBuild).toBe(false)
  })

  it('does NOT persist allowBuild on an installed entry (only meaningful for repo sources)', async () => {
    const { deps: d, added } = deps()
    await onboardDesignSystem(req(), d)
    expect(added[0].allowBuild).toBeUndefined()
  })

  it('refuses repo when no ingest runner is wired', async () => {
    const { deps: d } = deps({ ingestRepo: undefined })
    await expect(
      onboardDesignSystem(
        { source: { kind: 'repo', url: 'https://x/y.git' }, prototypeRoot: '/proto' },
        d,
      ),
    ).rejects.toThrow(/not available/i)
  })

  it('rejects a package name with path traversal before touching the filesystem', async () => {
    const { deps: d, added } = deps()
    await expect(
      onboardDesignSystem(
        { source: { kind: 'installed', package: '../../etc/passwd' }, prototypeRoot: '/proto' },
        d,
      ),
    ).rejects.toThrow(/invalid package name/i)
    expect(d.resolvePackageVersion).not.toHaveBeenCalled()
    expect(added).toHaveLength(0)
  })

  it('errors when the package is not installed', async () => {
    const { deps: d } = deps({ resolvePackageVersion: vi.fn(() => null) })
    await expect(onboardDesignSystem(req(), d)).rejects.toThrow(/not installed/i)
  })

  it('errors on an undetectable framework', async () => {
    const { deps: d } = deps({ detectFramework: vi.fn((): FrameworkDetection => ({ framework: 'unknown' })) })
    await expect(onboardDesignSystem(req(), d)).rejects.toThrow(/detect a supported framework/i)
  })

  it('does NOT register when source building fails', async () => {
    const { deps: d, added } = deps({ buildSource: vi.fn(() => null) })
    await expect(onboardDesignSystem(req(), d)).rejects.toThrow(/manifest source/i)
    expect(added).toHaveLength(0)
  })
})

/**
 * An npm install or a git clone lands under `<prototypeRoot>/.desde/ingested`.
 * The prototype repo is untrusted input, so it can ship `.desde` as a symlink,
 * and a package tree written through that link lands outside the working tree.
 * See `src/editor/worktree/desde-dir.ts`.
 */
describe('a .desde that is a symlink', () => {
  it('refuses to ingest, and never starts the install', async () => {
    const base = mkdtempSync(join(tmpdir(), 'onboard-symlink-'))
    try {
      const prototypeRoot = join(base, 'proto')
      const target = join(base, 'target')
      mkdirSync(prototypeRoot, { recursive: true })
      mkdirSync(target, { recursive: true })
      symlinkSync(target, join(prototypeRoot, '.desde'))
      const { deps: d } = deps()
      await expect(
        onboardDesignSystem({ source: { kind: 'npm', spec: 'x' }, prototypeRoot }, d),
      ).rejects.toThrow(/\.desde is a symbolic link/)
      expect(d.ingestNpm).not.toHaveBeenCalled()
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
