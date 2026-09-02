/**
 * Adapter seam for running verification commands (typecheck, lint, test,
 * build) in a substrate-neutral way. The agent's `run_verification` MCP
 * tool delegates to an instance of this interface so the check-name →
 * shell-command mapping is owned by the substrate adapter, not
 * hardcoded in core.
 *
 * Day-one impl: `src/editor/adapters/node-npm/verification-adapter.ts`
 * for Node/npm (auto-detects pnpm / yarn from lockfile). Other
 * substrates (Python/pytest, Rust/cargo, etc.) plug in behind the same
 * interface when a customer asks for them.
 *
 * The adapter NEVER throws — every failure mode is encoded in
 * {@link VerificationRunResult}. The MCP tool wrapper translates the
 * result into the `EditorToolResult` shape; it never sees an
 * uncaught exception.
 */

/** The four verbs the agent can request. Substrate-neutral. */
export type VerificationCheck = 'typecheck' | 'lint' | 'test' | 'build'

/**
 * Output of a single check run. Always returned — even on
 * "no such script" the adapter answers with `ok=false, noScript=true`
 * plus the list of scripts that DO exist so the model can self-correct
 * (e.g. "typecheck not found — try test:types").
 */
export interface VerificationRunResult {
  ok: boolean
  exitCode: number
  /** stdout, capped to {@link VERIFICATION_OUTPUT_MAX_BYTES}. */
  stdout: string
  /** stderr, capped to {@link VERIFICATION_OUTPUT_MAX_BYTES}. */
  stderr: string
  /** Wall-clock duration. */
  durationMs: number
  /**
   * The exact command line executed (display only — never re-shell-
   * exec this). Mostly useful for "we couldn't find typecheck so we
   * tried tsc directly" diagnostics.
   */
  command: string
  /**
   * True when the substrate has no script for this check AND no
   * builtin fallback was available. `exitCode` is conventionally -1
   * in this case; `availableScripts` lists what the user does have.
   */
  noScript?: boolean
  /**
   * Names of the scripts the substrate exposes (e.g. `package.json`'s
   * `scripts`). Populated when `noScript=true` so the model can
   * suggest the user run something else.
   */
  availableScripts?: string[]
  /** Set when the process was aborted (signal abort, timeout). */
  aborted?: boolean
  /** Set when the process timed out before completing. */
  timedOut?: boolean
}

/** Cap on each of stdout / stderr captured by the adapter. */
export const VERIFICATION_OUTPUT_MAX_BYTES = 32 * 1024

/** Hard timeout cap on a single verification run (10 minutes). */
export const VERIFICATION_TIMEOUT_MS = 10 * 60 * 1000

export interface VerificationAdapter {
  /**
   * Human-readable substrate label surfaced to the agent. Examples:
   * `"npm"`, `"pnpm"`, `"yarn"`, `"cargo"`. Used in the tool's stdout
   * preamble so the model knows what runtime executed.
   */
  readonly substrateLabel: string

  /**
   * Run the named check. Implementations MUST NOT throw — every
   * failure path returns a {@link VerificationRunResult}.
   */
  run(
    check: VerificationCheck,
    opts?: { signal?: AbortSignal },
  ): Promise<VerificationRunResult>
}
