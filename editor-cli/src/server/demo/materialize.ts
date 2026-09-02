/**
 * Copy the bundled demo to disk and make it a git repo.
 *
 * Git is not optional. `launcher-open-check.ts` refuses a non-git folder
 * outright, and its reason is worth restating: edits land in the working tree,
 * undo comes from the backup journal, and Commit and Publish are git
 * operations, so there is nothing underneath them without a repo.
 *
 * NO `origin` is configured, deliberately. `hasRemote` means only "a remote is
 * configured", never "the remote is writable", so pointing the demo at a repo
 * the user cannot push to would leave Push, Merge-and-push and
 * Create-Pull-Request rendering ENABLED and then failing with raw git stderr in
 * a toast. With no remote they render disabled with a plain reason. This costs
 * nothing, and it does not affect the viewer link, which is configured
 * separately in `.desde/config.json`.
 *
 * A mid-copy failure leaves a half-built repo. Left alone, the next call's
 * "does it already exist" check would treat that rubble as a working demo and
 * open it. So the write phase is wrapped: on failure it best-effort removes
 * whatever it created and RETHROWS the original error, so the caller can report
 * it and the next attempt starts clean. The cleanup is its own try/catch,
 * because a cleanup failure must never shadow the real error.
 */
import { execFile } from "node:child_process"
import { access, cp, mkdir, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { promisify } from "node:util"
import { resolveDemoFixtureDir } from "../../payload-paths.js"
import { demoRepoPath, markDemoTried } from "./paths.js"

const execFileAsync = promisify(execFile)

export interface MaterializeDemoOptions {
  home?: string
  /** Overridden only by tests; production always resolves the shipped fixture. */
  fixtureDir?: string
}

export interface MaterializeDemoResult {
  path: string
  /** False when the demo was already on disk and was opened as-is. */
  created: boolean
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function materializeDemo(
  opts: MaterializeDemoOptions = {},
): Promise<MaterializeDemoResult> {
  const dest = demoRepoPath(opts.home)
  if (await exists(dest)) {
    await markDemoTried(opts.home)
    return { path: dest, created: false }
  }

  const fixtureDir = opts.fixtureDir ?? resolveDemoFixtureDir()
  if (!(await stat(fixtureDir)).isDirectory()) {
    throw new Error(`Demo fixture is not a directory: ${fixtureDir}`)
  }

  try {
    await mkdir(dirname(dest), { recursive: true })
    await cp(fixtureDir, dest, { recursive: true })
    const git = (args: string[]) => execFileAsync("git", ["-C", dest, ...args])
    await git(["init", "--quiet"])
    await git(["add", "-A"])
    // `-c` rather than the user's global config: the demo must neither depend
    // on an identity being configured nor attribute itself to the user.
    await git([
      "-c",
      "user.name=Desde",
      "-c",
      "user.email=demo@desde.local",
      "commit",
      "--quiet",
      "-m",
      "Demo prototype",
    ])
    await markDemoTried(opts.home)
    return { path: dest, created: true }
  } catch (error) {
    try {
      await rm(dest, { recursive: true, force: true })
    } catch {
      // A cleanup failure must never shadow the original error.
    }
    throw error
  }
}
