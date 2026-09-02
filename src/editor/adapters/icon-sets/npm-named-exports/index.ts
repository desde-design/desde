/**
 * `IconSetSource` for npm packages that expose their icons as named
 * default-re-exports — `@acme/icons`, `lucide-react`, `@heroicons/react`,
 * and similar. The adapter resolves the package from the open
 * prototype's `node_modules`, parses its TypeScript declarations to
 * enumerate icons + categorization, and emits `IconManifest`s with
 * placeholder previews. Real previews are backfilled by the renderer
 * in `src/editor/icon-preview/` (see slice 3).
 *
 * The adapter is framework-neutral in code but framework-declared at
 * the instance level — Vue SFC packages get `framework: 'vue3'`,
 * React component packages get `'react'`. The editor registry
 * filters sets against the open project's framework so the picker
 * never offers React icons to a Vue prototype.
 *
 * Substrate-neutrality: the literal package name (`@acme/icons`,
 * `lucide-react`) is supplied at construction time. This file MUST
 * never mention specific packages inline.
 */

import { promises as fs } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type {
  FrameworkId,
  IconManifest,
  IconSetSource,
  IconUsagePattern,
} from '../../../core'
import { renderIconPreviews } from '../../../icon-preview/render'
import { enumerateNamedExports, type DiscoveredExport } from './enumerate'

export interface NpmNamedExportsAdapterOptions {
  /** Absolute path to the open prototype repo. `node_modules/<packageName>` is resolved from here. */
  prototypeRoot: string
  /** Public package name, e.g. `'@acme/icons'`. Used both for resolution and as the swap `importPath`. */
  packageName: string
  /** Stable registry key, kebab-case. */
  id: string
  /** Picker-facing label for the set's group header. */
  displayName: string
  /** Framework this set's icons target. The picker uses this to filter sets per project. */
  framework: FrameworkId | 'any'
  /** Override the default `/Icon$/` export filter. */
  iconPattern?: RegExp
  /**
   * Skip the preview render subprocess entirely. The adapter returns
   * the placeholder SVG for every icon. Useful for tests that exercise
   * enumeration without needing a real renderer.
   */
  skipPreviews?: boolean
}

const PLACEHOLDER_PREVIEW = {
  kind: 'svg' as const,
  markup:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><rect width="24" height="24" fill="none" stroke="currentColor" stroke-dasharray="2 2"/></svg>',
}

export class NpmNamedExportsAdapter implements IconSetSource {
  readonly id: string
  readonly displayName: string
  readonly framework: FrameworkId | 'any'
  readonly usagePattern: IconUsagePattern

  private readonly prototypeRoot: string
  private readonly packageName: string
  private readonly iconPattern?: RegExp
  private readonly skipPreviews: boolean
  private cache: Promise<IconManifest[]> | null = null

  constructor(options: NpmNamedExportsAdapterOptions) {
    this.id = options.id
    this.displayName = options.displayName
    this.framework = options.framework
    this.prototypeRoot = options.prototypeRoot
    this.packageName = options.packageName
    this.iconPattern = options.iconPattern
    this.skipPreviews = options.skipPreviews ?? false
    this.usagePattern = { kind: 'named-component-import', packageName: options.packageName }
  }

  async listIcons(): Promise<IconManifest[]> {
    if (!this.cache) {
      // Cache the load() promise so concurrent listIcons() calls
      // share one subprocess + one enumeration. If load() rejects,
      // CLEAR the cache so the next call retries — otherwise a
      // transient failure (npm ci race, momentary fs read error)
      // poisons the adapter for the rest of the session.
      const inflight = this.load()
      this.cache = inflight
      inflight.catch(() => {
        if (this.cache === inflight) this.cache = null
      })
    }
    return this.cache
  }

  async getIcon(id: string): Promise<IconManifest | null> {
    const all = await this.listIcons()
    return all.find((icon) => icon.id === id) ?? null
  }

  private async load(): Promise<IconManifest[]> {
    const typesEntry = await resolveTypesEntry(this.prototypeRoot, this.packageName)
    const discovered = await enumerateNamedExports({
      rootTypesFile: typesEntry,
      iconPattern: this.iconPattern,
    })

    const previews = await this.loadPreviews(discovered.map((d) => d.exportName))
    return discovered.map((d) => this.toManifest(d, previews))
  }

  /**
   * Render previews for the full set in one subprocess call. Renderer
   * failures are swallowed — the picker still surfaces icons with a
   * placeholder rather than blocking the whole set. Per-icon failures
   * inside the renderer are reflected by `previews` not containing the
   * key (the same fallback applies).
   */
  private async loadPreviews(iconExports: string[]): Promise<Record<string, string>> {
    if (this.skipPreviews || iconExports.length === 0) return {}
    try {
      const result = await renderIconPreviews({
        framework: this.framework,
        packageName: this.packageName,
        iconExports,
        prototypeRoot: this.prototypeRoot,
      })
      return result.previews
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Log to stderr but never fail listIcons over preview problems.
       
      console.warn(
        `[icon-sets:${this.id}] preview render failed, falling back to placeholders: ${message}`,
      )
      return {}
    }
  }

  private toManifest(
    discovered: DiscoveredExport,
    previews: Record<string, string>,
  ): IconManifest {
    const category =
      discovered.categoryPath.length > 0
        ? discovered.categoryPath[discovered.categoryPath.length - 1]
        : undefined
    const rendered = previews[discovered.exportName]
    return {
      id: discovered.exportName,
      displayName: humanize(discovered.exportName),
      category,
      tags: [],
      ref: {
        kind: 'named-component-import',
        exportName: discovered.exportName,
        importPath: this.packageName,
      },
      preview: rendered ? { kind: 'svg', markup: rendered } : PLACEHOLDER_PREVIEW,
    }
  }
}

/**
 * Resolve the absolute path to a package's TypeScript entry
 * declaration file by reading its `package.json#types` /
 * `package.json#typings` field. Throws if the package isn't
 * installed or doesn't ship a types entry — callers should treat
 * either as "this set is not usable in this project".
 */
async function resolveTypesEntry(prototypeRoot: string, packageName: string): Promise<string> {
  const packageDir = join(prototypeRoot, 'node_modules', packageName)
  let pkgJson: { types?: string; typings?: string }
  try {
    pkgJson = JSON.parse(await fs.readFile(join(packageDir, 'package.json'), 'utf8'))
  } catch (err) {
    throw new Error(
      `Cannot read package.json for "${packageName}" under "${prototypeRoot}/node_modules". ` +
        `Is the package installed? (${err instanceof Error ? err.message : String(err)})`,
    )
  }

  const typesRel = pkgJson.types ?? pkgJson.typings
  if (!typesRel) {
    throw new Error(
      `Package "${packageName}" has no "types" or "typings" field in package.json — ` +
        `npm-named-exports adapter cannot enumerate it without TS declarations.`,
    )
  }

  const typesAbs = isAbsolute(typesRel) ? typesRel : resolve(packageDir, typesRel)

  // Validate the path exists; allow either the file directly or its
  // containing dir's index.d.ts (some packages point `types` at a folder).
  try {
    const stat = await fs.stat(typesAbs)
    if (stat.isFile()) return typesAbs
    if (stat.isDirectory()) {
      const indexed = join(typesAbs, 'index.d.ts')
      await fs.stat(indexed)
      return indexed
    }
  } catch (err) {
    throw new Error(
      `Types entry for "${packageName}" not found at "${typesAbs}" — ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  throw new Error(`Types entry for "${packageName}" at "${typesAbs}" is not a file or directory.`)
}

/**
 * Turn a PascalCase export name into a human-readable label.
 * `'DataObjectIcon'` → `'Data object'`. Drops a trailing `Icon`
 * suffix when present. Acronym-aware enough for normal use — we
 * don't try to title-case domain abbreviations (`'AwsIcon'` →
 * `'Aws'`, not `'AWS'`); a future curated label override can refine
 * this without changing the adapter shape.
 */
function humanize(exportName: string): string {
  const stripped = exportName.replace(/Icon$/, '')
  if (!stripped) return exportName
  const spaced = stripped
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  const lowered = spaced.toLowerCase()
  return lowered.charAt(0).toUpperCase() + lowered.slice(1)
}

// Exported for unit testing.
export const __testing = { humanize, resolveTypesEntry }
