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

export type CredentialSource = 'subscription' | 'env' | 'stored' | 'none'

/** The persisted half of the ladder — the shape `llm-credential-store` holds. */
export interface StoredCredentials {
  apiKey?: string
  devMode: boolean
}

export interface CredentialProbeInput {
  /**
   * The `ANTHROPIC_API_KEY` the process INHERITED from its launch
   * environment, before anything injected into it.
   *
   * **Not `process.env.ANTHROPIC_API_KEY`.** Boot copies a stored key into
   * that variable, so reading it live makes every stored key report as
   * externally managed, which disables the controls that manage it. The field
   * is named for the distinction because passing the wrong one type-checks
   * cleanly and produced exactly that bug. See
   * `editor-cli/src/server/inherited-llm-env.ts`.
   */
  inheritedApiKey?: string
  stored: StoredCredentials
  /**
   * Whether the `claude` runtime resolves on disk. NOT whether it is logged
   * in — see the heuristic note on `probeCredential`.
   *
   * As of the BYO-key cutover this no longer makes the ladder report
   * credentialed on its own; it is consulted only when the subscription path
   * has been opted into. See the "Why subscription is opt-in" note on
   * `probeCredential`.
   */
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

const MASK_PREFIX = 'sk-ant-…'
const MASK_TAIL_LENGTH = 4

/**
 * Reduce a key to something safe to render. The tail is enough for a person to
 * recognise WHICH key is configured; the prefix is a constant, not read from
 * the key, so a malformed value can never leak its head.
 *
 * A key too short to have a distinct tail is masked entirely — showing 3 of 3
 * characters would be the whole secret.
 */
export function maskKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length <= MASK_TAIL_LENGTH) return MASK_PREFIX
  return `${MASK_PREFIX}${trimmed.slice(-MASK_TAIL_LENGTH)}`
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
 */
export function probeCredential(input: CredentialProbeInput): CredentialProbeResult {
  if (input.stored.devMode) {
    return { credentialed: true, source: 'subscription' }
  }
  const envKey = presentKey(input.inheritedApiKey)
  if (envKey) {
    return { credentialed: true, source: 'env', maskedHint: maskKey(envKey) }
  }
  const storedKey = presentKey(input.stored.apiKey)
  if (storedKey) {
    return { credentialed: true, source: 'stored', maskedHint: maskKey(storedKey) }
  }
  if (input.subscriptionOptIn && input.claudeRuntimeResolvable) {
    return { credentialed: true, source: 'subscription' }
  }
  return { credentialed: false, source: 'none' }
}
