/**
 * Tests for the plain `git clone` helper. Uses a local source repo as
 * the clone origin (git clones a filesystem path fine), so no network
 * or credentials are involved.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { buildAuthedCloneUrl, cloneRepo, deriveDirName } from "../clone-repo.js"

const execFileAsync = promisify(execFile)

describe("buildAuthedCloneUrl", () => {
  it("injects the token into https github urls only", () => {
    expect(buildAuthedCloneUrl("https://github.com/acme/app.git", "tok")).toBe(
      "https://x-access-token:tok@github.com/acme/app.git",
    )
    // ssh / non-github / empty token → unchanged (use the user's creds).
    expect(buildAuthedCloneUrl("git@github.com:acme/app.git", "tok")).toBe(
      "git@github.com:acme/app.git",
    )
    expect(buildAuthedCloneUrl("https://gitlab.com/acme/app.git", "tok")).toBe(
      "https://gitlab.com/acme/app.git",
    )
    expect(buildAuthedCloneUrl("https://github.com/acme/app.git", "")).toBe(
      "https://github.com/acme/app.git",
    )
  })
})

describe("deriveDirName", () => {
  it("extracts the repo name from https / ssh / trailing-slash forms", () => {
    expect(deriveDirName("https://github.com/acme/widgets.git")).toBe("widgets")
    expect(deriveDirName("git@github.com:acme/widgets.git")).toBe("widgets")
    expect(deriveDirName("https://github.com/acme/widgets/")).toBe("widgets")
    expect(deriveDirName("/local/path/my-repo")).toBe("my-repo")
  })
})

describe("cloneRepo", () => {
  let tmp: string
  let source: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clone-repo-test-"))
    // Build a tiny source repo to clone from.
    source = path.join(tmp, "source")
    await fs.mkdir(source)
    await execFileAsync("git", ["-C", source, "init", "-q"])
    await execFileAsync("git", ["-C", source, "config", "user.email", "t@t.dev"])
    await execFileAsync("git", ["-C", source, "config", "user.name", "T"])
    await fs.writeFile(path.join(source, "README.md"), "# hi\n")
    await execFileAsync("git", ["-C", source, "add", "README.md"])
    await execFileAsync("git", ["-C", source, "commit", "-q", "-m", "init"])
  })
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it("clones a repo into an explicit dest", async () => {
    const dest = path.join(tmp, "checkout")
    const result = await cloneRepo({ repoUrl: source, dest })
    expect(result.dest).toBe(dest)
    // The cloned tree has the file + a .git dir.
    expect(await fs.readFile(path.join(dest, "README.md"), "utf-8")).toBe("# hi\n")
    const gitStat = await fs.stat(path.join(dest, ".git"))
    expect(gitStat.isDirectory()).toBe(true)
  })

  it("refuses to clone over an existing destination", async () => {
    const dest = path.join(tmp, "existing")
    await fs.mkdir(dest)
    await expect(cloneRepo({ repoUrl: source, dest })).rejects.toThrow(
      /already exists/i,
    )
  })

  it("surfaces git's error for a bad repo", async () => {
    await expect(
      cloneRepo({ repoUrl: path.join(tmp, "nope"), dest: path.join(tmp, "out") }),
    ).rejects.toThrow(/git clone failed/i)
  })

  it("rejects a whitespace-laden URL before touching git", async () => {
    await expect(
      cloneRepo({ repoUrl: "bad url with spaces", dest: path.join(tmp, "x") }),
    ).rejects.toThrow(/invalid repo url/i)
  })
})
