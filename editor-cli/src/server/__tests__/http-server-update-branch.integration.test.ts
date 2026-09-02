/**
 * End-to-end HTTP coverage for the two all-or-nothing update actions
 * (`POST /api/editor/branches/update-from-default`, and the shared
 * `sendUpdateBranchResult` tail both routes go through).
 *
 * What this file pins, from the branch-conflict-recovery review:
 *
 *  - The pre-merge auto-commit is REPORTED on every path it runs
 *    (`committedBranch` on the up-to-date result AND on the conflict 409),
 *    and the conflict reason never claims nothing changed.
 *  - The git-status cache is invalidated whenever the auto-commit ran,
 *    including the up-to-date path and the conflict path. Before the fix
 *    the guard was `if (!result.upToDate)`, written on the assumption that
 *    up-to-date means nothing happened — which the auto-commit breaks: a
 *    dirty tree plus an already-current branch produced `upToDate: true`
 *    AND a commit, and `/mcp/status` kept serving `dirty: true` from the
 *    cache.
 *
 * Harness copied from `http-server-history.integration.test.ts` (real
 * `startHttpServer`, real git repo, real bearer + Origin auth).
 *
 * Timing note: the staleness window is `CACHE_TTL_MS` (1s in git-ops.ts).
 * The cache assertions prime the cache immediately before the POST and
 * read immediately after, well inside that window on any machine — if the
 * whole round trip ever exceeded the TTL the test would pass vacuously,
 * never fail spuriously.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"

const run = promisify(execFile)

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let token: string
let shellOrigin: string

beforeEach(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-update-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-update-repo-"))
  await run("git", ["-C", repoDir, "init", "--initial-branch=main", "--quiet"])
  await run("git", ["-C", repoDir, "config", "user.email", "t@e.com"])
  await run("git", ["-C", repoDir, "config", "user.name", "T"])
  await run("git", ["-C", repoDir, "config", "commit.gpgsign", "false"])
  await writeFile(join(repoDir, "a.txt"), "a\n")
  await run("git", ["-C", repoDir, "add", "a.txt"])
  await run("git", ["-C", repoDir, "commit", "-m", "init", "--quiet"])

  const port = await pickFreePort()
  shellOrigin = `http://127.0.0.1:${port}`
  const security = newSecurityContext(shellOrigin)
  token = security.token

  handle = await startHttpServer({
    host: "127.0.0.1",
    port,
    repoRoot: repoDir,
    uiBundleRoot: bundleDir,
    viteUrl: "http://localhost:5173",
    security,
    branchMode: true,
  })
})

afterEach(async () => {
  await handle.close()
  await rm(bundleDir, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
})

async function pickFreePort(): Promise<number> {
  const net = await import("node:net")
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const p = typeof addr === "object" && addr ? addr.port : 0
      server.close(() => resolve(p))
    })
  })
}

function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${handle.url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: shellOrigin,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })
}

/** `dirty` as `/mcp/status` reports it — served from the git-status cache. */
async function statusDirty(): Promise<boolean> {
  const res = await authedFetch("/mcp/status")
  expect(res.status).toBe(200)
  const body = (await res.json()) as { dirty: boolean }
  return body.dirty
}

describe("POST /api/editor/branches/update-from-default", () => {
  it("up-to-date with a dirty tree: reports the auto-commit and busts the status cache", async () => {
    // `feature` already contains main; the tree is dirty.
    await run("git", ["-C", repoDir, "checkout", "-b", "feature", "--quiet"])
    await writeFile(join(repoDir, "wip.txt"), "uncommitted\n")

    // Prime the cache with the dirty state.
    expect(await statusDirty()).toBe(true)

    const res = await authedFetch("/api/editor/branches/update-from-default", {
      method: "POST",
      body: "{}",
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      upToDate?: boolean
      committedBranch?: boolean
    }
    expect(body.ok).toBe(true)
    expect(body.upToDate).toBe(true)
    // The auto-commit ran and the response says so.
    expect(body.committedBranch).toBe(true)

    // The commit flipped the tree clean, and the cache must know it NOW —
    // not after the TTL. Before the fix the `if (!result.upToDate)` guard
    // skipped the invalidation and this read served the stale dirty: true.
    expect(await statusDirty()).toBe(false)
  })

  it("a conflict with a dirty tree: 409 reports the auto-commit, honest reason, busted cache", async () => {
    // Diverge a.txt on both sides, plus an uncommitted wip file.
    await run("git", ["-C", repoDir, "checkout", "-b", "feature", "--quiet"])
    await writeFile(join(repoDir, "a.txt"), "page version\n")
    await run("git", ["-C", repoDir, "commit", "-am", "page", "--quiet"])
    await run("git", ["-C", repoDir, "checkout", "main", "--quiet"])
    await writeFile(join(repoDir, "a.txt"), "trunk version\n")
    await run("git", ["-C", repoDir, "commit", "-am", "trunk", "--quiet"])
    await run("git", ["-C", repoDir, "checkout", "feature", "--quiet"])
    await writeFile(join(repoDir, "wip.txt"), "uncommitted\n")

    expect(await statusDirty()).toBe(true)

    const res = await authedFetch("/api/editor/branches/update-from-default", {
      method: "POST",
      body: "{}",
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      ok: boolean
      reason?: string
      conflict?: boolean
      conflictFiles?: string[]
      committedBranch?: boolean
    }
    expect(body.ok).toBe(false)
    expect(body.conflict).toBe(true)
    expect(body.conflictFiles).toEqual(["a.txt"])
    // The failure branch carries the truth: the commit happened, and the
    // message does not claim nothing changed.
    expect(body.committedBranch).toBe(true)
    expect(body.reason).not.toMatch(/nothing was changed/i)
    expect(body.reason).toMatch(/committed/i)

    // The auto-commit still flipped the tree clean on the FAILURE path, so
    // the cache must be invalidated here too.
    expect(await statusDirty()).toBe(false)
  })
})
