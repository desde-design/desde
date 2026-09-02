/**
 * P1 (round-4 whole-branch review finding, 2026-08-19): the ledger route
 * used to take a `git status` snapshot, then call `reconcileLedger`,
 * which re-read the ledger from disk. An edit that lands between those
 * two steps appends a ledger line the re-read then sees — but its file
 * is not in the already-captured dirty set, because status ran before
 * the edit wrote. The still-uncommitted edit was durably marked
 * committed, with no way to un-say it on a later poll (the log is
 * append-only).
 *
 * This needs no unusual timing: the panel polls this endpoint
 * continuously, so a poll overlapping an edit is the ordinary case, not
 * an edge case.
 *
 * This test constructs the exact interleaving over the REAL HTTP route,
 * using one narrow mock purely to make the race DETERMINISTIC rather
 * than hoping real disk-I/O timing cooperates (see the sibling
 * `http-server-commit-ledger-ordering.integration.test.ts` for the same
 * reasoning about a different race):
 *
 *   `listDirtyRepoRelativePaths` is wrapped so that, immediately AFTER
 *   it has computed the real `git status` snapshot (but before
 *   returning it to the caller), a test hook writes a NEW file to disk
 *   and appends its OWN ledger `edit` entry — simulating an edit that
 *   lands in the race window between the status snapshot and reconcile.
 *   The returned dirty set is the one computed BEFORE that write, so it
 *   genuinely does not contain the late file — exactly what "status ran
 *   before the edit wrote" means.
 *
 * With the bug, `reconcileLedger` re-reads the ledger AFTER the mock's
 * side effect has already landed, sees the late entry, checks it against
 * the stale dirty set, finds it "clean," and marks it committed. With
 * the fix, the ledger route reads the ledger BEFORE calling
 * `listDirtyRepoRelativePaths` at all — before the mock (and its late
 * append) ever runs — so the late entry is simply not a candidate this
 * round.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const hooks = vi.hoisted(() => {
  let onStatusSnapshot: (() => Promise<void>) | null = null
  return {
    setOnStatusSnapshot(fn: (() => Promise<void>) | null) {
      onStatusSnapshot = fn
    },
    async signalStatusSnapshot() {
      await onStatusSnapshot?.()
    },
  }
})

// Wraps the REAL `listDirtyRepoRelativePaths` — computes the genuine
// status snapshot first, THEN (if a hook is armed) runs the race's late
// write + ledger append, THEN returns the snapshot computed before that
// write. Every other export passes through untouched.
vi.mock("../../../../src/editor/worktree/git-branches.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/editor/worktree/git-branches.js")>()
  return {
    ...actual,
    listDirtyRepoRelativePaths: async (root: string) => {
      const status = await actual.listDirtyRepoRelativePaths(root)
      await hooks.signalStatusSnapshot()
      return status
    },
  }
})

import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import { appendLedgerEntry, hashContent } from "../../../../src/editor/ledger/index.js"

// `App.vue`'s content as written by `beforeEach` below — `reconcileLedger`
// now requires positive evidence (HEAD's content genuinely matching the
// entry's own recorded hash), not just a clean working tree, so a
// hand-built entry that expects to reconcile needs a REAL hash here, not
// an empty `afterHashes`. See `edit-ledger.ts`'s `reconcileLedger` doc
// comment.
const APP_VUE_CONTENT = "<template><h1>Hi</h1></template>\n"

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
  hooks.setOnStatusSnapshot(null)

  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerrace-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerrace-repo-"))
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
}

describe("the ledger route does not reconcile an edit that races its own status snapshot", () => {
  it("an edit landing between the status snapshot and reconcile stays pending on that same poll", async () => {
    // Armed: fires from inside the mocked `listDirtyRepoRelativePaths`,
    // AFTER it has already computed the real (pre-race) dirty set. This
    // is the race window — a concurrent edit writing its file and
    // appending its ledger line while a ledger GET is in flight.
    hooks.setOnStatusSnapshot(async () => {
      await writeFile(join(repoDir, "Late.vue"), "<template><h1>Late</h1></template>\n")
      await appendLedgerEntry(repoDir, {
        type: "edit",
        id: "late",
        at: new Date().toISOString(),
        kind: "prop",
        lane: "direct",
        files: ["Late.vue"],
        afterHashes: {},
      })
    })

    const ledgerRes = await authedFetch("/api/editor/ledger")
    expect(ledgerRes.status).toBe(200)
    const { entries } = (await ledgerRes.json()) as { entries: LedgerRow[] }

    const lateEntry = entries.find((e) => e.id === "late")
    expect(lateEntry).toBeDefined()
    // The load-bearing assertion. Before the fix, this reads `true` —
    // `reconcileLedger` re-read the ledger AFTER the race's append had
    // already landed, checked it against a dirty set captured before
    // the write, found it "clean," and durably marked it committed even
    // though Late.vue's bytes were never actually committed anywhere.
    expect(lateEntry?.committed).toBe(false)

    // And the append-only consequence: no `reconcile` line at all should
    // have been written naming it, since the caller's pre-snapshot read
    // never had this entry to consider.
    const raw = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8")
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.some((l) => l.type === "reconcile")).toBe(false)
  })

  it("the SAME edit is correctly reconciled on the very next poll, once a fresh read can see it", async () => {
    // No race this time — the entry already exists before this poll's
    // read starts, and its file genuinely reads clean: App.vue is
    // byte-identical to HEAD (nothing wrote to it in this test), which
    // stands in for "the user committed it in their own terminal in
    // between polls."
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "late",
      at: new Date().toISOString(),
      kind: "prop",
      lane: "direct",
      files: ["App.vue"],
      afterHashes: { "App.vue": hashContent(APP_VUE_CONTENT) },
    })

    const ledgerRes = await authedFetch("/api/editor/ledger")
    expect(ledgerRes.status).toBe(200)
    const { entries } = (await ledgerRes.json()) as { entries: LedgerRow[] }
    const lateEntry = entries.find((e) => e.id === "late")
    expect(lateEntry?.committed).toBe(true)
  })
})
