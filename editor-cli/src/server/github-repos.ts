/**
 * Browse the developer's GitHub repos via the `gh` CLI.
 *
 * The Editor deliberately holds no GitHub credentials of its own: `clone-repo.ts`
 * clones with whatever git already has (SSH agent, credential helper), and the
 * whole point of that design is "no brokered token, no network service". Listing
 * repos is the one place that stance ran out, because a clone URL has to come
 * from somewhere and typing it by hand is the worst of the options.
 *
 * `gh` closes the gap without reopening the question. It is already logged in on
 * most developer machines, it owns the token in the OS keyring, and it hands us
 * JSON. Nothing here sees, stores, or transmits a credential: we shell out and
 * parse stdout, exactly as `folder-picker.ts` does with `osascript`.
 *
 * A device-flow login of our own is the documented fallback if this proves too
 * narrow (see the Editor's connect flow); it is deliberately NOT built yet,
 * because it would mean registering an OAuth app and holding a token to do a job
 * `gh` already does for free.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** `gh` can hang on a network stall; the UI must not hang with it. */
const GH_TIMEOUT_MS = 10_000

/** How many repos to list. `gh` defaults to 30, which hides recent work. */
export const REPO_LIMIT = 100

export interface GitHubRepo {
  /** `owner/name`, the form `gh repo clone` and the URL both use. */
  nameWithOwner: string
  name: string
  isPrivate: boolean
  /** ISO timestamp; the list is sorted newest-first so recent work is on top. */
  updatedAt: string
}

export type GitHubReposResult =
  | { available: true; repos: GitHubRepo[] }
  /**
   * Every not-listing case, told apart so the UI can say which one it is:
   * `gh` missing is a different instruction from `gh` present but logged out.
   */
  | { available: false; reason: "not-installed" | "not-authenticated" | "failed"; detail?: string }

function isMissingBinary(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT"
}

/**
 * Did we kill it, rather than it exiting on its own?
 *
 * `execFile`'s timeout signals the child; the rejection then carries `killed`
 * rather than an exit code. This is the one non-exit failure we can identify
 * without reading `gh`'s human-facing stderr, and it matters because the
 * instruction differs: a timeout is not something `gh auth login` fixes.
 */
function wasKilled(err: unknown): boolean {
  return (err as { killed?: boolean })?.killed === true
}

/**
 * Is `gh` installed AND logged in?
 *
 * `gh auth status` exits 1 when logged out, which is the signal we want; its
 * output goes to stderr and is deliberately not parsed, since that text is for
 * humans and changes between releases. The cost of not parsing it is that an
 * exit-1 for some other reason (a keychain the OS refused, say) is read as
 * logged out. A timeout is told apart, because that one is distinguishable
 * without guessing at prose.
 */
export async function checkGitHubAuth(): Promise<
  { ok: true } | { ok: false; reason: "not-installed" | "not-authenticated" | "failed"; detail?: string }
> {
  try {
    await execFileAsync("gh", ["auth", "status"], { timeout: GH_TIMEOUT_MS })
    return { ok: true }
  } catch (err) {
    if (isMissingBinary(err)) return { ok: false, reason: "not-installed" }
    if (wasKilled(err)) {
      return {
        ok: false,
        reason: "failed",
        detail: `gh auth status did not answer within ${GH_TIMEOUT_MS / 1000}s.`,
      }
    }
    return { ok: false, reason: "not-authenticated" }
  }
}

/** Shape guard: `gh` is the user's own binary, but its JSON is still input. */
function toRepo(value: unknown): GitHubRepo | null {
  if (typeof value !== "object" || value === null) return null
  const row = value as Record<string, unknown>
  if (typeof row.nameWithOwner !== "string" || row.nameWithOwner === "") return null
  return {
    nameWithOwner: row.nameWithOwner,
    name: typeof row.name === "string" ? row.name : row.nameWithOwner,
    isPrivate: row.isPrivate === true,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
  }
}

/**
 * List the signed-in user's repos, newest first.
 *
 * `execFile` with an argument array, never a shell string: nothing here is
 * user-supplied today, and keeping it that way means it cannot become an
 * injection site if a filter or owner argument is added later.
 */
export async function listGitHubRepos(): Promise<GitHubReposResult> {
  const auth = await checkGitHubAuth()
  if (!auth.ok) return { available: false, reason: auth.reason, detail: auth.detail }

  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "repo",
        "list",
        "--limit",
        String(REPO_LIMIT),
        "--json",
        "name,nameWithOwner,isPrivate,updatedAt",
      ],
      { timeout: GH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    )
    const parsed: unknown = JSON.parse(stdout)
    if (!Array.isArray(parsed)) {
      return { available: false, reason: "failed", detail: "gh returned an unexpected shape." }
    }
    const repos = parsed.map(toRepo).filter((r): r is GitHubRepo => r !== null)
    repos.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return { available: true, repos }
  } catch (err) {
    if (isMissingBinary(err)) return { available: false, reason: "not-installed" }
    return {
      available: false,
      reason: "failed",
      detail: (err as Error)?.message ?? "gh repo list failed.",
    }
  }
}

/** The https clone URL for a repo, which is what the clone route takes. */
export function cloneUrlFor(nameWithOwner: string): string {
  return `https://github.com/${nameWithOwner}.git`
}
