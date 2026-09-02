/**
 * P2 (round-6 whole-branch review finding, 2026-08-19): the ledger route's
 * orphaned-branch fail-open (`isOrphanedBranch`, F3 round-5) must fire only
 * when the branch list was genuinely obtained and the resolved branch is
 * missing from it — not when the branch list couldn't be obtained at all.
 *
 * Before the fix, `handleLedgerRequest` called `listLocalBranchNames`,
 * which collapses "genuinely no local branches" and "the underlying `git
 * for-each-ref` call failed" into the same `[]`. Since `isOrphanedBranch`
 * treats "not in the list" as orphaned and fails the row filter open, a
 * transient git failure made EVERY resolved branch read as orphaned —
 * bypassing the branch filter for the WHOLE poll, not just a genuinely
 * renamed-outside-the-product row. A pending edit recorded on a
 * completely different, still-existing branch would leak into this
 * checkout's ledger view.
 *
 * This test forces the branch-name lookup to fail (mocked, mirroring the
 * sibling reconcile-race integration tests' own reasoning for a narrow
 * mock over trying to make a real `git` subprocess fail deterministically)
 * and proves the foreign branch's pending edit stays hidden.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const hooks = vi.hoisted(() => {
  let failing = false
  return {
    setFailing(v: boolean) {
      failing = v
    },
    isFailing() {
      return failing
    },
  }
})

// Wraps the REAL `tryListLocalBranchNames` so a test can force it to
// report "couldn't ask" (`null`) — exactly what it returns when the real
// `git for-each-ref` spawn fails. Every other export, including
// `listLocalBranchNames` (used elsewhere for the Branch panel), passes
// through untouched.
vi.mock("../../../../src/editor/worktree/git-branches.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/editor/worktree/git-branches.js")>()
  return {
    ...actual,
    tryListLocalBranchNames: async (root: string) => {
      if (hooks.isFailing()) return null
      return actual.tryListLocalBranchNames(root)
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
  hooks.setFailing(false)

  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-orphanlookup-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-orphanlookup-repo-"))
  await run("git", ["-C", repoDir, "init", "--initial-branch=main", "--quiet"])
  await run("git", ["-C", repoDir, "config", "user.email", "t@e.com"])
  await run("git", ["-C", repoDir, "config", "user.name", "T"])
  await run("git", ["-C", repoDir, "config", "commit.gpgsign", "false"])
  await writeFile(join(repoDir, "App.vue"), "<template><h1>Hi</h1></template>\n")
  await run("git", ["-C", repoDir, "add", "App.vue"])
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

describe("P2 (round-6): orphan fail-open does not fire when the branch list can't be obtained", () => {
  it("hides a foreign, still-existing branch's pending edit even when the branch-list lookup fails", async () => {
    // A REAL, still-existing branch — never checked out, same as a real
    // stash-and-switch. The checked-out repo stays on "main" the whole
    // test.
    await run("git", ["-C", repoDir, "branch", "feature"])
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e1",
      at: new Date().toISOString(),
      kind: "prop",
      lane: "direct",
      branch: "feature",
      files: ["App.vue"],
      afterHashes: { "App.vue": hashContent("<template><h1>Hi</h1></template>\n") },
      fields: { propName: "title", value: "Feature branch pricing" },
    })

    hooks.setFailing(true)

    const ledgerRes = await authedFetch("/api/editor/ledger")
    expect(ledgerRes.status).toBe(200)
    const { entries } = (await ledgerRes.json()) as { entries: { id: string }[] }
    // The load-bearing assertion. Before the fix, a failed branch-name
    // lookup collapsed to an empty Set, `isOrphanedBranch` reads "not in
    // an empty Set" as orphaned, and the row filter fails open — so this
    // entry (recorded on "feature", a real, still-existing branch that
    // just isn't checked out) would incorrectly appear here.
    expect(entries).toEqual([])
  })

  it("still shows a genuinely orphaned branch's edit when the branch-list lookup succeeds", async () => {
    // Control case: the SAME entry, but the lookup is allowed to run for
    // real and "feature" genuinely no longer exists (renamed outside the
    // product, simulated by a plain `git branch -m` with no ledger
    // `rename` line) — proving the fix didn't just make this filter
    // refuse to fail open at all.
    await run("git", ["-C", repoDir, "branch", "feature"])
    await run("git", ["-C", repoDir, "branch", "-m", "feature", "feature-renamed"])
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e1",
      at: new Date().toISOString(),
      kind: "prop",
      lane: "direct",
      branch: "feature",
      files: ["App.vue"],
      afterHashes: { "App.vue": hashContent("<template><h1>Hi</h1></template>\n") },
      fields: { propName: "title", value: "Feature branch pricing" },
    })

    hooks.setFailing(false)

    const ledgerRes = await authedFetch("/api/editor/ledger")
    expect(ledgerRes.status).toBe(200)
    const { entries } = (await ledgerRes.json()) as { entries: { id: string }[] }
    expect(entries).toHaveLength(1)
    expect(entries[0]?.id).toBe("e1")
  })
})
