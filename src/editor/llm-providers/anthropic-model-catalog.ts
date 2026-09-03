/**
 * Static Anthropic model catalog for the chat model picker: the FALLBACK,
 * and the per-model detail the live lists lack.
 *
 * Since 2026-09-02 the CLI merges a live list over this one whenever it can
 * reach one (the Models API with a key, the `claude` binary in dev mode);
 * see `live-model-catalog.ts`. This file is what the picker shows when it
 * cannot, and where labels, descriptions and effort ladders come from for
 * the models it names.
 *
 * Data, not code — edit this list when models change. Effort support
 * per model follows the Anthropic API: full low…max ladder on Fable 5.1,
 * Opus 4.7+ and Sonnet 5; no `xhigh` on Sonnet 4.6 (pre-4.7); no effort at
 * all on Haiku 4.5. The Agent SDK silently downgrades unsupported levels,
 * so these flags are UX gating, not a hard safety requirement.
 *
 * The `isDefault` entry MUST match DEFAULT_SDK_MODEL in
 * run-chat-turn-sdk.ts — enforced by the colocated test.
 */
import type { ProviderModelCatalog } from '../core/model-catalog'

export const ANTHROPIC_MODEL_CATALOG: ProviderModelCatalog = {
  providerId: 'anthropic',
  models: [
    {
      id: 'claude-fable-5-1',
      label: 'Fable 5.1',
      description: 'Most capable, highest cost: the hardest reasoning and long-horizon work',
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      id: 'claude-opus-5',
      label: 'Opus 5',
      description: 'Deep reasoning, long-horizon work',
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      id: 'claude-opus-4-8',
      label: 'Opus 4.8',
      description: 'Default: strong agentic coding',
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      isDefault: true,
    },
    {
      id: 'claude-sonnet-5',
      label: 'Sonnet 5',
      description: 'Fast, near-Opus quality on coding',
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      id: 'claude-sonnet-4-6',
      label: 'Sonnet 4.6',
      description: 'Fast + economical',
      effortLevels: ['low', 'medium', 'high', 'max'],
    },
    {
      id: 'claude-haiku-4-5',
      label: 'Haiku 4.5',
      description: 'Fastest: simple edits and lookups',
      effortLevels: null,
    },
  ],
}
