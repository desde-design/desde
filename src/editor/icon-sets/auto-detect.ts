/**
 * Zero-config icon-set discovery. Reads the open prototype's
 * `package.json`, finds installed dependencies that actually LOOK like
 * icon packages when probed, and returns adapter instances for each
 * (filtered by the prototype's framework).
 *
 * **Shape-verified, not name-listed.** There is deliberately no catalog of
 * blessed packages here. Detection is two-stage:
 *
 *   1. *Candidate gate* (cheap, name-based): a declared dependency whose
 *      name mentions "icon". This exists only to bound the work — probing
 *      every dependency's declaration tree at boot would be far too
 *      expensive, and a package with no "icon" in its name is not an icon
 *      library by any convention we've seen.
 *   2. *Shape verification* (authoritative): the candidate's TypeScript
 *      declarations are enumerated with the SAME parser the adapter uses
 *      at serve time ({@link enumerateNamedExports}). A candidate is
 *      registered only if that yields at least one icon-shaped named
 *      export. So a package whose declarations don't match the adapter's
 *      supported shape is silently skipped rather than registered as a set
 *      that would surface empty (or throw) in the picker.
 *
 * The second stage is what keeps this honest. `@heroicons/react` publishes
 * only subpath entries and `lucide-react`'s declaration shape doesn't match
 * `enumerateNamedExports`; both fail verification and are not offered,
 * instead of being promised and then delivering nothing. Supporting them is
 * an adapter/enumerator change (a subpath-aware variant), and when that
 * lands they start being detected here with no edit to this file.
 *
 * Substrate-neutrality: this file names no package, no design system, and
 * no vendor. Id, label and framework are all derived from what is installed.
 */

import { promises as fs } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { FrameworkId, IconSetSource } from '../core'
import { NpmNamedExportsAdapter } from '../adapters/icon-sets/npm-named-exports'
import { enumerateNamedExports } from '../adapters/icon-sets/npm-named-exports/enumerate'

/**
 * Candidate gate — a dependency name that mentions "icon". Bounds the
 * probe; never decides the outcome on its own (see stage 2 above).
 */
const ICON_ISH_NAME_RE = /icon/i

/**
 * Cost caps, applied to WORK DONE rather than to candidates considered.
 *
 * Truncating the candidate list before probing made detection depend on
 * package.json ORDER: a project with more than the cap's worth of icon-ish
 * dependency names would silently skip a valid icon package sitting later in
 * the list, because unsupported or wrong-framework candidates ahead of it had
 * already spent the budget. Real projects plausibly carry several icon-ish
 * names (lucide, heroicons, iconify, phosphor, a first-party set…), so that
 * was reachable, and it failed silently — an empty picker with no reason.
 *
 * Now every icon-ish candidate is probed until either the probe budget is
 * spent (pathological trees still can't stall boot) or enough sets have been
 * verified.
 */
const MAX_PROBES = 32
const MAX_DETECTED_SETS = 8

export interface AutoDetectInput {
  /** Absolute path to the open prototype repo. */
  prototypeRoot: string
  /**
   * The prototype's framework. Sets whose `framework` doesn't match
   * are excluded — a Vue project never sees React icons. Omit to
   * skip framework filtering (all detected sets returned).
   */
  framework?: FrameworkId
}

export async function autoDetectIconSets(input: AutoDetectInput): Promise<IconSetSource[]> {
  const installed = await readInstalledPackages(input.prototypeRoot)
  const candidates = [...installed].filter((name) => ICON_ISH_NAME_RE.test(name))

  const sources: IconSetSource[] = []
  let probes = 0
  for (const packageName of candidates) {
    if (sources.length >= MAX_DETECTED_SETS) break

    // Cheap definite-mismatch skip, deliberately BEFORE the budget check.
    // A React icon package in a Vue prototype would be probed in full and
    // then thrown away by the framework filter below — spending budget that
    // a valid, correct-framework package later in the list then can't have.
    // That is the same order-dependence the budget change fixed, in a new
    // place. This cannot change the outcome: `inferFramework` returns
    // exactly this value from package.json alone whenever one of vue/react
    // is declared and the other is not, so such a candidate was always
    // destined to be filtered.
    if (input.framework) {
      const declared = await declaredFrameworkFromPackageJson(input.prototypeRoot, packageName)
      if (declared && declared !== input.framework) continue
    }

    if (probes >= MAX_PROBES) break
    probes += 1
    const probe = await probeIconPackage(input.prototypeRoot, packageName)
    if (!probe) continue
    if (input.framework && probe.framework !== 'any' && probe.framework !== input.framework) continue

    sources.push(
      new NpmNamedExportsAdapter({
        prototypeRoot: input.prototypeRoot,
        packageName,
        id: iconSetId(packageName),
        displayName: iconSetLabel(packageName),
        framework: probe.framework,
      }),
    )
  }

  return sources
}

/**
 * Stage 2: does this package actually enumerate as an icon set, and for
 * which framework? Returns `null` for anything that doesn't — a missing
 * `types` field, an unreadable declaration tree, or zero icon-shaped
 * exports. Never throws; a candidate that can't be probed is simply not a
 * detected set.
 */
async function probeIconPackage(
  prototypeRoot: string,
  packageName: string,
): Promise<{ framework: FrameworkId | 'any' } | null> {
  const packageDir = join(prototypeRoot, 'node_modules', ...packageName.split('/'))

  let pkgJson: {
    types?: string
    typings?: string
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  try {
    pkgJson = JSON.parse(await fs.readFile(join(packageDir, 'package.json'), 'utf8'))
  } catch {
    return null
  }

  const typesRel = pkgJson.types ?? pkgJson.typings
  if (!typesRel) return null
  const typesAbs = isAbsolute(typesRel) ? typesRel : resolve(packageDir, typesRel)

  let discovered: Awaited<ReturnType<typeof enumerateNamedExports>>
  try {
    discovered = await enumerateNamedExports({ rootTypesFile: typesAbs })
  } catch {
    return null
  }
  if (discovered.length === 0) return null

  return { framework: inferFramework(pkgJson, discovered.map((d) => d.sourceFile)) }
}

/**
 * Which framework do these icons target? The package's own declared
 * `vue`/`react` dependency is the strongest signal (icon libraries declare
 * their renderer as a peer). Falling back to the resolved declaration file
 * extensions covers a package that declares neither.
 */
/**
 * The framework a package DECLARES, read from its package.json alone —
 * `null` when it declares both or neither and only its declaration files
 * could decide.
 *
 * Mirrors `inferFramework`'s first two branches exactly, so skipping on a
 * definite mismatch is outcome-neutral: any candidate this rejects would
 * have been rejected by the framework filter after a full probe. It exists
 * only to stop that wasted probe consuming the budget.
 */
async function declaredFrameworkFromPackageJson(
  prototypeRoot: string,
  packageName: string,
): Promise<FrameworkId | null> {
  const packageDir = join(prototypeRoot, 'node_modules', ...packageName.split('/'))
  try {
    const pkgJson = JSON.parse(await fs.readFile(join(packageDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const declared = new Set([
      ...Object.keys(pkgJson.dependencies ?? {}),
      ...Object.keys(pkgJson.peerDependencies ?? {}),
    ])
    const hasVue = declared.has('vue')
    const hasReact = declared.has('react')
    if (hasVue && !hasReact) return 'vue3'
    if (hasReact && !hasVue) return 'react'
    return null
  } catch {
    return null
  }
}

function inferFramework(
  pkgJson: { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> },
  sourceFiles: string[],
): FrameworkId | 'any' {
  const declared = new Set([
    ...Object.keys(pkgJson.dependencies ?? {}),
    ...Object.keys(pkgJson.peerDependencies ?? {}),
  ])
  const hasVue = declared.has('vue')
  const hasReact = declared.has('react')
  if (hasVue && !hasReact) return 'vue3'
  if (hasReact && !hasVue) return 'react'
  if (sourceFiles.some((f) => /\.vue(\.d\.ts)?$/.test(f))) return 'vue3'
  if (sourceFiles.some((f) => /\.[jt]sx(\.d\.ts)?$/.test(f))) return 'react'
  return 'any'
}

/**
 * Stable kebab-case registry id derived from the package name:
 * `@acme/icons` → `acme-icons`, `tabler-icons-vue` → `tabler-icons-vue`.
 */
export function iconSetId(packageName: string): string {
  return packageName
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

/** Picker-facing label derived from the package name: `@acme/icons` → `Acme Icons`. */
export function iconSetLabel(packageName: string): string {
  return iconSetId(packageName)
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Read the prototype's `package.json` and return the set of installed
 * package names across `dependencies`, `devDependencies`, `peerDependencies`,
 * and `optionalDependencies`. Returns an empty set when `package.json`
 * is missing or malformed — auto-detect is best-effort.
 */
async function readInstalledPackages(prototypeRoot: string): Promise<Set<string>> {
  const installed = new Set<string>()
  try {
    const raw = await fs.readFile(join(prototypeRoot, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      const deps = pkg[field]
      if (!deps) continue
      for (const name of Object.keys(deps)) installed.add(name)
    }
  } catch {
    // Missing or malformed package.json — auto-detect yields nothing,
    // which is the right outcome (the registry just stays empty).
  }
  return installed
}

// Exported for unit tests.
export const __testing = { ICON_ISH_NAME_RE, probeIconPackage, inferFramework }
