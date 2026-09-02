/**
 * The load-bearing tests here are the two safety ones, not the happy path.
 *
 * `gh` resolves a pull request's base repository from the git remotes, and a
 * remote named `upstream` outranks `origin` silently. So the two things that
 * must never regress are: the preflight NOTICES when the destination is not the
 * user's own repo (`crossRepo`), and the create call PINS the destination it
 * was given with `-R` rather than letting `gh` resolve it again.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const { ghMock, originMock } = vi.hoisted(() => ({
  ghMock: vi.fn(),
  originMock: vi.fn(),
}))

// `promisify(execFile)` only resolves to `{stdout, stderr}` because the real
// execFile carries a custom promisify implementation. A plain callback stub
// would resolve to a bare string, so the mock has to carry it too.
vi.mock("node:child_process", () => {
  const custom = Symbol.for("nodejs.util.promisify.custom")
  const execFile = Object.assign(
    () => {
      throw new Error("github-pull-request must use the promisified form")
    },
    { [custom]: ghMock },
  )
  return { execFile }
})

// Every call runs through an existsSync gate that tells "no gh" apart from
// "no such directory"; the fake repo root does not exist on disk.
vi.mock("node:fs", () => ({ existsSync: () => true }))

vi.mock("./git-remote.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-remote.js")>()
  return { ...actual, readOriginRemoteUrl: originMock }
})

const { resolvePullRequestTarget, createPullRequest, suggestPullRequestTitle } = await import(
  "./github-pull-request.js"
)

const ROOT = "/fake/repo"

function enoent(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error("spawn gh ENOENT")
  err.code = "ENOENT"
  return err
}

/** `gh` exits 4 when it holds no credentials. */
function exitCode(code: number, stderr = ""): Error {
  return Object.assign(new Error("gh failed"), { code, stderr })
}

function repoViewJson(nameWithOwner: string, base = "main"): string {
  return JSON.stringify({
    nameWithOwner,
    defaultBranchRef: { name: base },
    isFork: false,
    viewerPermission: "ADMIN",
  })
}

/** The arg array of the Nth gh spawn. */
function argsOf(call: number): string[] {
  return ghMock.mock.calls[call]?.[1] as string[]
}

beforeEach(() => {
  ghMock.mockReset()
  originMock.mockReset()
  originMock.mockResolvedValue("https://github.com/mochang/desde.git")
})

describe("suggestPullRequestTitle", () => {
  it.each([
    ["feat/new-checkout-page", "New checkout page"],
    ["fix_bug_123", "Fix bug 123"],
    ["main", "Main"],
    ["feat/a/b-c", "B c"],
  ])("%s becomes %s", (branch, expected) => {
    expect(suggestPullRequestTitle(branch)).toBe(expected)
  })
})

describe("resolvePullRequestTarget", () => {
  it("refuses when there is no origin remote, without spawning gh", async () => {
    originMock.mockResolvedValue(null)
    const res = await resolvePullRequestTarget(ROOT, "feat/x")
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.kind).toBe("no-remote")
    expect(ghMock).not.toHaveBeenCalled()
  })

  it("flags crossRepo when gh resolves somewhere other than origin", async () => {
    // THE safety case. origin is the user's own repo; an `upstream` remote has
    // made gh choose someone else's. Measured on gh 2.92.0 with a real checkout.
    ghMock
      .mockResolvedValueOnce({ stdout: repoViewJson("cli/cli"), stderr: "" })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" })

    const res = await resolvePullRequestTarget(ROOT, "feat/x")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.target.crossRepo).toBe(true)
    expect(res.target.nameWithOwner).toBe("cli/cli")
  })

  it("does not flag crossRepo when gh agrees with origin", async () => {
    ghMock
      .mockResolvedValueOnce({ stdout: repoViewJson("mochang/desde"), stderr: "" })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" })

    const res = await resolvePullRequestTarget(ROOT, "feat/x")
    expect(res.ok === true && res.target.crossRepo).toBe(false)
  })

  it("never passes -R to gh repo view, which rejects it", async () => {
    // Measured: `gh repo view -R x/y` fails with "unknown shorthand flag: 'R'".
    // -R is inherited by `gh pr create` / `gh pr list` only.
    ghMock
      .mockResolvedValueOnce({ stdout: repoViewJson("mochang/desde"), stderr: "" })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" })

    await resolvePullRequestTarget(ROOT, "feat/x")
    expect(argsOf(0).slice(0, 2)).toEqual(["repo", "view"])
    expect(argsOf(0)).not.toContain("-R")
    // The existing-PR probe DOES pin, because there it is legal and needed.
    expect(argsOf(1)).toContain("-R")
  })

  it("reports the base branch gh named, not a hardcoded main", async () => {
    ghMock
      .mockResolvedValueOnce({ stdout: repoViewJson("mochang/desde", "develop"), stderr: "" })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" })

    const res = await resolvePullRequestTarget(ROOT, "feat/x")
    expect(res.ok === true && res.target.base).toBe("develop")
  })

  it("surfaces an existing open pull request", async () => {
    ghMock
      .mockResolvedValueOnce({ stdout: repoViewJson("mochang/desde"), stderr: "" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ number: 26, url: "https://github.com/mochang/desde/pull/26" }]),
        stderr: "",
      })

    const res = await resolvePullRequestTarget(ROOT, "feat/x")
    expect(res.ok === true && res.target.existing).toEqual({
      number: 26,
      url: "https://github.com/mochang/desde/pull/26",
    })
  })

  it("still resolves when the existing-PR probe fails", async () => {
    // That probe is a nicety. Losing it must not cost the whole action.
    ghMock
      .mockResolvedValueOnce({ stdout: repoViewJson("mochang/desde"), stderr: "" })
      .mockRejectedValueOnce(exitCode(1, "something broke"))

    const res = await resolvePullRequestTarget(ROOT, "feat/x")
    expect(res.ok).toBe(true)
    expect(res.ok === true && res.target.existing).toBeNull()
  })

  it.each([
    ["not installed", enoent(), "gh-not-installed"],
    ["signed out (exit 4)", exitCode(4), "gh-not-authenticated"],
    ["some other refusal", exitCode(1, "no known GitHub host"), "gh-failed"],
  ])("classifies %s", async (_label, err, kind) => {
    ghMock.mockRejectedValue(err)
    const res = await resolvePullRequestTarget(ROOT, "feat/x")
    expect(res.ok === false && res.kind).toBe(kind)
  })

  it("classifies a killed process as a timeout, not a sign-in problem", async () => {
    ghMock.mockRejectedValue(Object.assign(new Error("killed"), { killed: true }))
    const res = await resolvePullRequestTarget(ROOT, "feat/x")
    expect(res.ok === false && res.kind).toBe("gh-timeout")
  })

  it("trims gh's usage block out of a failure message", async () => {
    ghMock.mockRejectedValue(
      exitCode(1, "could not determine base repo\n\nUsage:  gh repo view [<repository>] [flags]\n  -R ..."),
    )
    const res = await resolvePullRequestTarget(ROOT, "feat/x")
    expect(res.ok === false && res.reason).toBe("could not determine base repo")
    expect(res.ok === false && res.reason).not.toMatch(/Usage/)
  })
})

describe("createPullRequest", () => {
  const INPUT = {
    repoRef: "mochang/desde",
    base: "main",
    head: "feat/x",
    title: "New checkout page",
  }

  it("pins the repo with -R and skips gh's fork-or-push prompt with --head", async () => {
    // THE other safety case. Without -R, gh re-resolves and an `upstream`
    // remote redirects the PR. Without --head, gh's own help says it prompts to
    // push and offers to FORK the base repository.
    ghMock.mockResolvedValue({ stdout: "https://github.com/mochang/desde/pull/27\n", stderr: "" })

    const res = await createPullRequest(ROOT, INPUT)
    expect(res).toEqual({ ok: true, url: "https://github.com/mochang/desde/pull/27" })

    const args = argsOf(0)
    expect(args.slice(0, 2)).toEqual(["pr", "create"])
    expect(args[args.indexOf("-R") + 1]).toBe("mochang/desde")
    expect(args[args.indexOf("--head") + 1]).toBe("feat/x")
    expect(args[args.indexOf("--base") + 1]).toBe("main")
    // Always supplied, so gh never falls back to asking for one.
    expect(args[args.indexOf("--title") + 1]).toBe("New checkout page")
    expect(args).toContain("--body")
  })

  it("passes the branch as one argv entry, so a hostile name cannot become a flag", async () => {
    ghMock.mockResolvedValue({ stdout: "https://x/pull/1\n", stderr: "" })
    await createPullRequest(ROOT, { ...INPUT, head: "--not-a-flag" })
    const args = argsOf(0)
    expect(args[args.indexOf("--head") + 1]).toBe("--not-a-flag")
  })

  it("adds --draft only when asked", async () => {
    ghMock.mockResolvedValue({ stdout: "https://x/pull/1\n", stderr: "" })
    await createPullRequest(ROOT, INPUT)
    expect(argsOf(0)).not.toContain("--draft")

    ghMock.mockClear()
    await createPullRequest(ROOT, { ...INPUT, draft: true })
    expect(argsOf(0)).toContain("--draft")
  })

  it("takes the URL from gh's output even when it prints progress first", async () => {
    ghMock.mockResolvedValue({
      stdout: "Warning: 3 uncommitted changes\nhttps://github.com/mochang/desde/pull/28\n",
      stderr: "",
    })
    const res = await createPullRequest(ROOT, INPUT)
    expect(res).toEqual({ ok: true, url: "https://github.com/mochang/desde/pull/28" })
  })

  it("refuses rather than claiming success when gh prints no URL", async () => {
    ghMock.mockResolvedValue({ stdout: "\n", stderr: "" })
    const res = await createPullRequest(ROOT, INPUT)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.kind).toBe("gh-failed")
  })
})
