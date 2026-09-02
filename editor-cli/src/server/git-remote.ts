/**
 * Read + normalize the local checkout's `origin` remote, so the
 * project-link flow can verify a local folder actually points at the
 * GitHub repo the cloud project is bound to (`project.repo.fullName`).
 *
 * Mirrors the exec pattern in `src/editor/worktree/git-branches.ts`
 * (execFile, no shell, `-C <root>`, locks disabled) rather than
 * importing its module-private helpers.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const GIT_ENV = { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" }

/**
 * `git -C <root> remote get-url origin`, or null when there's no repo
 * / no `origin` remote. Never throws for the "not configured" cases —
 * a missing remote is an expected state the caller handles, not an
 * error.
 */
export async function readOriginRemoteUrl(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "remote", "get-url", "origin"],
      { env: GIT_ENV },
    )
    const url = stdout.trim()
    return url.length > 0 ? url : null
  } catch {
    // No repo, no `origin`, or git absent — all "unknown remote".
    return null
  }
}

/**
 * Extract `owner/repo` from a GitHub remote URL, matching the shape of
 * `ProjectRepo.fullName`. Handles the common forms:
 *   - https://github.com/owner/repo(.git)
 *   - git@github.com:owner/repo(.git)
 *   - ssh://git@github.com/owner/repo(.git)
 * Returns null for anything that isn't recognizably a GitHub remote.
 * Comparison is case-insensitive (GitHub owners/repos are).
 */
export function parseGitHubFullName(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/i, "")
  // scp-like: git@github.com:owner/repo
  const scp = trimmed.match(/^[^@]+@github\.com:([^/]+)\/(.+)$/i)
  if (scp) return `${scp[1]}/${scp[2]}`
  // url forms: https://github.com/owner/repo, ssh://git@github.com/owner/repo
  const urlLike = trimmed.match(/github\.com[/:]([^/]+)\/(.+)$/i)
  if (urlLike) return `${urlLike[1]}/${urlLike[2]}`
  return null
}

/**
 * Compare the local `origin` remote against an expected
 * `owner/repo`. Returns a discriminated result the link handler
 * surfaces to the user:
 *   - `match`     — origin resolves to the expected repo.
 *   - `mismatch`  — origin points somewhere else (warn, allow override).
 *   - `no-remote` — no origin / not a git repo (informational).
 *   - `unparseable` — origin isn't a recognizable GitHub URL.
 */
export async function checkOriginMatches(
  root: string,
  expectedFullName: string,
): Promise<
  | { status: "match" }
  | { status: "mismatch"; actual: string }
  | { status: "no-remote" }
  | { status: "unparseable"; remoteUrl: string }
> {
  const url = await readOriginRemoteUrl(root)
  if (!url) return { status: "no-remote" }
  const actual = parseGitHubFullName(url)
  if (!actual) return { status: "unparseable", remoteUrl: url }
  if (actual.toLowerCase() === expectedFullName.toLowerCase()) {
    return { status: "match" }
  }
  return { status: "mismatch", actual }
}
