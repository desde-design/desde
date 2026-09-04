/**
 * The opt-in for the bundled-`claude` subscription path.
 *
 * A LEAF module on purpose. It lived in `registry.ts`, which now reads the
 * descriptor table, while the descriptor table needs this flag: leaving it
 * there made the foundation depend on the thing built on top of it. Nothing
 * here imports anything.
 *
 * This USED to be the default whenever `ANTHROPIC_API_KEY` was unset, which was
 * fine while Editor was a single-user internal tool and wrong the moment it
 * ships to anyone else: it would silently spend the end user's own Claude
 * subscription, which the Agent SDK terms do not permit for distributed
 * software. Requiring an explicit flag makes that a decision someone takes
 * rather than one they inherit.
 */
export const CLAUDE_SUBSCRIPTION_ENV = 'EDITOR_USE_CLAUDE_SUBSCRIPTION'

export function isClaudeSubscriptionOptIn(env: NodeJS.ProcessEnv): boolean {
  return isTruthyFlag(env[CLAUDE_SUBSCRIPTION_ENV])
}

function isTruthyFlag(v: string | undefined): boolean {
  if (!v) return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}
