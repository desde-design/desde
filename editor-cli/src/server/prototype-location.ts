import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export interface PrototypeLocation {
  /**
   * Absolute path of the git repo root containing the prototype. Equals
   * the prototype root when the prototype IS the repo root.
   */
  gitRoot: string
  /**
   * POSIX-style path of the prototype relative to `gitRoot`, or "" when
   * the prototype is the repo root. e.g. "editor-cli/self-host".
   */
  subdirOffset: string
}

/**
 * Resolve where a supervised prototype sits within its git repo.
 *
 * Editor worktrees are whole-repo — git worktrees always are — so when
 * the supervised path is a **subdirectory** of a larger repo (a prototype
 * package in a monorepo, or Editor's own UI under
 * `editor-cli/self-host`), the session worktree checks out the repo
 * ROOT. The session must therefore be created against the git root (so
 * the `node_modules` symlink + `.desde/` scaffolding land where they
 * work), while Vite is rooted at `<worktree>/<subdirOffset>` where the
 * prototype's `index.html` + `vite.config` actually live.
 *
 * `subdirOffset === ""` is the common single-package case (prototype ==
 * repo root); callers fall straight back to existing behavior.
 *
 * Throws when `prototypeRoot` is not inside a git repo (or git is
 * unavailable). Callers should treat that as "not a subdir" and let
 * `createSession` surface the friendly "needs a git repository" error.
 */
export async function resolvePrototypeLocation(
  prototypeRoot: string,
): Promise<PrototypeLocation> {
  const { stdout: topRaw } = await execFileAsync("git", [
    "-C",
    prototypeRoot,
    "rev-parse",
    "--show-toplevel",
  ])
  const gitRoot = topRaw.trim()

  // `--show-prefix` is the prototype's in-tree path relative to the repo
  // root, POSIX-style, with a trailing slash ("" at the root). Using the
  // git-reported offset (rather than path.relative on realpath'd paths)
  // sidesteps symlink-canonicalization mismatches.
  const { stdout: prefixRaw } = await execFileAsync("git", [
    "-C",
    prototypeRoot,
    "rev-parse",
    "--show-prefix",
  ])
  const subdirOffset = prefixRaw.trim().replace(/\/+$/, "")

  return { gitRoot, subdirOffset }
}
