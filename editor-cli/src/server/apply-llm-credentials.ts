import { homedir } from "node:os"
import type { StoredCredentials } from "../../../src/editor/llm-providers/credential-probe.js"
import type { ProviderDescriptor } from "../../../src/editor/llm-providers/provider-descriptor.js"
import { PROVIDER_DESCRIPTORS } from "../../../src/editor/llm-providers/provider-registry.js"
// From `claude-subscription.js` directly, NOT `registry.js` (M1,
// final-review-report.md): `registry.js` statically imports
// `claude-agent-sdk-provider.ts`, which imports the Agent SDK, and this
// module is on the boot graph — pulling that in here would put the SDK on
// every boot, OpenAI-only included.
import { CLAUDE_SUBSCRIPTION_ENV } from "../../../src/editor/llm-providers/claude-subscription.js"
import {
  captureInheritedLlmEnv,
  inheritedLlmEnv,
  TRACKED_LLM_ENV_VARS,
  type InheritedLlmEnv,
} from "./inherited-llm-env.js"
import { readLlmCredentials } from "./llm-credential-store.js"

/**
 * The ONE place stored credentials enter the process environment.
 *
 * There are two consumers and both read env, so one injection covers both:
 *   - Chat, via the Claude Agent SDK, which spawns the `claude` binary.
 *   - The six non-chat lanes, via `getProvider()` -> `pickDefaultConfig(env)`:
 *     `apply-llm-patch`, `repair-edit`, `verification/translate-goal`,
 *     `hints/llm-generate-hints`, `iteration-data-llm`, `design-systems-handler`.
 *
 * KNOWN TRADE-OFF, recorded deliberately: this puts the key in reach of every
 * subprocess the CLI spawns, including `npm run <script>` during verification
 * (see the 2026-08-09 security audit). That was already true for a terminal
 * user who exports the variable; this makes it newly true for desktop users.
 * Accepted because the alternative — threading an `LLMConfig` through four
 * argless `getProvider()` call sites — is strictly larger AND would still
 * leave chat needing the variable, since the SDK spawns a separate binary.
 */

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Recompute the whole LLM-credential environment from (inherited, stored),
 * for every provider in `descriptors`. Mutates `env` in place.
 *
 * **Idempotent, and that is load-bearing.** It first restores `env` to the
 * inherited baseline, then applies the stored state on top. Written as an
 * in-place mutation instead, a dev-mode toggle permanently destroyed an
 * exported `ANTHROPIC_API_KEY`: enabling dev mode deletes the variable by
 * design, and with no record of what the shell had provided, disabling it
 * again restored only a stored key, or nothing.
 *
 * **Dev mode is Anthropic-scoped and runs LAST, with no early return.**
 * "Subscription regardless of key" cannot be implemented by merely declining
 * to inject one: `pickDefaultConfig` checks `env.ANTHROPIC_API_KEY` FIRST and
 * returns the API config when it finds one, and the spawned `claude` binary
 * reads the same variable independently. An externally exported key would
 * otherwise beat dev mode in both consumers. Returning early here, before
 * step 2 ran for every other provider, is exactly how a stored OpenAI key
 * would have been silently skipped whenever dev mode was on — dev mode forces
 * the Claude subscription, it does not disable another vendor. It is scoped
 * to `hasSubscriptionRuntime` descriptors, which today is Anthropic alone.
 *
 * `delete`, never assignment to `undefined` — `spawn()` passes an `undefined`
 * value through as the literal string `"undefined"` on some platforms. Same
 * reasoning `desktop/child.ts` already applies to
 * `EDITOR_CLAUDE_EXECUTABLE_PATH`.
 */
export function applyLlmCredentialsToEnv(
  stored: StoredCredentials,
  env: NodeJS.ProcessEnv,
  inherited: InheritedLlmEnv = inheritedLlmEnv(),
  descriptors: readonly ProviderDescriptor[] = PROVIDER_DESCRIPTORS,
): void {
  // 1. Reset EVERY tracked variable to the launch-time baseline, so this
  //    call's result depends only on its arguments and never on what a
  //    previous call left behind.
  for (const name of TRACKED_LLM_ENV_VARS) {
    const base = inherited.vars[name]
    if (base === undefined) delete env[name]
    else env[name] = base
  }

  // 2. Per provider, env always wins. A stored key must never silently
  //    overwrite an explicitly exported one — that would make a user's own
  //    shell config stop meaning what it says.
  for (const descriptor of descriptors) {
    const slot = stored.providers[descriptor.id]
    const keyVar = descriptor.credentials.apiKeyEnvVar
    if (!present(env[keyVar])) {
      const storedKey = present(slot?.apiKey)
      if (storedKey) env[keyVar] = storedKey
    }
    const baseUrlVar = descriptor.credentials.baseUrlEnvVar
    if (baseUrlVar && !present(env[baseUrlVar])) {
      const storedBaseUrl = present(slot?.baseUrl)
      if (storedBaseUrl) env[baseUrlVar] = storedBaseUrl
    }
  }

  // 3. Dev mode LAST, scoped to providers with a subscription runtime, and
  //    with NO early return. See the docblock above.
  if (stored.devMode) {
    for (const descriptor of descriptors) {
      if (descriptor.credentials.hasSubscriptionRuntime !== true) continue
      delete env[descriptor.credentials.apiKeyEnvVar]
    }
    env[CLAUDE_SUBSCRIPTION_ENV] = "1"
  }
}

/**
 * Boot entry point. Never throws — the store already degrades to defaults.
 *
 * Captures the inherited baseline FIRST. After the next line `process.env` may
 * hold a key we put there, and nothing downstream could otherwise tell that
 * apart from one the user exported.
 */
export async function applyLlmCredentialsAtBoot(home = homedir()): Promise<void> {
  const inherited = captureInheritedLlmEnv(process.env)
  applyLlmCredentialsToEnv(await readLlmCredentials(home), process.env, inherited)
}
