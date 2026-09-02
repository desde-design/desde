/**
 * A1 (round-2 whole-branch review finding, 2026-08-19): `createSdkWriteGuard`'s
 * `release` callback (`../../../../src/editor/agent-chat-sdk/sdk-write-guard.ts`)
 * used to call `finishToolUse` BEFORE awaiting `recordLedgerEntry` — i.e. it
 * released the repo's SHARED tree gate before the ledger append for the
 * write it just released had actually landed.
 *
 * Why that mattered: `finishToolUse` releases the per-file mutex it holds
 * via the injected `acquireWriteLock` (production wires this to
 * `acquireFileEditLock` in `../session-lock.ts`), which is the SAME shared
 * tree gate `withTreeLock` (Commit, Publish, branch switch/create/rename)
 * needs EXCLUSIVELY. A chat Write/Edit's actual bytes land on disk as part
 * of the SDK's own tool execution — strictly BEFORE `release`/`PostToolUse`
 * fires — so by the time `release` runs, a queued Commit only needs the
 * shared gate to free up to run `git add -A` and capture those bytes for
 * real. Releasing the gate before the ledger append finished let that
 * queued Commit run to completion — including appending its OWN `commit`
 * line (already inside its own critical section per the P1-3 fix) — WHILE
 * this write's `edit` line was still in flight. The commit line then
 * precedes the edit line in the append-only log, and `resolveCommitState`
 * reads the log in order: an edit line arriving after the commit that
 * actually covered its bytes reads as uncommitted forever.
 *
 * This drives the REAL locking primitives end to end: the real
 * `acquireFileEditLock`/`withTreeLock` from `../session-lock.ts`, the real
 * `createSdkWriteGuard` hooks (no SDK runtime needed — same technique
 * `sdk-write-guard.test.ts` uses), and the real `/api/editor/branches/commit`
 * HTTP route. Two narrow mocks make the race deterministic rather than
 * hoping real disk-I/O timing cooperates (see the sibling
 * `http-server-commit-ledger-ordering.integration.test.ts`'s own header for
 * why an untimed version of this shape of test can pass even with the bug
 * present):
 *
 *   1. `commitWorkingTree` is wrapped only to SIGNAL once called — proof the
 *      exclusive tree gate has actually been GRANTED to the commit, i.e.
 *      every earlier shared holder (our simulated chat write) has released.
 *      Never blocked.
 *   2. `appendLedgerEntry` is wrapped to gate ONLY the write guard's own
 *      `edit`-type entry for `Other.ts`; the commit's `commit`-type entry
 *      passes straight through unblocked. This is the OPPOSITE selectivity
 *      from the P1-3 test, because A1 is testing the opposite half of the
 *      same ordering contract: here we're proving the shared gate CANNOT
 *      release (so Commit cannot even start) until this append finishes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { HookInput } from "@anthropic-ai/claude-agent-sdk"

const hooks = vi.hoisted(() => {
  let onCommitStart: (() => void) | null = null
  let editLedgerGate: Promise<void> = Promise.resolve()
  return {
    setOnCommitStart(fn: (() => void) | null) {
      onCommitStart = fn
    },
    setEditLedgerGate(p: Promise<void>) {
      editLedgerGate = p
    },
    signalCommitStart() {
      onCommitStart?.()
    },
    awaitEditLedgerGate() {
      return editLedgerGate
    },
  }
})

// Signal-only — never blocks. Fires only once the exclusive tree gate has
// actually been granted to the commit (every shared holder, including our
// simulated chat write, has released) — `withTreeLock` acquires it BEFORE
// invoking this callback.
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

// Gates ONLY the write guard's own `edit`-type entry for Other.ts. The
// commit's `commit`-type entry passes straight through, unblocked — so
// whether the commit can even START (which needs the shared gate this
// write holds to fully release) depends entirely on whether the fix keeps
// that gate held across this append, not on incidental real-disk-I/O
// timing.
vi.mock("../../../../src/editor/ledger/edit-ledger.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/editor/ledger/edit-ledger.js")>()
  return {
    ...actual,
    appendLedgerEntry: async (
      canonicalRoot: string,
      entry: Parameters<typeof actual.appendLedgerEntry>[1],
    ) => {
      if (entry.type === "edit" && entry.files.includes("Other.ts")) {
        await hooks.awaitEditLedgerGate()
      }
      return actual.appendLedgerEntry(canonicalRoot, entry)
    },
  }
})

import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import { acquireFileEditLock } from "../session-lock.js"
import { createSdkWriteGuard } from "../../../../src/editor/agent-chat-sdk/sdk-write-guard.js"
import type { HistoryRecorder } from "../../../../src/editor/agent-chat-sdk/write-broker.js"

const run = promisify(execFile)

const HOOK_OPTS = { signal: new AbortController().signal }

function preToolUse(toolName: string, toolInput: unknown, toolUseId = "tu-1"): HookInput {
  return {
    hook_event_name: "PreToolUse",
    session_id: "test-session",
    transcript_path: "/dev/null",
    cwd: "/",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  } as HookInput
}

function terminal(event: "PostToolUse", toolUseId = "tu-1"): HookInput {
  return {
    hook_event_name: event,
    session_id: "test-session",
    transcript_path: "/dev/null",
    cwd: "/",
    tool_name: "Write",
    tool_input: {},
    tool_use_id: toolUseId,
    tool_response: {},
  } as HookInput
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
  hooks.setEditLedgerGate(Promise.resolve())

  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-sdkrace-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-sdkrace-repo-"))
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

describe("a chat write's ledger line lands before it releases the tree gate a queued commit needs", () => {
  it("a commit queued behind an in-flight chat write cannot start until the write's own ledger append finishes", async () => {
    // App.vue is already dirty on disk before either lane touches
    // anything — the commit has something real to sweep even independent
    // of the race.
    await writeFile(join(repoDir, "App.vue"), "<template><h1>Pricing</h1></template>\n")

    const history: HistoryRecorder = { record: async () => {} }
    const guard = createSdkWriteGuard({
      worktreeRoot: repoDir,
      history,
      acquireWriteLock: (repoRelPath: string) => acquireFileEditLock(repoDir, repoRelPath),
    })

    // 1. Start the simulated chat write for Other.ts. `preToolUse` acquires
    //    the real shared tree gate + per-file mutex — awaited here, so by
    //    the time this resolves the gate is provably HELD.
    await guard.preToolUse(preToolUse("Write", { file_path: "Other.ts" }), "tu-1", HOOK_OPTS)
    // The SDK's own tool execution writes the new bytes BEFORE PostToolUse
    // fires — this is the real ordering `sdk-write-guard.ts` documents.
    await writeFile(join(repoDir, "Other.ts"), "export const x = 2\n", "utf8")

    // Gate this write's own ledger append shut before releasing it.
    let openEditLedgerGate: () => void = () => {}
    hooks.setEditLedgerGate(new Promise<void>((resolve) => (openEditLedgerGate = resolve)))

    const commitStarted = new Promise<void>((resolve) => {
      hooks.setOnCommitStart(resolve)
    })

    // 2. Fire `release` (PostToolUse) — NOT awaited: with the fix it
    //    cannot resolve until the gate above opens (it awaits
    //    `recordLedgerEntry` before calling `finishToolUse`); with the bug
    //    it resolves almost immediately (`finishToolUse` ran first,
    //    unaffected by the gate).
    const releasePromise = guard.release(terminal("PostToolUse"), "tu-1", HOOK_OPTS)

    // 3. Fire the commit. It needs the EXCLUSIVE tree gate, which this
    //    write still (with the fix) or no longer (with the bug) holds.
    const commitPromise = authedFetch("/api/editor/branches/commit", {
      method: "POST",
      body: JSON.stringify({ message: "ship pricing copy" }),
    })

    // Give the buggy code's path every chance to let the commit start
    // while our write's own ledger line is still gated — poll (bounded)
    // rather than guessing a fixed delay, matching the sibling P1-3 test's
    // own reasoning for why a fixed delay is unreliable here.
    let commitStartedEarly = false
    const raceObserver = commitStarted.then(() => {
      commitStartedEarly = true
    })
    await Promise.race([raceObserver, new Promise((r) => setTimeout(r, 300))])

    // The load-bearing assertion: with the fix, the commit could NOT have
    // started yet — the shared gate this write holds cannot release until
    // the gated ledger append (opened only below) completes.
    expect(commitStartedEarly).toBe(false)

    openEditLedgerGate()
    await releasePromise
    await commitStarted
    const [commitRes, editRes] = await Promise.all([commitPromise, Promise.resolve()])
    void editRes
    expect(commitRes.status).toBe(200)
    const commitBody = (await commitRes.json()) as { ok: boolean; sha: string }
    expect(commitBody.ok).toBe(true)

    const raw = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8")
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)

    const commitIdx = lines.findIndex((l) => l.type === "commit")
    const editIdx = lines.findIndex(
      (l) => l.type === "edit" && (l.files as string[])[0] === "Other.ts",
    )
    expect(commitIdx).toBeGreaterThanOrEqual(0)
    expect(editIdx).toBeGreaterThanOrEqual(0)
    // The write's own line must precede the commit it was actually part
    // of — the ordering the whole fix exists to guarantee.
    expect(editIdx).toBeLessThan(commitIdx)

    // And the consequence that actually matters: Other.ts's bytes really
    // were captured by this commit (git add -A swept them, since they
    // were on disk before the commit ran), so the ledger must say so.
    const ledgerRes = await authedFetch("/api/editor/ledger")
    const { entries } = (await ledgerRes.json()) as {
      entries: { files: string[]; committed: boolean; sha?: string }[]
    }
    const otherEntry = entries.find((e) => e.files[0] === "Other.ts")
    expect(otherEntry).toBeDefined()
    expect(otherEntry?.committed).toBe(true)
    expect(otherEntry?.sha).toBe(commitBody.sha)
  })
})
