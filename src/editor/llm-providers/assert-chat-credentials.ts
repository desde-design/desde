import { CLAUDE_SUBSCRIPTION_ENV, isClaudeSubscriptionOptIn } from './claude-subscription'
import { getDescriptor } from './provider-registry'
import type { ProviderDescriptor } from './provider-descriptor'

/**
 * Refuse a chat turn that would otherwise run on someone's Claude
 * subscription without them having asked for it, or on a provider they
 * never gave a key for.
 *
 * ## Why this exists
 *
 * Chat runs on the Claude Agent SDK, which spawns the bundled `claude`
 * binary, which authenticates with whatever it is already configured with.
 * That is a genuinely nice property when you are the developer: sign in once
 * in a terminal and every tool works. It is also the exact thing Anthropic's
 * Agent SDK terms do not allow a distributed product to do — third-party
 * developers may not offer claude.ai login for products built on the SDK,
 * and must use API-key authentication instead.
 *
 * Without this gate the terms problem is invisible rather than absent: a user who
 * happens to have `claude` signed in gets a fully working product, is never
 * asked for anything, and is billed against their own subscription by our
 * software. The old quickstart advertised precisely that ("Nothing extra to
 * set").
 *
 * The non-chat provider registry has always required an explicit choice here,
 * on the stated grounds that "routing silently to a personal Claude
 * subscription is a decision someone should take on purpose". This applies the
 * same rule to chat, which was the lane that had not adopted it.
 *
 * ## Why it checks the provider the session picked, not Anthropic alone
 *
 * A chat turn now names a provider (`effectiveModelConfig.provider`). Once a
 * session can pick OpenAI, a gate that only ever reads `ANTHROPIC_API_KEY`
 * checks the wrong thing in both directions: it would admit an OpenAI turn on
 * an unrelated Anthropic key, and it would refuse an OpenAI-only user who has
 * never set an Anthropic key at all. This module takes the provider id as an
 * argument and checks that provider's own credential, from the same
 * descriptor table `resolveDefaultProviderId` and `isCredentialedFromEnv`
 * use.
 *
 * ## Why it reads the environment rather than the credential store
 *
 * `applyLlmCredentialsToEnv` is the single place stored credentials enter the
 * process, and it runs at boot and after every mutation. So by the time a turn
 * starts, a provider's API key env var is present exactly when a key is
 * configured, from either source. Reading the store directly here would also
 * invert the import direction: this module lives in root `src/`, the store
 * lives in `editor-cli/`, and `src/` never imports upward.
 *
 * Dev mode is covered by the same read: it DELETES `ANTHROPIC_API_KEY` and is
 * an opt-in, so it fails the key test and passes the opt-in test.
 */
export class ChatCredentialsMissingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatCredentialsMissingError'
  }
}

export function hasChatCredentials(env: NodeJS.ProcessEnv, providerId: string): boolean {
  const descriptor = getDescriptor(providerId)
  if (!descriptor) return false
  if (env[descriptor.credentials.apiKeyEnvVar]?.trim()) return true
  // The subscription clause is gated on the descriptor, so an unrelated
  // Claude subscription can never admit an OpenAI session.
  return descriptor.credentials.hasSubscriptionRuntime === true && isClaudeSubscriptionOptIn(env)
}

/**
 * The message a user sees. It names what they can do, not what we require: the
 * settings dialog is where almost everyone will set a key, and it is the ONLY
 * route in the desktop app, where a shell `export` never reaches the process.
 * The environment variable is named second, for terminal users.
 */
export function chatCredentialsMessage(descriptor: ProviderDescriptor): string {
  const subscription =
    descriptor.credentials.hasSubscriptionRuntime === true
      ? ` If you are running Desde only for yourself and would rather use the Claude subscription the bundled \`claude\` binary is signed in with, set ${CLAUDE_SUBSCRIPTION_ENV}=1.`
      : ''
  return (
    `Chat needs an ${descriptor.label} API key for this model. ` +
    'Add one from the settings gear in the top bar, or set ' +
    `${descriptor.credentials.apiKeyEnvVar} before starting. ` +
    'Everything that does not use a model, including the inspector, layers, direct edits, ' +
    'comments, Commit and Publish, keeps working without one.' +
    subscription
  )
}

export function assertChatCredentials(env: NodeJS.ProcessEnv, providerId: string): void {
  const descriptor = getDescriptor(providerId)
  if (!descriptor) {
    throw new ChatCredentialsMissingError(
      `Chat cannot run on provider '${providerId}': no such provider is configured.`,
    )
  }
  if (hasChatCredentials(env, providerId)) return
  throw new ChatCredentialsMissingError(chatCredentialsMessage(descriptor))
}
