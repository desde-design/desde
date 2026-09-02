/**
 * Owns the desktop app's IN-MEMORY `claude` runtime install state — the
 * `main.ts` counterpart to `updater.ts` (same shape: a small controller
 * object main.ts constructs once at boot, subscribes to, and exposes over
 * IPC), but far simpler: there's no persisted toggle, no periodic re-check —
 * just "ensure it's installed," fired once automatically at boot (in the
 * BACKGROUND — see `main.ts`'s `boot()`, which never awaits this) and
 * again on demand via the settings-menu retry action.
 *
 * See `tasks/electron-app.md`'s "stop bundling the claude binary, fetch it
 * on first run" work and `claude-runtime-installer.ts`'s module doc comment
 * for the install mechanics this wraps.
 */

import {
  ClaudeRuntimeInstallError,
  ensureClaudeRuntime,
  type ClaudeRuntimeInstallCause,
  type EnsureClaudeRuntimeOptions,
} from "./claude-runtime-installer.js"

export interface ClaudeRuntimeState {
  phase: "checking" | "downloading" | "ready" | "error"
  error?: string
  errorReason?: ClaudeRuntimeInstallCause
}

export interface ClaudeRuntimeController {
  getState(): ClaudeRuntimeState
  /** Returns an unsubscribe function — same shape as `Updater.onState`. */
  onState(cb: (state: ClaudeRuntimeState) => void): () => void
  /**
   * Kicks off (or re-kicks-off) the ensure-installed flow. Safe to call
   * repeatedly — a call while one is already in flight is a no-op (the
   * in-flight attempt's own result still reaches every subscriber). This is
   * both the automatic boot-time trigger AND the settings-menu "Retry"
   * action; they're the exact same call.
   */
  ensure(): void
}

export interface CreateClaudeRuntimeControllerOptions {
  appSupportDir: string
  sdkVersion: string
  /** The signed-anchor tarball SRI for this platform+version — read from the payload lockfile by `claude-runtime-expectation.ts` and passed through to every {@link ensureClaudeRuntime} call. See `claude-runtime-installer.ts`'s `expectedIntegrity` doc. */
  expectedIntegrity: string
  /** Injected for tests — production callers never pass this. */
  ensureFn?: (opts: EnsureClaudeRuntimeOptions) => Promise<string>
}

export function createClaudeRuntimeController(
  opts: CreateClaudeRuntimeControllerOptions,
): ClaudeRuntimeController {
  let state: ClaudeRuntimeState = { phase: "checking" }
  const listeners = new Set<(state: ClaudeRuntimeState) => void>()
  let inFlight = false

  function setState(next: ClaudeRuntimeState): void {
    state = next
    for (const listener of listeners) listener(state)
  }

  function ensure(): void {
    if (inFlight) return
    inFlight = true
    const ensureFn = opts.ensureFn ?? ensureClaudeRuntime
    ensureFn({
      appSupportDir: opts.appSupportDir,
      sdkVersion: opts.sdkVersion,
      expectedIntegrity: opts.expectedIntegrity,
      // ensureClaudeRuntime reports "checking" -> ["downloading"] -> "ready"
      // itself on the success path — this is the ONLY place "ready" gets
      // set, so a caller observing state === "ready" knows the path really
      // was verified (executable + actually spawned), not just requested.
      onProgress: (phase) => setState({ phase }),
    })
      .catch((err: unknown) => {
        const errorReason = err instanceof ClaudeRuntimeInstallError ? err.reason : "unknown"
        setState({
          phase: "error",
          error: err instanceof Error ? err.message : String(err),
          errorReason,
        })
      })
      .finally(() => {
        inFlight = false
      })
  }

  return {
    getState: () => state,
    onState: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    ensure,
  }
}
