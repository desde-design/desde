/**
 * P1 (round-7 whole-branch review finding, 2026-08-19): a `commit` line
 * used to mark every PENDING edit on its branch committed (minus an
 * `.gitignore` exclusion list), computed from a ledger read taken AFTER
 * `commitWorkingTree` (`git add -A && git commit`) had already run. The
 * lock that makes "every pending edit on the branch" safe to sweep
 * (`withTreeLock`, `session-lock.ts`) is PROCESS-LOCAL — but the ledger is
 * deliberately LOCK-FREE JSONL specifically so a second Editor process on
 * the SAME repo can append concurrently (see `edit-ledger.ts`'s module
 * doc: "appends from concurrent Editor processes on one repo must not
 * need a lock").
 *
 * Failure scenario this reproduces: the repo is open in two Editor
 * processes. Process B appends a new pending edit AFTER process A's `git
 * add -A` already ran (so B's bytes are genuinely NOT part of A's
 * commit) but BEFORE A's ledger `commit` marker gets written — the
 * ordinary gap between `commitWorkingTree` returning and
 * `recordCommitInLedger` running. A post-commit read cannot tell B's
 * edit apart from one that predated the commit, and durably (and
 * wrongly) marks it committed under A's sha.
 *
 * This test simulates process B with a narrow mock on `commitWorkingTree`
 * — the same technique the sibling race tests in this directory use
 * (`http-server-ledger-reconcile-after-commit-race`,
 * `http-server-commit-ledger-ordering`): call through to the REAL
 * implementation (so a genuine `git add -A && git commit` really runs),
 * then — simulating a foreign process's write landing in the gap before
 * the ledger marker is appended — write a second file to disk and append
 * its OWN pending `edit` ledger line, entirely outside process A's tree
 * lock (a second, real Editor process would not hold it either).
 *
 * The fix (`captureCommitCoverage` in `http-server.ts`) reads the ledger
 * BEFORE `commitWorkingTree` runs at all, so this test's injected
 * "foreign" append — which happens strictly AFTER that read, from inside
 * the mocked `commitWorkingTree` — must never appear in the resulting
 * `commit` line's `committedIds`, and the foreign edit must stay
 * `committed: false`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const hooks = vi.hoisted(() => {
  let afterRealCommit: (() => Promise<void>) | null = null
  return {
    setAfterRealCommit(fn: (() => Promise<void>) | null) {
      afterRealCommit = fn
    },
    async signalAfterRealCommit() {
      await afterRealCommit?.()
    },
  }
})

// Wraps the REAL `commitWorkingTree` — runs the genuine `git add -A &&
// git commit`, then (if armed) simulates a concurrent, foreign process's
// write landing in the gap before the ledger marker is appended. Every
// other export passes through untouched.
vi.mock("../../../../src/editor/worktree/git-branches.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/editor/worktree/git-branches.js")>()
  return {
    ...actual,
    commitWorkingTree: async (root: string, message?: string) => {
      const result = await actual.commitWorkingTree(root, message)
      if (result.ok) await hooks.signalAfterRealCommit()
      return result
    },
  }
})

import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import { appendLedgerEntry, hashContent } from "../../../../src/editor/ledger/index.js"

const run = promisify(execFile)

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let token: string
let shellOrigin: string

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

beforeEach(async () => {
  hooks.setAfterRealCommit(null)

  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-crossprocess-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-crossprocess-repo-"))
  await run("git", ["-C", repoDir, "init", "--initial-branch=main", "--quiet"])
  await run("git", ["-C", repoDir, "config", "user.email", "t@e.com"])
  await run("git", ["-C", repoDir, "config", "user.name", "T"])
  await run("git", ["-C", repoDir, "config", "commit.gpgsign", "false"])
  await writeFile(join(repoDir, "App.vue"), "<template><h1>Hi</h1></template>\n")
  await writeFile(join(repoDir, "Other.vue"), "<template><h1>Other</h1></template>\n")
  await run("git", ["-C", repoDir, "add", "App.vue", "Other.vue"])
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
  vi.clearAllMocks()
})

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

interface LedgerRow {
  id: string
  committed: boolean
  sha?: string
}

describe("a concurrent Editor process's edit is never swept into another process's commit line", () => {
  it("stays uncommitted when it lands after this process's git add -A but before the commit marker", async () => {
    // Process A's own pending edit — genuinely staged and committed by
    // the real `git add -A && git commit` this test drives.
    const ownContent = "<template><h1>Pricing</h1></template>\n"
    await writeFile(join(repoDir, "App.vue"), ownContent)
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e-own",
      at: new Date().toISOString(),
      kind: "prop",
      lane: "direct",
      files: ["App.vue"],
      afterHashes: { "App.vue": hashContent(ownContent) },
      fields: { propName: "title", value: "Pricing" },
    })

    // Armed: fires from inside the mocked `commitWorkingTree`, AFTER the
    // real `git add -A && git commit` already ran — simulating process B
    // writing its own file and appending its own pending edit, entirely
    // outside process A's tree lock (a second real process holds none of
    // process A's in-memory locks).
    const foreignContent = "<template><h1>Foreign</h1></template>\n"
    hooks.setAfterRealCommit(async () => {
      await writeFile(join(repoDir, "Other.vue"), foreignContent)
      await appendLedgerEntry(repoDir, {
        type: "edit",
        id: "e-foreign",
        at: new Date().toISOString(),
        kind: "prop",
        lane: "direct",
        files: ["Other.vue"],
        afterHashes: { "Other.vue": hashContent(foreignContent) },
        fields: { propName: "title", value: "Foreign" },
      })
    })

    const commitRes = await authedFetch("/api/editor/branches/commit", {
      method: "POST",
      body: JSON.stringify({ message: "ship pricing copy" }),
    })
    expect(commitRes.status).toBe(200)
    const commitBody = (await commitRes.json()) as { ok: boolean; sha: string }
    expect(commitBody.ok).toBe(true)

    // Other.vue was never staged by process A's `git add -A` — it did
    // not exist with this content on disk yet when that ran — so it is
    // genuinely still dirty afterward.
    const status = await run("git", ["-C", repoDir, "status", "--porcelain", "--", "Other.vue"])
    expect(status.stdout.trim()).not.toBe("")

    const ledgerRes = await authedFetch("/api/editor/ledger")
    expect(ledgerRes.status).toBe(200)
    const { entries } = (await ledgerRes.json()) as { entries: LedgerRow[] }
    const own = entries.find((e) => e.id === "e-own")
    const foreign = entries.find((e) => e.id === "e-foreign")

    expect(own).toMatchObject({ committed: true, sha: commitBody.sha })
    // The load-bearing assertion. Before the fix (a post-commit ledger
    // read swept every pending edit on the branch, minus only an
    // `.gitignore` exclusion), this read `committed: true` with the SAME
    // sha as e-own — even though Other.vue never entered process A's
    // commit at all.
    expect(foreign?.committed).toBe(false)
    expect(foreign?.sha).toBeUndefined()

    // And the commit line itself must name exactly what it observed
    // BEFORE `git add -A` ran — e-own only.
    const raw = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8")
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    const commitLine = lines.find((l) => l.type === "commit") as
      | { sha: string; committedIds: string[] }
      | undefined
    expect(commitLine?.committedIds).toEqual(["e-own"])
  })
})
