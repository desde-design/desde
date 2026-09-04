/**
 * OpenAI. BYO API key only, mirroring the Anthropic default: OpenAI's terms
 * tolerate plan reuse for a personal CLI but give no written permission for a
 * distributed product to offer it, so there is no plan path and no second
 * binary. `hasSubscriptionRuntime` is therefore absent, which is what makes
 * the credential ladder's dev-mode rungs unreachable here by construction.
 *
 * `buildProvider` builds an `AiSdkProvider` on the Responses API (see
 * `ai-sdk-openai.ts` for why Responses rather than Chat Completions). The
 * earlier fetch-based `OpenAIProvider` is retired.
 */
import { EFFORT_LEVELS } from '../../core/model-catalog'
import { OPENAI_MODEL_CATALOG } from '../openai-model-catalog'
import { listOpenAiLiveModels } from '../openai-live-models'
import { buildOpenAiProvider } from '../ai-sdk-openai'
import type { ProviderDescriptor } from '../provider-descriptor'

// Convention: `OPENAI_BASE_URL` (and the dialog's base-URL field) INCLUDES
// `/v1`, matching `listOpenAiLiveModels` and the AI SDK's `createOpenAI`
// default. All three sites must agree, or no single value works for a
// gateway user — see `openai-base-url-convention.test.ts`.
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const VALIDATE_TIMEOUT_MS = 10_000

/** `https://host/v1/` and `https://host/v1` both have to produce one `/v1/models`. */
function modelsUrl(baseUrl: string | undefined): string {
  return `${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/models`
}

export const OPENAI_DESCRIPTOR: ProviderDescriptor = {
  id: 'openai',
  label: 'OpenAI',
  chatRuntime: 'neutral',
  capabilities: {
    // A steer lands at the next tool-loop boundary, not mid-generation. Named
    // here rather than implied away, because the picker and the steer route
    // both have to tell the user which one they are getting.
    midTurnSteering: false,
    vendorReportedCostUsd: false,
    inTurnBudgetStop: 'step-boundary',
    reasoningVisibility: true,
    vendorRateLimitEvents: false,
    imagesInPrompt: true,
    webTools: false,
  },
  credentials: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    maskPrefix: 'sk-',
    consoleUrl: 'https://platform.openai.com/api-keys',
  },
  buildProvider(input) {
    return buildOpenAiProvider(input)
  },
  staticCatalog: OPENAI_MODEL_CATALOG,
  listLiveModels(input) {
    return listOpenAiLiveModels(input)
  },
  async validateKey(input) {
    const fetchImpl = input.fetchImpl ?? fetch
    try {
      const res = await fetchImpl(modelsUrl(input.baseUrl), {
        method: 'GET',
        headers: { Authorization: `Bearer ${input.apiKey}` },
        signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
      })
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: 'OpenAI rejected that key.' }
      }
      if (!res.ok) {
        return { ok: false, message: `OpenAI answered ${res.status}. Try again.` }
      }
      return { ok: true }
    } catch {
      return {
        ok: false,
        message: 'Could not reach OpenAI to check the key. Check your connection.',
      }
    }
  },
  effort: {
    levels: [...EFFORT_LEVELS],
    toRequest(effort) {
      // Omitted means "let the model decide", which is OpenAI's own default of
      // `medium`. Sending nothing is honest; sending 'medium' would claim the
      // user chose it.
      return effort === undefined ? {} : { reasoningEffort: effort }
    },
  },
  errorPatterns: {
    auth: [
      // An exhausted quota is not a rate limit even though it arrives as a 429:
      // waiting does not fix it, so it belongs on the auth arm where the copy
      // sends the user to their billing page.
      /\binsufficient_quota\b/i,
      /\binvalid_api_key\b/i,
      /incorrect api key/i,
    ],
    rateLimited: [/\brate_limit_exceeded\b/i],
    reauthMessage:
      'OpenAI rejected the request (401 or 429). The key Editor is using looks ' +
      'invalid, or the account has no remaining quota. Add or replace your OpenAI ' +
      'API key from the settings gear, or check your billing at ' +
      'platform.openai.com. Then start a new chat turn.',
  },
}
