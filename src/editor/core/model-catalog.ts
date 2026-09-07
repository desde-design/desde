/**
 * Provider-neutral model/effort catalog types for the chat model picker.
 *
 * The catalog is STATIC data (no live /v1/models query — subscription
 * auth via the bundled `claude` binary may have no API key). Each
 * provider ships one `ProviderModelCatalog`; the CLI serves them at
 * GET /api/editor/chat/model-catalog and the chat handler validates
 * incoming `modelConfig` against them.
 *
 * Core stays provider-neutral: concrete catalogs live in
 * `src/editor/llm-providers/` (e.g. anthropic-model-catalog.ts).
 */

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const EFFORT_LEVELS: readonly EffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

export interface ModelOption {
  /** Provider model id, e.g. 'claude-opus-4-8'. */
  id: string
  /** Short display label, e.g. 'Opus 4.8'. */
  label: string
  /** One-line description for the picker (optional). */
  description?: string
  /**
   * Effort levels this model accepts, or null when the model has no
   * effort parameter (the picker hides the effort control).
   */
  effortLevels: EffortLevel[] | null
  /** Marks the provider's default model (exactly one per catalog). */
  isDefault?: boolean
  /**
   * Where the picker's effort slider sits before the session has chosen
   * anything, AND the level the turn runs at in that same state. One field
   * for both halves on purpose: the picker displays it and the chat handler
   * sends it, so they cannot disagree. Absent only when the model takes no
   * effort at all.
   *
   * It travels on the catalog because only the server can see the provider
   * descriptor that names it. The slider has no "Default" stop meaning
   * "send nothing": every position is a real level (Mo, 2026-09-07), so the
   * starting one has to be a real level too.
   */
  defaultEffort?: EffortLevel
  /**
   * Whether the model takes adaptive thinking (the model decides when and
   * how much to think) rather than a fixed thinking budget. Set from a live
   * source when it says; absent means "decide from the id", which the chat
   * runtime does by model family. A live list can offer ALIASES (`default`,
   * `sonnet`) whose family the id does not name, and on a current-generation
   * model a fixed budget is rejected outright, so the source's own answer
   * has to travel with the option.
   */
  adaptiveThinking?: boolean
}

/**
 * Stamp `defaultEffort` onto every model in a catalog that has an effort
 * ladder at all. Called wherever a served catalog is assembled — the static
 * path and the live-merge path both — so a live-listed model carries the
 * field too.
 *
 * A model with no ladder gets nothing: there is no level to start on and the
 * picker shows no control.
 *
 * A model whose ladder does not contain `level` gets the MIDDLE of its own
 * ladder instead. That case is real: a live list can ship a ladder the
 * vendor's declared default is not part of. It used to leave the field
 * unset, and then the two sides guessed separately — the picker's slider
 * opened on the middle of the ladder while the chat handler, seeing no
 * `defaultEffort`, sent no effort at all and let the vendor decide. The chip
 * showed one level and the turn ran another, which is exactly what the
 * picker's own invariant forbids. Deciding the fallback HERE, once, on the
 * server, is what keeps the display and the request the same value.
 */
export function withDefaultEffort(
  catalog: ProviderModelCatalog,
  level: EffortLevel | null | undefined,
): ProviderModelCatalog {
  if (!level) return catalog
  return {
    ...catalog,
    models: catalog.models.map((m) => {
      const ladder = m.effortLevels
      if (!ladder || ladder.length === 0) return m
      const onLadder = ladder.includes(level)
      // Same index the picker used to compute for itself, so the fallback is
      // the position a reader of either side would predict.
      const middle = ladder[Math.floor((ladder.length - 1) / 2)]!
      return { ...m, defaultEffort: onLadder ? level : middle }
    }),
  }
}

export interface ProviderModelCatalog {
  providerId: string
  models: ModelOption[]
}

/** Per-session model choice, persisted on the ChatSession record. */
export interface SessionModelConfig {
  provider: string
  model: string
  /** Omitted = provider default effort. */
  effort?: EffortLevel
}

export type ModelConfigValidation =
  | { ok: true; config: SessionModelConfig; warnings: string[] }
  | { ok: false; error: string }

function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as string[]).includes(value)
}

/**
 * Validate an untrusted request-body `modelConfig` against the known
 * catalogs. Effort on a model without effort support is stripped with
 * a warning (not a hard error) so an out-of-date client still works.
 */
export function validateSessionModelConfig(
  raw: unknown,
  catalogs: ProviderModelCatalog[],
): ModelConfigValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '`modelConfig` must be an object.' }
  }
  const { provider, model, effort } = raw as Record<string, unknown>
  if (typeof provider !== 'string' || provider.length === 0) {
    return { ok: false, error: '`modelConfig.provider` must be a non-empty string.' }
  }
  const catalog = catalogs.find((c) => c.providerId === provider)
  if (!catalog) {
    return { ok: false, error: `Unknown provider '${provider}'.` }
  }
  if (typeof model !== 'string' || model.length === 0) {
    return { ok: false, error: '`modelConfig.model` must be a non-empty string.' }
  }
  const option = catalog.models.find((m) => m.id === model)
  if (!option) {
    return { ok: false, error: `Unknown model '${model}' for provider '${provider}'.` }
  }
  const warnings: string[] = []
  let resolvedEffort: EffortLevel | undefined
  if (effort !== undefined) {
    if (!isEffortLevel(effort)) {
      return {
        ok: false,
        error: `Invalid effort '${String(effort)}': expected one of ${EFFORT_LEVELS.join(', ')}.`,
      }
    }
    if (option.effortLevels === null) {
      warnings.push(
        `Model '${option.label}' does not support effort; ignoring effort='${effort}'.`,
      )
    } else if (!option.effortLevels.includes(effort)) {
      return {
        ok: false,
        error: `Model '${option.label}' does not support effort '${effort}' (supported: ${option.effortLevels.join(', ')}).`,
      }
    } else {
      resolvedEffort = effort
    }
  }
  return {
    ok: true,
    config: {
      provider,
      model,
      ...(resolvedEffort !== undefined ? { effort: resolvedEffort } : {}),
    },
    warnings,
  }
}

/**
 * The catalog's default choice (first `isDefault`, else first model).
 *
 * Guards the empty-catalog case: a `ProviderModelCatalog` with no models
 * is a broken build (the catalogs are static data), and without the
 * guard the `.id` dereference below throws an opaque TypeError from
 * inside whatever request handler happened to call this. Throwing a
 * named error keeps the failure diagnosable.
 */
export function defaultModelConfig(
  catalog: ProviderModelCatalog,
): SessionModelConfig {
  const option = catalog.models.find((m) => m.isDefault) ?? catalog.models[0]
  if (!option) {
    throw new Error(
      `Model catalog for provider '${catalog.providerId}' has no models.`,
    )
  }
  return { provider: catalog.providerId, model: option.id }
}

/**
 * Reconcile an untrusted-but-previously-valid config (a value persisted
 * on a chat session, or one seeded into client state from one) against
 * the CURRENT catalogs.
 *
 * Returns the validator's sanitized config when it still validates, and
 * `null` when it doesn't — a model that has since left the catalog, or a
 * provider that's no longer served. `null` means "fall back to the
 * runtime default"; it is never an error, because a stale saved choice
 * must not be able to brick a chat session.
 *
 * Note this returns `v.config`, not the input: a hand-edited session
 * file carrying an effort value on a model that doesn't support effort
 * gets the effort stripped rather than forwarded.
 */
export function reconcileSessionModelConfig(
  raw: unknown,
  catalogs: ProviderModelCatalog[],
): SessionModelConfig | null {
  if (raw === null || raw === undefined) return null
  const v = validateSessionModelConfig(raw, catalogs)
  return v.ok ? v.config : null
}
