import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateHintsRun, computeHintCoverage, mergeRenderingHints } from './generate-hints-run'
import {
  readHintCache,
  writeHintCache,
  hintCacheFilePath,
  HINTS_SCHEMA_VERSION,
  type HintCacheFile,
} from '../adapters/hints-cache'
import type { ComponentManifest, ComponentPropManifest, RenderingHint } from '../core/manifest'
import type { ProbeObservation } from './probe-driver'
import type { InferFromSourceOutcome } from './infer-from-source'
import type { CompleteOpts, CompleteResult, CompletionProvider } from '../llm-providers/types'

function prop(over: Partial<ComponentPropManifest> = {}): ComponentPropManifest {
  return {
    name: 'label',
    type: 'string',
    required: false,
    control: { kind: 'text' },
    ...over,
  }
}

function manifest(over: Partial<ComponentManifest> = {}): ComponentManifest {
  return {
    id: 'acme-ds:UiButton',
    name: 'UiButton',
    framework: 'vue3',
    designSystem: 'acme-ds',
    importPath: '@acme/design-system',
    props: [prop()],
    ...over,
  }
}

/** Write a fixture `HintCacheFile` directly — used to set up "prior run" state for the carry-forward tests. */
function seedHintCache(
  filePath: string,
  entry: { packageName: string; packageVersion: string; designSystem: string },
  hints: Record<string, RenderingHint[]>,
): void {
  const file: HintCacheFile = {
    schema: HINTS_SCHEMA_VERSION,
    packageName: entry.packageName,
    packageVersion: entry.packageVersion,
    generatedAt: '2026-07-01T00:00:00.000Z',
    hints,
  }
  writeHintCache(filePath, file)
}

describe('generateHintsRun', () => {
  let dir: string
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'hints-run-'))
    return dir
  }
  const teardown = () => rmSync(dir, { recursive: true, force: true })

  it('filters components by entry.designSystem, ignoring unrelated catalog entries', async () => {
    setup()
    try {
      const components = [
        manifest({ name: 'UiButton', designSystem: 'acme-ds' }),
        manifest({ name: 'Other', designSystem: 'other-ds' }),
      ]
      const probe = vi.fn(
        async (): Promise<ProbeObservation> => ({
          ok: true,
          findings: [
            {
              sentinel: 'x',
              propOrSlot: { kind: 'prop', name: 'label' },
              matches: [{ selector: ':root', field: 'textContent' }],
            },
          ],
        }),
      )
      const result = await generateHintsRun({
        entry: { packageName: '@acme/design-system', packageVersion: '1.0.0', designSystem: 'acme-ds' },
        cacheDir: dir,
        components,
        probe,
        sentinelSuffix: 'S',
      })
      expect(probe).toHaveBeenCalledTimes(1) // only UiButton, not Other
      expect(result.probed).toBe(1)
      expect(result.hinted).toBe(1)
      expect(result.verified).toBe(1)
      expect(result.skipped).toEqual([])
      expect(result.wroteCache).toBe(true)
      expect(result.note).toBeUndefined()
    } finally {
      teardown()
    }
  })

  it('filters by entry.importPath too, so two packages sharing one designSystem label do not cross-contaminate', async () => {
    setup()
    try {
      // Both registered under the SAME `designSystem` label (e.g. a
      // re-stamped `PACKAGE_OVERRIDES.designSystem`), but different real
      // packages — `importPath` is the only thing that disambiguates them.
      const components = [
        manifest({ name: 'Card', designSystem: 'acme-ui', importPath: '@acme/card' }),
        manifest({ name: 'Button', designSystem: 'acme-ui', importPath: '@acme/button' }),
      ]
      const probe = vi.fn(
        async (spec): Promise<ProbeObservation> => {
          void spec
          return {
            ok: true,
            findings: [
              {
                sentinel: 'x',
                propOrSlot: { kind: 'prop', name: 'label' },
                matches: [{ selector: ':root', field: 'textContent' }],
              },
            ],
          }
        },
      )
      const result = await generateHintsRun({
        entry: {
          packageName: '@acme/button',
          packageVersion: '1.0.0',
          designSystem: 'acme-ui',
          importPath: '@acme/button',
        },
        cacheDir: dir,
        components,
        probe,
        sentinelSuffix: 'S',
      })
      // Only Button (matching importPath) is probed — Card, despite sharing
      // `designSystem: 'acme-ui'`, is excluded because its importPath is a
      // different package.
      expect(probe).toHaveBeenCalledTimes(1)
      expect(probe.mock.calls[0]?.[0]?.exportName).toBe('Button')
      expect(result.probed).toBe(1)

      const written = readHintCache(hintCacheFilePath(dir, '@acme/button', '1.0.0'))
      expect(written).not.toBeNull()
      expect(Object.keys(written!.hints)).toEqual(['Button'])
      expect(written!.hints['Card']).toBeUndefined()
    } finally {
      teardown()
    }
  })

  it('records progress with index/total/component name, in order', async () => {
    setup()
    try {
      const components = [
        manifest({ name: 'UiButton' }),
        manifest({ name: 'UiInput' }),
      ]
      const seen: Array<{ index: number; total: number; component: string }> = []
      await generateHintsRun({
        entry: { packageName: '@acme/design-system', packageVersion: '1.0.0', designSystem: 'acme-ds' },
        cacheDir: dir,
        components,
        probe: async () => ({ ok: true, findings: [] }),
        onProgress: (p) => seen.push(p),
        sentinelSuffix: 'S',
      })
      expect(seen).toEqual([
        { index: 0, total: 2, component: 'UiButton' },
        { index: 1, total: 2, component: 'UiInput' },
      ])
    } finally {
      teardown()
    }
  })

  it('isolates a per-component mount failure: counts it as skipped and continues the run', async () => {
    setup()
    try {
      const components = [manifest({ name: 'Broken' }), manifest({ name: 'UiButton' })]
      const probe = vi.fn(async (spec): Promise<ProbeObservation> => {
        if (spec.exportName === 'Broken') return { ok: false, reason: 'setup() threw', findings: [] }
        return {
          ok: true,
          findings: [
            {
              sentinel: 'x',
              propOrSlot: { kind: 'prop', name: 'label' },
              matches: [{ selector: ':root', field: 'textContent' }],
            },
          ],
        }
      })
      const result = await generateHintsRun({
        entry: { packageName: '@acme/design-system', packageVersion: '1.0.0', designSystem: 'acme-ds' },
        cacheDir: dir,
        components,
        probe,
        sentinelSuffix: 'S',
      })
      expect(result.skipped).toEqual([{ name: 'Broken', reason: 'setup() threw' }])
      expect(result.probed).toBe(1)
      expect(result.hinted).toBe(1)
    } finally {
      teardown()
    }
  })

  it('writes ONE HintCacheFile including probed-but-zero-hint components (empty array retained)', async () => {
    setup()
    try {
      const components = [manifest({ name: 'UiButton' }), manifest({ name: 'UiEmpty' })]
      const probe = vi.fn(async (spec): Promise<ProbeObservation> => {
        if (spec.exportName === 'UiEmpty') return { ok: true, findings: [] }
        return {
          ok: true,
          findings: [
            {
              sentinel: 'x',
              propOrSlot: { kind: 'prop', name: 'label' },
              matches: [{ selector: ':root', field: 'textContent' }],
            },
          ],
        }
      })
      await generateHintsRun({
        entry: { packageName: '@acme/design-system', packageVersion: '1.0.0', designSystem: 'acme-ds' },
        cacheDir: dir,
        components,
        probe,
        sentinelSuffix: 'S',
        now: () => new Date('2026-07-26T00:00:00.000Z'),
      })
      const file = readHintCache(hintCacheFilePath(dir, '@acme/design-system', '1.0.0'))
      expect(file).not.toBeNull()
      expect(file?.packageName).toBe('@acme/design-system')
      expect(file?.packageVersion).toBe('1.0.0')
      expect(file?.generatedAt).toBe('2026-07-26T00:00:00.000Z')
      expect(Object.keys(file!.hints).sort()).toEqual(['UiButton', 'UiEmpty'])
      expect(file!.hints.UiEmpty).toEqual([])
      expect(file!.hints.UiButton).toHaveLength(1)
    } finally {
      teardown()
    }
  })

  it('never writes a file when zero components matched the design system (guards against clobbering an existing file)', async () => {
    setup()
    try {
      const probe = vi.fn(async (): Promise<ProbeObservation> => ({ ok: true, findings: [] }))
      const result = await generateHintsRun({
        entry: { packageName: '@acme/design-system', packageVersion: '1.0.0', designSystem: 'acme-ds' },
        cacheDir: dir,
        components: [manifest({ designSystem: 'unrelated' })],
        probe,
        sentinelSuffix: 'S',
      })
      expect(probe).not.toHaveBeenCalled()
      expect(result).toEqual({
        probed: 0,
        hinted: 0,
        verified: 0,
        skipped: [],
        wroteCache: false,
        note: 'no hints produced. Existing hint cache left unchanged.',
        carriedForward: 0,
      })
      expect(readHintCache(hintCacheFilePath(dir, '@acme/design-system', '1.0.0'))).toBeNull()
    } finally {
      teardown()
    }
  })

  it('does NOT overwrite an existing hint cache file when a later run produces zero hints (transient-failure guard, codex P2 fix)', async () => {
    setup()
    try {
      const entry = {
        packageName: '@acme/design-system',
        packageVersion: '1.0.0',
        designSystem: 'acme-ds' as const,
      }
      const components = [manifest({ name: 'UiButton' })]
      const filePath = hintCacheFilePath(dir, entry.packageName, entry.packageVersion)

      // First run: succeeds and writes a real, verified hint to disk.
      const okProbe = vi.fn(
        async (): Promise<ProbeObservation> => ({
          ok: true,
          findings: [
            {
              sentinel: 'x',
              propOrSlot: { kind: 'prop', name: 'label' },
              matches: [{ selector: ':root', field: 'textContent' }],
            },
          ],
        }),
      )
      const first = await generateHintsRun({
        entry,
        cacheDir: dir,
        components,
        probe: okProbe,
        sentinelSuffix: 'S',
      })
      expect(first.wroteCache).toBe(true)
      expect(first.note).toBeUndefined()
      const before = readHintCache(filePath)
      expect(before?.hints.UiButton).toHaveLength(1)

      // Second run: every targeted component fails to mount (e.g. a
      // transient failure — the isolation route unavailable, Vite not
      // serving the mount). This must NOT clobber the file written above.
      const failingProbe = vi.fn(
        async (): Promise<ProbeObservation> => ({ ok: false, reason: 'setup() threw', findings: [] }),
      )
      const second = await generateHintsRun({
        entry,
        cacheDir: dir,
        components,
        probe: failingProbe,
        sentinelSuffix: 'S',
      })
      expect(second.wroteCache).toBe(false)
      expect(second.note).toBe('no hints produced. Existing hint cache left unchanged.')
      expect(second.skipped).toEqual([{ name: 'UiButton', reason: 'setup() threw' }])

      const after = readHintCache(filePath)
      expect(after).toEqual(before) // untouched — same content as the first run left it
    } finally {
      teardown()
    }
  })

  it('carries forward a SKIPPED component\'s prior entry while an evaluated sibling in the SAME run is overwritten (codex P2 fix)', async () => {
    setup()
    try {
      const entry = {
        packageName: '@acme/design-system',
        packageVersion: '1.0.0',
        designSystem: 'acme-ds' as const,
      }
      const filePath = hintCacheFilePath(dir, entry.packageName, entry.packageVersion)
      const priorAHint = domHint({ source: { kind: 'prop', name: 'oldA' } })
      const priorBHint = domHint({ source: { kind: 'prop', name: 'oldB' } })
      seedHintCache(filePath, entry, { A: [priorAHint], B: [priorBHint] })

      const components = [manifest({ name: 'A' }), manifest({ name: 'B' })]
      const probe = vi.fn(async (spec): Promise<ProbeObservation> => {
        if (spec.exportName === 'B') return { ok: false, reason: 'setup() threw', findings: [] }
        return {
          ok: true,
          findings: [
            {
              sentinel: 'x',
              propOrSlot: { kind: 'prop', name: 'label' },
              matches: [{ selector: ':root', field: 'textContent' }],
            },
          ],
        }
      })

      const result = await generateHintsRun({
        entry,
        cacheDir: dir,
        components,
        probe,
        sentinelSuffix: 'S',
      })

      expect(result.wroteCache).toBe(true)
      expect(result.carriedForward).toBe(1)
      expect(result.skipped).toEqual([{ name: 'B', reason: 'setup() threw' }])

      const file = readHintCache(filePath)
      // A was evaluated this run — its FRESH result wins (a brand-new hint,
      // not the stale `priorAHint`).
      expect(file?.hints.A).toHaveLength(1)
      expect(file?.hints.A?.[0]).not.toEqual(priorAHint)
      // B was skipped (transient probe failure) — its prior, previously
      // verified entry survives untouched.
      expect(file?.hints.B).toEqual([priorBHint])
    } finally {
      teardown()
    }
  })

  it('replaces a stale entry with zero hints when this run evaluates that SAME component and finds nothing (evaluated always wins, even at zero)', async () => {
    setup()
    try {
      const entry = {
        packageName: '@acme/design-system',
        packageVersion: '1.0.0',
        designSystem: 'acme-ds' as const,
      }
      const filePath = hintCacheFilePath(dir, entry.packageName, entry.packageVersion)
      const priorAHint = domHint({ source: { kind: 'prop', name: 'oldA' } })
      seedHintCache(filePath, entry, { A: [priorAHint] })

      const components = [manifest({ name: 'A' })]
      // Mounts fine, but no sentinel match — a legitimate "we now know there
      // is no trustworthy hint site" result, not a failure.
      const probe = vi.fn(async (): Promise<ProbeObservation> => ({ ok: true, findings: [] }))

      const result = await generateHintsRun({
        entry,
        cacheDir: dir,
        components,
        probe,
        sentinelSuffix: 'S',
      })

      expect(result.wroteCache).toBe(true)
      expect(result.carriedForward).toBe(0)
      expect(result.skipped).toEqual([])

      // A's stale hint is gone — replaced by this run's authoritative empty
      // result. (An evaluated-zero component keeps its KEY mapped to `[]`
      // rather than being deleted outright — see the write-step doc comment
      // for why that's equivalent for every downstream reader, and why it
      // doesn't fight the round-5 "don't write an empty file" guard, which
      // is scoped to a run that evaluated NOTHING at all, not to an
      // individual component's zero-hint result.)
      const file = readHintCache(filePath)
      expect(file?.hints.A).toEqual([])
    } finally {
      teardown()
    }
  })

  it('behaves exactly as before when there is no prior hint-cache file at all', async () => {
    setup()
    try {
      const entry = {
        packageName: '@acme/design-system',
        packageVersion: '1.0.0',
        designSystem: 'acme-ds' as const,
      }
      const filePath = hintCacheFilePath(dir, entry.packageName, entry.packageVersion)
      expect(readHintCache(filePath)).toBeNull() // no prior file

      const components = [manifest({ name: 'A' })]
      const probe = vi.fn(
        async (): Promise<ProbeObservation> => ({
          ok: true,
          findings: [
            {
              sentinel: 'x',
              propOrSlot: { kind: 'prop', name: 'label' },
              matches: [{ selector: ':root', field: 'textContent' }],
            },
          ],
        }),
      )

      const result = await generateHintsRun({
        entry,
        cacheDir: dir,
        components,
        probe,
        sentinelSuffix: 'S',
      })

      expect(result.wroteCache).toBe(true)
      expect(result.carriedForward).toBe(0)
      const file = readHintCache(filePath)
      expect(Object.keys(file!.hints)).toEqual(['A'])
    } finally {
      teardown()
    }
  })

  it('does not consult a prior hint-cache file written under a DIFFERENT version key', async () => {
    setup()
    try {
      const designSystem = 'acme-ds' as const
      const otherVersionFilePath = hintCacheFilePath(dir, '@acme/design-system', '0.9.0')
      // A prior file exists, but for version 0.9.0 — a DIFFERENT cache key
      // (different filename) than the 1.0.0 run below targets.
      seedHintCache(
        otherVersionFilePath,
        { packageName: '@acme/design-system', packageVersion: '0.9.0', designSystem },
        { B: [domHint({ source: { kind: 'prop', name: 'oldB' } })] },
      )

      const entry = { packageName: '@acme/design-system', packageVersion: '1.0.0', designSystem }
      const components = [manifest({ name: 'A' }), manifest({ name: 'B' })]
      const probe = vi.fn(async (spec): Promise<ProbeObservation> => {
        if (spec.exportName === 'B') return { ok: false, reason: 'setup() threw', findings: [] }
        return {
          ok: true,
          findings: [
            {
              sentinel: 'x',
              propOrSlot: { kind: 'prop', name: 'label' },
              matches: [{ selector: ':root', field: 'textContent' }],
            },
          ],
        }
      })

      const result = await generateHintsRun({
        entry,
        cacheDir: dir,
        components,
        probe,
        sentinelSuffix: 'S',
      })

      // B was skipped this run, and the ONLY existing entry for B lives
      // under the 0.9.0 file — never consulted for a 1.0.0 run — so nothing
      // is carried forward for it.
      expect(result.carriedForward).toBe(0)
      const file = readHintCache(hintCacheFilePath(dir, '@acme/design-system', '1.0.0'))
      expect(Object.keys(file!.hints)).toEqual(['A'])
      // The 0.9.0 file itself is untouched.
      expect(readHintCache(otherVersionFilePath)?.hints.B).toEqual([
        domHint({ source: { kind: 'prop', name: 'oldB' } }),
      ])
    } finally {
      teardown()
    }
  })

  it('shares ONE sentinel suffix across every component in the run (default random generator)', async () => {
    setup()
    try {
      const seenSpecs: Array<{ props: Record<string, string>; slotText?: string }> = []
      const probe = vi.fn(async (spec) => {
        seenSpecs.push({ props: spec.props, slotText: spec.slotText })
        return { ok: true, findings: [] } as ProbeObservation
      })
      await generateHintsRun({
        entry: { packageName: '@acme/design-system', packageVersion: '1.0.0', designSystem: 'acme-ds' },
        cacheDir: dir,
        components: [manifest({ name: 'UiButton' }), manifest({ name: 'UiInput' })],
        probe,
      })
      const suffixOf = (s: string) => s.split('_').slice(2).join('_')
      const suffixA = suffixOf(seenSpecs[0].slotText!)
      const suffixB = suffixOf(seenSpecs[1].slotText!)
      expect(suffixA).toBe(suffixB)
      expect(suffixA.length).toBeGreaterThan(0)
    } finally {
      teardown()
    }
  })
})

function domHint(over: Partial<Extract<RenderingHint, { kind: 'dom' }>> = {}): RenderingHint {
  return {
    kind: 'dom',
    source: { kind: 'prop', name: 'label' },
    domTarget: { selector: ':root', field: 'textContent' },
    editability: 'literal',
    provenance: 'generated',
    verified: true,
    ...over,
  }
}

describe('mergeRenderingHints (Task 4 — probe/inference dedupe)', () => {
  it('returns generated hints, then any non-colliding inferred hints, when there is no overlap', () => {
    const generated = [domHint({ source: { kind: 'prop', name: 'a' } })]
    const inferred = [
      domHint({
        source: { kind: 'prop', name: 'b' },
        domTarget: { selector: '.b', field: 'textContent' },
        provenance: 'inferred',
        verified: false,
      }),
    ]
    expect(mergeRenderingHints(generated, inferred)).toEqual([...generated, ...inferred])
  })

  it('prefers the generated (verified) hint over an inferred hint at the SAME site', () => {
    const site = { source: { kind: 'prop' as const, name: 'label' }, domTarget: { selector: ':root', field: 'textContent' as const } }
    const generated = [domHint({ ...site, provenance: 'generated', verified: true })]
    const inferred = [domHint({ ...site, provenance: 'inferred', verified: false })]
    const merged = mergeRenderingHints(generated, inferred)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toEqual(generated[0])
  })

  it('is a no-op merge when one side is empty', () => {
    const only = [domHint()]
    expect(mergeRenderingHints(only, [])).toEqual(only)
    expect(mergeRenderingHints([], only)).toEqual(only)
  })

  it('keeps BOTH hints when the same source/selector/field renders into two different attributes (regression: attribute-blind merge key collapsed these)', () => {
    const site = {
      source: { kind: 'prop' as const, name: 'label' },
      domTarget: { selector: ':root', field: 'attribute' as const },
    }
    const ariaLabel = domHint({ ...site, domTarget: { ...site.domTarget, attribute: 'aria-label' } })
    const title = domHint({ ...site, domTarget: { ...site.domTarget, attribute: 'title' } })
    const merged = mergeRenderingHints([ariaLabel], [title])
    expect(merged).toHaveLength(2)
    expect(merged).toEqual(expect.arrayContaining([ariaLabel, title]))
  })

  it('still dedupes when the attribute is identical on both sides (probe wins, existing behavior)', () => {
    const site = {
      source: { kind: 'prop' as const, name: 'label' },
      domTarget: { selector: ':root', field: 'attribute' as const, attribute: 'aria-label' },
    }
    const generated = [domHint({ ...site, provenance: 'generated', verified: true })]
    const inferred = [domHint({ ...site, provenance: 'inferred', verified: false })]
    const merged = mergeRenderingHints(generated, inferred)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toEqual(generated[0])
  })

  it('keeps a textContent hint and an attribute hint at the same selector for the same source distinct', () => {
    const text = domHint({
      source: { kind: 'prop', name: 'label' },
      domTarget: { selector: ':root', field: 'textContent' },
    })
    const attr = domHint({
      source: { kind: 'prop', name: 'label' },
      domTarget: { selector: ':root', field: 'attribute', attribute: 'aria-label' },
    })
    const merged = mergeRenderingHints([text], [attr])
    expect(merged).toHaveLength(2)
    expect(merged).toEqual(expect.arrayContaining([text, attr]))
  })
})

describe('generateHintsRun — Task 4 (source-inference lane)', () => {
  let dir: string
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'hints-run-infer-'))
    return dir
  }
  const teardown = () => rmSync(dir, { recursive: true, force: true })

  const inferOk = (hints: RenderingHint[]): (() => Promise<InferFromSourceOutcome>) =>
    async () => ({ ok: true, hints })
  const inferFail = (reason: string): (() => Promise<InferFromSourceOutcome>) =>
    async () => ({ ok: false, reason, hints: [] })

  it('writes unverified inferred hints for a component with NO probe supplied at all (repo-ingested, unmountable in V1)', async () => {
    setup()
    try {
      const components = [manifest({ name: 'UiButton' })]
      const inferredHint = domHint({ provenance: 'inferred', verified: false })
      const result = await generateHintsRun({
        entry: { packageName: '@acme/ui', packageVersion: '1.0.0', designSystem: 'acme-ds' },
        cacheDir: dir,
        components,
        // No `probe` at all — mirrors the handler omitting it entirely for
        // a repo-ingested entry (V1: never attempts to mount it).
        inferHints: inferOk([inferredHint]),
        sentinelSuffix: 'S',
      })
      // Never mounted, so NOT counted as probed — but the component still
      // has an entry in the written file (the whole point of Task 4).
      expect(result.probed).toBe(0)
      expect(result.hinted).toBe(1)
      expect(result.verified).toBe(0)
      expect(result.skipped).toEqual([
        { name: 'UiButton', reason: 'not probed (no probe supplied for this run)' },
      ])

      const file = readHintCache(hintCacheFilePath(dir, '@acme/ui', '1.0.0'))
      expect(file?.hints.UiButton).toEqual([inferredHint])
    } finally {
      teardown()
    }
  })

  it('flips an inferred hint to effectively-verified when the probe independently confirms the SAME site', async () => {
    setup()
    try {
      const components = [manifest({ name: 'UiButton' })]
      const site = {
        source: { kind: 'prop' as const, name: 'label' },
        domTarget: { selector: ':root', field: 'textContent' as const },
      }
      const inferredHint = domHint({ ...site, provenance: 'inferred', verified: false })
      const probe = vi.fn(
        async (): Promise<ProbeObservation> => ({
          ok: true,
          findings: [
            {
              sentinel: 'x',
              propOrSlot: { kind: 'prop', name: 'label' },
              matches: [{ selector: ':root', field: 'textContent' }],
            },
          ],
        }),
      )
      const result = await generateHintsRun({
        entry: { packageName: '@acme/ui', packageVersion: '1.0.0', designSystem: 'acme-ds' },
        cacheDir: dir,
        components,
        probe,
        inferHints: inferOk([inferredHint]),
        sentinelSuffix: 'S',
      })
      expect(result.probed).toBe(1)
      expect(result.hinted).toBe(1)
      expect(result.verified).toBe(1)
      expect(result.skipped).toEqual([])

      const file = readHintCache(hintCacheFilePath(dir, '@acme/ui', '1.0.0'))
      // Exactly ONE hint at the site — the probe-derived (verified) one won
      // the collision; the duplicate inferred hint was dropped.
      expect(file?.hints.UiButton).toHaveLength(1)
      expect(file?.hints.UiButton[0]).toMatchObject({ provenance: 'generated', verified: true })
    } finally {
      teardown()
    }
  })

  it('still skips (with the mount-failure reason) and writes nothing when BOTH probe and inference fail for a component', async () => {
    setup()
    try {
      const components = [manifest({ name: 'UiButton' })]
      const probe = vi.fn(async (): Promise<ProbeObservation> => ({ ok: false, reason: 'mount crashed', findings: [] }))
      const result = await generateHintsRun({
        entry: { packageName: '@acme/ui', packageVersion: '1.0.0', designSystem: 'acme-ds' },
        cacheDir: dir,
        components,
        probe,
        inferHints: inferFail('no matching source file'),
        sentinelSuffix: 'S',
      })
      expect(result.probed).toBe(0)
      expect(result.hinted).toBe(0)
      expect(result.skipped).toEqual([{ name: 'UiButton', reason: 'mount crashed' }])

      const file = readHintCache(hintCacheFilePath(dir, '@acme/ui', '1.0.0'))
      expect(file?.hints.UiButton).toBeUndefined()
    } finally {
      teardown()
    }
  })

  it('a mounted component with zero probe findings still picks up a non-colliding inferred hint', async () => {
    setup()
    try {
      const components = [manifest({ name: 'UiButton' })]
      const probe = vi.fn(async (): Promise<ProbeObservation> => ({ ok: true, findings: [] }))
      const inferredHint = domHint({
        source: { kind: 'prop', name: 'label' },
        domTarget: { selector: '.fallback-title', field: 'textContent' },
        provenance: 'inferred',
        verified: false,
      })
      const result = await generateHintsRun({
        entry: { packageName: '@acme/ui', packageVersion: '1.0.0', designSystem: 'acme-ds' },
        cacheDir: dir,
        components,
        probe,
        inferHints: inferOk([inferredHint]),
        sentinelSuffix: 'S',
      })
      expect(result.probed).toBe(1)
      expect(result.hinted).toBe(1)
      // Not every hint is verified (this one isn't) → the component doesn't
      // count toward `verified`.
      expect(result.verified).toBe(0)

      const file = readHintCache(hintCacheFilePath(dir, '@acme/ui', '1.0.0'))
      expect(file?.hints.UiButton).toEqual([inferredHint])
    } finally {
      teardown()
    }
  })

  it('C1: drops BOTH hints when the probe hints one prop and inference hints a DIFFERENT prop at the SAME site', async () => {
    setup()
    try {
      const components = [manifest({ name: 'UiButton', props: [prop({ name: 'first' }), prop({ name: 'second' })] })]
      const probe = vi.fn(
        async (): Promise<ProbeObservation> => ({
          ok: true,
          findings: [
            {
              sentinel: 'x',
              propOrSlot: { kind: 'prop', name: 'first' },
              matches: [{ selector: 'div.msg', field: 'textContent' }],
            },
          ],
        }),
      )
      const collidingInferredHint = domHint({
        source: { kind: 'prop', name: 'second' },
        domTarget: { selector: 'div.msg', field: 'textContent' },
        provenance: 'inferred',
        verified: false,
      })
      const result = await generateHintsRun({
        entry: { packageName: '@acme/ui', packageVersion: '1.0.0', designSystem: 'acme-ds' },
        cacheDir: dir,
        components,
        probe,
        inferHints: inferOk([collidingInferredHint]),
        sentinelSuffix: 'S',
      })
      // Mounted, but the cross-prop collision means zero SURVIVING hints —
      // not counted toward `hinted`.
      expect(result.probed).toBe(1)
      expect(result.hinted).toBe(0)
      expect(result.verified).toBe(0)

      const file = readHintCache(hintCacheFilePath(dir, '@acme/ui', '1.0.0'))
      expect(file?.hints.UiButton).toEqual([])
    } finally {
      teardown()
    }
  })

  it('an inference throw is isolated exactly like a probe throw — component skipped, run continues', async () => {
    setup()
    try {
      const components = [manifest({ name: 'Broken' }), manifest({ name: 'UiButton' })]
      const inferHints = vi.fn(async (m: ComponentManifest) => {
        if (m.name === 'Broken') throw new Error('fs blew up')
        return { ok: true, hints: [] } as InferFromSourceOutcome
      })
      const result = await generateHintsRun({
        entry: { packageName: '@acme/ui', packageVersion: '1.0.0', designSystem: 'acme-ds' },
        cacheDir: dir,
        components,
        inferHints,
        sentinelSuffix: 'S',
      })
      // Neither component has a probe, so neither is "probed" — but the run
      // itself completed for both (isolation): `Broken`'s inference throw is
      // surfaced as its skip reason, and `UiButton` (whose inference legitimately
      // found nothing, and had no probe either) is still reached and recorded.
      expect(result.skipped).toEqual([
        { name: 'Broken', reason: 'fs blew up' },
        { name: 'UiButton', reason: 'probe failed and no inference available' },
      ])
    } finally {
      teardown()
    }
  })
})

describe('computeHintCoverage', () => {
  it('computes hinted/verified/total from a hints map, treating empty arrays as "probed, not hinted"', () => {
    const coverage = computeHintCoverage({
      UiButton: [
        {
          kind: 'dom',
          source: { kind: 'prop', name: 'label' },
          domTarget: { selector: ':root', field: 'textContent' },
          editability: 'literal',
          provenance: 'generated',
          verified: true,
        },
      ],
      UiEmpty: [],
    })
    expect(coverage).toEqual({ hinted: 1, verified: 1, total: 2 })
  })

  it('does not count a hinted-but-unverified component as verified', () => {
    const coverage = computeHintCoverage({
      UiButton: [
        {
          kind: 'dom',
          source: { kind: 'prop', name: 'label' },
          domTarget: { selector: ':root', field: 'textContent' },
          editability: 'literal',
          provenance: 'inferred',
          verified: false,
        },
      ],
    })
    expect(coverage).toEqual({ hinted: 1, verified: 0, total: 1 })
  })

  it('returns all-zero for an empty hints map', () => {
    expect(computeHintCoverage({})).toEqual({ hinted: 0, verified: 0, total: 0 })
  })
})

describe('generateHintsRun — Task 5 (opt-in LLM lane)', () => {
  let dir: string
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'hints-run-llm-'))
    return dir
  }
  const teardown = () => rmSync(dir, { recursive: true, force: true })

  function fakeProvider(respond: (opts: CompleteOpts) => unknown[] | Error): CompletionProvider {
    const complete = vi.fn(async (opts: CompleteOpts): Promise<CompleteResult> => {
      const r = respond(opts)
      if (r instanceof Error) throw r
      const body = { hints: r }
      return {
        text: JSON.stringify(body),
        parsed: body,
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: 'end_turn',
      }
    })
    return { name: 'fake', defaultModel: 'fake-model', complete }
  }

  it('never calls the LLM when useLlm is omitted (default false)', async () => {
    setup()
    try {
      const components = [manifest({ name: 'UiEmpty' })]
      const probe = vi.fn(async (): Promise<ProbeObservation> => ({ ok: true, findings: [] }))
      const provider = fakeProvider(() => [])
      const result = await generateHintsRun({
        entry: { packageName: '@acme/design-system', packageVersion: '1.0.0', designSystem: 'acme-ds' },
        cacheDir: dir,
        components,
        probe,
        llm: { provider },
        sentinelSuffix: 'S',
      })
      expect(provider.complete).not.toHaveBeenCalled()
      expect(result.hinted).toBe(0)
      expect(result.probed).toBe(1)
    } finally {
      teardown()
    }
  })

  it('never calls the LLM when useLlm is explicitly false', async () => {
    setup()
    try {
      const components = [manifest({ name: 'UiEmpty' })]
      const probe = vi.fn(async (): Promise<ProbeObservation> => ({ ok: true, findings: [] }))
      const provider = fakeProvider(() => [])
      await generateHintsRun({
        entry: { packageName: '@acme/design-system', packageVersion: '1.0.0', designSystem: 'acme-ds' },
        cacheDir: dir,
        components,
        probe,
        useLlm: false,
        llm: { provider },
        sentinelSuffix: 'S',
      })
      expect(provider.complete).not.toHaveBeenCalled()
    } finally {
      teardown()
    }
  })

  it('runs the LLM lane ONLY for the zero-hint component, leaving an already-hinted component untouched', async () => {
    setup()
    try {
      const components = [manifest({ name: 'UiButton' }), manifest({ name: 'UiEmpty' })]
      const probe = vi.fn(async (spec): Promise<ProbeObservation> => {
        if (spec.exportName === 'UiEmpty') return { ok: true, findings: [] }
        return {
          ok: true,
          findings: [
            {
              sentinel: 'x',
              propOrSlot: { kind: 'prop', name: 'label' },
              matches: [{ selector: ':root', field: 'textContent' }],
            },
          ],
        }
      })
      const provider = fakeProvider(() => [
        { source: { kind: 'prop', name: 'label' }, domTarget: { selector: '.title', field: 'textContent' } },
      ])
      const result = await generateHintsRun({
        entry: { packageName: '@acme/design-system', packageVersion: '1.0.0', designSystem: 'acme-ds' },
        cacheDir: dir,
        components,
        probe,
        useLlm: true,
        llm: { provider },
        sentinelSuffix: 'S',
      })
      // Only UiEmpty (the zero-hint component) reached the LLM lane.
      expect(provider.complete).toHaveBeenCalledTimes(1)
      expect(result.probed).toBe(2)
      expect(result.hinted).toBe(2) // UiButton (probe) + UiEmpty (llm)
      expect(result.verified).toBe(1) // UiButton only — the llm hint is unverified (no probe re-check configured here)

      const file = readHintCache(hintCacheFilePath(dir, '@acme/design-system', '1.0.0'))
      expect(file?.hints.UiEmpty).toEqual([
        expect.objectContaining({ provenance: 'generated', verified: false, source: { kind: 'prop', name: 'label' } }),
      ])
    } finally {
      teardown()
    }
  })

  it('verifies an LLM hint via a post-generation probe re-check for a mounted-but-zero-hint component', async () => {
    setup()
    try {
      const components = [manifest({ name: 'UiEmpty' })]
      const probe = vi.fn(async (spec): Promise<ProbeObservation> => {
        // The ORIGINAL sentinel-probe mount (Task 3) always sets `slotText`
        // (buildProbeMountSpec always attempts the default slot); the LLM
        // lane's verify-only mount sets ONLY the one claimed prop/slot and
        // omits it for a prop-kind hint. Use that to tell the two mounts
        // apart: the first must find nothing (so UiEmpty reaches the LLM
        // lane at all), the second confirms the claimed site.
        if (spec.slotText === undefined && spec.props.label) {
          return {
            ok: true,
            findings: [
              {
                sentinel: spec.props.label,
                propOrSlot: { kind: 'prop', name: 'label' },
                matches: [{ selector: ':root', field: 'textContent' }],
              },
            ],
          }
        }
        return { ok: true, findings: [] }
      })
      const provider = fakeProvider(() => [
        { source: { kind: 'prop', name: 'label' }, domTarget: { selector: ':root', field: 'textContent' } },
      ])
      const result = await generateHintsRun({
        entry: { packageName: '@acme/design-system', packageVersion: '1.0.0', designSystem: 'acme-ds' },
        cacheDir: dir,
        components,
        probe,
        useLlm: true,
        llm: { provider },
        sentinelSuffix: 'S',
      })
      expect(result.hinted).toBe(1)
      expect(result.verified).toBe(1)
      const file = readHintCache(hintCacheFilePath(dir, '@acme/design-system', '1.0.0'))
      expect(file?.hints.UiEmpty).toEqual([expect.objectContaining({ verified: true })])
    } finally {
      teardown()
    }
  })

  it('never attempts probe verification for an unmountable component (no probe supplied at all)', async () => {
    setup()
    try {
      const components = [manifest({ name: 'UiButton' })]
      const provider = fakeProvider(() => [
        { source: { kind: 'prop', name: 'label' }, domTarget: { selector: ':root', field: 'textContent' } },
      ])
      const result = await generateHintsRun({
        entry: { packageName: '@acme/ui', packageVersion: '1.0.0', designSystem: 'acme-ds' },
        cacheDir: dir,
        components,
        // No probe at all — mirrors a repo-ingested entry.
        inferHints: async () => ({ ok: false, reason: 'no matching source file', hints: [] }),
        useLlm: true,
        llm: { provider },
        sentinelSuffix: 'S',
      })
      expect(result.probed).toBe(0)
      expect(result.hinted).toBe(1)
      expect(result.verified).toBe(0)
      // The original skip reason survives, annotated is NOT needed here since
      // the llm SUCCEEDED (only lane-reported skips get merged in) — the
      // component keeps its original "why wasn't this probed" reason.
      expect(result.skipped).toEqual([
        { name: 'UiButton', reason: 'no matching source file' },
      ])
      const file = readHintCache(hintCacheFilePath(dir, '@acme/ui', '1.0.0'))
      expect(file?.hints.UiButton).toEqual([expect.objectContaining({ verified: false })])
    } finally {
      teardown()
    }
  })

  it('merges an llm-lane skip reason into an existing skip entry when the LLM also fails', async () => {
    setup()
    try {
      const components = [manifest({ name: 'UiButton' })]
      const provider = fakeProvider(() => new Error('provider unavailable'))
      const result = await generateHintsRun({
        entry: { packageName: '@acme/ui', packageVersion: '1.0.0', designSystem: 'acme-ds' },
        cacheDir: dir,
        components,
        inferHints: async () => ({ ok: false, reason: 'no matching source file', hints: [] }),
        useLlm: true,
        llm: { provider },
        sentinelSuffix: 'S',
      })
      expect(result.hinted).toBe(0)
      expect(result.skipped).toEqual([
        {
          name: 'UiButton',
          reason: expect.stringMatching(/^no matching source file; llm: .*provider unavailable/),
        },
      ])
    } finally {
      teardown()
    }
  })

  it('adds a fresh skip entry for a mounted-but-llm-failed component (was never skipped before)', async () => {
    setup()
    try {
      const components = [manifest({ name: 'UiEmpty' })]
      const probe = vi.fn(async (): Promise<ProbeObservation> => ({ ok: true, findings: [] }))
      const provider = fakeProvider(() => [])
      const result = await generateHintsRun({
        entry: { packageName: '@acme/design-system', packageVersion: '1.0.0', designSystem: 'acme-ds' },
        cacheDir: dir,
        components,
        probe,
        useLlm: true,
        llm: { provider },
        sentinelSuffix: 'S',
      })
      expect(result.hinted).toBe(0)
      expect(result.skipped).toEqual([{ name: 'UiEmpty', reason: 'llm produced no usable hints' }])
    } finally {
      teardown()
    }
  })

  it('C1: drops BOTH LLM hints when the model claims two different props at the identical site', async () => {
    setup()
    try {
      const components = [manifest({ name: 'UiEmpty', props: [prop({ name: 'first' }), prop({ name: 'second' })] })]
      const probe = vi.fn(async (): Promise<ProbeObservation> => ({ ok: true, findings: [] }))
      const provider = fakeProvider(() => [
        { source: { kind: 'prop', name: 'first' }, domTarget: { selector: 'div.msg', field: 'textContent' } },
        { source: { kind: 'prop', name: 'second' }, domTarget: { selector: 'div.msg', field: 'textContent' } },
      ])
      const result = await generateHintsRun({
        entry: { packageName: '@acme/design-system', packageVersion: '1.0.0', designSystem: 'acme-ds' },
        cacheDir: dir,
        components,
        probe,
        useLlm: true,
        llm: { provider },
        sentinelSuffix: 'S',
      })
      expect(result.hinted).toBe(0)
      expect(result.skipped).toContainEqual({
        name: 'UiEmpty',
        reason: 'llm hints dropped: cross-prop selector collision',
      })
      const file = readHintCache(hintCacheFilePath(dir, '@acme/design-system', '1.0.0'))
      expect(file?.hints.UiEmpty).toEqual([])
    } finally {
      teardown()
    }
  })

  it('threads maxComponents/maxConcurrency/resolveDistExcerpt through to the LLM lane', async () => {
    setup()
    try {
      const components = [manifest({ name: 'A' }), manifest({ name: 'B' }), manifest({ name: 'C' })]
      const seenExcerpts: Array<string | undefined> = []
      const provider = fakeProvider((opts) => {
        const text = typeof opts.user === 'string' ? opts.user : opts.user.map((b) => b.text).join('\n')
        seenExcerpts.push(/SRC-(\w+)/.exec(text)?.[0])
        return []
      })
      const result = await generateHintsRun({
        entry: { packageName: '@acme/design-system', packageVersion: '1.0.0', designSystem: 'acme-ds' },
        cacheDir: dir,
        components,
        useLlm: true,
        llm: {
          provider,
          maxComponents: 2,
          resolveDistExcerpt: (m) => `SRC-${m.name}`,
        },
        sentinelSuffix: 'S',
      })
      expect(provider.complete).toHaveBeenCalledTimes(2)
      expect(seenExcerpts.filter(Boolean)).toHaveLength(2)
      expect(result.skipped.some((s) => s.reason.includes('llm budget'))).toBe(true)
    } finally {
      teardown()
    }
  })
})
