/**
 * F1 (round-8 whole-branch review finding, 2026-08-19): the ledger route
 * holds the repo's tree gate SHARED across its branch-resolve → ledger-read
 * → status-snapshot → reconcile sequence (round-6 P1-2). That gate is
 * IN-PROCESS ONLY — an `acquireTreeGateShared`/`acquireTreeGateExclusive`
 * pair arbitrates concurrent calls inside this one Node process, and has no
 * way to see a `git checkout` typed in the user's own terminal, or a second
 * Editor process running against the same repo.
 *
 * If that external checkout lands between `branch = resolveBranchCached()`
 * and the `listDirtyRepoRelativePaths` status snapshot, `branch` names the
 * OLD checkout while the dirty set reflects the NEW one. A pending ledger
 * entry whose file happens to read clean on the new checkout then gets a
 * durable `reconcile` line recorded against a status snapshot that was
 * never actually scoped to the branch it claims — the log is append-only,
 * so nothing later corrects it.
 *
 * The fix brackets the status snapshot with a raw `.git/HEAD` read
 * (`readGitHeadRaw`) on each side and skips reconciling for this poll when
 * they disagree. This test makes that race deterministic by wrapping the
 * real `listDirtyRepoRelativePaths` so that, on the way in — after the
 * route's "before" fingerprint read, before the real status snapshot
 * runs — a test hook performs a REAL `git checkout -b` against the repo,
 * exactly standing in for an external process switching HEAD mid-poll.
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

// Wraps the REAL `listDirtyRepoRelativePaths` so a test can land an
// external `git checkout` in the exact window the fix brackets: AFTER the
// route's pre-snapshot HEAD fingerprint read, BEFORE the real status
// snapshot runs. Every other export passes through untouched.
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
  hooks.setOnBeforeStatus(null)

  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerheadrace-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerheadrace-repo-"))
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
  hooks.setOnBeforeStatus(null)
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

describe("F1 (round-8): the ledger route skips reconcile when HEAD moves mid-status-snapshot", () => {
  it("does not durably reconcile a pending entry when an external checkout lands between the fingerprint reads", async () => {
    // Armed: fires from inside the mocked `listDirtyRepoRelativePaths`,
    // AFTER the route has already taken its "before" HEAD fingerprint —
    // exactly the window F1 is about. This stands in for a `git checkout`
    // typed in the user's own terminal, or a second Editor process, since
    // neither is visible to the in-process tree gate this poll holds.
    hooks.setOnBeforeStatus(async () => {
      await run("git", ["-C", repoDir, "checkout", "-b", "other", "--quiet"])
    })

    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "pending",
      at: new Date().toISOString(),
      kind: "prop",
      lane: "direct",
      files: ["App.vue"],
      afterHashes: {},
    })

    const ledgerRes = await authedFetch("/api/editor/ledger")
    expect(ledgerRes.status).toBe(200)
    const { entries } = (await ledgerRes.json()) as { entries: LedgerRow[] }
    const entry = entries.find((e) => e.id === "pending")
    expect(entry).toBeDefined()
    // The load-bearing assertion. App.vue is byte-identical to HEAD on
    // BOTH branches (nothing modified it), so the entry reads "clean"
    // either way — without the fix, `reconcileLedger` runs against that
    // clean status regardless of which checkout it came from, and marks
    // this entry committed even though the branch it was resolved
    // against (`main`) is not the one the snapshot just measured
    // (`other`).
    expect(entry?.committed).toBe(false)

    // And the append-only consequence: no `reconcile` line should exist
    // at all yet.
    const raw = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8")
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.some((l) => l.type === "reconcile")).toBe(false)
  })

  it("the SAME entry reconciles normally on the next poll, once HEAD holds still", async () => {
    // No external checkout this time — HEAD does not move between the two
    // fingerprint reads, so the fix's guard is a no-op and reconcile runs
    // exactly as it did before F1.
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "pending",
      at: new Date().toISOString(),
      kind: "prop",
      lane: "direct",
      files: ["App.vue"],
      afterHashes: { "App.vue": hashContent(APP_VUE_CONTENT) },
    })

    const ledgerRes = await authedFetch("/api/editor/ledger")
    expect(ledgerRes.status).toBe(200)
    const { entries } = (await ledgerRes.json()) as { entries: LedgerRow[] }
    expect(entries.find((e) => e.id === "pending")?.committed).toBe(true)
  })
})
