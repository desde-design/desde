/**
 * The `@ai-sdk/openai` half of the transport. Separate from
 * `ai-sdk-provider.ts` so the adapter stays vendor-free and so the import
 * fence (`ai-sdk-*.ts`) still covers this file.
 *
 * OpenAI itself runs on the RESPONSES API, not Chat Completions. Two reasons,
 * both from the design's §2 table: reasoning items survive across tool calls
 * (so a multi-step edit turn does not re-derive its own plan every step), and
 * `store: false` keeps a stateless request stateless. Every OTHER vendor runs
 * on Chat Completions through `ai-sdk-openai-compatible.ts`, because that is
 * the only shape they all speak.
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
  const openai = createOpenAI({
    apiKey: input.apiKey ?? '',
    ...(input.baseUrl ? { baseURL: input.baseUrl } : {}),
    ...(input.fetchImpl ? { fetch: input.fetchImpl } : {}),
  })
  return new AiSdkProvider({
    name: 'openai',
    defaultModel: input.model ?? OPENAI_DEFAULT_MODEL,
    languageModel: (modelId) => openai.responses(modelId),
    providerOptionsKey: OPENAI_PROVIDER_OPTIONS_KEY,
  })
}
