import { CLAUDE_SUBSCRIPTION_ENV, isClaudeSubscriptionOptIn } from './registry'

/**
 * Refuse a chat turn that would otherwise run on someone's Claude
 * subscription without them having asked for it.
 *
 * ## Why this exists
 *
 * Chat runs on the Claude Agent SDK, which spawns the bundled `claude` binary,
 * which authenticates with whatever it is already configured with. That is a
 * genuinely nice property when you are the developer: sign in once in a
 * terminal and every tool works. It is also the exact thing Anthropic's Agent
 * SDK terms do not allow a distributed product to do — third-party developers
 * may not offer claude.ai login for products built on the SDK, and must use
 * API-key authentication instead.
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
 * ## Why it reads the environment rather than the credential store
 *
 * `applyLlmCredentialsToEnv` is the single place stored credentials enter the
 * process, and it runs at boot and after every mutation. So by the time a turn
 * starts, `ANTHROPIC_API_KEY` is present exactly when a key is configured, from
 * either source. Reading the store directly here would also invert the import
 * direction: this module lives in root `src/`, the store lives in
 * `editor-cli/`, and `src/` never imports upward.
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

export function hasChatCredentials(env: NodeJS.ProcessEnv): boolean {
  if (env.ANTHROPIC_API_KEY?.trim()) return true
  return isClaudeSubscriptionOptIn(env)
}

/**
 * The message a user sees. It names what they can do, not what we require:
 * the settings dialog is where almost everyone will set a key, and it is the
 * ONLY route in the desktop app, where a shell `export` never reaches the
 * process. The environment variable is named second, for terminal users.
 *
 * The subscription opt-in is mentioned last and framed as what it is. Someone
 * running Desde for themselves is not the case the restriction is about.
 */
export function chatCredentialsMessage(): string {
  return (
    'Chat needs an Anthropic API key. Add one from the settings gear in the top bar, ' +
    'or set ANTHROPIC_API_KEY before starting. ' +
    'Everything that does not use a model, including the inspector, layers, direct edits, ' +
    'comments, Commit and Publish, keeps working without one. ' +
    `If you are running Desde only for yourself and would rather use the Claude subscription ` +
    `the bundled \`claude\` binary is signed in with, set ${CLAUDE_SUBSCRIPTION_ENV}=1.`
  )
}

export function assertChatCredentials(env: NodeJS.ProcessEnv): void {
  if (hasChatCredentials(env)) return
  throw new ChatCredentialsMissingError(chatCredentialsMessage())
}
