/**
 * Concrete in-memory implementation of {@link IconSetRegistry}. Owned
 * by the editor CLI process; populated at startup by
 * {@link autoDetectIconSets} (zero-config path) and/or a future
 * `desde.config.json` reader. Exposed to the inspector via the
 * HTTP server (`GET /api/editor/icon-sets`).
 *
 * The registry is the only icon-related dependency the picker UI and
 * swap dispatcher import — they never reach into specific adapters.
 */

import type {
  IconSearchHit,
  IconSetRegistry,
  IconSetSource,
} from '../core'

export class InMemoryIconSetRegistry implements IconSetRegistry {
  private readonly sources = new Map<string, IconSetSource>()

  register(source: IconSetSource): void {
    if (this.sources.has(source.id)) {
      throw new Error(
        `IconSetRegistry already has a source registered with id "${source.id}". ` +
          `Adapter ids must be unique within a registry.`,
      )
    }
    this.sources.set(source.id, source)
  }

  list(): IconSetSource[] {
    return [...this.sources.values()]
  }

  get(sourceId: string): IconSetSource | null {
    return this.sources.get(sourceId) ?? null
  }

  findOwnerOfPackage(packageName: string): IconSetSource | null {
    for (const source of this.sources.values()) {
      if (
        source.usagePattern.kind === 'named-component-import' &&
        source.usagePattern.packageName === packageName
      ) {
        return source
      }
    }
    return null
  }

  async searchIcons(query: string): Promise<IconSearchHit[]> {
    const needle = query.trim().toLowerCase()
    if (!needle) return []

    const hits: IconSearchHit[] = []
    for (const source of this.sources.values()) {
      const icons = await source.listIcons()
      for (const icon of icons) {
        if (matchesQuery(icon, needle)) {
          hits.push({ sourceId: source.id, icon })
        }
      }
    }
    return hits
  }
}

function matchesQuery(
  icon: { id: string; displayName: string; category?: string; tags: string[] },
  needle: string,
): boolean {
  if (icon.id.toLowerCase().includes(needle)) return true
  if (icon.displayName.toLowerCase().includes(needle)) return true
  if (icon.category && icon.category.toLowerCase().includes(needle)) return true
  for (const tag of icon.tags) {
    if (tag.toLowerCase().includes(needle)) return true
  }
  return false
}
