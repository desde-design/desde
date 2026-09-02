/**
 * Tests for `repairComponent` (Phase 5 Task 4 — granular manifest repair).
 * Every dependency is a hand-rolled fake — no real fs, no real TS
 * checker/program — per the task's "TDD with injected deps (no real TS
 * program in unit tests)" constraint. `createDefaultRepairDeps` (the real
 * production wiring) is exercised only for its shape/no-throw behavior,
 * not for a real extraction.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ComponentManifest } from '../core'
import type { VueDtsComponent } from '../adapters/vue-dts-meta'
import type { RegisteredDesignSystem } from '../onboarding/types'
import { registeredCacheName } from '../onboarding/build-registered-sources'
import { sanitize } from '../adapters/cached'
import { createDefaultRepairDeps, repairComponent, type RepairDeps } from './repair-component'

function registeredEntry(overrides: Partial<RegisteredDesignSystem> = {}): RegisteredDesignSystem {
  return {
    id: 'acme-ds-attached',
    source: { kind: 'installed', package: '@acme/design-system' },
    package: '@acme/design-system',
    version: '9.0.0',
    framework: 'vue3',
    designSystem: 'acme-ds',
    importPath: '@acme/design-system',
    addedAt: '2026-07-29T00:00:00.000Z',
    ...overrides,
  }
}

function manifest(props: Array<{ name: string }> = [{ name: 'appearance' }]): ComponentManifest {
  return {
    id: 'acme-ds:UiButton',
    name: 'UiButton',
    framework: 'vue3',
    designSystem: 'acme-ds',
    importPath: '@acme/design-system',
    props: props as ComponentManifest['props'],
  }
}

interface FakeOverrides {
  reextractVue?: RepairDeps['reextractVue']
  reextractReact?: RepairDeps['reextractReact']
  patchCache?: RepairDeps['patchCache']
  readCache?: RepairDeps['readCache']
  invalidate?: RepairDeps['invalidate']
  findRegisteredEntry?: RepairDeps['findRegisteredEntry']
  discoverVueDtsComponents?: RepairDeps['discoverVueDtsComponents']
  discoverReactDtsEntries?: RepairDeps['discoverReactDtsEntries']
  resolveTsconfigPath?: RepairDeps['resolveTsconfigPath']
  resolvePackageVersion?: RepairDeps['resolvePackageVersion']
  fingerprintFile?: RepairDeps['fingerprintFile']
}

function fakeDeps(overrides: FakeOverrides = {}): RepairDeps {
  const declaredComponents: VueDtsComponent[] = [
    { componentName: 'UiButton', declarationFile: '/proto/node_modules/@acme/design-system/dist/types/components/UiButton/UiButton.vue.d.ts' },
  ]
  return {
    reextractVue: overrides.reextractVue ?? (async () => manifest()),
    reextractReact: overrides.reextractReact ?? (async () => manifest()),
    patchCache: overrides.patchCache ?? vi.fn(() => true),
    readCache: overrides.readCache ?? vi.fn(() => null),
    invalidate: overrides.invalidate ?? vi.fn(),
    // Default: package is only auto-scanned, never explicitly registered —
    // matches every pre-existing test's assumption of the auto-scan cache key.
    findRegisteredEntry: overrides.findRegisteredEntry ?? (async () => null),
    discoverVueDtsComponents: overrides.discoverVueDtsComponents ?? (async () => declaredComponents),
    // Default: no React entry resolvable — matches every pre-existing (Vue)
    // test's assumption that Vue discovery already found the component.
    discoverReactDtsEntries: overrides.discoverReactDtsEntries ?? (() => []),
    resolveTsconfigPath: overrides.resolveTsconfigPath ?? (async () => '/proto/tsconfig.json'),
    resolvePackageVersion: overrides.resolvePackageVersion ?? (() => '9.0.0'),
    fingerprintFile: overrides.fingerprintFile ?? (() => 'tsconfig-hash'),
  }
}

function call(deps: RepairDeps, overrides: Partial<Parameters<typeof repairComponent>[0]> = {}) {
  return repairComponent({
    entryKey: 'UiButton::@acme/design-system',
    component: 'UiButton',
    importPath: '@acme/design-system',
    designSystem: 'acme-ds',
    prototypeRoot: '/proto',
    deps,
    ...overrides,
  })
}

describe('repairComponent', () => {
  it('repairs when the re-extracted manifest differs from what is cached', async () => {
    const deps = fakeDeps({
      readCache: vi.fn(() => manifest([{ name: 'old-only-prop' }])),
      reextractVue: async () => manifest([{ name: 'appearance' }, { name: 'size' }]),
    })

    const result = await call(deps)

    expect(result).toEqual({ outcome: 'repaired' })
    expect(deps.patchCache).toHaveBeenCalledTimes(1)
    const [cacheFile, patchedManifest] = (deps.patchCache as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(cacheFile).toContain('.desde/manifests')
    expect(cacheFile).toContain('acme-design-system') // sanitized importPath
    expect(cacheFile).toContain('9.0.0')
    expect(patchedManifest.props).toEqual([{ name: 'appearance' }, { name: 'size' }])
    expect(deps.invalidate).toHaveBeenCalledWith('UiButton', '@acme/design-system')
  })

  it('repairs a REGISTERED entry using registeredCacheName, not the auto-scan key (Task 5 carry-forward fix)', async () => {
    const entry = registeredEntry()
    const deps = fakeDeps({
      findRegisteredEntry: async () => entry,
      readCache: vi.fn(() => manifest([{ name: 'old-only-prop' }])),
      reextractVue: async () => manifest([{ name: 'appearance' }, { name: 'size' }]),
    })

    const result = await call(deps)

    expect(result).toEqual({ outcome: 'repaired' })
    expect(deps.patchCache).toHaveBeenCalledTimes(1)
    const [cacheFile] = (deps.patchCache as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(cacheFile).toContain(sanitize(registeredCacheName(entry)))
    expect(cacheFile).not.toContain('acme-design-system@9.0.0') // not the auto-scan key
    expect(deps.invalidate).toHaveBeenCalledWith('UiButton', '@acme/design-system')
  })

  it('passes the registered entry dtsRoots into discovery, finding a component under a non-default declarations layout (codex P2, 2026-07-30)', async () => {
    const entry = registeredEntry({ dtsRoots: ['dist/custom-types'] })
    const discoverSpy = vi.fn(async () => [
      {
        componentName: 'UiButton',
        declarationFile: '/proto/node_modules/@acme/design-system/dist/custom-types/UiButton.vue.d.ts',
      },
    ])
    const deps = fakeDeps({
      findRegisteredEntry: async () => entry,
      discoverVueDtsComponents: discoverSpy,
      readCache: vi.fn(() => manifest([{ name: 'old-only-prop' }])),
      reextractVue: async () => manifest([{ name: 'appearance' }, { name: 'size' }]),
    })

    const result = await call(deps)

    expect(result).toEqual({ outcome: 'repaired' })
    expect(discoverSpy).toHaveBeenCalledWith(expect.stringContaining('@acme/design-system'), {
      dtsRoots: ['dist/custom-types'],
    })
  })

  it('passes dtsRoots: undefined into discovery for an auto-scan entry (unchanged default probe order)', async () => {
    const discoverSpy = vi.fn(async () => [
      {
        componentName: 'UiButton',
        declarationFile:
          '/proto/node_modules/@acme/design-system/dist/types/components/UiButton/UiButton.vue.d.ts',
      },
    ])
    const deps = fakeDeps({ discoverVueDtsComponents: discoverSpy })

    const result = await call(deps)

    expect(result.outcome).toBe('seeded')
    expect(discoverSpy).toHaveBeenCalledWith(expect.stringContaining('@acme/design-system'), {
      dtsRoots: undefined,
    })
  })

  // --- Carry-forward B (closed 2026-07-30): ingested (npm/repo) registered entries ---

  it('repairs an ingested REGISTERED entry, resolving packageRoot under .desde/ingested/… and using entry.version for cache identity', async () => {
    const entry = registeredEntry({
      packageRoot: '.desde/ingested/acme-ds',
      version: 'scratch-abc1234',
    })
    const discoverSpy = vi.fn(async () => [
      {
        componentName: 'UiButton',
        declarationFile: '/proto/.desde/ingested/acme-ds/dist/types/UiButton.vue.d.ts',
      },
    ])
    const versionSpy = vi.fn(() => 'should-not-be-called')
    const deps = fakeDeps({
      findRegisteredEntry: async () => entry,
      discoverVueDtsComponents: discoverSpy,
      resolvePackageVersion: versionSpy,
      readCache: vi.fn(() => manifest([{ name: 'old-only-prop' }])),
      reextractVue: async () => manifest([{ name: 'appearance' }, { name: 'size' }]),
    })

    const result = await call(deps)

    expect(result.outcome).toBe('repaired')
    // Discovery ran under the resolved ingested root, not node_modules.
    expect(discoverSpy).toHaveBeenCalledWith(
      '/proto/.desde/ingested/acme-ds',
      { dtsRoots: entry.dtsRoots },
    )
    // The installed-package version resolver is never consulted for an
    // ingested entry — the onboard-time entry.version is the cache identity.
    expect(versionSpy).not.toHaveBeenCalled()
    const [cacheFile] = (deps.patchCache as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(cacheFile).toContain('scratch-abc1234')
    expect(cacheFile).toContain(sanitize(registeredCacheName(entry)))
  })

  it('resolves an ingested entry\'s own tsconfigPath override (scratch install tsconfig), not the prototype tsconfig', async () => {
    const entry = registeredEntry({
      packageRoot: '.desde/ingested/acme-ds',
      tsconfigPath: '.desde/ingested/acme-ds/tsconfig.json',
      version: 'scratch-abc1234',
    })
    let seenTsconfig = ''
    const deps = fakeDeps({
      findRegisteredEntry: async () => entry,
      readCache: vi.fn(() => null),
      reextractVue: async (a) => {
        seenTsconfig = a.tsconfigPath
        return manifest()
      },
    })

    const result = await call(deps)

    expect(result.outcome).toBe('seeded')
    expect(seenTsconfig).toBe('/proto/.desde/ingested/acme-ds/tsconfig.json')
  })

  it('fails when an ingested entry\'s packageRoot escapes the prototype root (containment guard)', async () => {
    const deps = fakeDeps({
      findRegisteredEntry: async () => registeredEntry({ packageRoot: '../../../../etc/passwd' }),
    })

    const result = await call(deps)

    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/packageRoot escapes the prototype root/i)
    expect(deps.patchCache).not.toHaveBeenCalled()
  })

  it('fails when an ingested entry\'s tsconfigPath escapes the prototype root (containment guard)', async () => {
    const deps = fakeDeps({
      findRegisteredEntry: async () =>
        registeredEntry({
          packageRoot: '.desde/ingested/acme-ds',
          tsconfigPath: '../../../../etc/passwd',
        }),
    })

    const result = await call(deps)

    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/tsconfigPath escapes the prototype root/i)
    expect(deps.patchCache).not.toHaveBeenCalled()
  })

  // --- Carry-forward A (closed 2026-07-30): React auto-repair ---

  it('repairs a REGISTERED React entry via the whole-entry reextractReact path, patching only the drifted component', async () => {
    const entry = registeredEntry({ framework: 'react', package: '@acme/react-ui', importPath: '@acme/react-ui' })
    const reactManifest = manifest([{ name: 'variant' }])
    let seenEntryFiles: string[] = []
    const deps = fakeDeps({
      findRegisteredEntry: async () => entry,
      readCache: vi.fn(() => manifest([{ name: 'old-only-prop' }])),
      reextractReact: async (a) => {
        seenEntryFiles = a.entryFiles
        return reactManifest
      },
      discoverReactDtsEntries: () => ['/proto/node_modules/@acme/react-ui/dist/index.d.ts'],
    })

    const result = await call(deps, { component: 'UiButton', importPath: '@acme/react-ui', designSystem: undefined })

    expect(result.outcome).toBe('repaired')
    expect(seenEntryFiles).toEqual(['/proto/node_modules/@acme/react-ui/dist/index.d.ts'])
    expect(deps.patchCache).toHaveBeenCalledTimes(1)
    const [, patchedManifest] = (deps.patchCache as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(patchedManifest).toBe(reactManifest)
  })

  it('resolves a REGISTERED React entry\'s dtsRoots override as explicit entry FILES, not directories', async () => {
    const entry = registeredEntry({
      framework: 'react',
      package: '@acme/react-ui',
      importPath: '@acme/react-ui',
      dtsRoots: ['dist/custom-entry.d.ts', 'dist/ignored-dir'],
    })
    const discoverReactSpy = vi.fn(() => ['/should-not-be-used.d.ts'])
    let seenEntryFiles: string[] = []
    const deps = fakeDeps({
      findRegisteredEntry: async () => entry,
      discoverReactDtsEntries: discoverReactSpy,
      reextractReact: async (a) => {
        seenEntryFiles = a.entryFiles
        return manifest()
      },
    })

    const result = await call(deps, { importPath: '@acme/react-ui' })

    expect(result.outcome).toBe('seeded')
    expect(seenEntryFiles).toEqual(['/proto/node_modules/@acme/react-ui/dist/custom-entry.d.ts'])
    expect(discoverReactSpy).not.toHaveBeenCalled()
  })

  it('reports unsupported for a REGISTERED React entry with no resolvable .d.ts entry', async () => {
    const entry = registeredEntry({ framework: 'react', package: '@acme/react-ui', importPath: '@acme/react-ui' })
    const deps = fakeDeps({
      findRegisteredEntry: async () => entry,
      discoverReactDtsEntries: () => [],
    })

    const result = await call(deps, { importPath: '@acme/react-ui' })

    expect(result.outcome).toBe('unsupported')
    expect(result.reason).toMatch(/no resolvable React \.d\.ts entry/i)
    expect(deps.patchCache).not.toHaveBeenCalled()
  })

  it('repairs an auto-scanned (unregistered) React entry, falling back to React discovery only after Vue discovery finds nothing', async () => {
    const reactManifest = manifest([{ name: 'onCheckedChange' }])
    const deps = fakeDeps({
      discoverVueDtsComponents: async () => [], // no *.vue.d.ts under this package
      discoverReactDtsEntries: () => ['/proto/node_modules/react-lib/dist/index.d.ts'],
      readCache: vi.fn(() => null),
      reextractReact: async () => reactManifest,
    })

    const result = await call(deps, { importPath: 'react-lib', designSystem: undefined })

    expect(result.outcome).toBe('seeded')
    const [, patchedManifest] = (deps.patchCache as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(patchedManifest).toBe(reactManifest)
  })

  it('repairs a React component in a mixed-framework auto-scanned package by preferring the cached manifest\'s framework over the package-wide Vue probe (codex review, 2026-07-30)', async () => {
    // The package ships BOTH Vue and React components — Vue discovery finds
    // a sibling Vue component, so `discovered.length > 0` package-wide, even
    // though the SPECIFIC drifted component ("ReactButton") is a React
    // export. Before the fix this package-wide signal alone committed the
    // dispatch to Vue, the `vueTarget` lookup for "ReactButton" failed, and
    // repair reported `failed` — never reaching the React fallback for this
    // component.
    const vueDiscovered: VueDtsComponent[] = [
      {
        componentName: 'VueCard',
        declarationFile: '/proto/node_modules/mixed-ui/dist/types/VueCard.vue.d.ts',
      },
    ]
    const cachedReactManifest: ComponentManifest = {
      id: 'mixed-ui:ReactButton',
      name: 'ReactButton',
      framework: 'react',
      designSystem: 'mixed-ui',
      importPath: 'mixed-ui',
      props: [{ name: 'old-only-prop' }] as ComponentManifest['props'],
    }
    const reextractedManifest: ComponentManifest = {
      ...cachedReactManifest,
      props: [{ name: 'variant' }] as ComponentManifest['props'],
    }
    const discoverVueSpy = vi.fn(async () => vueDiscovered)
    let seenEntryFiles: string[] = []
    const deps = fakeDeps({
      discoverVueDtsComponents: discoverVueSpy,
      discoverReactDtsEntries: () => ['/proto/node_modules/mixed-ui/dist/react-entry.d.ts'],
      readCache: vi.fn(() => cachedReactManifest),
      reextractReact: async (a) => {
        seenEntryFiles = a.entryFiles
        return reextractedManifest
      },
    })

    const result = await call(deps, {
      component: 'ReactButton',
      importPath: 'mixed-ui',
      designSystem: undefined,
    })

    expect(result.outcome).toBe('repaired')
    expect(seenEntryFiles).toEqual(['/proto/node_modules/mixed-ui/dist/react-entry.d.ts'])
    // The Vue-shaped probe never even needs to run for this dispatch — the
    // cached framework signal short-circuits straight to the React path.
    expect(discoverVueSpy).not.toHaveBeenCalled()
  })

  it('reports unsupported for an auto-scanned package with neither *.vue.d.ts nor a resolvable React entry', async () => {
    const deps = fakeDeps({
      discoverVueDtsComponents: async () => [],
      discoverReactDtsEntries: () => [],
    })

    const result = await call(deps)

    expect(result.outcome).toBe('unsupported')
    expect(result.reason).toMatch(/no \*\.vue\.d\.ts declarations and no resolvable React/i)
  })

  it('reports seeded (not repaired) when nothing was cached for this component yet', async () => {
    const deps = fakeDeps({ readCache: vi.fn(() => null) })

    const result = await call(deps)

    // No prior cache entry means nothing was actually compared — reporting
    // `repaired` here would falsely tell the trust path a stale manifest was
    // found and fixed. It still writes the cache and invalidates, same as a
    // real repair, just under a distinct outcome.
    expect(result.outcome).toBe('seeded')
    expect(result.reason).toMatch(/no prior cache entry/i)
    expect(deps.patchCache).toHaveBeenCalledTimes(1)
    expect(deps.invalidate).toHaveBeenCalledTimes(1)
  })

  it('reports repaired (not seeded) when a prior cached manifest existed and differed', async () => {
    const deps = fakeDeps({
      readCache: vi.fn(() => manifest([{ name: 'old-only-prop' }])),
      reextractVue: async () => manifest([{ name: 'appearance' }, { name: 'size' }]),
    })

    const result = await call(deps)

    expect(result).toEqual({ outcome: 'repaired' })
    expect(deps.patchCache).toHaveBeenCalledTimes(1)
    expect(deps.invalidate).toHaveBeenCalledTimes(1)
  })

  it('fails, never invalidates, when patchCache reports failure on a seed (no prior cache)', async () => {
    const deps = fakeDeps({ readCache: vi.fn(() => null), patchCache: vi.fn(() => false) })

    const result = await call(deps)

    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/could not patch/i)
    expect(deps.invalidate).not.toHaveBeenCalled()
  })

  it('reports unchanged (and never patches/invalidates) when re-extraction matches the cache', async () => {
    const same = manifest([{ name: 'appearance' }, { name: 'size' }])
    const deps = fakeDeps({
      readCache: vi.fn(() => manifest([{ name: 'appearance' }, { name: 'size' }])),
      reextractVue: async () => same,
    })

    const result = await call(deps)

    expect(result.outcome).toBe('unchanged')
    expect(deps.patchCache).not.toHaveBeenCalled()
    expect(deps.invalidate).not.toHaveBeenCalled()
  })

  it('treats slots/events/rendering, not just props, as part of the equality check', async () => {
    const cached: ComponentManifest = { ...manifest(), rendering: [{ prop: 'label', selector: '.x' } as never] }
    const reextracted: ComponentManifest = { ...manifest() } // no rendering — vue-dts-meta never populates it
    const deps = fakeDeps({
      readCache: vi.fn(() => cached),
      reextractVue: async () => reextracted,
    })

    const result = await call(deps)

    // Different `rendering` ⇒ not equal ⇒ repaired. (Rendering hints live in
    // a SEPARATE cache file in production — this just proves the compare
    // function actually looks at the field, not that this scenario is
    // realistic for the vue-dts-meta cache specifically.)
    expect(result.outcome).toBe('repaired')
  })

  it('fails when the drift entry has no importPath', async () => {
    const deps = fakeDeps()
    const result = await call(deps, { importPath: undefined })
    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/no importPath/i)
    expect(deps.patchCache).not.toHaveBeenCalled()
  })

  it('refuses an importPath that resolves outside node_modules (path containment)', async () => {
    let discoverCalled = false
    const deps = fakeDeps({
      discoverVueDtsComponents: async () => {
        discoverCalled = true
        return []
      },
    })
    const result = await call(deps, { importPath: '../../../../etc/passwd' })
    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/resolves outside node_modules/i)
    // The containment check must reject BEFORE any fs discovery is attempted
    // against the escaped path.
    expect(discoverCalled).toBe(false)
  })

  it('fails when no tsconfig can be resolved', async () => {
    const deps = fakeDeps({ resolveTsconfigPath: async () => null })
    const result = await call(deps)
    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/tsconfig/i)
  })

  it('reports unsupported when discovery finds zero *.vue.d.ts declarations (e.g. a React package)', async () => {
    const deps = fakeDeps({ discoverVueDtsComponents: async () => [] })
    const result = await call(deps)
    expect(result.outcome).toBe('unsupported')
    expect(result.reason).toMatch(/not a Vue package|React/i)
  })

  it('fails when the component is not among the discovered declarations', async () => {
    const deps = fakeDeps({
      discoverVueDtsComponents: async () => [
        { componentName: 'KOtherThing', declarationFile: '/x/KOtherThing.vue.d.ts' },
      ],
    })
    const result = await call(deps)
    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/not found/i)
  })

  it('fails when the package version cannot be resolved', async () => {
    const deps = fakeDeps({ resolvePackageVersion: () => null })
    const result = await call(deps)
    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/version/i)
  })

  it('fails when re-extraction returns null', async () => {
    const deps = fakeDeps({ reextractVue: async () => null })
    const result = await call(deps)
    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/no manifest/i)
  })

  it('fails, never invalidates, when patchCache reports failure', async () => {
    const deps = fakeDeps({ patchCache: vi.fn(() => false) })
    const result = await call(deps)
    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/could not patch/i)
    expect(deps.invalidate).not.toHaveBeenCalled()
  })

  it('never throws: catches a rejecting reextractVue and reports failed', async () => {
    const deps = fakeDeps({
      reextractVue: async () => {
        throw new Error('checker exploded')
      },
    })
    const result = await call(deps)
    expect(result).toEqual({ outcome: 'failed', reason: 'checker exploded' })
  })

  it('never throws: catches a rejecting discoverVueDtsComponents and reports failed', async () => {
    const deps = fakeDeps({
      discoverVueDtsComponents: async () => {
        throw new Error('fs walk exploded')
      },
    })
    const result = await call(deps)
    expect(result).toEqual({ outcome: 'failed', reason: 'fs walk exploded' })
  })

  it('falls back to importPath as designSystem when the entry has none resolved yet', async () => {
    let seenDesignSystem = ''
    const deps = fakeDeps({
      reextractVue: async (a) => {
        seenDesignSystem = a.designSystem
        return manifest()
      },
    })
    await call(deps, { designSystem: undefined })
    expect(seenDesignSystem).toBe('@acme/design-system')
  })

  // --- codex P2 fixes (2026-07-30): package identity + designSystem disambiguation ---

  it('resolves the package root (discovery + version) from a REGISTERED entry\'s `package`, not the drift signal\'s importPath, when the two differ (codex P2)', async () => {
    const entry = registeredEntry({
      package: '@acme/ui',
      importPath: '@acme/ui/components',
      designSystem: 'acme',
    })
    const discoverSpy = vi.fn(async () => [
      {
        componentName: 'UiButton',
        declarationFile: '/proto/node_modules/@acme/ui/dist/types/components/UiButton/UiButton.vue.d.ts',
      },
    ])
    const versionSpy = vi.fn(() => '2.1.0')
    const deps = fakeDeps({
      findRegisteredEntry: async () => entry,
      discoverVueDtsComponents: discoverSpy,
      resolvePackageVersion: versionSpy,
      readCache: vi.fn(() => manifest([{ name: 'old-only-prop' }])),
      reextractVue: async () => manifest([{ name: 'appearance' }, { name: 'size' }]),
    })

    const result = await call(deps, { importPath: '@acme/ui/components', designSystem: 'acme' })

    expect(result.outcome).toBe('repaired')
    // Discovery (and version resolution) must run against node_modules/@acme/ui
    // — the registered entry's PACKAGE — not node_modules/@acme/ui/components,
    // which would resolve outside node_modules entirely for a subpath import.
    expect(discoverSpy).toHaveBeenCalledWith(expect.stringMatching(/node_modules\/@acme\/ui$/), {
      dtsRoots: entry.dtsRoots,
    })
    expect(versionSpy).toHaveBeenCalledWith(expect.stringMatching(/node_modules\/@acme\/ui$/))
  })

  it('patches the cache file for the registered entry the drift signal actually names, not a different entry sharing the same importPath (codex P2)', async () => {
    const entryA = registeredEntry({ id: 'a', designSystem: 'acme-a' })
    const entryB = registeredEntry({ id: 'b', designSystem: 'acme-b' })
    const deps = fakeDeps({
      findRegisteredEntry: async (importPath, _prototypeRoot, designSystem) => {
        const candidates = [entryA, entryB].filter((e) => e.importPath === importPath)
        if (designSystem !== undefined) {
          return candidates.find((e) => e.designSystem === designSystem) ?? null
        }
        if (candidates.length > 1) {
          throw new Error(
            `ambiguous registered entry: ${candidates.length} registered design systems share importPath "${importPath}"`,
          )
        }
        return candidates[0] ?? null
      },
      readCache: vi.fn(() => manifest([{ name: 'old-only-prop' }])),
      reextractVue: async () => manifest([{ name: 'appearance' }, { name: 'size' }]),
    })

    const result = await call(deps, { designSystem: 'acme-b' })

    expect(result.outcome).toBe('repaired')
    const [cacheFile] = (deps.patchCache as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(cacheFile).toContain(sanitize(registeredCacheName(entryB)))
    expect(cacheFile).not.toContain(sanitize(registeredCacheName(entryA)))
  })

  it('reports failed with an ambiguous reason (never calls patchCache) when the drift signal has no designSystem and multiple registered entries share the importPath (codex P2)', async () => {
    const deps = fakeDeps({
      // Fakes the production throw (`createDefaultRepairDeps.findRegisteredEntry`
      // throws in exactly this shape when it can't disambiguate) — exercising
      // the REAL impl here would require a real on-disk registry file
      // (`createLocalRegistryStore` reads from fs), which this suite avoids.
      findRegisteredEntry: async (importPath, _prototypeRoot, designSystem) => {
        if (designSystem !== undefined) return null
        throw new Error(
          `ambiguous registered entry: 2 registered design systems share importPath "${importPath}" ` +
            'and the drift signal carries no designSystem to disambiguate; refusing to guess which one to repair',
        )
      },
    })

    const result = await call(deps, { designSystem: undefined })

    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/ambiguous/i)
    expect(deps.patchCache).not.toHaveBeenCalled()
  })

  it('auto-scan (no registered entry) still resolves the package root from importPath directly, unchanged (codex P2 regression guard)', async () => {
    const discoverSpy = vi.fn(async () => [
      {
        componentName: 'UiButton',
        declarationFile:
          '/proto/node_modules/@acme/design-system/dist/types/components/UiButton/UiButton.vue.d.ts',
      },
    ])
    const deps = fakeDeps({ discoverVueDtsComponents: discoverSpy, findRegisteredEntry: async () => null })

    const result = await call(deps)

    expect(result.outcome).not.toBe('failed')
    expect(discoverSpy).toHaveBeenCalledWith(expect.stringMatching(/node_modules\/@acme\/design-system$/), {
      dtsRoots: undefined,
    })
  })
})

describe('createDefaultRepairDeps', () => {
  it('returns an object shaped like RepairDeps with a no-op invalidate', () => {
    const deps = createDefaultRepairDeps()
    expect(typeof deps.reextractVue).toBe('function')
    expect(typeof deps.reextractReact).toBe('function')
    expect(typeof deps.patchCache).toBe('function')
    expect(typeof deps.readCache).toBe('function')
    expect(typeof deps.findRegisteredEntry).toBe('function')
    expect(typeof deps.discoverVueDtsComponents).toBe('function')
    expect(typeof deps.discoverReactDtsEntries).toBe('function')
    expect(typeof deps.resolveTsconfigPath).toBe('function')
    expect(typeof deps.resolvePackageVersion).toBe('function')
    expect(typeof deps.fingerprintFile).toBe('function')
    // No-op — documented in the module: the server has no in-process
    // CachedManifestLookup to invalidate.
    expect(deps.invalidate('UiButton', '@acme/design-system')).toBeUndefined()
  })

  it('findRegisteredEntry resolves null for a root with no registry file', async () => {
    const deps = createDefaultRepairDeps()
    await expect(
      deps.findRegisteredEntry('@acme/design-system', '/definitely/not/a/real/prototype/root'),
    ).resolves.toBeNull()
  })

  it('resolveTsconfigPath resolves null for a root with no tsconfig', async () => {
    const deps = createDefaultRepairDeps()
    await expect(deps.resolveTsconfigPath('/definitely/not/a/real/prototype/root')).resolves.toBeNull()
  })

  it('resolvePackageVersion resolves null for a nonexistent package root', () => {
    const deps = createDefaultRepairDeps()
    expect(deps.resolvePackageVersion('/definitely/not/a/real/package/root')).toBeNull()
  })
})
