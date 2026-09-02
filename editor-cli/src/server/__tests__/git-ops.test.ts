import { afterEach, describe, expect, it, vi } from "vitest"
import {
  GitError,
  _resetGitStatusCacheForTests,
  getGitStatus,
  invalidateGitStatusCache,
  type SpawnFn,
} from "../git-ops.js"

afterEach(() => {
  _resetGitStatusCacheForTests()
})

/**
 * Build a stub spawn function from a map of `args.join(' ')` → result.
 * Throws if the test calls a command we didn't expect — surfaces test
 * coverage gaps explicitly rather than silently returning a default.
 */
function stubSpawn(cases: Record<string, { exitCode: number; stdout?: string; stderr?: string }>): SpawnFn {
  return async (_cwd, args) => {
    const key = args.join(" ")
    const c = cases[key]
    if (!c) {
      throw new Error(`stubSpawn: no case for "${key}"`)
    }
    return {
      exitCode: c.exitCode,
      stdout: c.stdout ?? "",
      stderr: c.stderr ?? "",
    }
  }
}

const TS = "2026-05-04T22:18:31Z"
const COMMIT_TS_KEY = "log -1 --format=%cI HEAD"
const TS_OK = { exitCode: 0, stdout: `${TS}\n` }

describe("getGitStatus — happy path", () => {
  it("normalizes a clean tree on a named branch", async () => {
    const spawnFn = stubSpawn({
      "rev-parse --short HEAD": { exitCode: 0, stdout: "abc1234\n" },
      "rev-parse --abbrev-ref HEAD": { exitCode: 0, stdout: "main\n" },
      "status --porcelain": { exitCode: 0, stdout: "" },
      [COMMIT_TS_KEY]: TS_OK,
    })
    const result = await getGitStatus("/tmp/repo", { spawnFn, noCache: true })
    expect(result).toEqual({
      head_commit: "abc1234",
      branch: "main",
      dirty: false,
      head_commit_timestamp: TS,
    })
  })

  it("reports dirty when status --porcelain has output", async () => {
    const spawnFn = stubSpawn({
      "rev-parse --short HEAD": { exitCode: 0, stdout: "abc1234\n" },
      "rev-parse --abbrev-ref HEAD": { exitCode: 0, stdout: "main\n" },
      "status --porcelain": { exitCode: 0, stdout: " M src/App.vue\n?? new-file.ts\n" },
      [COMMIT_TS_KEY]: TS_OK,
    })
    const result = await getGitStatus("/tmp/repo", { spawnFn, noCache: true })
    expect(result.dirty).toBe(true)
  })

  it("reports null head_commit_timestamp when git log fails", async () => {
    const spawnFn = stubSpawn({
      "rev-parse --short HEAD": { exitCode: 0, stdout: "abc1234\n" },
      "rev-parse --abbrev-ref HEAD": { exitCode: 0, stdout: "main\n" },
      "status --porcelain": { exitCode: 0, stdout: "" },
      [COMMIT_TS_KEY]: { exitCode: 128, stderr: "fatal: bad object HEAD\n" },
    })
    const result = await getGitStatus("/tmp/repo", { spawnFn, noCache: true })
    expect(result.head_commit_timestamp).toBeNull()
    // The rest of the status remains intact — timestamp failure is
    // graceful-degrade, not a hard error.
    expect(result.head_commit).toBe("abc1234")
  })
})

describe("getGitStatus — special states", () => {
  it("maps detached HEAD to branch: null", async () => {
    const spawnFn = stubSpawn({
      "rev-parse --short HEAD": { exitCode: 0, stdout: "abc1234\n" },
      "rev-parse --abbrev-ref HEAD": { exitCode: 0, stdout: "HEAD\n" },
      "status --porcelain": { exitCode: 0, stdout: "" },
      [COMMIT_TS_KEY]: TS_OK,
    })
    const result = await getGitStatus("/tmp/repo", { spawnFn, noCache: true })
    expect(result.branch).toBeNull()
    expect(result.head_commit).toBe("abc1234")
  })

  it("maps unborn HEAD to head_commit: null and falls back to symbolic-ref for branch", async () => {
    const spawnFn = stubSpawn({
      "rev-parse --short HEAD": {
        exitCode: 128,
        stderr:
          "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.\n",
      },
      "rev-parse --abbrev-ref HEAD": {
        exitCode: 128,
        stderr: "fatal: ambiguous argument 'HEAD': unknown revision\n",
      },
      "symbolic-ref --short HEAD": { exitCode: 0, stdout: "main\n" },
      "status --porcelain": { exitCode: 0, stdout: "?? README.md\n" },
      // git log fails on unborn HEAD too — head_commit_timestamp must be null.
      [COMMIT_TS_KEY]: { exitCode: 128, stderr: "fatal: bad default revision 'HEAD'\n" },
    })
    const result = await getGitStatus("/tmp/repo", { spawnFn, noCache: true })
    expect(result).toEqual({
      head_commit: null,
      branch: "main",
      dirty: true,
      head_commit_timestamp: null,
    })
  })

  it("maps unborn HEAD with a 'no commits yet' error variant", async () => {
    // Some git versions phrase the unborn-HEAD error differently.
    const spawnFn = stubSpawn({
      "rev-parse --short HEAD": {
        exitCode: 128,
        stderr: "fatal: your current branch 'main' does not have any commits yet\n",
      },
      "rev-parse --abbrev-ref HEAD": {
        exitCode: 128,
        stderr: "fatal: your current branch 'main' does not have any commits yet\n",
      },
      "symbolic-ref --short HEAD": { exitCode: 0, stdout: "main\n" },
      "status --porcelain": { exitCode: 0, stdout: "" },
      [COMMIT_TS_KEY]: { exitCode: 128, stderr: "fatal: no commits\n" },
    })
    const result = await getGitStatus("/tmp/repo", { spawnFn, noCache: true })
    expect(result.head_commit).toBeNull()
    expect(result.branch).toBe("main")
    expect(result.head_commit_timestamp).toBeNull()
  })

  it("reports branch: null when symbolic-ref also fails on unborn HEAD", async () => {
    const spawnFn = stubSpawn({
      "rev-parse --short HEAD": {
        exitCode: 128,
        stderr: "fatal: ambiguous argument 'HEAD'\n",
      },
      "rev-parse --abbrev-ref HEAD": {
        exitCode: 128,
        stderr: "fatal: ambiguous argument 'HEAD'\n",
      },
      "symbolic-ref --short HEAD": {
        exitCode: 128,
        stderr: "fatal: ref HEAD is not a symbolic ref\n",
      },
      "status --porcelain": { exitCode: 0, stdout: "" },
      [COMMIT_TS_KEY]: { exitCode: 128, stderr: "fatal: no commits\n" },
    })
    const result = await getGitStatus("/tmp/repo", { spawnFn, noCache: true })
    expect(result.branch).toBeNull()
    expect(result.head_commit).toBeNull()
  })
})

describe("getGitStatus — error propagation", () => {
  it("throws GitError when status --porcelain fails for a non-recoverable reason", async () => {
    const spawnFn = stubSpawn({
      "rev-parse --short HEAD": { exitCode: 0, stdout: "abc1234\n" },
      "rev-parse --abbrev-ref HEAD": { exitCode: 0, stdout: "main\n" },
      "status --porcelain": {
        exitCode: 128,
        stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
      },
      [COMMIT_TS_KEY]: TS_OK,
    })
    await expect(getGitStatus("/tmp/repo", { spawnFn, noCache: true })).rejects.toBeInstanceOf(
      GitError,
    )
  })

  it("does NOT swallow a hard failure on rev-parse HEAD as 'unborn HEAD' (must match stderr signature)", async () => {
    const spawnFn = stubSpawn({
      "rev-parse --short HEAD": {
        exitCode: 128,
        stderr: "fatal: not a git repository\n",
      },
      "rev-parse --abbrev-ref HEAD": { exitCode: 0, stdout: "main\n" },
      "status --porcelain": { exitCode: 0, stdout: "" },
      [COMMIT_TS_KEY]: TS_OK,
    })
    await expect(getGitStatus("/tmp/repo", { spawnFn, noCache: true })).rejects.toBeInstanceOf(
      GitError,
    )
  })
})

describe("getGitStatus — cache behavior", () => {
  it("returns the cached value within TTL without re-spawning", async () => {
    const spawnFn = vi.fn(
      stubSpawn({
        "rev-parse --short HEAD": { exitCode: 0, stdout: "abc1234\n" },
        "rev-parse --abbrev-ref HEAD": { exitCode: 0, stdout: "main\n" },
        "status --porcelain": { exitCode: 0, stdout: "" },
        [COMMIT_TS_KEY]: TS_OK,
      }),
    )
    await getGitStatus("/tmp/repo", { spawnFn, ttlMs: 60_000 })
    await getGitStatus("/tmp/repo", { spawnFn, ttlMs: 60_000 })
    // 4 spawns on first call (head, branch, dirty, timestamp), 0 on the second.
    expect(spawnFn).toHaveBeenCalledTimes(4)
  })

  it("invalidateGitStatusCache forces a re-fetch", async () => {
    const spawnFn = vi.fn(
      stubSpawn({
        "rev-parse --short HEAD": { exitCode: 0, stdout: "abc1234\n" },
        "rev-parse --abbrev-ref HEAD": { exitCode: 0, stdout: "main\n" },
        "status --porcelain": { exitCode: 0, stdout: "" },
        [COMMIT_TS_KEY]: TS_OK,
      }),
    )
    await getGitStatus("/tmp/repo", { spawnFn, ttlMs: 60_000 })
    invalidateGitStatusCache("/tmp/repo")
    await getGitStatus("/tmp/repo", { spawnFn, ttlMs: 60_000 })
    expect(spawnFn).toHaveBeenCalledTimes(8)
  })

  it("caches per repoRoot — different paths don't share state", async () => {
    const spawnFn = vi.fn(
      stubSpawn({
        "rev-parse --short HEAD": { exitCode: 0, stdout: "abc1234\n" },
        "rev-parse --abbrev-ref HEAD": { exitCode: 0, stdout: "main\n" },
        "status --porcelain": { exitCode: 0, stdout: "" },
        [COMMIT_TS_KEY]: TS_OK,
      }),
    )
    await getGitStatus("/tmp/repo-a", { spawnFn, ttlMs: 60_000 })
    await getGitStatus("/tmp/repo-b", { spawnFn, ttlMs: 60_000 })
    // 4 invocations per repo = 8 total.
    expect(spawnFn).toHaveBeenCalledTimes(8)
  })

  it("noCache: true bypasses cache for tests without invalidating it", async () => {
    const spawnFn = vi.fn(
      stubSpawn({
        "rev-parse --short HEAD": { exitCode: 0, stdout: "abc1234\n" },
        "rev-parse --abbrev-ref HEAD": { exitCode: 0, stdout: "main\n" },
        "status --porcelain": { exitCode: 0, stdout: "" },
        [COMMIT_TS_KEY]: TS_OK,
      }),
    )
    await getGitStatus("/tmp/repo", { spawnFn, noCache: true })
    await getGitStatus("/tmp/repo", { spawnFn, noCache: true })
    expect(spawnFn).toHaveBeenCalledTimes(8)
  })
})
