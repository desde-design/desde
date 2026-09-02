/**
 * A2 (round-2 whole-branch review finding, 2026-08-19): the SDK's
 * *structural* write tools (`insert_component`, `delete_file`,
 * `rename_file`, `scaffold_route`, `insert_element`, `manage_package`,
 * `download_asset` — handlers in
 * `../../../../src/editor/agent-chat-sdk/fs-structural-tools.ts`) call
 * `brokeredWrite` directly with NO outer tree-gate wrapping at all — unlike
 * the CLI edit route, which already wraps its own `brokeredWrite`/`applyEdit`
 * call in `withEditLocks` at the route layer. So a structural tool's
 * edit-ledger append had no ordering against a concurrent `withTreeLock`
 * (Commit/Publish/branch switch-create-rename) whatsoever: the row could
 * miss its real commit, or inherit one that excluded it, depending on pure
 * timing.
 *
 * The fix is `BrokeredWriteOptions.acquireTreeGate` (write-broker.ts) — an
 * OPTIONAL dependency `brokeredWrite` holds across its ENTIRE call
 * (mutation → invalidate → record → ledger append) when supplied, without
 * `write-broker.ts` importing anything from `editor-cli/`. The CLI wires the
 * concrete impl (`acquireTreeGateShared`, `../session-lock.ts`) through
 * `editor-tools.ts` → each structural-tool handler's opts →
 * `brokeredWrite`.
 *
 * This drives `renameFileHandler` DIRECTLY (the same technique
 * `file-write-tools.test.ts` uses — these handlers are exported precisely
 * so tests can call them without the SDK MCP layer) with the REAL
 * `acquireTreeGateShared`, racing a real `/api/editor/branches/commit`
 * request through the REAL `withTreeLock`. Two narrow mocks make the race
 * deterministic, mirroring the sibling `sdk-write-guard-commit-ledger-race`
 * and `http-server-commit-ledger-ordering` integration tests:
 *
 *   1. `commitWorkingTree` is wrapped only to SIGNAL once called — proof the
 *      exclusive tree gate has actually been GRANTED to the commit (every
 *      earlier shared holder, including this rename, has released). Never
 *      blocked.
 *   2. `appendLedgerEntry` is wrapped to gate ONLY the rename's own
 *      `edit`-type entry; the commit's `commit`-type entry passes straight
 *      through unblocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const hooks = vi.hoisted(() => {
  let onCommitStart: (() => void) | null = null
  let renameLedgerGate: Promise<void> = Promise.resolve()
  return {
    setOnCommitStart(fn: (() => void) | null) {
      onCommitStart = fn
    },
    setRenameLedgerGate(p: Promise<void>) {
      renameLedgerGate = p
    },
    signalCommitStart() {
      onCommitStart?.()
    },
    awaitRenameLedgerGate() {
      return renameLedgerGate
    },
  }
})

vi.mock("../../../../src/editor/worktree/git-branches.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/editor/worktree/git-branches.js")>()
  return {
    ...actual,
    commitWorkingTree: async (root: string, message?: string) => {
      hooks.signalCommitStart()
      return actual.commitWorkingTree(root, message)
    },
  }
})

// Gates ONLY the rename's own `edit`-type entry (kind: 'rename_file'). The
// commit's `commit`-type entry passes straight through, unblocked — so
// whether the commit can even START (which needs the shared gate this
// rename holds to fully release) depends entirely on whether the fix keeps
// that gate held across this append.
vi.mock("../../../../src/editor/ledger/edit-ledger.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/editor/ledger/edit-ledger.js")>()
  return {
    ...actual,
    appendLedgerEntry: async (
      canonicalRoot: string,
      entry: Parameters<typeof actual.appendLedgerEntry>[1],
    ) => {
      if (entry.type === "edit" && entry.kind === "rename_file") {
        await hooks.awaitRenameLedgerGate()
      }
      return actual.appendLedgerEntry(canonicalRoot, entry)
    },
  }
})

import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import { acquireTreeGateShared } from "../session-lock.js"
import { renameFileHandler } from "../../../../src/editor/agent-chat-sdk/fs-structural-tools.js"
import type { EditProposalPayload } from "../../../../src/editor/agent-tools/types.js"
import type { EmitEditResult } from "../../../../src/editor/agent-chat-sdk/editor-tools.js"

const run = promisify(execFile)

function captureEmit(): (payload: EditProposalPayload) => Promise<EmitEditResult> {
  let n = 0
  return async () => ({ ok: true, editId: `eid-${++n}` })
}

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
  hooks.setOnCommitStart(null)
  hooks.setRenameLedgerGate(Promise.resolve())

  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-structuralrace-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-structuralrace-repo-"))
  await run("git", ["-C", repoDir, "init", "--initial-branch=main", "--quiet"])
  await run("git", ["-C", repoDir, "config", "user.email", "t@e.com"])
  await run("git", ["-C", repoDir, "config", "user.name", "T"])
  await run("git", ["-C", repoDir, "config", "commit.gpgsign", "false"])
  await writeFile(join(repoDir, "App.vue"), "<template><h1>Hi</h1></template>\n")
  await writeFile(join(repoDir, "Other.ts"), "export const x = 1\n")
  await run("git", ["-C", repoDir, "add", "App.vue", "Other.ts"])
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

describe("a structural tool's ledger line lands before it releases the tree gate a queued commit needs", () => {
  it("a commit queued behind an in-flight rename_file cannot start until the rename's own ledger append finishes", async () => {
    // App.vue is already dirty on disk — the commit has something real to
    // sweep independent of the race.
    await writeFile(join(repoDir, "App.vue"), "<template><h1>Pricing</h1></template>\n")

    // Gate the rename's own ledger append shut before firing it.
    let openRenameLedgerGate: () => void = () => {}
    hooks.setRenameLedgerGate(new Promise<void>((resolve) => (openRenameLedgerGate = resolve)))

    const commitStarted = new Promise<void>((resolve) => {
      hooks.setOnCommitStart(resolve)
    })

    // `renameFileHandler` does real async I/O (realpath, path resolution,
    // reading + hashing the prior content) BEFORE it ever calls
    // `brokeredWrite`/`acquireTreeGate` — so firing the commit request the
    // instant `renameFileHandler` is called would race it: `withTreeLock`'s
    // exclusive acquisition could win before the rename's shared
    // acquisition even starts, which would prove nothing about the fix
    // either way. Signal the exact moment the shared gate is genuinely
    // held, and only fire the commit after that — the same reason the
    // sibling `sdk-write-guard-commit-ledger-race` test AWAITS
    // `guard.preToolUse(...)` before firing its commit.
    let signalGateAcquired: () => void = () => {}
    const gateAcquired = new Promise<void>((resolve) => {
      signalGateAcquired = resolve
    })

    // Fire the rename — NOT awaited: with the fix it cannot resolve until
    // the gate above opens (its own `brokeredWrite` call holds the SHARED
    // tree gate across the whole call, including the gated ledger append);
    // with the bug it resolves as soon as the rename lands, unaffected by
    // the gate, because `acquireTreeGate` is never consulted at all.
    const renamePromise = renameFileHandler({
      worktreeRoot: repoDir,
      emitEdit: captureEmit(),
      input: { from: "Other.ts", to: "Renamed.ts" },
      acquireTreeGate: async () => {
        const release = await acquireTreeGateShared(repoDir)
        signalGateAcquired()
        return release
      },
    })

    await gateAcquired

    // Fire the commit. It needs the EXCLUSIVE tree gate, which the rename
    // still (with the fix) or no longer (with the bug) holds.
    const commitPromise = authedFetch("/api/editor/branches/commit", {
      method: "POST",
      body: JSON.stringify({ message: "ship pricing copy" }),
    })

    // Give the buggy code's path every chance to let the commit start
    // while the rename's own ledger line is still gated.
    let commitStartedEarly = false
    const raceObserver = commitStarted.then(() => {
      commitStartedEarly = true
    })
    await Promise.race([raceObserver, new Promise((r) => setTimeout(r, 300))])

    // The load-bearing assertion: with the fix, the commit could NOT have
    // started yet — the shared gate the rename holds cannot release until
    // the gated ledger append (opened only below) completes.
    expect(commitStartedEarly).toBe(false)

    openRenameLedgerGate()
    await renamePromise
    await commitStarted
    const commitRes = await commitPromise
    expect(commitRes.status).toBe(200)
    const commitBody = (await commitRes.json()) as { ok: boolean; sha: string }
    expect(commitBody.ok).toBe(true)

    const raw = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8")
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)

    const commitIdx = lines.findIndex((l) => l.type === "commit")
    const renameIdx = lines.findIndex(
      (l) => l.type === "edit" && l.kind === "rename_file",
    )
    expect(commitIdx).toBeGreaterThanOrEqual(0)
    expect(renameIdx).toBeGreaterThanOrEqual(0)
    // The rename's own line must precede the commit it was actually part of.
    expect(renameIdx).toBeLessThan(commitIdx)

    // And the consequence that matters: Renamed.ts's bytes really were
    // captured by this commit (git add -A swept them, since the rename
    // landed on disk before the commit ran), so the ledger must say so.
    const ledgerRes = await authedFetch("/api/editor/ledger")
    const { entries } = (await ledgerRes.json()) as {
      entries: { files: string[]; committed: boolean; sha?: string }[]
    }
    const renameEntry = entries.find((e) => e.files.includes("Renamed.ts"))
    expect(renameEntry).toBeDefined()
    expect(renameEntry?.committed).toBe(true)
    expect(renameEntry?.sha).toBe(commitBody.sha)
  })
})
