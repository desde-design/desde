/**
 * The `@ai-sdk/anthropic` half of the transport. Separate from
 * `ai-sdk-provider.ts` for the same reason `ai-sdk-openai.ts` is: the
 * adapter stays vendor-free, and the import fence (`ai-sdk-*.ts`) still
 * covers this file.
 *
 * `createAnthropic(...)` returns a provider that is itself callable —
 * `anthropic(modelId)` is the Messages API language model `AiSdkProvider`
 * needs. There is no `.responses()` detour the way there is for OpenAI
 * (see that file's header): Anthropic has one API, and this transport
 * talks to it directly.
 *
 * No `defaultProviderOptions` are set here. `cacheControl: 'anthropic'` is set
 * instead, which is narrower: it only tells `AiSdkProvider.toSystem` to emit
 * `providerOptions.anthropic.cacheControl` on a system block the caller
 * marked `cacheHint: 'ephemeral'`, rather than sending a provider option on
 * every request regardless of what the caller asked for.
 *
 * `@ai-sdk/anthropic` pins `@ai-sdk/provider@4.0.17` exactly. `ai` and
 * `@ai-sdk/openai` are pinned here (`package.json`) to the versions that pin
 * the SAME `@ai-sdk/provider@4.0.17` exactly (`ai@7.0.111`,
 * `@ai-sdk/openai@4.0.72`), so npm dedupes to one copy on disk and
 * `anthropic(modelId)`'s `LanguageModelV4` is the same type `AiSdkProvider`
 * expects — no cast needed. Bumping any one of these three packages again
 * must keep the other two on a `@ai-sdk/provider` version that matches, or
 * this file (and `ai-sdk-openai.ts`) stop typechecking without a cast.
 * `ai-sdk-packages.test.ts` fails if any of the three top-level pins drifts
 * from what is actually installed; it does not check the `@ai-sdk/provider`
 * sub-pin directly, so a bump that breaks the alignment above is caught by
 * `npm run typecheck`, not by that test.
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import { AiSdkProvider } from './ai-sdk-provider'
import type { LLMProvider } from './types'

/**
 * Provider-options key. `@ai-sdk/anthropic` looks its own options
 * (`cacheControl`, `sendReasoning`, …) up by this name.
 */
export const ANTHROPIC_PROVIDER_OPTIONS_KEY = 'anthropic'

/** Same default as the static catalog's `isDefault` entry (`anthropic-model-catalog.ts`). */
export const ANTHROPIC_AI_SDK_DEFAULT_MODEL = 'claude-opus-4-8'

export interface BuildAnthropicProviderInput {
  apiKey?: string
  baseUrl?: string
  model?: string
  fetchImpl?: typeof fetch
}

export function buildAnthropicProvider(input: BuildAnthropicProviderInput): LLMProvider {
  if (!input.apiKey) {
    throw new Error(
      'Anthropic needs an API key: none was supplied. Set ANTHROPIC_API_KEY or add a key from the settings gear.',
    )
  }
  const anthropic = createAnthropic({
    apiKey: input.apiKey,
    ...(input.baseUrl ? { baseURL: input.baseUrl } : {}),
    ...(input.fetchImpl ? { fetch: input.fetchImpl } : {}),
  })
  return new AiSdkProvider({
    name: 'anthropic',
    defaultModel: input.model ?? ANTHROPIC_AI_SDK_DEFAULT_MODEL,
    languageModel: (modelId) => anthropic(modelId),
    providerOptionsKey: ANTHROPIC_PROVIDER_OPTIONS_KEY,
    cacheControl: 'anthropic',
  })
}
