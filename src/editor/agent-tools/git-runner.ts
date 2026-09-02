/**
 * Thin wrapper around `git` for read-only history tools.
 *
 * The agent never gets a shell. Every git invocation:
 *   - Goes through `execFile` (no shell interpretation of args).
 *   - First arg must be in `ALLOWED_SUBCOMMANDS` — write subcommands
 *     (`commit`, `checkout`, `reset`, …) cannot be reached from here.
 *   - Runs with sanitized env so `GIT_DIR` / `GIT_WORK_TREE` / config
 *     overrides on the parent process can't redirect git to another
 *     repo behind our back.
 *   - Disables hooks via `-c core.hooksPath=/dev/null` — an external
 *     repo's `.git/config` could otherwise install behavior on git
 *     commands.
 *   - Capped at `maxBuffer` + `timeout` so a runaway log can't OOM us.
 *
 * Refs and shas the agent passes in are validated against
 * `validateRef` / `validateSha` *before* hitting `execFile`. Paths are
 * always passed after `--` so leading-dash paths can't masquerade as
 * flags.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { sanitizedGitEnv } from '../core/read-roots'

const execFileP = promisify(execFile)

/**
 * Subcommands the read-only git tools are allowed to invoke. Anything
 * not on this list throws before `execFile` runs.
 */
export const ALLOWED_SUBCOMMANDS = new Set([
  'rev-parse',
  'rev-list',
  'log',
  'show',
  'cat-file',
  'diff',
  'grep',
  'ls-files',
  'status',
])

const SHA_RE = /^[0-9a-f]{4,64}$/
// Refs: HEAD, HEAD~N, HEAD^N, branch/tag names with safe chars only.
// Deliberately rejects ranges (`a..b`), ref-specs with whitespace, and
// anything containing shell metacharacters even though `execFile`
// already removes shell-injection risk — the regex is the cheap second
// layer.
const REF_RE = /^(HEAD|HEAD[~^]\d+|[A-Za-z0-9._/-]{1,200})$/
// Consecutive-dot check rejects range syntax (`a..b`, `a...b`).
const REF_RANGE_RE = /\.\./

export class GitRunnerError extends Error {
  constructor(
    message: string,
    public readonly stderr?: string,
    public readonly code?: number,
  ) {
    super(message)
    this.name = 'GitRunnerError'
  }
}

export function validateSha(sha: string): string {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
    throw new GitRunnerError(`invalid git sha: ${JSON.stringify(sha)}`)
  }
  return sha
}

export function validateRef(ref: string): string {
  if (typeof ref !== 'string' || !REF_RE.test(ref) || REF_RANGE_RE.test(ref)) {
    throw new GitRunnerError(`invalid git ref: ${JSON.stringify(ref)}`)
  }
  return ref
}

/**
 * Invoke `git -C <rootPath> <args>` with hardening. Returns stdout on
 * success, throws `GitRunnerError` (with captured stderr) on failure.
 *
 * Caller is responsible for arg construction — this function does NOT
 * shell-quote or escape; it just validates that the subcommand is on
 * the allowlist and forwards argv verbatim.
 */
export async function runGit(
  rootPath: string,
  args: readonly string[],
  opts?: { maxBytes?: number; timeoutMs?: number; signal?: AbortSignal },
): Promise<string> {
  if (args.length === 0) {
    throw new GitRunnerError('git invoked with no subcommand')
  }
  const subcommand = args[0]
  if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw new GitRunnerError(`git subcommand not allowed: ${subcommand}`)
  }

  // `-c core.hooksPath=/dev/null` defangs any hooks an external repo
  // may have configured. Prepended as global `-c` so it applies to the
  // subcommand without leaking into argv positions.
  const fullArgs = ['-C', rootPath, '-c', 'core.hooksPath=/dev/null', ...args]

  try {
    const { stdout } = await execFileP('git', fullArgs, {
      maxBuffer: opts?.maxBytes ?? 1_000_000,
      timeout: opts?.timeoutMs ?? 10_000,
      encoding: 'utf8',
      env: sanitizedGitEnv(),
      signal: opts?.signal,
    })
    return stdout
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; code?: number }
    // Differentiate timeout / abort from a git failure for callers.
    if (e.code === 'ABORT_ERR' || e.name === 'AbortError') {
      throw new GitRunnerError('git command aborted')
    }
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : undefined
    throw new GitRunnerError(stderr || e.message, stderr, typeof e.code === 'number' ? e.code : undefined)
  }
}
