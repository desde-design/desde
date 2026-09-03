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
 * Two live sources, matching the two ways the editor can be credentialed:
 *
 *  - The Anthropic Models API (`GET /v1/models`), when an API key is active.
 *    It reports ids, display names, and a per-level effort capability tree.
 *  - The bundled `claude` binary, through the Agent SDK's `supportedModels()`
 *    control request, when dev mode / the subscription opt-in is active and
 *    there is no key to call the API with. It reports ids, display names,
 *    descriptions, and a single "supports effort" flag.
 *
 * This module is the PURE half: shaping either list into `LiveModel`s and
 * merging them into a catalog. The I/O (clients, the process spawn, caching,
 * which source applies) lives in `editor-cli/src/server/model-catalog-source.ts`.
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

/** The Models API shape this module reads. A structural subset of the SDK's `ModelInfo`. */
export interface ModelsApiModel {
  id: string
  display_name: string
  created_at: string
  capabilities?: {
    effort?: {
      supported: boolean
      low?: { supported: boolean } | null
      medium?: { supported: boolean } | null
      high?: { supported: boolean } | null
      xhigh?: { supported: boolean } | null
      max?: { supported: boolean } | null
    } | null
    thinking?: {
      supported: boolean
      types?: { adaptive?: { supported: boolean } | null } | null
    } | null
  } | null
}

/**
 * The Agent SDK's `ModelInfo`, structurally. The declared type stops at
 * `supportsEffort`; the binary actually answers with more (MEASURED
 * 2026-09-02 against SDK 0.3.143: `supportedEffortLevels` and
 * `supportsAdaptiveThinking` ride along), and both are read when present.
 */
export interface AgentSdkModel {
  value: string
  displayName: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: readonly string[]
  supportsAdaptiveThinking?: boolean
}

const FULL_EFFORT_LADDER: EffortLevel[] = [...EFFORT_LEVELS]

/**
 * `claude-<family>-<major>[-<minor>][-<yyyymmdd>]`. Families the editor knows
 * how to drive; the major version is what the generation filter reads.
 */
const CLAUDE_ID = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-(\d{8}))?$/

/** Models older than this generation predate everything the chat runtime tunes for. */
const MIN_MAJOR_VERSION = 4

/**
 * Shape the Models API list. Keeps Claude 4+ models, drops a dated snapshot
 * when its bare alias is also listed (the picker shows `claude-haiku-4-5`,
 * not both it and `claude-haiku-4-5-20251001`), newest first.
 */
export function fromModelsApi(models: readonly ModelsApiModel[]): LiveModel[] {
  const ids = new Set(models.map((m) => m.id))
  return [...models]
    .filter((m) => {
      const match = CLAUDE_ID.exec(m.id)
      if (!match) return false
      if (Number(match[2]) < MIN_MAJOR_VERSION) return false
      const dated = match[4] !== undefined
      if (dated) {
        const bare = m.id.slice(0, -(match[4]!.length + 1))
        if (ids.has(bare)) return false
      }
      return true
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((m) => {
      const adaptive = m.capabilities?.thinking?.types?.adaptive?.supported
      return {
        id: m.id,
        label: m.display_name.replace(/^Claude\s+/, ''),
        effortLevels: effortLadderFromCapabilities(m),
        ...(typeof adaptive === 'boolean' ? { adaptiveThinking: adaptive } : {}),
      }
    })
}

function effortLadderFromCapabilities(m: ModelsApiModel): EffortLevel[] | null | undefined {
  const effort = m.capabilities?.effort
  if (!effort) return undefined
  if (!effort.supported) return null
  const ladder = EFFORT_LEVELS.filter((level) => effort[level]?.supported === true)
  return ladder.length > 0 ? [...ladder] : null
}

/**
 * The binary names its entries by ALIAS ("Default (recommended)", "Sonnet")
 * and puts the versioned model in the description ("Opus 4.7 with 1M context
 * · Most capable for complex work", "Sonnet 4.6 · Best for everyday tasks").
 * The picker shows name and version and nothing else (Mo, 2026-09-02), so
 * the label is the description's leading "<Family> <version>" when it has
 * one, and the display name otherwise (a custom model says "Custom model").
 */
const VERSIONED_NAME = /^((?:Fable|Opus|Sonnet|Haiku)\s+\d+(?:\.\d+)*)\b/

export function versionedNameFrom(description: string | undefined): string | undefined {
  if (!description) return undefined
  return VERSIONED_NAME.exec(description.trim())?.[1]
}

/**
 * The same name out of a model ID (`claude-fable-5-1[1m]` is "Fable 5.1"),
 * for an entry whose description says nothing ("Custom model"). The `[1m]`
 * context suffix and a dated snapshot are ignored; a bare alias with no
 * version in it (`fable[1m]`) yields nothing, and the alias stays.
 */
export function versionedNameFromId(id: string): string | undefined {
  const m = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-\d{8})?(?:\[.*\])?$/.exec(id)
  if (!m) return undefined
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1)
  return m[3] !== undefined ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`
}

/**
 * Shape the Agent SDK's list. Everything it offers is usable as a `model`,
 * but only entries with a NAME AND VERSION are shown (Mo, 2026-09-02: "there
 * should not be any value called default. It should be model name and
 * version"). An entry whose version can be read from neither its description
 * nor its id is dropped: today that is the "Custom model" row the binary adds
 * for a bare alias in the user's own Claude Code settings (`fable[1m]`, the
 * `fable` alias with the 1M-context suffix), which duplicates the versioned
 * Fable entry beside it.
 */
export function fromAgentSdk(models: readonly AgentSdkModel[]): LiveModel[] {
  // One row per name-and-version. The binary offers the same model under
  // two aliases (`default` and `opus[1m]` both resolve to Opus 5 with the
  // 1M context, MEASURED on SDK 0.3.259), and a menu that says "Opus 5"
  // twice asks the reader to guess which one to pick. The first alias wins,
  // which is the binary's own preferred one.
  const seenLabels = new Set<string>()
  return models
    .filter((m) => typeof m.value === 'string' && m.value.length > 0)
    .flatMap((m) => {
      const label = versionedNameFrom(m.description) ?? versionedNameFromId(m.value)
      if (!label || seenLabels.has(label)) return []
      seenLabels.add(label)
      const ladder = Array.isArray(m.supportedEffortLevels)
        ? EFFORT_LEVELS.filter((level) => m.supportedEffortLevels!.includes(level))
        : undefined
      return [{
        id: m.value,
        label,
        ...(m.description ? { description: m.description } : {}),
        ...(m.supportsEffort === false
          ? { effortLevels: null }
          : ladder && ladder.length > 0
            ? { effortLevels: [...ladder] }
            : {}),
        ...(typeof m.supportsEffort === 'boolean' ? { supportsEffort: m.supportsEffort } : {}),
        ...(typeof m.supportsAdaptiveThinking === 'boolean'
          ? { adaptiveThinking: m.supportsAdaptiveThinking }
          : {}),
      }]
    })
}

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
