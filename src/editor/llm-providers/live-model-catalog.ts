/**
 * Live model lists for the chat picker, folded into the static catalog.
 *
 * The picker used to be the static `ANTHROPIC_MODEL_CATALOG` and nothing
 * else, so a model Anthropic shipped was invisible here until someone edited
 * that file. Since 2026-09-02 (Mo: "add the live functionality and have the
 * hard coded as a back up") the CLI asks for the live list on demand and
 * merges it over the static one; the static catalog is the fallback when
 * nothing live can be reached, and the source of the per-model detail the
 * live lists do not carry.
 *
 * This module is the PURE half: shaping either list into `LiveModel`s and
 * merging them into a catalog. The I/O (clients, the process spawn, caching,
 * which source applies) lives in `editor-cli/src/server/model-catalog-source.ts`.
 * The Anthropic-specific shaping (Models API / Agent SDK response parsing)
 * lives in `anthropic-live-models.ts`; this module has no vendor logic.
 *
 * Merge rules, in order of who knows best:
 *  - Membership and order come from the live list. A model the API no longer
 *    lists is gone from the picker even if the static file still names it.
 *  - Effort levels: an explicit live ladder wins (the Models API says per
 *    level); otherwise the static entry's ladder (it records what the API
 *    tree does not, such as Sonnet 4.6 lacking `xhigh`); otherwise the live
 *    "supports effort" flag; otherwise a caller-supplied fallback, since a
 *    brand-new model nobody has described yet still needs an answer.
 *  - Labels and descriptions: static first for the ones it knows, because a
 *    hand-written "Fast, near-Opus quality on coding" beats "Claude Sonnet 5".
 *  - The default is the static default when the live list has it, otherwise
 *    the first live entry. The picker never opens on a model that cannot be
 *    used.
 */

import type { EffortLevel, ModelOption, ProviderModelCatalog } from '../core/model-catalog'
import { EFFORT_LEVELS } from '../core/model-catalog'

export interface LiveModel {
  id: string
  label?: string
  description?: string
  /**
   * `EffortLevel[]` when the source enumerated levels, `null` when it said
   * effort is unsupported, `undefined` when it did not say per level.
   */
  effortLevels?: EffortLevel[] | null
  /** The coarse flag some sources carry instead of a ladder. */
  supportsEffort?: boolean
  /** Adaptive thinking, when the source says. See `ModelOption.adaptiveThinking`. */
  adaptiveThinking?: boolean
}

const FULL_EFFORT_LADDER: EffortLevel[] = [...EFFORT_LEVELS]

export interface MergeLiveOptions {
  /** What a live model with no effort information of any kind gets. */
  effortFallback: (id: string) => EffortLevel[] | null
}

/**
 * Fold a live list over the static catalog. Returns `null` when the live
 * list is empty, which callers treat as "nothing live: use the static one";
 * a picker with no entries is worse than a stale picker.
 */
export function mergeLiveModels(
  catalog: ProviderModelCatalog,
  live: readonly LiveModel[],
  opts: MergeLiveOptions,
): ProviderModelCatalog | null {
  if (live.length === 0) return null
  const staticById = new Map(catalog.models.map((m) => [m.id, m]))
  const staticDefault = catalog.models.find((m) => m.isDefault)
  const seen = new Set<string>()
  const models: ModelOption[] = []
  for (const entry of live) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    const known = staticById.get(entry.id)
    const effortLevels =
      entry.effortLevels !== undefined
        ? entry.effortLevels
        : known
          ? known.effortLevels
          : entry.supportsEffort === true
            ? FULL_EFFORT_LADDER
            : opts.effortFallback(entry.id)
    const description = known?.description ?? entry.description
    const adaptiveThinking = entry.adaptiveThinking ?? known?.adaptiveThinking
    models.push({
      id: entry.id,
      label: known?.label ?? entry.label ?? entry.id,
      ...(description ? { description } : {}),
      effortLevels,
      ...(typeof adaptiveThinking === 'boolean' ? { adaptiveThinking } : {}),
    })
  }
  const defaultId = staticDefault && seen.has(staticDefault.id) ? staticDefault.id : models[0]!.id
  return {
    providerId: catalog.providerId,
    models: models.map((m) => (m.id === defaultId ? { ...m, isDefault: true } : m)),
  }
}
