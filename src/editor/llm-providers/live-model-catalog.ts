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
 *  - The default is the static default when the live list has it. Otherwise,
 *    when the descriptor's `defaultAlias` rule recognises a live id as a
 *    stand-in for it, that alias becomes the default: a vendor can retire
 *    the bare id and keep serving it only under a dated snapshot (Anthropic)
 *    or a named tier (OpenAI's `gpt-5.6-sol`), and the flagship should not
 *    lose its place just because the bare id disappeared. Otherwise, the
 *    first live entry. The picker never opens on a model that cannot be used.
 *
 *    The alias rule is PER PROVIDER, supplied by the caller (the provider's
 *    `ProviderDescriptor.defaultAlias`), not guessed generically here. A
 *    generic "starts with the default id plus a dash" guess used to pick
 *    ANY matching live id in live order — which is newest-first, so a newer
 *    and more expensive tier that happens to share the stem (`gpt-5.6-cyber`)
 *    could outrank the intended alias (`gpt-5.6-sol`) with no UI saying the
 *    user's default just got pricier. See `DefaultAliasRule`.
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

/**
 * How a provider's live ids can stand in for its static default when the
 * bare default id itself has fallen out of the live list.
 *
 *  - `'dated-snapshot'`: a live id counts as an alias when it is
 *    `<defaultId>-` followed by exactly an 8-digit date (`YYYYMMDD`) and is
 *    not itself some OTHER static model's id. Anthropic's shape: the vendor
 *    keeps serving a retiring alias under its dated snapshot
 *    (`claude-opus-4-8-20260315`) before the next one takes the bare id.
 *  - `'map'`: an explicit `{ [staticDefaultId]: aliasId }` table. OpenAI's
 *    shape: `gpt-5.6` resolves to the researched alias `gpt-5.6-sol`, a
 *    named tier chosen on purpose rather than picked by string prefix or
 *    live-list sort order (which is newest-first, and would otherwise let a
 *    newer, pricier tier like `gpt-5.6-cyber` win just for sharing the
 *    `gpt-5.6-` stem).
 *
 * Provider-supplied and explicit on purpose: a generic "starts with the
 * default id plus a dash" guess cannot tell "the vendor's intended stand-in"
 * from "an unrelated model that happens to share the prefix."
 */
export type DefaultAliasRule =
  | { readonly kind: 'dated-snapshot' }
  | { readonly kind: 'map'; readonly aliases: Readonly<Record<string, string>> }

const DATED_SNAPSHOT_SUFFIX = /^\d{8}$/

/**
 * Find the live entry that `rule` recognises as an alias of `staticDefault`.
 * `undefined` when there is no rule, or the rule names nothing present in
 * `models`.
 */
function findDefaultAlias(
  catalog: ProviderModelCatalog,
  models: readonly ModelOption[],
  staticDefault: ModelOption,
  rule: DefaultAliasRule | undefined,
): ModelOption | undefined {
  if (!rule) return undefined
  if (rule.kind === 'map') {
    const aliasId = rule.aliases[staticDefault.id]
    return aliasId === undefined ? undefined : models.find((m) => m.id === aliasId)
  }
  const staticIds = new Set(catalog.models.map((m) => m.id))
  const stem = `${staticDefault.id}-`
  return models.find(
    (m) =>
      m.id.startsWith(stem) &&
      !staticIds.has(m.id) &&
      DATED_SNAPSHOT_SUFFIX.test(m.id.slice(stem.length)),
  )
}

export interface MergeLiveOptions {
  /** What a live model with no effort information of any kind gets. */
  effortFallback: (id: string) => EffortLevel[] | null
  /** How to recognise a live id as a stand-in for the static default. */
  defaultAlias?: DefaultAliasRule
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
  const defaultId =
    staticDefault && seen.has(staticDefault.id)
      ? staticDefault.id
      : // Last resort: the newest live id. This CAN land on a pricier tier —
        // with `gpt-5.6` and `gpt-5.6-sol` both gone and `gpt-5.6-cyber`
        // live, the picker opens on $12.5/$75 rather than $4/$20, and no UI
        // says the default moved (reviewed 2026-09-04, P3-5).
        //
        // Two alternatives were tried and are worse. Preferring the cheapest
        // live entry with a known rate card opens the picker on a nano-class
        // model, which is a bad default for an agent that edits code.
        // Preferring the first live id the STATIC catalog also describes
        // demotes a dated flagship snapshot (`claude-opus-4-8-20260315`, the
        // vendor's own stand-in) to Sonnet, because the snapshot id is not
        // itself a static entry. Both trade a rare over-spend for a routine
        // under-capability.
        //
        // The narrow fix is the one already shipped: give the provider a
        // `defaultAlias` rule, which is explicit and cannot be fooled by
        // live-list order. This arm only runs when that rule names nothing
        // live either.
        (staticDefault && findDefaultAlias(catalog, models, staticDefault, opts.defaultAlias)?.id) ??
        models[0]!.id
  return {
    providerId: catalog.providerId,
    models: models.map((m) => (m.id === defaultId ? { ...m, isDefault: true } : m)),
  }
}
