/**
 * Clone a git repo to a local directory using the user's own git
 * credentials (SSH agent / https credential helper). No brokered
 * token, no network service — this is the infra-free path that covers
 * the common case where the developer can already `git clone` the repo
 * from their shell.
 *
 * A GitHub-OAuth "log in and browse repos" flow that mints a
 * short-lived token for repos the user can't otherwise reach could
 * layer on top of this (the `token` param below exists for that), but
 * no such flow is currently wired up.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { rm, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { launchCwd } from "../launch-cwd.js"

const execFileAsync = promisify(execFile)
const GIT_ENV = {
  ...process.env,
  LC_ALL: "C",
  GIT_OPTIONAL_LOCKS: "0",
  // Fail fast instead of blocking on an interactive credential prompt
  // when the user has no creds for a private repo (the server has no
  // TTY). The developer's credential helper still answers.
  GIT_TERMINAL_PROMPT: "0",
}

export interface CloneResult {
  /** Absolute path the repo was cloned into. */
  dest: string
}

/**
 * Inject a GitHub access token into an https github URL for a
 * private-repo clone: `https://github.com/o/r` →
 * `https://x-access-token:<token>@github.com/o/r`. Non-github / non-
 * https URLs (ssh, other hosts) are returned unchanged — those use the
 * user's own creds. The token must be scrubbed from the persisted
 * remote afterward (cloneRepo does this via `git remote set-url`).
 */
export function buildAuthedCloneUrl(repoUrl: string, token: string): string {
  const m = repoUrl.trim().match(/^https:\/\/github\.com\/(.+)$/i)
  if (!m || !token) return repoUrl
  return `https://x-access-token:${token}@github.com/${m[1]}`
}

/**
 * `git clone <repoUrl> <dest>`. Derives `dest` from the repo name when
 * omitted. Refuses to clone over an existing path. Throws on any git
 * failure (auth, network, unknown repo) with git's stderr attached.
 */
export async function cloneRepo(input: {
  repoUrl: string
  /** Target directory (absolute or cwd-relative). Defaults to the repo name. */
  dest?: string
  /** Optional branch to check out. */
  branch?: string
  /**
   * Optional brokered GitHub token for a private repo the user's local
   * creds can't reach. Injected into the clone URL, then scrubbed from
   * the persisted `origin` remote so it never lands on disk.
   */
  token?: string
}): Promise<CloneResult> {
  const repoUrl = input.repoUrl.trim()
  // Reject empty / whitespace / control chars. `--` below stops a URL
  // starting with `-` from being read as a git option, but a NUL or
  // newline has no business in a URL and could confuse tooling.
  if (repoUrl.length === 0 || /[\s]/.test(repoUrl)) {
    throw new Error("Invalid repo URL")
  }

  // Resolved against the LAUNCH directory, not `process.cwd()`.
  //
  // `core.ts` chdirs into the prototype's Vite root at startup, and this
  // launcher runs lazily in that same process afterwards — so a bare
  // `resolve()` would put the clone INSIDE the repo the user is currently
  // editing. An absolute `dest` is unaffected either way.
  const dest = resolve(launchCwd(), input.dest?.trim() || deriveDirName(repoUrl))
  if (await pathExists(dest)) {
    throw new Error(`Destination already exists: ${dest}`)
  }

  // Use the token-injected URL for the clone when a brokered token is
  // supplied; otherwise the user's own creds.
  const cloneUrl = input.token ? buildAuthedCloneUrl(repoUrl, input.token) : repoUrl
  const usedToken = cloneUrl !== repoUrl

  const args = ["clone"]
  if (input.branch) args.push("--branch", input.branch)
  // `--` terminates options so a hostile repoUrl/dest can't inject flags.
  args.push("--", cloneUrl, dest)

  try {
    await execFileAsync("git", args, { env: GIT_ENV })
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? (err as Error).message
    throw new Error(`git clone failed: ${stderr.trim()}`)
  }

  // Scrub the token from the persisted remote — never leave it on disk.
  if (usedToken) {
    try {
      await execFileAsync("git", ["-C", dest, "remote", "set-url", "origin", repoUrl], {
        env: GIT_ENV,
      })
    } catch (scrubErr) {
      // The token is still embedded in `.git/config`. Leaving the
      // checkout would persist the secret silently, so remove the whole
      // clone and fail loudly — the user re-clones rather than
      // unknowingly keeping a token on disk.
      await rm(dest, { recursive: true, force: true }).catch(() => {})
      throw new Error(
        `Clone succeeded but the embedded access token could not be removed from the git remote; deleted the checkout for safety (${(scrubErr as Error).message})`,
      )
    }
  }
  return { dest }
}

/** `https://github.com/acme/widgets.git` → `widgets`. */
export function deriveDirName(repoUrl: string): string {
  const cleaned = repoUrl
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
  const seg = cleaned.split(/[/:]/).pop()
  return seg && seg.length > 0 ? seg : "repo"
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}
