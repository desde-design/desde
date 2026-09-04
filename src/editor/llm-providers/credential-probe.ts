/**
 * The credential ladder: does Editor have ANY usable model credential, and
 * which one?
 *
 * Pure and fully injected — no `process.env` read, no filesystem, no network.
 * That is not only for testability: this module lives in root `src/`, and the
 * credential store lives in `editor-cli/`. The import direction is fixed
 * (`editor-cli` imports `src`, never the reverse), so the caller reads the
 * store and passes its contents in.
 *
 * See `docs/superpowers/specs/2026-08-13-editor-llm-credentials-design.md` §1.
 */

import type { ProviderDescriptor } from './provider-descriptor'

export type CredentialSource = 'subscription' | 'env' | 'stored' | 'none'

/** One provider's slot in the store. Open string ids: a new vendor needs no schema change. */
export interface StoredProviderCredentials {
  apiKey?: string
  baseUrl?: string
}

/** The persisted half of the ladder — the shape `llm-credential-store` holds. */
export interface StoredCredentials {
  providers: Record<string, StoredProviderCredentials>
  /** Global, and Anthropic-only in MEANING. See the ladder's rung 0. */
  devMode: boolean
}

export interface CredentialProbeInput {
  /** Which provider is being asked about. Rungs 0 and 3 read its credential spec. */
  descriptor: ProviderDescriptor
  /**
   * This descriptor's key env var as the process INHERITED it, before
   * anything injected into it.
   *
   * **Not `process.env[...]`.** Boot copies a stored key into that variable,
   * so reading it live makes every stored key report as externally managed,
   * which disables the controls that manage it. The field is named for the
   * distinction because passing the wrong one type-checks cleanly and
   * produced exactly that bug. See `editor-cli/src/server/inherited-llm-env.ts`.
   */
  inheritedApiKey?: string
  stored: StoredCredentials
  claudeRuntimeResolvable: boolean
  /**
   * Whether the caller has explicitly opted into the Claude-subscription
   * path: dev mode in the settings dialog, or `EDITOR_USE_CLAUDE_SUBSCRIPTION`
   * in the environment.
   *
   * Separate from `stored.devMode` because the two opt-ins come from
   * different places and either one is sufficient. The caller ORs them.
   */
  subscriptionOptIn?: boolean
}

export type CredentialProbeResult =
  | { credentialed: true; source: 'subscription' }
  | { credentialed: true; source: 'env' | 'stored'; maskedHint: string }
  | { credentialed: false; source: 'none' }

const MASK_TAIL_LENGTH = 4

/**
 * Reduce a key to something safe to render. The tail is enough for a person to
 * recognise WHICH key is configured; the prefix comes from the descriptor, not
 * from the key, so a malformed value can never leak its head.
 *
 * A key too short to have a distinct tail is masked entirely — showing 3 of 3
 * characters would be the whole secret.
 */
export function maskKey(key: string, maskPrefix: string): string {
  const trimmed = key.trim()
  if (trimmed.length <= MASK_TAIL_LENGTH) return `${maskPrefix}…`
  return `${maskPrefix}…${trimmed.slice(-MASK_TAIL_LENGTH)}`
}

function presentKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * The subscription rung is a HEURISTIC and callers must treat it as one. It
 * asks whether the runtime exists, not whether it is authenticated, so an
 * expired subscription login still reports credentialed there.
 *
 * That is deliberate. Probing authentication properly costs a network
 * round-trip on every boot, and the expiry case is already handled at runtime
 * by `AUTH_REAUTH_MESSAGE` in `../agent-chat/classify-turn-error`. This probe
 * exists for the empty-install case, which it identifies correctly.
 *
 * ## Why subscription is opt-in, and no longer a silent fallthrough
 *
 * This rung used to fire on `claudeRuntimeResolvable` ALONE. The effect was
 * that anyone whose `claude` binary happened to be signed in got a working
 * Editor and was never asked for anything, which is what made the old
 * quickstart able to say "Nothing extra to set."
 *
 * Anthropic's Agent SDK terms do not allow that for a distributed product:
 * third-party developers may not offer claude.ai login for products built on
 * the SDK, and must use API-key authentication instead. Dogfooding on a
 * personal subscription is fine. Shipping a product whose default path is
 * someone's subscription is not.
 *
 * So the rung now needs `subscriptionOptIn` too. With no key and no opt-in the
 * ladder reports `none`, which is what makes the first-run dialog ask for a
 * key rather than silently proceeding.
 *
 * This mirrors what the non-chat provider registry already did. It required
 * `ANTHROPIC_API_KEY`, or an explicit `EDITOR_USE_CLAUDE_SUBSCRIPTION`, and
 * refused otherwise, on the stated grounds that "routing silently to a
 * personal Claude subscription is a decision someone should take on purpose."
 * That reasoning was right and chat was the lane that had not adopted it.
 *
 * ## Rungs 0 and 3 are provider-gated, not id-compared
 *
 * Both dev-mode rungs check `descriptor.credentials.hasSubscriptionRuntime`
 * rather than `descriptor.id === 'anthropic'`. That makes them unreachable
 * for every other provider BY CONSTRUCTION — a new vendor with no
 * subscription runtime never needs this file touched to stay excluded.
 */
export function probeCredential(input: CredentialProbeInput): CredentialProbeResult {
  const { credentials } = input.descriptor
  const hasSubscriptionRuntime = credentials.hasSubscriptionRuntime === true
  const maskPrefix = credentials.maskPrefix

  // Rung 0. Gated on the descriptor, so it is unreachable for a provider with
  // no subscription runtime BY CONSTRUCTION rather than by an id comparison.
  if (input.stored.devMode && hasSubscriptionRuntime) {
    return { credentialed: true, source: 'subscription' }
  }
  const envKey = presentKey(input.inheritedApiKey)
  if (envKey) {
    return { credentialed: true, source: 'env', maskedHint: maskKey(envKey, maskPrefix) }
  }
  const storedKey = presentKey(input.stored.providers[input.descriptor.id]?.apiKey)
  if (storedKey) {
    return {
      credentialed: true,
      source: 'stored',
      maskedHint: maskKey(storedKey, maskPrefix),
    }
  }
  // Rung 3, same gate. `isClaudeRuntimeResolvable` is a presence heuristic for
  // ONE bundled binary; generalising it would misdescribe every provider that
  // has none, so it is simply never consulted for them.
  if (hasSubscriptionRuntime && input.subscriptionOptIn && input.claudeRuntimeResolvable) {
    return { credentialed: true, source: 'subscription' }
  }
  return { credentialed: false, source: 'none' }
}
