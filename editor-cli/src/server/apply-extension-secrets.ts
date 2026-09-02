import { homedir } from "node:os"
import { capabilitySecretNames } from "../../../src/editor/core/capability-catalog.js"
import { readExtensionSecrets } from "./extension-secret-store.js"

/**
 * The ONE place stored extension secrets enter the process environment.
 *
 * The MCP server entries in `.mcp.json` carry `${VAR}` references written
 * UNinterpolated, so the loader resolves them from `process.env` at the moment
 * a turn's `query()` is constructed. Putting a saved key there is therefore
 * the whole mechanism: nothing else has to change for the extension to start
 * working on the next message.
 *
 * **Only catalog names are ever injected.** The HTTP layer already refuses a
 * name the catalog does not declare, and this is the second half of that same
 * guard — `process.env` decides what every subprocess we spawn inherits, so a
 * write that could name `PATH` or `NODE_OPTIONS` would be arbitrary code
 * execution rather than a settings change. Two independent checks, because
 * either one alone is one bug away from that.
 *
 * The same known trade-off `apply-llm-credentials.ts` records applies here and
 * is accepted for the same reason: a key in `process.env` is reachable by
 * every subprocess, which was already true for the `export FIGMA_API_KEY=…`
 * user this replaces.
 */
export function applyExtensionSecretsToEnv(
  stored: Record<string, string>,
  env: NodeJS.ProcessEnv,
): void {
  const allowed = capabilitySecretNames()
  for (const [name, value] of Object.entries(stored)) {
    if (!allowed.has(name)) continue
    const trimmed = value.trim()
    if (!trimmed) continue
    // Env always wins, matching the LLM key. A stored value must never
    // silently overwrite one the user exported, or their shell config stops
    // meaning what it says.
    if (env[name]?.trim()) continue
    env[name] = trimmed
  }
}

/** Boot entry point. Never throws — the store already degrades to empty. */
export async function applyExtensionSecretsAtBoot(home = homedir()): Promise<void> {
  applyExtensionSecretsToEnv(await readExtensionSecrets(home), process.env)
}
