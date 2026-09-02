/**
 * F2 (round-5 whole-branch review finding, 2026-08-19): `resolveCommitState`
 * (`src/editor/ledger/commit-state.ts`) replays the ledger in file order.
 * A `reconcile` line used to overwrite ANY already-`committed` state
 * unconditionally, including a `sha` a `commit` line had already
 * attached — `state.set(id, { committed: true })`, no check on what was
 * there before.
 *
 * That's safe when `reconcile` runs BEFORE the matching `commit` line
 * (the ordinary order): `reconcileLedger`'s producer deletes the id from
 * its own "still pending" bookkeeping the moment it reconciles it, so a
 * LATER `commit` line's sweep never touches that id again.
 *
 * It is NOT safe in the reverse order, and round 4 (2026-08-19, the
 * `.gitignore`-unprovable fix — see `edit-ledger.ts`) made that reverse
 * order reachable: `handleLedgerRequest` now reads the ledger's pending
 * entries BEFORE taking the `git status` snapshot, specifically so a
 * LATE edit landing mid-poll isn't judged against a dirty set that
 * predates it. But that same "read entries early" strategy means the
 * poll's view can also be stale in the OTHER direction — if a real
 * product commit lands in the gap between that early read and the
 * dirty-status check, the poll's `reconcileLedger` call still reasons
 * from the pre-commit entries snapshot, sees the file now reads clean
 * (because the commit really did land), and appends a `reconcile` line
 * for an id a `commit` line ALREADY covered with a real sha — just
 * earlier in the log than this now-stale `reconcile` line.
 *
 * This test constructs that exact interleaving over the REAL HTTP ledger
 * route, using one narrow mock purely to make the race DETERMINISTIC
 * (mirrors the sibling `http-server-ledger-reconcile-race` test's own
 * reasoning for why a mock, not disk-I/O timing, drives this):
 *
 *   `listDirtyRepoRelativePaths` is wrapped so that, BEFORE it runs the
 *   real `git status` check, a test hook performs a REAL concurrent
 *   commit — `git add -A && git commit`, plus the `commit` ledger line
 *   `recordCommitInLedger` would append for it. The wrapped function then
 *   calls through to the real `listDirtyRepoRelativePaths`, which now
 *   genuinely reports the file clean (because the commit truly landed).
 *
 * Because `handleLedgerRequest` reads `preStatusEntries` BEFORE this mock
 * ever runs, that snapshot has only the pending `edit` line — not the
 * `commit` line the hook is about to append. `reconcileLedger` reasons
 * from that stale snapshot, finds the file clean, and appends its OWN
 * `reconcile` line — landing, in the file, AFTER the `commit` line the
 * concurrent commit already wrote.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const hooks = vi.hoisted(() => {
  let onBeforeStatus: (() => Promise<void>) | null = null
  return {
    setOnBeforeStatus(fn: (() => Promise<void>) | null) {
      onBeforeStatus = fn
    },
    async signalBeforeStatus() {
      await onBeforeStatus?.()
    },
  }
})

// Wraps the REAL `listDirtyRepoRelativePaths` — runs the race's concurrent
// commit FIRST (if armed), then calls through to the genuine status check,
// which now sees whatever the concurrent commit actually left behind.
// Every other export passes through untouched.
vi.mock("../../../../src/editor/worktree/git-branches.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/editor/worktree/git-branches.js")>()
  return {
    ...actual,
    listDirtyRepoRelativePaths: async (root: string) => {
      await hooks.signalBeforeStatus()
      return actual.listDirtyRepoRelativePaths(root)
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
  hooks.setOnBeforeStatus(null)

  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-reconcileaftercommit-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-reconcileaftercommit-repo-"))
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
  sha?: string
}

describe("a stale reconcile landing after a concurrent commit's marker does not erase the commit's sha", () => {
  it("keeps the real sha a concurrent product commit attached, instead of the reconcile line's committed-with-no-sha guess", async () => {
    const content = "<template><h1>Pricing</h1></template>\n"
    await writeFile(join(repoDir, "App.vue"), content)
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e1",
      at: new Date().toISOString(),
      kind: "prop",
      lane: "direct",
      files: ["App.vue"],
      afterHashes: { "App.vue": hashContent(content) },
      fields: { propName: "title", value: "Pricing" },
    })

    let concurrentSha = ""
    // Armed: fires from inside the mocked `listDirtyRepoRelativePaths`,
    // BEFORE the real status check runs — the race window between
    // `handleLedgerRequest`'s early ledger read (which only sees the
    // pending `edit` line above) and its dirty-status snapshot.
    hooks.setOnBeforeStatus(async () => {
      await run("git", ["-C", repoDir, "add", "-A"])
      await run("git", ["-C", repoDir, "commit", "-m", "concurrent commit", "--quiet"])
      const { stdout } = await run("git", ["-C", repoDir, "rev-parse", "HEAD"])
      concurrentSha = stdout.trim()
      // Mirrors `recordCommitInLedger` for the case under test: e1 is the
      // only pending edit, so `committedIds` names exactly it.
      await appendLedgerEntry(repoDir, {
        type: "commit",
        at: new Date().toISOString(),
        sha: concurrentSha,
        message: "concurrent commit",
        committedIds: ["e1"],
      })
    })

    const ledgerRes = await authedFetch("/api/editor/ledger")
    expect(ledgerRes.status).toBe(200)
    const { entries } = (await ledgerRes.json()) as { entries: LedgerRow[] }

    const e1 = entries.find((e) => e.id === "e1")
    expect(e1).toBeDefined()
    expect(e1?.committed).toBe(true)
    // The load-bearing assertion. Before the fix, this reads `undefined`
    // — the ledger genuinely has a `commit` line naming `concurrentSha`
    // for e1, but the stale `reconcile` line appended after it
    // unconditionally overwrote the resolved state to
    // `{ committed: true }`, dropping the sha.
    expect(e1?.sha).toBe(concurrentSha)
    expect(concurrentSha).not.toBe("")

    // And confirm the interleaving actually happened the way the test
    // claims: both a `commit` line and a `reconcile` line exist, with the
    // commit line FIRST in the file (recorded during the poll's own
    // status check) and the reconcile line naming e1 SECOND (appended by
    // this same poll's stale-snapshot reconcile pass).
    const raw = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8")
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    const commitIdx = lines.findIndex((l) => l.type === "commit")
    const reconcileIdx = lines.findIndex((l) => l.type === "reconcile")
    expect(commitIdx).toBeGreaterThanOrEqual(0)
    expect(reconcileIdx).toBeGreaterThan(commitIdx)
    expect((lines[reconcileIdx] as { committedIds: string[] }).committedIds).toContain("e1")
  })
})
