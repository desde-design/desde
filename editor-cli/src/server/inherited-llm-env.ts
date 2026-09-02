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
 */

export interface InheritedLlmEnv {
  /** `ANTHROPIC_API_KEY` as the process received it, if it had one. */
  apiKey?: string
  /** `EDITOR_USE_CLAUDE_SUBSCRIPTION` as the process received it. */
  useSubscription?: string
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
    captured = {
      ...(env.ANTHROPIC_API_KEY === undefined ? {} : { apiKey: env.ANTHROPIC_API_KEY }),
      ...(env.EDITOR_USE_CLAUDE_SUBSCRIPTION === undefined
        ? {}
        : { useSubscription: env.EDITOR_USE_CLAUDE_SUBSCRIPTION }),
    }
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
  return captured ?? {}
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
  if (inherited.apiKey === undefined) delete next.ANTHROPIC_API_KEY
  else next.ANTHROPIC_API_KEY = inherited.apiKey
  if (inherited.useSubscription === undefined) delete next.EDITOR_USE_CLAUDE_SUBSCRIPTION
  else next.EDITOR_USE_CLAUDE_SUBSCRIPTION = inherited.useSubscription
  return next
}
