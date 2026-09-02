/**
 * Coverage-as-a-library (spec §8): tally how well a freshly-extracted manifest
 * source covers a design system. Extracted from `tasks/scripts/manifest-
 * coverage.mts` so both the CLI script and the onboarding API/orchestrator
 * (6.3) report the same numbers.
 *
 * Pure over the source: runs `listComponents()` once and classifies each
 * manifest by whether it has any editable prop. The optional `discoveredNames`
 * lets the caller (which ran the discovery step) report `failedComponents` —
 * names that were discovered but didn't survive extraction (analyzed-and-threw
 * or filtered to nothing the source dropped) — so a partial extraction reads
 * as partial, not "fully covered."
 */

import type { ComponentManifestSource } from '@/editor/core/manifest'
import type { CoverageReport } from './types'

export interface ComputeCoverageOptions {
  /**
   * Component names the discovery step found (before extraction). When given,
   * `discovered` reflects this and `failedComponents` = discovered − listed.
   * Omitted → `discovered` = the number of listed manifests (no failure detail).
   */
  discoveredNames?: string[]
  /** How many components to include in `sampleProps` (default 5). */
  sampleLimit?: number
  /** Max prop names per sampled component (default 8). */
  propSampleLimit?: number
}

export async function computeCoverage(
  source: ComponentManifestSource,
  opts: ComputeCoverageOptions = {},
): Promise<CoverageReport> {
  const sampleLimit = opts.sampleLimit ?? 5
  const propSampleLimit = opts.propSampleLimit ?? 8

  const manifests = await source.listComponents()
  const listedNames = new Set(manifests.map((m) => m.name))

  const withProps = manifests.filter((m) => (m.props ?? []).length > 0)
  const empty = manifests.filter((m) => (m.props ?? []).length === 0)

  const discovered = opts.discoveredNames?.length ?? manifests.length
  const failedComponents = opts.discoveredNames
    ? opts.discoveredNames.filter((n) => !listedNames.has(n))
    : []

  const sampleProps: Record<string, string[]> = {}
  for (const m of withProps.slice(0, sampleLimit)) {
    sampleProps[m.name] = (m.props ?? [])
      .slice(0, propSampleLimit)
      .map((p) => p.name)
  }

  return {
    discovered,
    extracted: withProps.length,
    empty: empty.length,
    failedComponents,
    sampleProps,
  }
}
