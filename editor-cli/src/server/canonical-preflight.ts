/**
 * Canonical-repo state preflight, run before Editor starts editing the
 * user's working tree in place (branch mode).
 *
 * Branch mode only refuses one thing: an in-progress git operation
 * (merge/cherry-pick/revert/bisect/rebase). Editing over a mid-merge tree
 * is genuinely unsafe — the working tree contains unresolved conflict
 * markers and Editor's edits would land on top of them. A dirty tree or
 * detached HEAD is not a problem in branch mode: Editor edits the
 * current working tree in place, and dirty/detached is the user's own
 * call, not data-loss.
 *
 * (This preflight previously also refused dirty/detached-HEAD canonicals
 * ahead of creating a worktree session — worktree-session mode is gone,
 * so those checks were removed along with it.)
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { promises as fs } from "node:fs"
import path from "node:path"

const execFileAsync = promisify(execFile)

export type PreflightResult = { ok: true } | { ok: false; reason: string }

/**
 * Refuses only if canonical has an in-progress git operation.
 */
export async function preflightCanonicalRoot(canonicalRoot: string): Promise<PreflightResult> {
  return checkInProgressGitOps(canonicalRoot)
}

async function checkInProgressGitOps(
  root: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let gitDir: string
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      root,
      "rev-parse",
      "--git-common-dir",
    ])
    gitDir = stdout.trim()
    if (!path.isAbsolute(gitDir)) gitDir = path.resolve(root, gitDir)
  } catch (err) {
    return {
      ok: false,
      reason: `Could not read .git directory: ${(err as Error).message}`,
    }
  }
  const markers: Array<[string, string]> = [
    ["merge", "MERGE_HEAD"],
    ["cherry-pick", "CHERRY_PICK_HEAD"],
    ["revert", "REVERT_HEAD"],
    ["bisect", "BISECT_LOG"],
  ]
  const inProgress: string[] = []
  for (const [name, file] of markers) {
    try {
      await fs.access(path.join(gitDir, file))
      inProgress.push(name)
    } catch {
      // marker absent
    }
  }
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    try {
      const stat = await fs.stat(path.join(gitDir, dir))
      if (stat.isDirectory()) inProgress.push(`rebase (${dir})`)
    } catch {
      // dir absent
    }
  }
  if (inProgress.length > 0) {
    return {
      ok: false,
      // "This repository", not "Canonical". The word is ours — it names the
      // user's real checkout as distinct from a worktree, a distinction that
      // stopped existing when worktree-session mode was removed — and this
      // string is read by a person, in a terminal and now in the launcher's
      // modal (`server/launcher-open-check.ts` quotes it verbatim).
      reason: `This repository has in-progress git operations: ${inProgress.join(", ")}. Finish or abort them before starting the editor.`,
    }
  }
  return { ok: true }
}
