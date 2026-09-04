/**
 * Anthropic. The descriptor records what the product does today, unchanged:
 * the Claude Agent SDK serves its chat, a bundled `claude` binary gives it the
 * only subscription runtime any provider has, and its key validates against
 * `/v1/models`.
 *
 * `hasSubscriptionRuntime` is the one flag that must never be copied onto
 * another vendor. It is what makes the credential ladder's dev-mode rungs and
 * `isClaudeRuntimeResolvable` unreachable for everyone else by construction
 * rather than by an `if`.
 */
import { EFFORT_LEVELS } from '../../core/model-catalog'
import { ANTHROPIC_MODEL_CATALOG } from '../anthropic-model-catalog'
import { AnthropicProvider, ANTHROPIC_DEFAULT_MODEL } from '../anthropic-provider'
import { listAnthropicLiveModels } from '../anthropic-live-models'
import type { ProviderDescriptor } from '../provider-descriptor'
import { AUTH_REAUTH_MESSAGE } from '../../agent-chat/classify-turn-error'

const VALIDATE_URL = 'https://api.anthropic.com/v1/models?limit=1'
const ANTHROPIC_VERSION = '2023-06-01'
const VALIDATE_TIMEOUT_MS = 10_000

export const ANTHROPIC_DESCRIPTOR: ProviderDescriptor = {
  id: 'anthropic',
  label: 'Anthropic',
  chatRuntime: 'claude-agent-sdk',
  capabilities: {
    midTurnSteering: true,
    vendorReportedCostUsd: true,
    inTurnBudgetStop: 'vendor',
    reasoningVisibility: true,
    vendorRateLimitEvents: true,
    imagesInPrompt: true,
    webTools: true,
  },
  credentials: {
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maskPrefix: 'sk-ant-',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    hasSubscriptionRuntime: true,
  },
  buildProvider(input) {
    return new AnthropicProvider({
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      defaultModel: input.model ?? ANTHROPIC_DEFAULT_MODEL,
    })
  },
  staticCatalog: ANTHROPIC_MODEL_CATALOG,
  listLiveModels: (input) =>
    listAnthropicLiveModels({
      apiKey: input.apiKey,
      ...(input.signal ? { signal: input.signal } : {}),
    }),
  async validateKey(input) {
    const fetchImpl = input.fetchImpl ?? fetch
    try {
      const res = await fetchImpl(VALIDATE_URL, {
        method: 'GET',
        headers: {
          'x-api-key': input.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
      })
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: 'Anthropic rejected that key.' }
      }
      if (!res.ok) {
        return { ok: false, message: `Anthropic answered ${res.status}. Try again.` }
      }
      return { ok: true }
    } catch {
      // Fails closed. Persisting an unverified key recreates the failure this
      // check exists to prevent: someone who believes they are configured.
      return {
        ok: false,
        message: 'Could not reach Anthropic to check the key. Check your connection.',
      }
    }
  },
  effort: {
    levels: [...EFFORT_LEVELS],
    // The SDK lane resolves thinking from the model id
    // (`resolveAnthropicThinkingConfig`), so nothing rides provider options.
    toRequest: () => ({}),
  },
  errorPatterns: {
    auth: [/invalid authentication credentials/i, /\bauthentication_error\b/i, /failed to authenticate/i],
    reauthMessage: AUTH_REAUTH_MESSAGE,
  },
}
