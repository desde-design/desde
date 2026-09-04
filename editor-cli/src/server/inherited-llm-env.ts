/**
 * The LLM-credential environment this process INHERITED, captured once before
 * anything injects into it.
 *
 * Two defects made this necessary, both found by review rather than by tests:
 *
 * 1. **A stored key read back as `env`.** Boot injects the stored key into
 *    `process.env.ANTHROPIC_API_KEY`, and the probe's env rung fires before
 *    its stored rung, so after any save or restart the status said the key was
 *    externally managed. The dialog then disabled Replace and Remove: the user
 *    could never manage the key they had just saved.
 *
 * 2. **Dev mode destroyed an exported key.** Enabling dev mode deletes
 *    `ANTHROPIC_API_KEY` on purpose, but with nowhere recording what the shell
 *    had provided, disabling it again restored only a stored key, or nothing.
 *    An exported key was gone until the CLI restarted.
 *
 * Both are the same missing fact: whether a value in `process.env` came from
 * the user's shell or from us. Capturing the baseline answers it once, and
 * lets `applyLlmCredentialsToEnv` be idempotent — it recomputes the whole
 * desired state from (inherited, stored) rather than mutating in place.
 *
 * **Generalised over the descriptor table.** The tracked variable list used to
 * be two hand-named fields (`apiKey`, `useSubscription`). It is now every
 * descriptor's key and base-URL variable plus the subscription flag, derived
 * from `PROVIDER_DESCRIPTORS` so a new vendor is tracked for free.
 */
import { CLAUDE_SUBSCRIPTION_ENV } from "../../../src/editor/llm-providers/registry.js"
import { PROVIDER_DESCRIPTORS } from "../../../src/editor/llm-providers/provider-registry.js"

/**
 * Every environment variable this process may inject into or roll back.
 *
 * Derived from the descriptor table rather than listed by hand, because a
 * hand-listed variable is one a new vendor forgets. Adding Kimi adds its key
 * here for free.
 */
export const TRACKED_LLM_ENV_VARS: readonly string[] = [
  ...new Set([
    ...PROVIDER_DESCRIPTORS.flatMap((d) => [
      d.credentials.apiKeyEnvVar,
      ...(d.credentials.baseUrlEnvVar ? [d.credentials.baseUrlEnvVar] : []),
    ]),
    CLAUDE_SUBSCRIPTION_ENV,
  ]),
]

export interface InheritedLlmEnv {
  /**
   * Each tracked variable as the process received it. A variable the shell did
   * not set is ABSENT from the map rather than present-and-undefined, so
   * "empty baseline" stays literally `{}`.
   */
  vars: Record<string, string | undefined>
}

let captured: InheritedLlmEnv | undefined

/**
 * Capture the baseline. Idempotent: only the FIRST call records anything, so a
 * later call cannot mistake our own injection for the user's shell.
 *
 * Must run before `applyLlmCredentialsToEnv` touches the environment.
 */
export function captureInheritedLlmEnv(env: NodeJS.ProcessEnv = process.env): InheritedLlmEnv {
  if (!captured) {
    const vars: Record<string, string | undefined> = {}
    for (const name of TRACKED_LLM_ENV_VARS) {
      if (env[name] !== undefined) vars[name] = env[name]
    }
    captured = { vars }
  }
  return captured
}

/**
 * The captured baseline, or an empty one if capture never ran.
 *
 * Empty-when-uncaptured is the safe default: it means "the shell gave us
 * nothing", so a stored key is reported as `stored` and stays manageable. The
 * opposite default would re-create defect 1.
 */
export function inheritedLlmEnv(): InheritedLlmEnv {
  return captured ?? { vars: {} }
}

/** Test-only: clears the module-level capture between cases. */
export function resetInheritedLlmEnvForTests(): void {
  captured = undefined
}

/**
 * A copy of `env` with the LLM credential variables rolled back to what this
 * process inherited, for handing to a spawned child editor.
 *
 * The launcher re-runs this same entrypoint per project (`defaultSpawnEditor`)
 * and the child inherits `process.env` wholesale. Without this rollback the
 * child captures OUR injection as its own baseline, decides the key came from
 * the shell, and disables Replace and Remove for a key the app owns — the same
 * class of defect the capture exists to prevent, one process further down.
 *
 * The child reads the store and re-injects for itself, so nothing is lost.
 */
export function spawnEnvWithInheritedLlmCredentials(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const inherited = inheritedLlmEnv()
  const next: NodeJS.ProcessEnv = { ...env }
  for (const name of TRACKED_LLM_ENV_VARS) {
    const base = inherited.vars[name]
    if (base === undefined) delete next[name]
    else next[name] = base
  }
  return next
}
