/**
 * Provider registry. Single entry point for resolving the active
 * `LLMProvider` at runtime.
 *
 * Config sources, in order of precedence:
 *   1. Explicit `override` argument (test/dev convenience).
 *   2. `LLMConfig` passed in by the caller.
 *   3. Built-in default from `pickDefaultConfig(env)`: Anthropic.
 *
 * ⚠️ **Precedence 2 is currently unreachable, so `case 'openai'` below is
 * dead code.** Every call site — `apply-llm-patch.ts`, `repair-edit.ts`,
 * `verification/translate-goal.ts`, `hints/llm-generate-hints.ts` — calls
 * `getProvider()` with NO arguments, and nothing anywhere loads an
 * `LLMConfig` from disk. An earlier version of this comment claimed "CLI
 * bootstrap loads it from `.desde/config.json` and hands it through";
 * that loader was never written. So the provider is always whatever
 * `pickDefaultConfig` returns, which is Anthropic or `claude_code` — never
 * OpenAI.
 *
 * `OpenAIProvider` itself is real and tested; only the wiring is missing.
 * Reaching it means loading an `llm` block from
 * `desde.config.json` and threading it into those four calls.
 * Deferred past initial distribution — see tasks/NEXT.md § "Out of active
 * scope". Note this registry is NOT the chat lane: chat runs on the Claude
 * Agent SDK (`src/editor/agent-chat-sdk/`) and never calls `getProvider()`.
 *
 * The registry deliberately does NOT touch the filesystem itself —
 * config loading is the caller's responsibility. This keeps the
 * registry pure and testable, and keeps the per-runtime config policy
 * (CLI vs. web app vs. tests) in the runtime that owns it.
 */

import { AnthropicProvider, ANTHROPIC_DEFAULT_MODEL } from './anthropic-provider'
import {
  ClaudeAgentSdkProvider,
  CLAUDE_AGENT_SDK_DEFAULT_MODEL,
} from './claude-agent-sdk-provider'
import { CLAUDE_SUBSCRIPTION_ENV, isClaudeSubscriptionOptIn } from './claude-subscription'
import { OpenAIProvider, OPENAI_DEFAULT_MODEL } from './openai-provider'
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
 * Pick a default config from environment auth.
 *
 * Order, and why: an explicit `ANTHROPIC_API_KEY` always wins (a key-holder
 * is never silently routed elsewhere). Otherwise the subscription path is
 * used ONLY when explicitly opted into. With neither, the API config is
 * returned and `buildProvider` refuses with an actionable message — a
 * deliberate failure, because the alternative is quietly billing a user's
 * personal subscription.
 */
export function pickDefaultConfig(env: NodeJS.ProcessEnv): LLMConfig {
  if (env.ANTHROPIC_API_KEY) return DEFAULT_LLM_CONFIG
  if (isClaudeSubscriptionOptIn(env)) return CLAUDE_CODE_LLM_CONFIG
  return DEFAULT_LLM_CONFIG
}

function buildProvider(config: LLMConfig, env: NodeJS.ProcessEnv): LLMProvider {
  // `apiKeyEnv` (Phase 0 punchlist item): read the named env var
  // explicitly and pass to the provider INSTANCE. Each provider binds
  // to its own key — no `process.env` mutation, so two providers with
  // different keys can coexist in the same process without cross-wiring.
  const apiKey = config.apiKeyEnv ? env[config.apiKeyEnv] : undefined
  if (config.provider === 'anthropic' && !apiKey) {
    // Fail here, with instructions, rather than at the first turn with a
    // provider-internal 401 that reads like a bug in Editor.
    throw new Error(
      `Missing ${config.apiKeyEnv ?? 'ANTHROPIC_API_KEY'}. Set it to use Editor's AI features, ` +
        `or set ${CLAUDE_SUBSCRIPTION_ENV}=1 to use the Claude subscription of the bundled \`claude\` CLI ` +
        `(only appropriate when you are running Editor for yourself. See the README).`,
    )
  }
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider({
        defaultModel: config.model,
        apiKey,
      })
    case 'claude_code':
      return new ClaudeAgentSdkProvider({
        defaultModel: config.model,
      })
    case 'openai':
      return new OpenAIProvider({
        apiKey: apiKey ?? env.OPENAI_API_KEY,
        defaultModel: config.model ?? OPENAI_DEFAULT_MODEL,
        baseUrl: config.baseUrl,
      })
    default:
      throw new Error(
        `Unknown LLM provider '${config.provider}'. Supported: anthropic, claude_code, openai.`,
      )
  }
}
