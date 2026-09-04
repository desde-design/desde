/**
 * OpenAI's static catalog.
 *
 * PLACEHOLDER, deliberately minimal. Phase 0 only needs a catalog to exist so
 * the descriptor's invariants hold (exactly one default, ids that resolve to a
 * rate card); phase 4 replaces this list with the real one and adds the
 * rate-card coverage test that keeps it honest. Nothing serves it in
 * production until the neutral chat runtime is switched on.
 *
 * `gpt-5.2` is the id `OPENAI_DEFAULT_MODEL` already names and the one
 * `rate-cards.ts` already prices, so the placeholder cannot price at the
 * conservative unknown-model fallback.
 */
import type { ProviderModelCatalog } from '../core/model-catalog'

export const OPENAI_MODEL_CATALOG: ProviderModelCatalog = {
  providerId: 'openai',
  models: [
    {
      id: 'gpt-5.2',
      label: 'GPT-5.2',
      description: 'Placeholder entry. The full list ships with OpenAI chat.',
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      isDefault: true,
    },
  ],
}
