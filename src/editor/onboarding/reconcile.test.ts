import { describe, expect, it, vi } from 'vitest'
import type { DesignSystemDeclaration } from '@/editor/core/design-system-declarations'
import { reconcileDesignSystems, registryEntryIdentity, type ReconcileDeps, type ReconcileStatus } from './reconcile'
import type { OnboardRequest, OnboardResult, RegisteredDesignSystem } from './types'

function registeredInstalled(pkg: string): RegisteredDesignSystem {
  return {
    id: pkg,
    source: { kind: 'installed', package: pkg },
    package: pkg,
    version: '1.0.0',
    framework: 'vue3',
    designSystem: pkg,
    importPath: pkg,
    addedAt: '2026-07-01T00:00:00.000Z',
  }
}

function onboardResult(pkg: string): OnboardResult {
  return {
    package: pkg,
    version: '1.0.0',
    framework: 'vue3',
    designSystem: pkg,
    importPath: pkg,
    coverage: { discovered: 1, extracted: 1, empty: 0, failedComponents: [], sampleProps: {} },
    registryEntryId: pkg,
  }
}

function makeDeps(over: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    listRegistry: vi.fn(async () => []),
    onboard: vi.fn(async (req: OnboardRequest) => onboardResult((req.source as { package?: string; spec?: string; url?: string }).package ?? 'unknown')),
    ...over,
  }
}

describe('registryEntryIdentity', () => {
  it('uses the package name for installed/npm entries', () => {
    expect(registryEntryIdentity(registeredInstalled('@acme/design-system'))).toBe('@acme/design-system')
  })

  it('uses declarationIdentity(entry.source) for repo entries', () => {
    const entry: RegisteredDesignSystem = {
      ...registeredInstalled('acme-ds'),
      source: { kind: 'repo', url: 'https://github.com/acme/ds', ref: 'main', subdir: 'packages/ui' },
    }
    expect(registryEntryIdentity(entry)).toBe('repo:https://github.com/acme/ds|main|packages/ui')
  })
})

describe('reconcileDesignSystems', () => {
  it('skips a declaration whose identity already matches a registry entry', async () => {
    const declarations: DesignSystemDeclaration[] = [
      { source: { kind: 'installed', package: '@acme/design-system' } },
    ]
    const deps = makeDeps({ listRegistry: vi.fn(async () => [registeredInstalled('@acme/design-system')]) })

    const status = await reconcileDesignSystems({ prototypeRoot: '/proto', declarations, deps })

    expect(status.entries).toHaveLength(1)
    expect(status.entries[0]).toMatchObject({
      identity: '@acme/design-system',
      state: 'skipped',
      reason: 'already registered',
    })
    expect(deps.onboard).not.toHaveBeenCalled()
  })

  it('onboards an unregistered installed declaration and lands done', async () => {
    const declarations: DesignSystemDeclaration[] = [
      { source: { kind: 'installed', package: '@acme/widgets' } },
    ]
    const deps = makeDeps()

    const status = await reconcileDesignSystems({ prototypeRoot: '/proto', declarations, deps })

    expect(status.startedAt).not.toBeNull()
    expect(status.entries).toHaveLength(1)
    expect(status.entries[0]).toMatchObject({
      identity: '@acme/widgets',
      state: 'done',
      registryEntryId: '@acme/widgets',
    })
    expect(deps.onboard).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'installed', package: '@acme/widgets' }, prototypeRoot: '/proto' }),
    )
  })

  it('isolates an onboard rejection to that entry and still runs later declarations', async () => {
    const declarations: DesignSystemDeclaration[] = [
      { source: { kind: 'installed', package: '@acme/broken' } },
      { source: { kind: 'installed', package: '@acme/fine' } },
    ]
    const onboard = vi.fn(async (req: OnboardRequest) => {
      const pkg = (req.source as { package: string }).package
      if (pkg === '@acme/broken') throw new Error('extraction failed: no components discovered')
      return onboardResult(pkg)
    })
    const deps = makeDeps({ onboard })

    const status = await reconcileDesignSystems({ prototypeRoot: '/proto', declarations, deps })

    expect(status.entries[0]).toMatchObject({
      identity: '@acme/broken',
      state: 'failed',
      reason: 'extraction failed: no components discovered',
    })
    expect(status.entries[1]).toMatchObject({
      identity: '@acme/fine',
      state: 'done',
      registryEntryId: '@acme/fine',
    })
    expect(onboard).toHaveBeenCalledTimes(2)
  })

  it('passes a repo declaration allowBuild through to the onboard request', async () => {
    const declarations: DesignSystemDeclaration[] = [
      {
        source: { kind: 'repo', url: 'https://github.com/acme/ds', ref: 'main' },
        allowBuild: true,
      },
    ]
    const onboard = vi.fn(async () => onboardResult('@acme/from-repo'))
    const deps = makeDeps({ onboard })

    await reconcileDesignSystems({ prototypeRoot: '/proto', declarations, deps })

    expect(onboard).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: 'repo', url: 'https://github.com/acme/ds', ref: 'main' },
        allowBuild: true,
      }),
    )
  })

  it('passes an EXPLICIT allowBuild:false declaration through as false (never upgraded to the default)', async () => {
    // Regression for the `…/share` route bug: a declaration that explicitly
    // records the user's declined build consent must reach `onboard` as
    // `false`, not get bumped by the default applied to an UNSET field.
    // (Since audit S13 that default is itself `false`, so this now pins the
    // pass-through rather than a difference — kept because the `…/share`
    // route still writes the field explicitly for exactly this reason.)
    const declarations: DesignSystemDeclaration[] = [
      {
        source: { kind: 'repo', url: 'https://github.com/acme/ds', ref: 'main' },
        allowBuild: false,
      },
    ]
    const onboard = vi.fn(async () => onboardResult('@acme/from-repo'))
    const deps = makeDeps({ onboard })

    await reconcileDesignSystems({ prototypeRoot: '/proto', declarations, deps })

    expect(onboard).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: 'repo', url: 'https://github.com/acme/ds', ref: 'main' },
        allowBuild: false,
      }),
    )
  })

  // Audit S13. Reconciliation is AUTOMATIC and fires at boot over whatever
  // the OPENED REPO's config file declares, so an unset `allowBuild` must
  // not be read as "clone this URL and run its build script as me". The
  // previous default here was `?? true`, and this test used to pin it.
  it('defaults an unset repo declaration allowBuild to FALSE — boot-time reconciliation never grants build consent', async () => {
    const declarations: DesignSystemDeclaration[] = [
      { source: { kind: 'repo', url: 'https://github.com/acme/ds', ref: 'main' } },
    ]
    const onboard = vi.fn(async () => onboardResult('@acme/from-repo'))
    const deps = makeDeps({ onboard })

    await reconcileDesignSystems({ prototypeRoot: '/proto', declarations, deps })

    expect(onboard).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: 'repo', url: 'https://github.com/acme/ds', ref: 'main' },
        allowBuild: false,
      }),
    )
  })

  it('never throws when listRegistry rejects — marks every entry failed', async () => {
    const declarations: DesignSystemDeclaration[] = [
      { source: { kind: 'installed', package: '@acme/a' } },
      { source: { kind: 'installed', package: '@acme/b' } },
    ]
    const deps = makeDeps({ listRegistry: vi.fn(async () => { throw new Error('disk error') }) })

    const status = await reconcileDesignSystems({ prototypeRoot: '/proto', declarations, deps })

    expect(status.entries).toHaveLength(2)
    for (const entry of status.entries) {
      expect(entry.state).toBe('failed')
      expect(entry.reason).toContain('disk error')
    }
    expect(deps.onboard).not.toHaveBeenCalled()
  })

  it('reports intermediate pending/running states via onStatusChange', async () => {
    const declarations: DesignSystemDeclaration[] = [
      { source: { kind: 'installed', package: '@acme/widgets' } },
    ]
    const snapshots: ReconcileStatus[] = []
    const deps = makeDeps({ onStatusChange: (s) => snapshots.push(s) })

    await reconcileDesignSystems({ prototypeRoot: '/proto', declarations, deps })

    const states = snapshots.map((s) => s.entries[0]?.state)
    expect(states).toContain('pending')
    expect(states).toContain('running')
    expect(states[states.length - 1]).toBe('done')
  })
})
