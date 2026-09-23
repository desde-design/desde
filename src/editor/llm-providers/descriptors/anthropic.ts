/**
 * Anthropic. Chat runs on the neutral loop, same as every other provider —
 * the transport is `buildProvider` below (the AI SDK path it can opt into is
 * spike-gated, see `EDITOR_ANTHROPIC_TRANSPORT_SPIKE`). The `claude` command
 * line tool on PATH gives it the only subscription runtime any provider has,
 * a dev-only sidecar lane reached separately (`resolveChatRuntimeKind`), and
 * its key validates against `/v1/models`.
 *
 * `hasSubscriptionRuntime` is the one flag that must never be copied onto
 * another vendor. It is what makes the credential ladder's dev-mode rungs and
 * `isClaudeOnPath` unreachable for everyone else by construction
 * rather than by an `if`.
 */
import { EFFORT_LEVELS } from '../../core/model-catalog'
import { ANTHROPIC_MODEL_CATALOG } from '../anthropic-model-catalog'
import { AnthropicProvider, ANTHROPIC_DEFAULT_MODEL } from '../anthropic-provider'
import { listAnthropicLiveModels } from '../anthropic-live-models'
import { resolveAnthropicThinkingConfig } from '../anthropic-adaptive-thinking'
import type { ProviderDescriptor } from '../provider-descriptor'
import { claudeReauthMessage } from '../../agent-chat/classify-turn-error'
import { buildAnthropicProvider } from '../ai-sdk-anthropic'

const VALIDATE_URL = 'https://api.anthropic.com/v1/models?limit=1'
const ANTHROPIC_VERSION = '2023-06-01'
const VALIDATE_TIMEOUT_MS = 10_000

export const ANTHROPIC_DESCRIPTOR: ProviderDescriptor = {
  id: 'anthropic',
  label: 'Anthropic',
  capabilities: {
    reasoningVisibility: true,
    vendorRateLimitEvents: true,
    imagesInPrompt: true,
    webTools: ['web_search', 'web_fetch'],
  },
  credentials: {
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maskPrefix: 'sk-ant-',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    hasSubscriptionRuntime: true,
  },
  buildProvider(input) {
    if (process.env.EDITOR_ANTHROPIC_TRANSPORT_SPIKE === 'ai-sdk') return buildAnthropicProvider(input)
    return new AnthropicProvider({
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      defaultModel: input.model ?? ANTHROPIC_DEFAULT_MODEL,
    })
  },
  staticCatalog: ANTHROPIC_MODEL_CATALOG,
  // The vendor retires a bare alias by continuing to serve it under its own
  // dated snapshot (`claude-opus-4-8-20260315`) before the next generation
  // takes the bare id. See `DefaultAliasRule` in `live-model-catalog.ts`.
  defaultAlias: { kind: 'dated-snapshot' },
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
    // Mo, 2026-09-07, measuring against Claude Code: effort is always a
    // concrete level there, and its own copy recommends medium.
    //
    // This is a behaviour change, and it is the intended one. Absent effort
    // used to mean the SDK query carried no `effort` at all, which left an
    // adaptive-thinking model deciding per turn how hard to think. A session
    // that never touches the slider now runs at medium. Nothing else moves:
    // `thinking` is still resolved from the model id by
    // `resolveAnthropicThinkingConfig`.
    defaultLevel: 'medium',
    // The SDK lane still resolves thinking itself and ignores this. The
    // neutral lane (`run-chat-turn-neutral.ts`'s `providerOptionsFor`) is the
    // one that puts these on the wire, as `StreamOpts.providerOptions`: the
    // AI SDK's Anthropic adapter nests them under the `anthropic` key. Keys
    // match `anthropicLanguageModelOptions` in `@ai-sdk/anthropic`.
    toRequest(effort, model) {
      return {
        thinking: resolveAnthropicThinkingConfig(model ?? ANTHROPIC_DEFAULT_MODEL),
        ...(effort ? { effort } : {}),
      }
    },
  },
  errorPatterns: {
    auth: [/invalid authentication credentials/i, /\bauthentication_error\b/i, /failed to authenticate/i],
    // A function, not a string: the `claude` binary answers a rejected key
    // and a signed-out subscription login with the same 401, and the two are
    // repaired in different places. See `claudeReauthMessage`.
    reauthMessage: claudeReauthMessage,
  },
}
