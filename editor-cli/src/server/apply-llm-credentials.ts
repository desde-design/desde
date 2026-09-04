import { homedir } from "node:os"
import type { StoredCredentials } from "../../../src/editor/llm-providers/credential-probe.js"
import {
  captureInheritedLlmEnv,
  inheritedLlmEnv,
  type InheritedLlmEnv,
} from "./inherited-llm-env.js"
import { readLlmCredentials } from "./llm-credential-store.js"

/**
 * The ONE place stored credentials enter the process environment.
 *
 * There are two consumers and both read env, so one injection covers both:
 *   - Chat, via the Claude Agent SDK, which spawns the `claude` binary.
 *   - The four non-chat lanes, via `getProvider()` -> `pickDefaultConfig(env)`:
 *     `apply-llm-patch`, `repair-edit`, `verification/translate-goal`,
 *     `hints/llm-generate-hints`.
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
 * Recompute the whole LLM-credential environment from (inherited, stored).
 * Mutates `env` in place.
 *
 * **Idempotent, and that is load-bearing.** It first restores `env` to the
 * inherited baseline, then applies the stored state on top. Written as an
 * in-place mutation instead, a dev-mode toggle permanently destroyed an
 * exported `ANTHROPIC_API_KEY`: enabling dev mode deletes the variable by
 * design, and with no record of what the shell had provided, disabling it
 * again restored only a stored key, or nothing.
 *
 * **Dev mode DELETES `ANTHROPIC_API_KEY`.** "Subscription regardless of key"
 * cannot be implemented by merely declining to inject one: `pickDefaultConfig`
 * checks `env.ANTHROPIC_API_KEY` FIRST and returns the API config when it
 * finds one, and the spawned `claude` binary reads the same variable
 * independently. An externally exported key would otherwise beat dev mode in
 * both consumers.
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
): void {
  // Reset to the launch-time baseline, so this call's result depends only on
  // its arguments and never on what a previous call left behind.
  if (inherited.apiKey === undefined) delete env.ANTHROPIC_API_KEY
  else env.ANTHROPIC_API_KEY = inherited.apiKey
  if (inherited.useSubscription === undefined) delete env.EDITOR_USE_CLAUDE_SUBSCRIPTION
  else env.EDITOR_USE_CLAUDE_SUBSCRIPTION = inherited.useSubscription

  if (stored.devMode) {
    delete env.ANTHROPIC_API_KEY
    env.EDITOR_USE_CLAUDE_SUBSCRIPTION = "1"
    return
  }
  // Env always wins. A stored key must never silently overwrite an explicitly
  // exported one — that would make a user's own shell config stop meaning
  // what it says.
  if (present(env.ANTHROPIC_API_KEY)) return
  const storedKey = present(stored.providers.anthropic?.apiKey)
  if (storedKey) env.ANTHROPIC_API_KEY = storedKey
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
