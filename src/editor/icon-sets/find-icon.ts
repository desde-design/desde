/**
 * Pure helpers for "is this selection an icon?" detection. Both the
 * server (via the IconSetRegistry) and the client (via the JSON
 * returned by GET /api/editor/icon-sets) call into the same shape.
 *
 * V1 detection rule: a selection is an icon when the selected element's
 * tag name matches an icon's `ref.exportName` in any registered set
 * whose `usagePattern.kind === 'named-component-import'`. We do not
 * cross-check the consumer SFC's import for the tag — false positives
 * from a project that re-uses an icon export name for an unrelated
 * local component are accepted as a rare-edge tradeoff for client-side
 * speed (no per-selection HTTP roundtrip). Add an import-aware
 * verification path here if that ever surfaces as a real problem.
 *
 * Other usage patterns (string-prop, css-class, sprite-ref) would key
 * detection off different selection metadata — the dispatcher inside
 * this function grows when those adapters ship.
 */

import type { IconManifest, IconSetSource, IconSearchHit } from '../core'

export interface FindIconInput {
  /** The selected element's tag name (e.g. `'DataObjectIcon'`). */
  tag: string
  /** The sets to search, in registration order. */
  sets: ReadonlyArray<SerializedIconSetShape>
}

/**
 * Shape both the server registry and the client JSON satisfy. Defined
 * structurally so this helper never imports server-only or
 * client-only types.
 */
export interface SerializedIconSetShape {
  id: string
  usagePattern: IconSetSource['usagePattern']
  icons: ReadonlyArray<IconManifest>
}

export function findIconByTag(input: FindIconInput): IconSearchHit | null {
  if (!input.tag) return null
  for (const set of input.sets) {
    if (set.usagePattern.kind !== 'named-component-import') continue
    for (const icon of set.icons) {
      if (icon.ref.kind !== 'named-component-import') continue
      if (icon.ref.exportName === input.tag) {
        return { sourceId: set.id, icon }
      }
    }
  }
  return null
}

/**
 * Convenience for the server: same lookup but pulls icons from each
 * source via `listIcons()`. Returns `null` when no source claims the
 * tag. The first match (in registration order) wins.
 */
export async function findIconInRegistry(
  tag: string,
  sources: ReadonlyArray<IconSetSource>,
): Promise<IconSearchHit | null> {
  if (!tag) return null
  for (const source of sources) {
    if (source.usagePattern.kind !== 'named-component-import') continue
    const icons = await source.listIcons()
    const hit = icons.find(
      (icon) => icon.ref.kind === 'named-component-import' && icon.ref.exportName === tag,
    )
    if (hit) return { sourceId: source.id, icon: hit }
  }
  return null
}
