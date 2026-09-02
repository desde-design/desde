/**
 * Real-git integration tests for the canonical-state preflight.
 *
 * Branch mode only refuses one thing: an in-progress git operation.
 * These tests pin the happy path plus the mid-merge refusal. (The
 * dirty/detached-HEAD refusal cases belonged to worktree-session mode,
 * which is gone — see canonical-preflight.ts.)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import os from "node:os"
import path from "node:path"

import { preflightCanonicalRoot } from "../canonical-preflight"

const execFileAsync = promisify(execFile)

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "editor-preflight-"))
  await execFileAsync("git", ["-C", dir, "init", "--initial-branch=main", "--quiet"])
  await execFileAsync("git", ["-C", dir, "config", "user.email", "test@example.com"])
  await execFileAsync("git", ["-C", dir, "config", "user.name", "Preflight Test"])
  await execFileAsync("git", ["-C", dir, "config", "commit.gpgsign", "false"])
  await fs.writeFile(path.join(dir, "hello.txt"), "hello\n", "utf8")
  await execFileAsync("git", ["-C", dir, "add", "hello.txt"])
  await execFileAsync("git", ["-C", dir, "commit", "-m", "initial", "--quiet"])
  return dir
}

describe("preflightCanonicalRoot", () => {
  let repo: string

  beforeEach(async () => {
    repo = await makeRepo()
  })

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true })
  })

  it("accepts a clean repo on a branch", async () => {
    const result = await preflightCanonicalRoot(repo)
    expect(result.ok).toBe(true)
  })

  it("accepts a dirty tree — editing dirty is the whole point", async () => {
    await fs.writeFile(path.join(repo, "hello.txt"), "unstaged\n", "utf8")
    const result = await preflightCanonicalRoot(repo)
    expect(result.ok).toBe(true)
  })

  it("accepts staged changes", async () => {
    await fs.writeFile(path.join(repo, "hello.txt"), "staged\n", "utf8")
    await execFileAsync("git", ["-C", repo, "add", "hello.txt"])
    const result = await preflightCanonicalRoot(repo)
    expect(result.ok).toBe(true)
  })

  it("accepts detached HEAD", async () => {
    const { stdout: head } = await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"])
    await execFileAsync("git", ["-C", repo, "checkout", "--quiet", "--detach", head.trim()])
    const result = await preflightCanonicalRoot(repo)
    expect(result.ok).toBe(true)
  })

  it("refuses when canonical is mid-merge (MERGE_HEAD marker present)", async () => {
    // Create the marker file directly — simulates the "we're mid-merge"
    // state without actually setting up a conflicting merge.
    await fs.writeFile(path.join(repo, ".git", "MERGE_HEAD"), "0".repeat(40), "utf8")
    const result = await preflightCanonicalRoot(repo)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/in-progress git operations.*merge/i)
  })
})
