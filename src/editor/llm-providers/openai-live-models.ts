/**
 * The live OpenAI model list, shaped for `mergeLiveModels`.
 *
 * `live-model-catalog.ts`'s `fromModelsApi` cannot be reused or generalised:
 * its `CLAUDE_ID` regex and its family names are Anthropic's, and its input
 * shape is Anthropic's `ModelInfo`. A sibling module is the right shape, and
 * matches the per-provider file convention already used for the catalogs.
 *
 * The FILTER is the whole job. Anthropic's list is chat models. OpenAI's mixes
 * in embeddings, moderation, TTS, transcription, realtime, search-preview and
 * image models, plus `-pro` variants whose latency makes them wrong for an
 * interactive editor and `-chat-latest` aliases that duplicate a versioned
 * entry. Everything not on the allowed shape is dropped, which is safer than
 * denylisting: a model family invented next quarter is invisible until someone
 * adds it here, and an invisible model is better than a broken one in the
 * picker.
 */

import type { LiveModel } from './live-model-catalog'

/** The `/v1/models` element shape this module reads. */
export interface OpenAiApiModel {
  id: string
  object: string
  created: number
  owned_by: string
  /** Set when a retirement has been announced. */
  shutdown_date?: string | null
}

/** `gpt-5`, `gpt-5.6`, `gpt-5.4-mini`, `gpt-5.3-codex`. Nothing else. */
const CHAT_MODEL_ID = /^gpt-5(?:\.\d+)?(?:-(?:mini|nano|terra|luna|sol|cyber|codex))?$/

/**
 * Derive a label the same way the static catalog would name it, for a live
 * id the static catalog does not describe (`mergeLiveModels` prefers the
 * static label when one exists, so this only ever surfaces for a live-only
 * id). `gpt` is uppercased, the version is kept as-is, and every following
 * dash-separated word is title-cased: `gpt-5.4-nano` -> `GPT-5.4 Nano`,
 * `gpt-5.6-sol` -> `GPT-5.6 Sol`, `gpt-5` -> `GPT-5`.
 */
export function labelFromOpenAiId(id: string): string {
  const [, version = '', ...words] = id.split('-')
  const wordLabels = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  return ['GPT-' + version, ...wordLabels].join(' ')
}

export function fromOpenAiModelsApi(models: readonly OpenAiApiModel[]): LiveModel[] {
  return [...models]
    .filter((m) => CHAT_MODEL_ID.test(m.id))
    .filter((m) => m.shutdown_date === undefined || m.shutdown_date === null)
    .sort((a, b) => b.created - a.created)
    .map((m) => ({
      id: m.id,
      // The static catalog's hand-written label still wins in the merge
      // when one exists; this is only what a live-only id falls back to.
      label: labelFromOpenAiId(m.id),
      // No effort information: `/v1/models` carries none, and `undefined`
      // is what mergeLiveModels reads as "ask the static catalog".
    }))
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const TIMEOUT_MS = 10_000

export interface ListOpenAiLiveModelsInput {
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

/**
 * Fetch and shape the live list. FAILS SOFT: any error returns `[]`, which the
 * catalog resolver reads as "nothing live, use the static catalog". A picker
 * with stale entries beats a picker with none.
 */
export async function listOpenAiLiveModels(
  input: ListOpenAiLiveModelsInput,
): Promise<LiveModel[]> {
  const base = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  try {
    const response = await fetchImpl(`${base}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal,
    })
    if (!response.ok) return []
    const json = (await response.json()) as { data?: OpenAiApiModel[] }
    return fromOpenAiModelsApi(json.data ?? [])
  } catch {
    return []
  }
}
