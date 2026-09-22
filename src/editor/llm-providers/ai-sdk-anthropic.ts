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
 * No `defaultProviderOptions` are set here. A later task adds prompt-cache
 * breakpoints under the `anthropic` provider-options key; `AiSdkProviderOptions`
 * has no `cacheControl` field yet, so this file does not reach for one.
 *
 * `@ai-sdk/anthropic` 4.0.60 pins `@ai-sdk/provider@4.0.17` exactly, while
 * `ai@7.0.92` and `@ai-sdk/openai@4.0.58` both pin `@ai-sdk/provider@4.0.10`
 * exactly. npm cannot dedupe two exact, differing pins, so this repo installs
 * BOTH copies, and TypeScript treats their `LanguageModelV4` as two distinct
 * (if structurally near-identical) types. The cast below is that version
 * skew made visible, not a behavioral claim: `anthropic(modelId)` returns a
 * real `LanguageModelV4` that `streamText`/`generateText` (built against the
 * SAME nested `@ai-sdk/provider@4.0.17` `@ai-sdk/anthropic` itself imports
 * from) accept at runtime. `AiSdkProvider.languageModel`'s param type is
 * `ai`'s own `LanguageModel`, resolved against the OTHER copy, which is the
 * only reason this needs a cast rather than a plain return.
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import type { LanguageModel } from 'ai'
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
    // See the file header: two pinned copies of `@ai-sdk/provider`, not a
    // real behavioral gap.
    languageModel: (modelId) => anthropic(modelId) as unknown as LanguageModel,
    providerOptionsKey: ANTHROPIC_PROVIDER_OPTIONS_KEY,
  })
}
