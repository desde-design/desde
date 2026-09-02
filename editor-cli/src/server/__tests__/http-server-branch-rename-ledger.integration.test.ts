/**
 * P2-3 (whole-branch review finding, 2026-08-18): `handleLedgerRequest`
 * filtered rows by an EXACT branch-name match. Renaming the current
 * branch through the Branch menu (`POST /api/editor/branches/rename`)
 * leaves every earlier ledger line carrying the OLD name — the log is
 * append-only, nothing about them is rewritten — so once the ledger's
 * branch cache refreshes (P2-1's fix, or simply the 5s TTL expiring), the
 * WHOLE ledger for that branch vanished from `GET /api/editor/ledger`,
 * even though the rename preserved the branch's commits and working tree
 * untouched.
 *
 * This drives the real rename route end-to-end and checks the real read
 * route — the shape of defect this plan has shipped twice before (a
 * producer and consumer individually testing green but disagreeing when
 * wired together), per the sibling `http-server-ledger-commit` suite's
 * own header comment.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
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
  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-renameledger-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-renameledger-repo-"))
  await run("git", ["-C", repoDir, "init", "--initial-branch=main", "--quiet"])
  await run("git", ["-C", repoDir, "config", "user.email", "t@e.com"])
  await run("git", ["-C", repoDir, "config", "user.name", "T"])
  await run("git", ["-C", repoDir, "config", "commit.gpgsign", "false"])
  await writeFile(join(repoDir, "App.vue"), "<template><h1>Hi</h1></template>\n")
  await run("git", ["-C", repoDir, "add", "App.vue"])
  await run("git", ["-C", repoDir, "commit", "-m", "init", "--quiet"])
  await run("git", ["-C", repoDir, "checkout", "-b", "feature", "--quiet"])

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

interface LedgerRow {
  id: string
  description: string
}

describe("renaming the current branch keeps its ledger history visible", () => {
  it("an entry recorded under the old branch name still shows up after the rename", async () => {
    const content = "<template><h1>Pricing</h1></template>\n"
    await writeFile(join(repoDir, "App.vue"), content)
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e1",
      at: new Date().toISOString(),
      branch: "feature",
      kind: "prop",
      lane: "direct",
      files: ["App.vue"],
      afterHashes: { "App.vue": hashContent(content) },
      fields: { propName: "title", value: "Pricing" },
    })

    // Sanity: visible before the rename.
    const before = await authedFetch("/api/editor/ledger")
    expect(((await before.json()) as { entries: LedgerRow[] }).entries).toHaveLength(1)

    const renameRes = await authedFetch("/api/editor/branches/rename", {
      method: "POST",
      body: JSON.stringify({ name: "feature", to: "feature-v2" }),
    })
    expect(renameRes.status).toBe(200)

    // Regression: before the fix, this would come back empty — e1 still
    // carries `branch: "feature"`, and the row filter no longer matched
    // the now-current "feature-v2".
    const after = await authedFetch("/api/editor/ledger")
    const { entries } = (await after.json()) as { entries: LedgerRow[] }
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: "e1", description: 'title = "Pricing"' })

    const raw = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8")
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.some((l) => l.type === "rename" && l.from === "feature" && l.to === "feature-v2"))
      .toBe(true)
  })

  it("a rename of a DIFFERENT branch than the one currently checked out is still recorded and does not affect the current branch's rows", async () => {
    // Rename "main" (not checked out — we're on "feature") to "trunk".
    const renameRes = await authedFetch("/api/editor/branches/rename", {
      method: "POST",
      body: JSON.stringify({ name: "main", to: "trunk" }),
    })
    expect(renameRes.status).toBe(200)

    const raw = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8")
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.some((l) => l.type === "rename" && l.from === "main" && l.to === "trunk")).toBe(
      true,
    )

    const ledgerRes = await authedFetch("/api/editor/ledger")
    expect(((await ledgerRes.json()) as { entries: LedgerRow[] }).entries).toEqual([])
  })

  // F3 (round-5 whole-branch review finding, 2026-08-19): the sibling test
  // above proves the product's OWN rename route (which appends a `rename`
  // line) keeps history visible. `git branch -m` typed in the user's own
  // terminal renames the checked-out branch the exact same way — same
  // commits, same working tree — but appends nothing to the ledger, and
  // `resolveBranchCached` reports the new name on the very next read (it
  // reads `.git/HEAD` directly, not the ledger). Before the fix, this
  // permanently hid the branch's entries: no `rename` line exists to
  // explain the name change, and the exact-match filter has no other way
  // to recognise "same branch, new name."
  it("an entry recorded under the old name still shows up after a `git branch -m` run outside the product", async () => {
    const content = "<template><h1>Pricing</h1></template>\n"
    await writeFile(join(repoDir, "App.vue"), content)
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e1",
      at: new Date().toISOString(),
      branch: "feature",
      kind: "prop",
      lane: "direct",
      files: ["App.vue"],
      afterHashes: { "App.vue": hashContent(content) },
      fields: { propName: "title", value: "Pricing" },
    })

    // Sanity: visible before the external rename.
    const before = await authedFetch("/api/editor/ledger")
    expect(((await before.json()) as { entries: LedgerRow[] }).entries).toHaveLength(1)

    // The external rename: no HTTP route, no `rename` ledger line — just
    // the bare git command a user would type in their own terminal.
    await run("git", ["-C", repoDir, "branch", "-m", "feature", "feature-v2"])

    const after = await authedFetch("/api/editor/ledger")
    const { entries } = (await after.json()) as { entries: LedgerRow[] }
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: "e1", description: 'title = "Pricing"' })

    // And confirm the ledger really has no rename line explaining this —
    // the fix cannot be relying on one.
    const raw = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8")
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.some((l) => l.type === "rename")).toBe(false)
  })

  it("a `git branch -m` of a DIFFERENT, still-existing branch does not reveal its entries under the current branch's view", async () => {
    // "main" exists and is untouched — only "feature" (checked out) gets
    // externally renamed. An entry recorded on "main" must stay hidden:
    // "main" still exists under its own name, so this is an ordinary
    // foreign-branch entry, not an orphaned one.
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e-main",
      at: new Date().toISOString(),
      branch: "main",
      kind: "prop",
      lane: "direct",
      files: ["App.vue"],
      afterHashes: { "App.vue": hashContent("<template><h1>Hi</h1></template>\n") },
      fields: { propName: "title", value: "Main branch pricing" },
    })

    await run("git", ["-C", repoDir, "branch", "-m", "feature", "feature-v2"])

    const ledgerRes = await authedFetch("/api/editor/ledger")
    expect(((await ledgerRes.json()) as { entries: LedgerRow[] }).entries).toEqual([])
  })
})
