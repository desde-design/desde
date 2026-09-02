/**
 * `HintsCacheManifestSource` — the manifest source that serves
 * non-hand-authored `RenderingHint`s (probe-derived, source-inferred, or
 * LLM-generated — see `docs/superpowers/plans/
 * 2026-07-26-grounding-phase4-rendering-hints.md`) from on-disk
 * `<package>@<version>.hints.json` files.
 *
 * Why a separate store from `CachedManifestSource` (`../cached/index.ts`):
 * that cache persists whole `ComponentManifest[]` (props + everything) for
 * an EXTRACTOR run; this one persists ONLY `rendering` hints, keyed the
 * same way (`packageName@packageVersion`) but written by a completely
 * different, explicit, user-triggered pipeline (hint generation, not prop
 * extraction). Keeping the file formats and classes separate means
 * generating hints for a package never touches (or risks corrupting) its
 * extracted-props cache, and vice versa.
 *
 * Trust: every hint this source can produce is either `provenance:
 * 'generated'` or `'inferred'`, `verified` true only when probe-confirmed.
 * The attribution trust gate (`isTrustedHint` in
 * `src/editor/attribution/attribute.ts`) is what decides whether any of
 * this is actually usable for a deterministic edit — this module has no
 * opinion on trust, it just reads/writes/serves what's on disk.
 *
 * Composite ordering: registered in `MANIFEST_SOURCE_ORDER` AFTER every
 * props source — see `src/editor/edit-service/build-manifest-source.ts`. Per
 * `CompositeManifestSource`'s overlay rule, `listComponents()` is
 * intentionally always `[]`: this source never wins the props race, it
 * only ever contributes `rendering` via `getComponent`'s hint overlay scan.
 *
 * One instance PER PACKAGE ENTRY (not one shared instance over every
 * package): each `HintsCacheManifestSource` is scoped to a single
 * `HintsCacheEntry` and serves only that package's hint file — see the
 * class doc comment for why an earlier multi-entry design (which refused
 * with `null` whenever two entries' files both named the same component)
 * was wrong. `build-manifest-source.ts`'s `hints-cache` step constructs one
 * source per entry, in entry order, and pushes each into the composite;
 * `CompositeManifestSource`'s `isPlausiblySameComponent` identity guard
 * (matching on `designSystem`/`importPath` against the props winner) is
 * what selects the right package's hints automatically — no ambiguity
 * handling belongs in this class at all, because a single-package source
 * has no ambiguity by construction.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  ComponentManifest,
  ComponentManifestSource,
  DesignSystemId,
  FrameworkId,
  RenderingHint,
} from '../../core'
import { sanitize } from '../cached'

/** On-disk format version for `.hints.json` files. */
export const HINTS_SCHEMA_VERSION = 1

/** One package's generated/inferred rendering hints, keyed by component name. */
export interface HintCacheFile {
  schema: 1
  packageName: string
  packageVersion: string
  generatedAt: string
  /** componentName → hints */
  hints: Record<string, RenderingHint[]>
}

/** `${sanitize(pkg)}@${sanitize(version)}.hints.json` under `cacheDir`. */
export function hintCacheFilePath(
  cacheDir: string,
  packageName: string,
  packageVersion: string,
): string {
  return join(cacheDir, `${sanitize(packageName)}@${sanitize(packageVersion)}.hints.json`)
}

/**
 * Read a hint cache file. Returns `null` on missing, unreadable, corrupt,
 * or schema-mismatched files — callers treat that as "no generated hints
 * for this package yet," never as an error.
 */
export function readHintCache(file: string): HintCacheFile | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  let parsed: Partial<HintCacheFile>
  try {
    parsed = JSON.parse(text) as Partial<HintCacheFile>
  } catch {
    return null
  }
  if (
    parsed.schema !== HINTS_SCHEMA_VERSION ||
    typeof parsed.packageName !== 'string' ||
    typeof parsed.packageVersion !== 'string' ||
    typeof parsed.generatedAt !== 'string' ||
    typeof parsed.hints !== 'object' ||
    parsed.hints === null ||
    Array.isArray(parsed.hints)
  ) {
    return null
  }
  return parsed as HintCacheFile
}

/**
 * Write a hint cache file atomically (tmp file + rename, so a concurrent
 * reader never sees a torn/partial JSON). Best-effort: a failure (missing
 * permissions, unwritable path) is swallowed rather than thrown — hint
 * generation is an optimization/UX feature, never a correctness dependency,
 * and the caller's in-memory result is still usable even if persistence
 * fails.
 */
export function writeHintCache(file: string, data: HintCacheFile): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data), 'utf8')
    renameSync(tmp, file)
  } catch {
    // Non-fatal: see doc comment above.
  }
}

/** One package this source should consult for generated/inferred hints. */
export interface HintsCacheEntry {
  packageName: string
  packageVersion: string
  designSystem: DesignSystemId
  framework: FrameworkId
  importPath: string
}

export interface HintsCacheManifestSourceOptions {
  /** Directory hint cache files live under (typically `.desde/manifests`). */
  cacheDir: string
  /** The single package this source consults for generated/inferred hints. */
  entry: HintsCacheEntry
}

/**
 * Serves minimal manifests carrying ONLY generated/inferred `rendering`
 * hints for ONE package — props always stay owned by the dts/props
 * sources. The `CompositeManifestSource` overlay (`getComponent`) takes
 * `rendering` from whichever source provides it first when the props
 * winner has none; this source exists to be that later, hints-only
 * fallback. See the module doc comment for why this is one instance per
 * package entry, not one shared instance over every package.
 *
 * Reads are NOT cached in memory across calls — `readHintCache` is a
 * cheap sync file read of a small JSON file, and re-reading means a
 * freshly (re-)generated hint file is picked up without needing an
 * explicit invalidation call.
 */
export class HintsCacheManifestSource implements ComponentManifestSource {
  readonly id: string
  readonly framework: FrameworkId
  readonly designSystem: DesignSystemId

  private readonly cacheDir: string
  private readonly entry: HintsCacheEntry

  constructor(options: HintsCacheManifestSourceOptions) {
    this.cacheDir = options.cacheDir
    this.entry = options.entry
    this.framework = options.entry.framework
    this.designSystem = options.entry.designSystem
    this.id = `hints-cache:${options.entry.packageName}`
  }

  async getComponent(name: string): Promise<ComponentManifest | null> {
    // No ambiguity handling here: this source is scoped to exactly ONE
    // package, so a match against ITS hint file is never in competition
    // with another package's file within this class. Cross-package
    // identity (rejecting a graft onto the wrong props winner) is the
    // composite's job — see `CompositeManifestSource.getComponent`'s
    // `isPlausiblySameComponent` guard.
    const entry = this.entry
    const file = hintCacheFilePath(this.cacheDir, entry.packageName, entry.packageVersion)
    if (!existsSync(file)) return null
    const cache = readHintCache(file)
    const hints: RenderingHint[] | undefined = cache?.hints[name]
    if (!hints || hints.length === 0) return null
    return {
      id: `${entry.packageName}:${name}`,
      name,
      framework: entry.framework,
      designSystem: entry.designSystem,
      importPath: entry.importPath,
      props: [],
      rendering: hints,
    }
  }

  /**
   * Never contributes catalog entries — per the composite's overlay
   * semantics, this source's ONLY job is supplying `rendering` via
   * `getComponent`; `listComponents` staying empty keeps it out of the
   * props-merge race entirely.
   */
  async listComponents(): Promise<ComponentManifest[]> {
    return []
  }
}
