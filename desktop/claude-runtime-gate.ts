/**
 * Should this launch download the bundled `claude` runtime?
 *
 * It is roughly 200MB, and until multi-provider chat existed every chat turn
 * needed it regardless of anything the user had configured, so it was fetched
 * unconditionally. That is no longer true: an OpenAI-only user's chat never
 * touches the binary.
 *
 * THE PREDICATE, stated once: skip the download only when a NON-ANTHROPIC
 * provider is credentialed and Anthropic is NOT. Everything else downloads.
 * The consequences of that phrasing, each of which is a real user:
 *
 *  - First run, nothing configured: DOWNLOAD. A new user has no key of any
 *    kind, and the binary is what makes the subscription path work for them.
 *  - Anthropic key in the environment, nothing stored: DOWNLOAD. A terminal
 *    user with `export ANTHROPIC_API_KEY` stores nothing, and reading only the
 *    file would classify them as an OpenAI-only user and break their chat.
 *  - Dev mode, or EDITOR_USE_CLAUDE_SUBSCRIPTION: DOWNLOAD. Both mean "use the
 *    bundled binary", which is the thing in question.
 *  - Both providers credentialed: DOWNLOAD. The user can switch in the picker
 *    mid-session and must not hit a missing runtime.
 *
 * The provider table below duplicates two fields of the descriptor table. It
 * has to: `desktop/` imports no repo source. `desktop-gate-env-vars.test.ts` in
 * the root suite reads THIS FILE'S TEXT and fails if a registered descriptor's
 * api-key variable is missing from it, which is what stops the copy drifting.
 */

import type { StoredProviderCredential } from "./llm-credentials-read.js"

/** The Anthropic descriptor's id and api-key variable. */
const ANTHROPIC_ID = "anthropic"
const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY"

/** Every other registered descriptor's id and api-key variable. */
const NON_ANTHROPIC_PROVIDERS: ReadonlyArray<{ id: string; apiKeyEnvVar: string }> = [
  { id: "openai", apiKeyEnvVar: "OPENAI_API_KEY" },
]

/** The Anthropic-only subscription opt-in. Its presence means the binary is wanted. */
const SUBSCRIPTION_ENV = "EDITOR_USE_CLAUDE_SUBSCRIPTION"

function isSubscriptionOptIn(value: string | undefined): boolean {
  if (value === undefined) return false
  return ["1", "true", "yes", "on"].includes(value.toLowerCase())
}

function credentialed(
  id: string,
  apiKeyEnvVar: string,
  stored: Record<string, StoredProviderCredential>,
  env: NodeJS.ProcessEnv,
): boolean {
  const storedKey = stored[id]?.apiKey
  if (typeof storedKey === "string" && storedKey.length > 0) return true
  const envKey = env[apiKeyEnvVar]
  return typeof envKey === "string" && envKey.length > 0
}

export interface ClaudeRuntimeGateInput {
  stored: Record<string, StoredProviderCredential>
  devMode: boolean
  env: NodeJS.ProcessEnv
}

export function shouldDownloadClaudeRuntime(input: ClaudeRuntimeGateInput): boolean {
  if (input.devMode) return true
  if (isSubscriptionOptIn(input.env[SUBSCRIPTION_ENV])) return true
  if (credentialed(ANTHROPIC_ID, ANTHROPIC_API_KEY_ENV, input.stored, input.env)) return true
  const other = NON_ANTHROPIC_PROVIDERS.some((p) =>
    credentialed(p.id, p.apiKeyEnvVar, input.stored, input.env),
  )
  // The only skip: somebody else is credentialed and Anthropic is not.
  return !other
}
