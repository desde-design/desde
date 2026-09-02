/**
 * Open a pull request through the developer's own `gh` CLI.
 *
 * Same stance as `github-repos.ts`: the Editor holds no GitHub credential of
 * its own. `gh` owns the token in the OS keyring, we shell out and parse
 * stdout. Nothing here sees, stores or transmits a credential.
 *
 * WHY THIS IS TWO CALLS INSTEAD OF ONE
 *
 * `gh` picks the pull request's BASE repository from the git remotes, and a
 * remote named `upstream` outranks `origin`. It does this silently, with no
 * prompt, in a non-interactive process. MEASURED on gh 2.92.0: in a checkout
 * with `origin` = `mochang/desde` and `upstream` = `cli/cli`,
 * `gh repo view --json nameWithOwner` answers `cli/cli`.
 *
 * That is the ordinary layout of every fork. So a one-shot "click the item and
 * let gh work it out" implementation would let a designer open a pull request
 * on a STRANGER'S repository from inside their own prototype, and only find out
 * by reading the URL afterwards.
 *
 * Hence: `resolvePullRequestTarget` is a read-only preflight that reports where
 * the pull request would go, the UI shows that to the user, and
 * `createPullRequest` pins that exact repository with `-R`. The user is told
 * the destination before anything is created, never after.
 */

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { promisify } from "node:util"
import { readOriginRemoteUrl, parseGitHubFullName } from "./git-remote.js"

const execFileAsync = promisify(execFile)

/** Reads (repo view, pr list). Same budget as `github-repos.ts`. */
export const GH_READ_TIMEOUT_MS = 10_000

/**
 * Creating does more work than a read: base-repo resolution, a commit walk, an
 * existing-PR query, then the create itself. 10s produces spurious failures on
 * a slow network AFTER the branch has already been pushed, which is the worst
 * possible moment to fail.
 */
export const GH_CREATE_TIMEOUT_MS = 30_000

/**
 * `GH_PROMPT_DISABLED` is written-down intent rather than the load-bearing
 * guard. `execFile` hands the child pipes, so `gh` already knows it cannot
 * prompt and errors instead of asking. Setting it anyway means one future
 * change to an inherited stdio cannot quietly reintroduce a prompt. That is the
 * same argument this repo already accepted for `GIT_TERMINAL_PROMPT`.
 *
 * A prompt is not the only way to block: `gh`'s token lives in the macOS
 * keyring, and a Keychain authorization dialog is an OS-level wait no `gh`
 * environment variable can suppress. The explicit timeout on every call is what
 * closes that one.
 */
const GH_ENV = {
  ...process.env,
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_PAGER: "cat",
  NO_COLOR: "1",
}

/** Failures this layer can produce. Git failures belong to the caller. */
export type PullRequestFailureKind =
  | "no-remote"
  | "repo-root-missing"
  | "gh-not-installed"
  | "gh-not-authenticated"
  | "gh-timeout"
  | "gh-failed"

export interface PullRequestFailure {
  ok: false
  kind: PullRequestFailureKind
  /** One plain sentence for the UI. Never `gh`'s raw usage block. */
  reason: string
}

export interface PullRequestTarget {
  /** What `-R` gets pinned to: `owner/repo`, or `host/owner/repo` off github.com. */
  repoRef: string
  /** Display form. */
  nameWithOwner: string
  /** The branch the pull request would merge INTO. */
  base: string
  /** The branch the pull request would come FROM. */
  head: string
  /**
   * The resolved base repo is NOT what `origin` points at. This is the fork
   * case described in the module header, and the UI must say so out loud.
   */
  crossRepo: boolean
  /** An open pull request already on this branch, if there is one. */
  existing: { number: number; url: string } | null
  suggestedTitle: string
}

/**
 * `gh`'s stderr on a refusal can be its entire flags block. `pushToOrigin`
 * surfaces git's stderr verbatim because git's messages are one line; `gh`'s
 * can be a man page, so this trims. Everything from the first `Usage:` onward
 * is dropped, then at most 3 lines and 300 characters survive.
 */
function ghMessage(err: unknown, fallback: string): string {
  const raw = (err as { stderr?: string })?.stderr
  if (typeof raw !== "string" || raw.trim() === "") return fallback
  const beforeUsage = raw.split(/^\s*Usage:/m)[0] ?? raw
  const text = beforeUsage.trim().split("\n").slice(0, 3).join(" ").trim()
  if (text === "") return fallback
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

function wasKilled(err: unknown): boolean {
  return (err as { killed?: boolean })?.killed === true
}

/**
 * Run a `gh` subcommand in `cwd`.
 *
 * `cwd` is required on every call: `gh` has no `-C` equivalent, so it discovers
 * the repository from the working directory.
 *
 * MEASURED: a missing `gh` binary and a nonexistent `cwd` BOTH reject with
 * `ENOENT` and the message "spawn gh ENOENT". Classifying on `ENOENT` alone
 * would tell a user who has `gh` installed to go install `gh`, so the directory
 * is checked first.
 */
async function runGh(
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ ok: true; stdout: string } | PullRequestFailure> {
  if (!existsSync(cwd)) {
    return { ok: false, kind: "repo-root-missing", reason: "That project folder no longer exists." }
  }
  try {
    const { stdout } = await execFileAsync("gh", [...args], {
      cwd,
      env: GH_ENV,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { ok: true, stdout }
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return {
        ok: false,
        kind: "gh-not-installed",
        reason: "The GitHub CLI is not installed on this machine.",
      }
    }
    if (wasKilled(err)) {
      return {
        ok: false,
        kind: "gh-timeout",
        reason: `gh did not answer within ${Math.round(timeoutMs / 1000)}s.`,
      }
    }
    // MEASURED: `gh` exits 4 when it has no credentials, and says so without
    // prompting. Every other non-zero exit carries its own message.
    if ((err as { code?: unknown })?.code === 4) {
      return {
        ok: false,
        kind: "gh-not-authenticated",
        reason: "The GitHub CLI is not signed in. Run gh auth login in a terminal.",
      }
    }
    return { ok: false, kind: "gh-failed", reason: ghMessage(err, "gh could not complete the request.") }
  }
}

/**
 * "feat/new-checkout-page" becomes "New checkout page".
 *
 * Exported so the dialog's prefill and any server-side fallback cannot drift
 * apart into two different titles for the same branch.
 */
export function suggestPullRequestTitle(branch: string): string {
  const segment = branch.split("/").filter(Boolean).pop() ?? branch
  const words = segment.replace(/[-_]+/g, " ").trim()
  if (words === "") return branch
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Shape guard: `gh` is the user's own binary, but its JSON is still input. */
function readString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  return typeof value === "string" && value !== "" ? value : null
}

/**
 * Work out where a pull request from `branch` would actually go, WITHOUT
 * creating anything.
 *
 * Note `gh repo view` takes its repository POSITIONALLY. MEASURED: passing `-R`
 * to it fails with "unknown shorthand flag: 'R' in -R". `-R` is an inherited
 * flag on `gh pr create` and `gh pr list` only.
 */
export async function resolvePullRequestTarget(
  repoRoot: string,
  branch: string,
): Promise<{ ok: true; target: PullRequestTarget } | PullRequestFailure> {
  // A checkout with no `origin` cannot have a pull request, and `gh`'s own
  // message for it is about "known GitHub hosts", which is confusing here.
  const origin = await readOriginRemoteUrl(repoRoot)
  if (!origin) {
    return {
      ok: false,
      kind: "no-remote",
      reason: "This project has no origin remote, so there is nowhere to open a pull request.",
    }
  }

  // Deliberately NOT gated on `parseGitHubFullName` returning a value: it
  // hardcodes github.com, so gating here would refuse every GitHub Enterprise
  // user before `gh` ever ran. Let `gh` decide what it can talk to, and surface
  // its own one-line answer if it cannot.
  const viewed = await runGh(
    repoRoot,
    ["repo", "view", "--json", "nameWithOwner,defaultBranchRef,isFork,viewerPermission"],
    GH_READ_TIMEOUT_MS,
  )
  if (!viewed.ok) return viewed

  let parsed: unknown
  try {
    parsed = JSON.parse(viewed.stdout)
  } catch {
    return { ok: false, kind: "gh-failed", reason: "gh returned an unexpected response." }
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, kind: "gh-failed", reason: "gh returned an unexpected response." }
  }
  const row = parsed as Record<string, unknown>
  const nameWithOwner = readString(row, "nameWithOwner")
  if (!nameWithOwner) {
    return { ok: false, kind: "gh-failed", reason: "gh did not name a repository for this project." }
  }
  const defaultRef = row.defaultBranchRef
  const base =
    typeof defaultRef === "object" && defaultRef !== null
      ? (readString(defaultRef as Record<string, unknown>, "name") ?? "main")
      : "main"

  // The whole point of the preflight. `origin` is what the user thinks they are
  // working on; `nameWithOwner` is what `gh` decided. When they disagree, an
  // `upstream` remote has taken over and the destination is someone else's repo.
  const originFullName = parseGitHubFullName(origin)
  const crossRepo = originFullName !== null && originFullName !== nameWithOwner

  // An existing open PR turns the action from "create" into "view", so it is
  // worth one more read. A failure here is not fatal: it only costs the nicety.
  let existing: PullRequestTarget["existing"] = null
  const listed = await runGh(
    repoRoot,
    ["pr", "list", "-R", nameWithOwner, "--head", branch, "--state", "open", "--json", "number,url", "--limit", "1"],
    GH_READ_TIMEOUT_MS,
  )
  if (listed.ok) {
    try {
      const rows: unknown = JSON.parse(listed.stdout)
      if (Array.isArray(rows) && rows.length > 0 && typeof rows[0] === "object" && rows[0] !== null) {
        const first = rows[0] as Record<string, unknown>
        const url = readString(first, "url")
        if (typeof first.number === "number" && url) existing = { number: first.number, url }
      }
    } catch {
      // Leave `existing` null; the create call reports a duplicate anyway.
    }
  }

  return {
    ok: true,
    target: {
      repoRef: nameWithOwner,
      nameWithOwner,
      base,
      head: branch,
      crossRepo,
      existing,
      suggestedTitle: suggestPullRequestTitle(branch),
    },
  }
}

export interface CreatePullRequestInput {
  /** Pinned from the preflight the user was shown. Never re-resolved. */
  repoRef: string
  base: string
  head: string
  title: string
  body?: string
  draft?: boolean
}

/**
 * Create the pull request.
 *
 * Three flags carry safety rather than preference:
 *
 * `-R` pins the destination to the repository the user was SHOWN, so the
 * `upstream` resolution described in the module header cannot redirect it
 * between the preflight and the create.
 *
 * `--head` is required, not optional. `gh pr create --help` states that when
 * the branch is not fully pushed, "a prompt will ask where to push the branch
 * and offer an option to fork the base repository", and that `--head` is what
 * skips "any forking or pushing behavior". Without it a non-interactive run can
 * fail, and an interactive one can silently create a fork.
 *
 * `--title` is always supplied, so `gh` never falls back to asking.
 */
export async function createPullRequest(
  repoRoot: string,
  input: CreatePullRequestInput,
): Promise<{ ok: true; url: string } | PullRequestFailure> {
  const args = [
    "pr",
    "create",
    "-R",
    input.repoRef,
    "--base",
    input.base,
    "--head",
    input.head,
    "--title",
    input.title,
    "--body",
    input.body ?? "",
  ]
  if (input.draft) args.push("--draft")

  const created = await runGh(repoRoot, args, GH_CREATE_TIMEOUT_MS)
  if (!created.ok) return created

  // `gh pr create --help`: "Upon success, the URL of the created pull request
  // will be printed." It is the last non-empty line, because gh may print
  // progress above it.
  const url = created.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("http"))
    .pop()
  if (!url) {
    return { ok: false, kind: "gh-failed", reason: "gh did not report a pull request URL." }
  }
  return { ok: true, url }
}
