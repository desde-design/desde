/**
 * The `@ai-sdk/openai` half of the transport. Separate from
 * `ai-sdk-provider.ts` so the adapter stays vendor-free and so the import
 * fence (`ai-sdk-*.ts`) still covers this file.
 *
 * OpenAI itself runs on the RESPONSES API, not Chat Completions. The reason
 * that survives measurement is retention: Responses takes `store`, and
 * `store: false` is what keeps the prompts this product sends — a designer's
 * private source files, and on later steps the tool results carrying more of
 * them — out of OpenAI's own 30-day retention and out of the organisation's
 * dashboard logs. The vendor default is `true`, so this has to be sent on
 * every request, which is why it is a build-time default on the provider
 * rather than something each call site remembers.
 *
 * The design's §2 table gave a SECOND reason, that reasoning items survive
 * across tool calls. That one is not true of this code and the claim has been
 * removed rather than left standing: `ai-sdk-provider.ts` deliberately drops
 * reasoning parts when it replays an assistant turn (they are display-only),
 * and nothing here sends `previous_response_id` or asks for
 * `reasoning.encrypted_content`. Each step re-derives its own plan today.
 *
 * Every OTHER vendor runs on Chat Completions through
 * `ai-sdk-openai-compatible.ts`, because that is the only shape they all
 * speak.
 */

import { createOpenAI } from '@ai-sdk/openai'
import { AiSdkProvider } from './ai-sdk-provider'
import type { LLMProvider } from './types'

/** Provider-options key. `@ai-sdk/openai` looks its own options up by name. */
export const OPENAI_PROVIDER_OPTIONS_KEY = 'openai'

export const OPENAI_DEFAULT_MODEL = 'gpt-5.6'

export interface BuildOpenAiProviderInput {
  apiKey?: string
  baseUrl?: string
  model?: string
  fetchImpl?: typeof fetch
}

export function buildOpenAiProvider(input: BuildOpenAiProviderInput): LLMProvider {
  if (!input.apiKey) {
    throw new Error(
      'OpenAI needs an API key: none was supplied. Set OPENAI_API_KEY or add a key from the settings gear.',
    )
  }
  const openai = createOpenAI({
    apiKey: input.apiKey,
    ...(input.baseUrl ? { baseURL: input.baseUrl } : {}),
    ...(input.fetchImpl ? { fetch: input.fetchImpl } : {}),
  })
  return new AiSdkProvider({
    name: 'openai',
    defaultModel: input.model ?? OPENAI_DEFAULT_MODEL,
    languageModel: (modelId) => openai.responses(modelId),
    providerOptionsKey: OPENAI_PROVIDER_OPTIONS_KEY,
    // Sent on every request. See the file header: OpenAI's default is to
    // retain the prompt, and the prompts this product sends are the user's
    // own source code.
    defaultProviderOptions: { store: false },
  })
}
