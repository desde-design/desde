/**
 * Tests for the origin-remote reader + GitHub URL normalization used
 * by the project-link flow. `parseGitHubFullName` is pure (table
 * test); `checkOriginMatches` runs against a throwaway git repo.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import {
  checkOriginMatches,
  parseGitHubFullName,
  readOriginRemoteUrl,
} from "../git-remote.js"

const execFileAsync = promisify(execFile)

describe("parseGitHubFullName", () => {
  it("parses https, ssh scp-like, and ssh url forms (and strips .git)", () => {
    const cases: [string, string | null][] = [
      ["https://github.com/acme/widgets.git", "acme/widgets"],
      ["https://github.com/acme/widgets", "acme/widgets"],
      ["git@github.com:Acme/Widgets.git", "Acme/Widgets"],
      ["ssh://git@github.com/acme/widgets.git", "acme/widgets"],
      ["https://gitlab.com/acme/widgets.git", null],
      ["not a url", null],
    ]
    for (const [input, expected] of cases) {
      expect(parseGitHubFullName(input)).toBe(expected)
    }
  })
})

describe("checkOriginMatches (real repo)", () => {
  let repo: string

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "git-remote-test-"))
    await execFileAsync("git", ["-C", repo, "init", "-q"])
  })
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true })
  })

  it("reports no-remote before any origin is added", async () => {
    expect(await readOriginRemoteUrl(repo)).toBeNull()
    expect(await checkOriginMatches(repo, "acme/app")).toEqual({
      status: "no-remote",
    })
  })

  it("matches origin case-insensitively", async () => {
    await execFileAsync("git", [
      "-C", repo, "remote", "add", "origin",
      "git@github.com:Acme/App.git",
    ])
    expect(await checkOriginMatches(repo, "acme/app")).toEqual({
      status: "match",
    })
  })

  it("flags a mismatch with the actual repo", async () => {
    await execFileAsync("git", [
      "-C", repo, "remote", "add", "origin",
      "https://github.com/other/thing.git",
    ])
    expect(await checkOriginMatches(repo, "acme/app")).toEqual({
      status: "mismatch",
      actual: "other/thing",
    })
  })

  it("flags an unparseable (non-GitHub) origin", async () => {
    await execFileAsync("git", [
      "-C", repo, "remote", "add", "origin",
      "https://gitlab.com/acme/app.git",
    ])
    expect(await checkOriginMatches(repo, "acme/app")).toEqual({
      status: "unparseable",
      remoteUrl: "https://gitlab.com/acme/app.git",
    })
  })
})
