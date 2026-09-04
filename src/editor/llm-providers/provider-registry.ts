/**
 * The descriptor table and the one rule that decides which provider is THE
 * provider when several could serve.
 *
 * That rule is stated once and answered here for four questions that used to
 * answer it separately: the picker's initial render, the catalog response's
 * `default`, a brand-new chat session's model, and the non-chat registry's
 * `pickDefaultConfig`.
 *
 * It imports `claude-subscription.ts`, NEVER `registry.ts`. `registry.ts` reads
 * this table (Task 8), so the reverse arrow would be a cycle in which the
 * foundation depends on what is built on it.
 */
import { isClaudeSubscriptionOptIn } from './claude-subscription'
import { ANTHROPIC_DESCRIPTOR } from './descriptors/anthropic'
import { OPENAI_DESCRIPTOR } from './descriptors/openai'
import type { ProviderDescriptor } from './provider-descriptor'

export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [
  ANTHROPIC_DESCRIPTOR,
  OPENAI_DESCRIPTOR,
]

/** Precedence when several providers are credentialed and no config says. */
export const DEFAULT_PROVIDER_PRECEDENCE = ['anthropic', 'openai'] as const

export function getDescriptor(id: string): ProviderDescriptor | undefined {
  return PROVIDER_DESCRIPTORS.find((d) => d.id === id)
}

export function listDescriptors(): readonly ProviderDescriptor[] {
  return PROVIDER_DESCRIPTORS
}

/**
 * Is this provider usable from the environment alone?
 *
 * Exported because the catalog resolver, the non-chat config resolver and the
 * status API all need the same answer, and three copies of it is exactly how
 * the five concerns drifted before the descriptor table existed. The
 * subscription clause is gated on `hasSubscriptionRuntime`, so it can never
 * make a keyless OpenAI look configured.
 */
export function isCredentialedFromEnv(
  descriptor: ProviderDescriptor,
  env: NodeJS.ProcessEnv,
): boolean {
  if (env[descriptor.credentials.apiKeyEnvVar]?.trim()) return true
  return (
    descriptor.credentials.hasSubscriptionRuntime === true &&
    isClaudeSubscriptionOptIn(env)
  )
}

/**
 * The credentials a descriptor is owed, read from the ONE place boot puts
 * them: `applyLlmCredentialsToEnv` injects the stored key into the
 * descriptor's own variable, and a shell export lands in the same variable.
 * Both chat lanes and the non-chat registry read through here, so "which
 * variable" is decided once, on the descriptor.
 */
export function credentialsFromEnv(
  descriptor: ProviderDescriptor,
  env: NodeJS.ProcessEnv,
): { apiKey?: string; baseUrl?: string } {
  const key = env[descriptor.credentials.apiKeyEnvVar]?.trim()
  const url = descriptor.credentials.baseUrlEnvVar
    ? env[descriptor.credentials.baseUrlEnvVar]?.trim()
    : undefined
  return { ...(key ? { apiKey: key } : {}), ...(url ? { baseUrl: url } : {}) }
}

/**
 * `llm.defaultProvider` if set and credentialed; else the first credentialed
 * id in precedence order, then registration order; else the first descriptor.
 *
 * The last clause matters: with nothing credentialed at all the answer must
 * still be a real provider, because the caller then produces a config whose
 * `buildProvider` refuses with that provider's own remediation text. Returning
 * "nobody" would move the failure to a null dereference somewhere later.
 */
export function resolveDefaultProviderId(input: {
  env: NodeJS.ProcessEnv
  configuredDefault?: string
  isCredentialed: (d: ProviderDescriptor) => boolean
}): string {
  const configured = input.configuredDefault
    ? getDescriptor(input.configuredDefault)
    : undefined
  if (configured && input.isCredentialed(configured)) return configured.id

  for (const id of DEFAULT_PROVIDER_PRECEDENCE) {
    const d = getDescriptor(id)
    if (d && input.isCredentialed(d)) return d.id
  }
  const credentialed = PROVIDER_DESCRIPTORS.find((d) => input.isCredentialed(d))
  if (credentialed) return credentialed.id

  return PROVIDER_DESCRIPTORS[0]!.id
}
