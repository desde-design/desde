/**
 * Provider registry. Single entry point for resolving the active
 * `LLMProvider` for the NON-CHAT lanes.
 *
 * Config sources, in order of precedence:
 *   1. Explicit `override` argument (test/dev convenience).
 *   2. `LLMConfig` passed in by the caller. The CLI builds one per request
 *      with `resolveLlmConfig` (`editor-cli/src/server/llm-config.ts`) from
 *      the `llm` block in `.desde/config.json`.
 *   3. `pickDefaultConfig(env)`, which reads the descriptor table.
 *
 * Precedence 2 used to be unreachable and `case 'openai'` used to be dead
 * code: every call site called `getProvider()` with no argument and nothing
 * anywhere loaded an `LLMConfig`. Both are live now.
 *
 * This registry is still NOT the chat lane. Chat dispatches on the session's
 * provider through `editor-cli/src/server/chat-runtime-dispatch.ts`.
 *
 * Import direction: this file reads `provider-registry.ts`, never the reverse.
 * The subscription flag both need lives lower still, in
 * `claude-subscription.ts`, which is what keeps that arrow one-way.
 *
 * The registry deliberately does NOT touch the filesystem — config loading is
 * the caller's responsibility, which keeps the per-runtime config policy in
 * the runtime that owns it.
 */

import { ANTHROPIC_DEFAULT_MODEL } from './anthropic-provider'
import {
  ClaudeAgentSdkProvider,
  CLAUDE_AGENT_SDK_DEFAULT_MODEL,
} from './claude-agent-sdk-provider'
import { CLAUDE_SUBSCRIPTION_ENV, isClaudeSubscriptionOptIn } from './claude-subscription'
import {
  credentialsFromEnv,
  getDescriptor,
  listDescriptors,
  resolveDefaultProviderId,
  isCredentialedFromEnv,
} from './provider-registry'
import type { LLMProvider } from './types'

export { CLAUDE_SUBSCRIPTION_ENV, isClaudeSubscriptionOptIn }

/**
 * Vendor-neutral provider configuration. The shape is intentionally
 * open-ended (`Record<string, unknown>` for `options`) so each provider
 * can carry its own knobs (model id, base URL, headers) without forcing
 * the registry to know about them.
 */
export interface LLMConfig {
  /** Provider id. Today: 'anthropic' | 'openai'. */
  provider: string
  /** Default model id for this provider. Optional. */
  model?: string
  /**
   * Name of the environment variable holding the API key. Each
   * provider instance binds to this key explicitly (no process.env
   * mutation), so multiple providers can coexist in the same process.
   */
  apiKeyEnv?: string
  /**
   * Optional API base URL override. Honored by OpenAI (use for
   * Codex / Azure OpenAI / local LLM gateways that speak the
   * chat-completions wire format). Ignored by Anthropic (its SDK
   * has its own base URL configuration if needed).
   */
  baseUrl?: string
}

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  provider: 'anthropic',
  model: ANTHROPIC_DEFAULT_MODEL,
  apiKeyEnv: 'ANTHROPIC_API_KEY',
}

/**
 * Config used when no caller-supplied config AND no `ANTHROPIC_API_KEY`
 * in the env. Routes through the Claude Agent SDK against the user's
 * logged-in `claude` subscription, so `desde` Just Works
 * without an API key on a machine that has `claude /login` set up.
 */
export const CLAUDE_CODE_LLM_CONFIG: LLMConfig = {
  provider: 'claude_code',
  model: CLAUDE_AGENT_SDK_DEFAULT_MODEL,
}

export interface GetProviderOpts {
  /** Direct provider injection (tests, dev override). Wins over config. */
  override?: LLMProvider
  /** Config (typically loaded from `.desde/config.json` by the caller). */
  config?: LLMConfig
  /**
   * Env snapshot. Defaults to `process.env` — only injected by tests
   * so they can verify the "no API key → falls back to claude_code"
   * branch without mutating the real env.
   */
  env?: NodeJS.ProcessEnv
}

export function getProvider(opts: GetProviderOpts = {}): LLMProvider {
  if (opts.override) return opts.override
  const env = opts.env ?? process.env
  const config = opts.config ?? pickDefaultConfig(env)
  return buildProvider(config, env)
}

/**
 * The `LLMConfig` a provider id implies, before any project overrides.
 *
 * The subscription special case lives HERE and nowhere else: with no Anthropic
 * key but an explicit opt-in, the config routes through the bundled `claude`
 * binary instead. Duplicating that rule in `resolveLlmConfig` is how the two
 * would come to disagree about what "no key" means.
 */
export function configForProvider(
  providerId: string,
  env: NodeJS.ProcessEnv,
): LLMConfig {
  const descriptor = getDescriptor(providerId)
  if (!descriptor) return DEFAULT_LLM_CONFIG
  const { apiKeyEnvVar, hasSubscriptionRuntime } = descriptor.credentials
  if (
    hasSubscriptionRuntime === true &&
    !env[apiKeyEnvVar]?.trim() &&
    isClaudeSubscriptionOptIn(env)
  ) {
    return CLAUDE_CODE_LLM_CONFIG
  }
  const { baseUrl } = credentialsFromEnv(descriptor, env)
  return {
    provider: descriptor.id,
    apiKeyEnv: apiKeyEnvVar,
    ...(baseUrl ? { baseUrl } : {}),
  }
}

/**
 * Pick a default config from environment auth.
 *
 * Order, and why: a credentialed provider in precedence order wins, an
 * explicit key always beating a subscription. With nothing credentialed the
 * first descriptor's API config is returned and `buildProvider` refuses with
 * an actionable message — a deliberate failure, because the alternative is
 * quietly billing a user's personal subscription.
 */
export function pickDefaultConfig(env: NodeJS.ProcessEnv): LLMConfig {
  return configForProvider(
    resolveDefaultProviderId({
      env,
      isCredentialed: (d) => isCredentialedFromEnv(d, env),
    }),
    env,
  )
}

function buildProvider(config: LLMConfig, env: NodeJS.ProcessEnv): LLMProvider {
  // `claude_code` is the one special case: it has no descriptor of its own,
  // it is the runtime `configForProvider` translates the Anthropic
  // descriptor into on the subscription opt-in path.
  if (config.provider === 'claude_code') {
    return new ClaudeAgentSdkProvider({ defaultModel: config.model })
  }

  const descriptor = getDescriptor(config.provider)
  if (!descriptor) {
    throw new Error(
      `Unknown LLM provider '${config.provider}'. Supported: ${[
        ...listDescriptors().map((d) => d.id),
        'claude_code',
      ].join(', ')}.`,
    )
  }

  // `apiKeyEnv`: read the named env var explicitly and pass it to the provider
  // INSTANCE, so two providers with different keys coexist in one process
  // without cross-wiring. Falls back to the provider's own descriptor env var
  // when the caller's config left `apiKeyEnv` unset.
  const apiKeyEnvVar = config.apiKeyEnv ?? descriptor.credentials.apiKeyEnvVar
  const apiKey = config.apiKeyEnv
    ? env[config.apiKeyEnv]?.trim()
    : credentialsFromEnv(descriptor, env).apiKey
  const baseUrl = config.baseUrl ?? credentialsFromEnv(descriptor, env).baseUrl

  // Fail here, with instructions, rather than at the first call with a
  // provider-internal 401 that reads like a bug in Editor. This used to fire
  // only for 'anthropic', so an OpenAI misconfiguration surfaced lazily inside
  // complete() — the inconsistent failure the descriptor table removes.
  if (!apiKey?.trim()) {
    const envVar = apiKeyEnvVar ?? descriptor.credentials.apiKeyEnvVar
    const subscriptionHint =
      descriptor.credentials.hasSubscriptionRuntime === true
        ? ` Or set ${CLAUDE_SUBSCRIPTION_ENV}=1 to use the Claude subscription of the bundled \`claude\` CLI (only appropriate when you are running Editor for yourself. See the README).`
        : ''
    throw new Error(
      `Missing ${envVar}. Set it to use Editor's AI features with ${descriptor.label}, ` +
        `or add a key from the settings gear in the top bar.${subscriptionHint}`,
    )
  }

  return descriptor.buildProvider({
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(config.model ? { model: config.model } : {}),
  })
}
