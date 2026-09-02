import { spawn } from "node:child_process"

/**
 * Git status snapshot for the user's repo, normalized to the shape
 * `validateStatusResponse` expects.
 *
 * Three fields populated by separate `git` invocations because the
 * commands have distinct exit-code semantics:
 *
 * - `head_commit` from `git rev-parse --short HEAD` — exits non-zero on
 *   unborn HEAD ("ambiguous argument 'HEAD'"), in which case the value
 *   is `null`. We DON'T treat this as an error, just as state.
 * - `branch` from `git rev-parse --abbrev-ref HEAD` — emits the literal
 *   "HEAD" on detached-HEAD checkouts, which we map to `null`. Real
 *   branches like `main`, `feat/x`, etc. pass through verbatim.
 * - `dirty` from `git status --porcelain` — non-empty output means
 *   uncommitted edits OR untracked files. We use porcelain v1 (the
 *   default) because v2 adds parsing complexity for no benefit.
 *
 * **Why spawn, not exec.** `exec` runs through a shell, which means a
 * weird repoRoot path containing shell metacharacters could lead to
 * command injection. `spawn` with an args array bypasses the shell
 * entirely. The repoRoot here is user-supplied (it's the path the user
 * passed to `desde <repo>`), so this is the right hygiene.
 */

export interface GitStatus {
  /** Working tree has uncommitted changes OR untracked files. */
  dirty: boolean
  /** 7-char SHA. `null` on unborn HEAD. */
  head_commit: string | null
  /** Git branch name. `null` in detached-HEAD state. */
  branch: string | null
  /**
   * ISO-8601 timestamp of the most recent commit on HEAD (`git log -1
   * --format=%cI HEAD`). `null` on unborn HEAD or when the probe
   * fails for any reason. Fed into `StatusResponse.last_edit_timestamp`
   * — the spec says local scope reports "most recent commit OR
   * uncommitted save"; we use commit time, with a future enhancement
   * to consider working-tree mtime when `dirty: true`.
   */
  head_commit_timestamp: string | null
}

const CACHE_TTL_MS = 1000

interface CacheEntry {
  status: GitStatus
  expiresAt: number
}

/**
 * Per-repoRoot cache. Keyed by absolute repoRoot path so two CLI
 * instances pointed at different repos don't share state. Invalidated
 * on `invalidateGitStatusCache(repoRoot)` when an edit applies — the
 * caller is the edit-handler.
 */
const cache = new Map<string, CacheEntry>()

export interface GetGitStatusOptions {
  /** Override TTL for tests. Default 1000ms. */
  ttlMs?: number
  /** Override the spawner for tests. Defaults to node:child_process spawn. */
  spawnFn?: SpawnFn
  /** Skip the cache (force a fresh run). Used by tests. */
  noCache?: boolean
}

/**
 * Fetch the git status for the working tree at `repoRoot`. Caches per
 * `repoRoot` for 1 second by default to absorb rapid agent polling
 * (status query can be called per-keystroke by some MCP consumers).
 *
 * Errors from any of the three git invocations propagate up — the
 * caller decides whether to surface as a `warnings` entry on the
 * StatusResponse or treat it as a hard failure. (V1: `mcp-handler.ts`
 * surfaces them as warnings; the response still ships with whichever
 * fields it could compute.)
 */
export async function getGitStatus(
  repoRoot: string,
  opts: GetGitStatusOptions = {},
): Promise<GitStatus> {
  const ttl = opts.ttlMs ?? CACHE_TTL_MS
  const spawnFn = opts.spawnFn ?? defaultSpawn

  const now = Date.now()
  const cached = cache.get(repoRoot)
  if (!opts.noCache && cached && cached.expiresAt > now) {
    return cached.status
  }

  const [head_commit, branch, dirty, head_commit_timestamp] = await Promise.all([
    readHeadCommit(repoRoot, spawnFn),
    readBranch(repoRoot, spawnFn),
    readDirty(repoRoot, spawnFn),
    readHeadCommitTimestamp(repoRoot, spawnFn),
  ])

  const status: GitStatus = { head_commit, branch, dirty, head_commit_timestamp }
  cache.set(repoRoot, { status, expiresAt: now + ttl })
  return status
}

/**
 * Drop the cached git status for `repoRoot`. The edit-handler calls
 * this after every successful `applyEdit` so the next status query
 * sees the fresh state without waiting for the TTL.
 */
export function invalidateGitStatusCache(repoRoot: string): void {
  cache.delete(repoRoot)
}

/** Test-only: drop ALL cache entries. */
export function _resetGitStatusCacheForTests(): void {
  cache.clear()
}

// ── git invocations ────────────────────────────────────────────────

async function readHeadCommit(
  repoRoot: string,
  spawnFn: SpawnFn,
): Promise<string | null> {
  const result = await runGit(spawnFn, repoRoot, ["rev-parse", "--short", "HEAD"])
  if (result.exitCode === 0) {
    return result.stdout.trim() || null
  }
  // Unborn HEAD: `git rev-parse HEAD` fails with a message containing
  // "ambiguous argument 'HEAD'" or "unknown revision". The exit code
  // alone isn't a reliable signal because the same code is used for
  // "not a git repo" — so we explicitly classify by stderr.
  if (looksLikeUnbornHead(result.stderr)) {
    return null
  }
  throw new GitError(
    `git rev-parse HEAD failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
  )
}

async function readBranch(repoRoot: string, spawnFn: SpawnFn): Promise<string | null> {
  const result = await runGit(spawnFn, repoRoot, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ])
  if (result.exitCode === 0) {
    const trimmed = result.stdout.trim()
    if (trimmed === "" || trimmed === "HEAD") return null
    return trimmed
  }
  if (looksLikeUnbornHead(result.stderr)) {
    // Unborn HEAD case: `rev-parse --abbrev-ref HEAD` also fails. The
    // status doc says branch is non-null on unborn HEAD (it's just
    // pointed at an unborn ref like `main` from `init.defaultBranch`).
    // Try `git symbolic-ref --short HEAD` as a fallback for unborn-HEAD
    // branch detection — it succeeds where rev-parse fails because
    // HEAD's symbolic ref EXISTS even when no commits do.
    const sym = await runGit(spawnFn, repoRoot, ["symbolic-ref", "--short", "HEAD"])
    if (sym.exitCode === 0) {
      const branch = sym.stdout.trim()
      return branch === "" ? null : branch
    }
    return null
  }
  throw new GitError(
    `git rev-parse --abbrev-ref HEAD failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
  )
}

async function readHeadCommitTimestamp(
  repoRoot: string,
  spawnFn: SpawnFn,
): Promise<string | null> {
  // %cI = committer date in strict ISO-8601 with timezone — exactly
  // the format the StatusResponse contract wants. Falls back to null
  // for any failure mode (unborn HEAD, transient git error, etc.) so
  // it never poisons the rest of the status query.
  const result = await runGit(spawnFn, repoRoot, ["log", "-1", "--format=%cI", "HEAD"])
  if (result.exitCode === 0) {
    const trimmed = result.stdout.trim()
    return trimmed || null
  }
  return null
}

async function readDirty(repoRoot: string, spawnFn: SpawnFn): Promise<boolean> {
  const result = await runGit(spawnFn, repoRoot, ["status", "--porcelain"])
  if (result.exitCode !== 0) {
    throw new GitError(
      `git status --porcelain failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    )
  }
  return result.stdout.trim().length > 0
}

function looksLikeUnbornHead(stderr: string): boolean {
  const s = stderr.toLowerCase()
  return (
    s.includes("ambiguous argument 'head'") ||
    s.includes("unknown revision") ||
    s.includes("does not have any commits yet") ||
    s.includes("bad revision") // some git versions phrase it this way
  )
}

// ── spawn plumbing ─────────────────────────────────────────────────

interface SpawnResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type SpawnFn = (
  cwd: string,
  args: readonly string[],
) => Promise<SpawnResult>

const defaultSpawn: SpawnFn = (cwd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", reject)
    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr })
    })
  })

async function runGit(
  spawnFn: SpawnFn,
  cwd: string,
  args: readonly string[],
): Promise<SpawnResult> {
  return spawnFn(cwd, args)
}

export class GitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GitError"
  }
}
