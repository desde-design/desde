/**
 * One table, five concerns.
 *
 * Catalog resolution, the chat credential gate, chat-runtime dispatch, the
 * credential settings surface and the non-chat `getProvider()` registry each
 * used to re-derive "is this provider usable" from its own facts. That is the
 * drifted-pair shape CLAUDE.md's "gate at both ends" rule warns about, applied
 * to providers instead of feature flags. Every one of them now reads a
 * descriptor.
 *
 * Adding a vendor must touch this directory, the catalogs, the rate cards and
 * nothing else. A change to a runtime, a handler, the credential store or the
 * picker while adding a vendor is a design failure, not a bigger commit.
 */
import type { EffortLevel, ProviderModelCatalog } from '../core/model-catalog'
import type { LiveModel } from './live-model-catalog'
import type { LLMProvider } from './types'

/** Which turn runtime serves this provider's chat. */
export type ChatRuntimeKind = 'claude-agent-sdk' | 'neutral'

/** Machine-readable asymmetries, read by the catalog response, the picker and the steer route. */
export interface ProviderCapabilities {
  /** true only on the Claude Agent SDK lane; false = steers land at the next tool-loop boundary. */
  midTurnSteering: boolean
  /** true when the runtime reports a dollar figure (SDK total_cost_usd); false = rate-card estimate. */
  vendorReportedCostUsd: boolean
  /** 'vendor' = the SDK stops in flight; 'step-boundary' = the loop stops between steps. */
  inTurnBudgetStop: 'vendor' | 'step-boundary'
  /** Whether reasoning_delta events can be expected. */
  reasoningVisibility: boolean
  /** rate_limit_warning events. Anthropic-only. */
  vendorRateLimitEvents: boolean
  imagesInPrompt: boolean
  /** WebFetch / WebSearch built-ins. */
  webTools: boolean
}

export interface ProviderCredentialSpec {
  /** Env var carrying the API key. Captured at boot, injected from the store. */
  apiKeyEnvVar: string
  /** Optional env var for a base URL override (OpenAI-compatible vendors). */
  baseUrlEnvVar?: string
  /** Mask prefix for the settings UI, e.g. 'sk-ant-' or 'sk-'. */
  maskPrefix: string
  /** Where the user gets a key. Rendered in the credential dialog. */
  consoleUrl: string
  /**
   * True only for a provider with a local subscription runtime (Anthropic's
   * bundled `claude` binary). Gates the dev-mode rungs of the credential
   * ladder and `isClaudeRuntimeResolvable`. Never generalise this.
   */
  hasSubscriptionRuntime?: boolean
}

export interface ValidateKeyResult {
  ok: boolean
  /** User-facing when !ok. No em dashes, no first person. */
  message?: string
}

export interface ProviderDescriptor {
  /** Stable id. Matches SessionModelConfig.provider and LLMConfig.provider. */
  readonly id: string
  /** 'Anthropic', 'OpenAI'. */
  readonly label: string
  readonly chatRuntime: ChatRuntimeKind
  readonly capabilities: ProviderCapabilities
  readonly credentials: ProviderCredentialSpec
  /** Build an LLMProvider bound to explicit credentials. No process.env reads. */
  buildProvider(input: {
    apiKey?: string
    baseUrl?: string
    model?: string
    fetchImpl?: typeof fetch
  }): LLMProvider
  /** Static fallback catalog. Always present, exactly one isDefault. */
  readonly staticCatalog: ProviderModelCatalog
  /** Live model list. Omitted for a vendor with no usable models endpoint. */
  listLiveModels?(input: {
    apiKey: string
    baseUrl?: string
    fetchImpl?: typeof fetch
    signal?: AbortSignal
  }): Promise<LiveModel[]>
  /** Cheap authenticated GET used by the settings dialog's Save. Fails closed. */
  validateKey(input: {
    apiKey: string
    baseUrl?: string
    fetchImpl?: typeof fetch
  }): Promise<ValidateKeyResult>
  /**
   * Effort mapping. `levels: null` hides the picker's effort control.
   * `toRequest` is what the neutral runtime puts on the wire (as
   * StreamOpts.providerOptions); the SDK runtime ignores it.
   */
  readonly effort: {
    levels: EffortLevel[] | null
    toRequest(effort: EffortLevel | undefined): Record<string, unknown>
  }
  /** Patterns merged into classify-turn-error's generic sets, plus the remediation copy. */
  readonly errorPatterns?: ProviderErrorPatterns
}

/** Patterns merged into classify-turn-error's generic sets, plus the remediation copy. */
export interface ProviderErrorPatterns {
  auth?: RegExp[]
  rateLimited?: RegExp[]
  reauthMessage: string
}
