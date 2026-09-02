/**
 * LIVE SMOKE FINDING (2026-08-20): `reconcileLedger` now requires POSITIVE
 * evidence — HEAD's actual content for a file must hash-equal the entry's
 * own recorded `afterHashes` — not just a clean working tree. The route
 * (`handleLedgerRequest` in `http-server.ts`) gets that evidence from
 * `readHeadBlobs` (`git-branches.ts`), one batched `git cat-file --batch`
 * spawn for every still-pending file.
 *
 * "Unknown must never read as committed" — the same rule the route
 * already applies when `listDirtyRepoRelativePaths` fails — has to hold
 * for THIS git call too. `readHeadBlobs` throws on a genuine failure
 * rather than returning a partial map (see its own doc comment and unit
 * tests in `git-branches.test.ts`); this test proves the ROUTE actually
 * treats that throw the safe way: skip reconciling this poll entirely,
 * not "couldn't confirm, so leave it pending" versus "couldn't confirm,
 * so mark it committed anyway" — the latter would be exactly the defect
 * this whole fix closes, just moved one layer up.
 *
 * The mock forces `readHeadBlobs` to throw on demand — the real function
 * already throws for a real reason (a bad root, a git spawn failure); this
 * just makes that failure deterministic instead of needing to break the
 * test repo itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

// Wraps the REAL `readHeadBlobs` so a test can force it to throw on
// demand — every other export (including `listDirtyRepoRelativePaths`,
// which the route also calls) passes through untouched.
vi.mock("../../../../src/editor/worktree/git-branches.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/editor/worktree/git-branches.js")>()
  return {
    ...actual,
    readHeadBlobs: async (root: string, paths: readonly string[]) => {
      if (hooks.isFailing()) {
        throw new Error("simulated git cat-file --batch failure")
      }
      return actual.readHeadBlobs(root, paths)
    },
  }
})

import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import { appendLedgerEntry, hashContent } from "../../../../src/editor/ledger/index.js"

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
  hooks.setFailing(false)

  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerheadfail-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerheadfail-repo-"))
  await run("git", ["-C", repoDir, "init", "--initial-branch=main", "--quiet"])
  await run("git", ["-C", repoDir, "config", "user.email", "t@e.com"])
  await run("git", ["-C", repoDir, "config", "user.name", "T"])
  await run("git", ["-C", repoDir, "config", "commit.gpgsign", "false"])
  await writeFile(join(repoDir, "App.vue"), APP_VUE_CONTENT)
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
  hooks.setFailing(false)
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

describe("the ledger route skips reconciliation, rather than guessing, when it cannot read HEAD's content", () => {
  it("leaves a genuinely-clean, genuinely-matching entry pending when the HEAD-content read fails", async () => {
    // App.vue is byte-identical to HEAD and the entry's own recorded hash
    // genuinely matches it — under ordinary conditions this reconciles.
    // The point of this test is that a git failure must win over that,
    // not the other way around: "we could not confirm" must never be
    // treated as license to guess "committed" just because everything
    // else about the entry looks right.
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e1",
      at: new Date().toISOString(),
      kind: "prop",
      lane: "direct",
      branch: "main",
      files: ["App.vue"],
      afterHashes: { "App.vue": hashContent(APP_VUE_CONTENT) },
    })

    hooks.setFailing(true)
    const ledgerRes = await authedFetch("/api/editor/ledger")
    expect(ledgerRes.status).toBe(200)
    const { entries } = (await ledgerRes.json()) as { entries: LedgerRow[] }
    const entry = entries.find((e) => e.id === "e1")
    expect(entry).toBeDefined()
    expect(entry?.committed).toBe(false)

    // And the append-only consequence: no `reconcile` line was written —
    // the failure skipped this poll's reconcile attempt entirely, rather
    // than reconciling with a wrong or partial answer.
    const raw = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8")
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.some((l) => l.type === "reconcile")).toBe(false)
  })

  it("the SAME entry reconciles normally on the next poll, once the HEAD-content read succeeds again", async () => {
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e1",
      at: new Date().toISOString(),
      kind: "prop",
      lane: "direct",
      branch: "main",
      files: ["App.vue"],
      afterHashes: { "App.vue": hashContent(APP_VUE_CONTENT) },
    })

    hooks.setFailing(false)
    const ledgerRes = await authedFetch("/api/editor/ledger")
    expect(ledgerRes.status).toBe(200)
    const { entries } = (await ledgerRes.json()) as { entries: LedgerRow[] }
    expect(entries.find((e) => e.id === "e1")?.committed).toBe(true)
  })
})
