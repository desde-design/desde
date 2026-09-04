/**
 * Static OpenAI model catalog for the chat model picker: the FALLBACK, and the
 * per-model detail the live list lacks.
 *
 * `GET /v1/models` returns ids, a creation timestamp and an owner, and nothing
 * else — no context window, no modality, no effort support (a standing feature
 * request, not an oversight). So labels, descriptions and effort ladders come
 * from here, exactly as they do for Anthropic.
 *
 * Data, not code — edit this list when models change. Every entry carries the
 * five levels Desde and OpenAI share. OpenAI also accepts `none` and `minimal`;
 * neither is offered, because the gpt-5.6 family rejects `none` with a 400 and
 * `minimal` has no rung on Desde's ladder.
 *
 * The `isDefault` entry must have a rate card, which
 * `rate-cards.test.ts` asserts for every id here.
 */
import type { ProviderModelCatalog } from '../core/model-catalog'

const LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const OPENAI_MODEL_CATALOG: ProviderModelCatalog = {
  providerId: 'openai',
  models: [
    {
      id: 'gpt-5.6',
      label: 'GPT-5.6',
      description: 'Most capable: the hardest reasoning and long-horizon work',
      effortLevels: [...LADDER],
      isDefault: true,
    },
    {
      id: 'gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      description: 'Strong agentic coding at a lower cost',
      effortLevels: [...LADDER],
    },
    {
      id: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      description: 'Fastest: simple edits and lookups',
      effortLevels: [...LADDER],
    },
    {
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      description: 'Previous flagship generation',
      effortLevels: [...LADDER],
    },
    {
      id: 'gpt-5.4',
      label: 'GPT-5.4',
      description: 'Balanced quality and cost',
      effortLevels: [...LADDER],
    },
    {
      id: 'gpt-5.4-mini',
      label: 'GPT-5.4 Mini',
      description: 'Fast and economical',
      effortLevels: [...LADDER],
    },
    {
      id: 'gpt-5.3-codex',
      label: 'GPT-5.3 Codex',
      description: 'Tuned for code',
      effortLevels: [...LADDER],
    },
  ],
}
