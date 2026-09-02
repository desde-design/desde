/**
 * Real-git tests for prototype-location resolution.
 *
 * Editor worktrees are whole-repo, so when the supervised path is a
 * SUBDIRECTORY of a larger repo (a monorepo package, or Editor's own
 * `editor-cli/self-host` harness) the session must be created against
 * the git root while Vite roots at `<worktree>/<subdirOffset>`. These
 * tests pin the two shapes the orchestrator branches on: prototype ==
 * repo root (offset "") vs. prototype in a nested subdir.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import os from "node:os"
import path from "node:path"

import { resolvePrototypeLocation } from "../prototype-location"

const execFileAsync = promisify(execFile)

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "editor-protoloc-"))
  await execFileAsync("git", ["-C", dir, "init", "--initial-branch=main", "--quiet"])
  await execFileAsync("git", ["-C", dir, "config", "user.email", "test@example.com"])
  await execFileAsync("git", ["-C", dir, "config", "user.name", "Protoloc Test"])
  await execFileAsync("git", ["-C", dir, "config", "commit.gpgsign", "false"])
  await fs.writeFile(path.join(dir, "hello.txt"), "hello\n", "utf8")
  await execFileAsync("git", ["-C", dir, "add", "hello.txt"])
  await execFileAsync("git", ["-C", dir, "commit", "-m", "initial", "--quiet"])
  // `--show-toplevel` reports the realpath'd root; on macOS /tmp is a
  // symlink to /private/tmp, so compare against the realpath to avoid a
  // spurious mismatch.
  return fs.realpath(dir)
}

describe("resolvePrototypeLocation", () => {
  let repo: string

  beforeEach(async () => {
    repo = await makeRepo()
  })

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true })
  })

  it("returns offset '' when the prototype IS the repo root", async () => {
    const loc = await resolvePrototypeLocation(repo)
    expect(loc.gitRoot).toBe(repo)
    expect(loc.subdirOffset).toBe("")
  })

  it("resolves the git root + POSIX offset for a nested subdir prototype", async () => {
    const sub = path.join(repo, "packages", "proto-app")
    await fs.mkdir(sub, { recursive: true })
    await fs.writeFile(path.join(sub, "index.html"), "<html></html>", "utf8")

    const loc = await resolvePrototypeLocation(sub)
    expect(loc.gitRoot).toBe(repo)
    // POSIX-style, no trailing slash — joins cleanly onto the worktree
    // root to produce the in-worktree Vite root.
    expect(loc.subdirOffset).toBe("packages/proto-app")
    expect(path.join(loc.gitRoot, loc.subdirOffset)).toBe(sub)
  })

  it("throws when the path is not inside a git repo", async () => {
    const nonRepo = await fs.mkdtemp(path.join(os.tmpdir(), "editor-nonrepo-"))
    try {
      await expect(resolvePrototypeLocation(nonRepo)).rejects.toThrow()
    } finally {
      await fs.rm(nonRepo, { recursive: true, force: true })
    }
  })
})
