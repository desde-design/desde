/**
 * Delete the demo, for real.
 *
 * Removing it from the recents list alone would be wrong twice over.
 * `projects-registry.ts` documents itself as "a CACHE, never a source of
 * truth... re-created on the next boot of that repo", so a list-only removal
 * undoes itself the moment the demo is opened again. And the demo lives in a
 * directory the app chose, not the user, so a list-only removal strands a
 * folder they did not ask for. For a user's own repo "remove from recents" is
 * right, because the repo still sits where they put it. For the demo it is
 * not.
 *
 * THE PATH IS PINNED. This module resolves the demo path itself and exposes
 * no way to name a different one; the HTTP route reads no body at all. A
 * recursive delete steered by a caller-supplied path is the traversal class
 * this repo has been bitten by before, and taking no parameter removes the
 * question rather than guarding it.
 *
 * THE MARKER IS CHECKED. A pinned path is not enough now that the path is a
 * plain folder name in Documents: a folder the user made there must never be
 * reported as the demo or deleted as the demo. `isManagedDemo` (paths.ts) is
 * the ownership test, and both functions here refuse anything it rejects.
 *
 * `triedAt` deliberately survives. See `paths.ts`.
 */
import { execFile } from "node:child_process"
import { access, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { promisify } from "node:util"
import { removeProjectRegistryEntry } from "../projects-registry.js"
import { demoRepoPath, isManagedDemo } from "./paths.js"

const execFileAsync = promisify(execFile)

export interface DemoChangeSummary {
  present: boolean
  /** Working-tree entries `git status --porcelain` reports. */
  dirtyFiles: number
  /** Commits beyond the single seed commit. */
  extraCommits: number
}

const ABSENT: DemoChangeSummary = { present: false, dirtyFiles: 0, extraCommits: 0 }

/**
 * What would actually be lost. The demo starts byte-identical to the bundle,
 * but the moment someone edits it, it becomes their work, so the confirmation
 * says something different in each case rather than one generic warning.
 */
export async function classifyDemoChanges(
  home: string = homedir(),
): Promise<DemoChangeSummary> {
  const path = demoRepoPath(home)
  try {
    await access(path)
  } catch {
    return ABSENT
  }
  if (!(await isManagedDemo(path))) return ABSENT
  try {
    const status = await execFileAsync("git", ["-C", path, "status", "--porcelain"])
    const count = await execFileAsync("git", ["-C", path, "rev-list", "--count", "HEAD"])
    const lines = status.stdout.split("\n").filter((line) => line.trim().length > 0)
    const commits = Number.parseInt(count.stdout.trim(), 10)
    return {
      present: true,
      dirtyFiles: lines.length,
      extraCommits: Number.isFinite(commits) ? Math.max(0, commits - 1) : 0,
    }
  } catch {
    // Present but not a readable git repo. Report it as present-and-unknown
    // rather than absent, so the confirmation still warns before deleting.
    return { present: true, dirtyFiles: 0, extraCommits: 0 }
  }
}

export async function removeDemo(
  home: string = homedir(),
): Promise<{ removed: boolean; reason?: string }> {
  const path = demoRepoPath(home)
  try {
    await access(path)
  } catch {
    return { removed: false }
  }
  if (!(await isManagedDemo(path))) {
    return {
      removed: false,
      reason: `The folder at ${path} is not the Desde demo, so it was left alone.`,
    }
  }
  await rm(path, { recursive: true, force: true })
  // Best effort: the registry is a cache, and a stale entry is repaired on the
  // next boot anyway. Failing the delete over it would be the wrong trade.
  try {
    await removeProjectRegistryEntry(path)
  } catch {
    // See above.
  }
  return { removed: true }
}
