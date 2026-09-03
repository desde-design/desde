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
