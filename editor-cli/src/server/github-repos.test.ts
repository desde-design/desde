/**
 * `gh` is the user's own binary, so these tests care about two things: that we
 * tell the three not-listing cases apart (missing / logged out / broke), and
 * that whatever JSON comes back is treated as input rather than trusted.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const { ghMock } = vi.hoisted(() => ({ ghMock: vi.fn() }))

// `promisify(execFile)` resolves to `{stdout, stderr}` only because the real
// execFile carries a custom promisify implementation. A plain callback stub
// would resolve to a bare stdout string, so the mock has to carry it too.
vi.mock("node:child_process", () => {
  const custom = Symbol.for("nodejs.util.promisify.custom")
  const execFile = Object.assign(
    () => {
      throw new Error("github-repos must use the promisified form")
    },
    { [custom]: ghMock },
  )
  return { execFile }
})

const { checkGitHubAuth, cloneUrlFor, listGitHubRepos, REPO_LIMIT } = await import(
  "./github-repos.js"
)

function enoent(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error("spawn gh ENOENT")
  err.code = "ENOENT"
  return err
}

beforeEach(() => {
  ghMock.mockReset()
})

describe("checkGitHubAuth", () => {
  it("reports not-installed when the binary is absent", async () => {
    ghMock.mockRejectedValue(enoent())
    expect(await checkGitHubAuth()).toEqual({ ok: false, reason: "not-installed" })
  })

  it("reports not-authenticated on a non-zero exit", async () => {
    // `gh auth status` exits 1 when logged out. Its stderr prose is for humans
    // and changes between releases, so only the exit code is read.
    ghMock.mockRejectedValue(new Error("exit status 1"))
    expect(await checkGitHubAuth()).toEqual({ ok: false, reason: "not-authenticated" })
  })

  it("reports ok on a zero exit", async () => {
    ghMock.mockResolvedValue({ stdout: "", stderr: "" })
    expect(await checkGitHubAuth()).toEqual({ ok: true })
  })

  it("calls a timeout a failure, not a logout", async () => {
    // `gh auth login` does not fix a hung `gh`, so telling the user to run it
    // would be wrong advice. A killed child is the one non-exit failure we can
    // identify without reading gh's human-facing stderr.
    const killed = Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" })
    ghMock.mockRejectedValue(killed)
    const result = await checkGitHubAuth()
    expect(result).toMatchObject({ ok: false, reason: "failed" })
  })
})

describe("listGitHubRepos", () => {
  it("returns repos newest-first", async () => {
    ghMock.mockImplementation((_file: string, args: string[]) => {
      if (args[0] === "auth") return Promise.resolve({ stdout: "", stderr: "" })
      return Promise.resolve({
        stdout: JSON.stringify([
          { nameWithOwner: "acme/old", name: "old", isPrivate: false, updatedAt: "2026-01-01T00:00:00Z" },
          { nameWithOwner: "acme/new", name: "new", isPrivate: true, updatedAt: "2026-08-01T00:00:00Z" },
        ]),
        stderr: "",
      })
    })

    const result = await listGitHubRepos()
    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.repos.map((r) => r.nameWithOwner)).toEqual(["acme/new", "acme/old"])
    expect(result.repos[0].isPrivate).toBe(true)
  })

  it("passes an argument array, never a shell string", async () => {
    // Nothing here is user-supplied today; keeping the array form means it
    // cannot become an injection site when a filter argument is added later.
    ghMock.mockImplementation((_file: string, args: string[]) =>
      Promise.resolve({ stdout: args[0] === "auth" ? "" : "[]", stderr: "" }),
    )
    await listGitHubRepos()

    const listCall = ghMock.mock.calls.find((call) => call[1][0] === "repo")
    expect(listCall?.[0]).toBe("gh")
    expect(listCall?.[1]).toContain("--json")
    expect(listCall?.[1]).toContain(String(REPO_LIMIT))
    expect(listCall?.[1].some((arg: string) => arg.includes("&&") || arg.includes("|"))).toBe(false)
  })

  it("drops rows that are not shaped like a repo", async () => {
    ghMock.mockImplementation((_file: string, args: string[]) => {
      if (args[0] === "auth") return Promise.resolve({ stdout: "", stderr: "" })
      return Promise.resolve({
        stdout: JSON.stringify([
          null,
          { name: "no-owner" },
          { nameWithOwner: "" },
          { nameWithOwner: "acme/real" },
        ]),
        stderr: "",
      })
    })

    const result = await listGitHubRepos()
    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.repos).toHaveLength(1)
    // A missing `name` falls back to the qualified one rather than undefined.
    expect(result.repos[0]).toMatchObject({ nameWithOwner: "acme/real", name: "acme/real" })
  })

  it("reports failed, not available, when the JSON is not a list", async () => {
    ghMock.mockImplementation((_file: string, args: string[]) =>
      Promise.resolve({ stdout: args[0] === "auth" ? "" : '{"message":"Bad credentials"}', stderr: "" }),
    )
    const result = await listGitHubRepos()
    expect(result).toMatchObject({ available: false, reason: "failed" })
  })

  it("does not attempt a listing when the user is signed out", async () => {
    ghMock.mockRejectedValue(new Error("exit status 1"))
    expect(await listGitHubRepos()).toEqual({ available: false, reason: "not-authenticated" })
    expect(ghMock.mock.calls.every((call) => call[1][0] === "auth")).toBe(true)
  })
})

describe("cloneUrlFor", () => {
  it("builds the https clone URL the clone route accepts", () => {
    expect(cloneUrlFor("acme/repo")).toBe("https://github.com/acme/repo.git")
  })
})
