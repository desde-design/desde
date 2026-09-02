/**
 * P1-3 (whole-branch review finding, 2026-08-18): the ledger's `commit`
 * marker used to be appended AFTER `withTreeLock` released the exclusive
 * tree gate, not inside the same exclusive callback as `commitWorkingTree`
 * (see `handleBranchCommitRequest` in `../http-server.ts`).
 *
 * Why that mattered: an edit queued behind the tree lock resumes the
 * INSTANT the lock releases. With the marker appended outside the lock,
 * that queued edit could land and append its OWN `edit` line to the
 * ledger BEFORE the (now-late) `commit` line ever showed up — so in FILE
 * order, the post-commit edit's line came first and the commit's line
 * came second. `resolveCommitState` replays the ledger in file order and
 * treats a `commit` line as covering every edit pending SO FAR — so that
 * ordering swept an edit that was never part of the commit into it,
 * durably (the log is append-only; there is no later correction).
 *
 * This test constructs the exact interleaving over the REAL HTTP routes,
 * using two narrow mocks purely to make the race DETERMINISTIC rather
 * than hoping real disk-I/O timing cooperates (an earlier version of this
 * test, timed off `commitWorkingTree` alone, passed even with the bug
 * present — the edit route's own chain of work is long enough that the
 * OLD code's late `recordCommitInLedger` call almost always won anyway):
 *
 *   1. `commitWorkingTree` is wrapped only to SIGNAL once it's called —
 *      proof the exclusive tree lock is already held (it's acquired by
 *      `withTreeLock` before the callback runs) — never blocked.
 *   2. `appendLedgerEntry` is wrapped to BLOCK only the `commit`-type
 *      entry behind a test-controlled gate; every other entry (including
 *      the edit's own `edit` line) passes straight through unblocked.
 *
 * With the fix, `recordCommitInLedger` — and therefore this gate — sits
 * INSIDE `withTreeLock`'s callback, so the tree lock cannot release, and
 * the queued edit cannot even start its write, until the gate opens. With
 * the bug, the lock releases the moment `commitWorkingTree` returns —
 * long before the gate opens — so the queued edit's own write (and its
 * `edit` ledger line) completes while the `commit` line is still gated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const hooks = vi.hoisted(() => {
  let onCommitStart: (() => void) | null = null
  let commitLedgerGate: Promise<void> = Promise.resolve()
  return {
    setOnCommitStart(fn: (() => void) | null) {
      onCommitStart = fn
    },
    setCommitLedgerGate(p: Promise<void>) {
      commitLedgerGate = p
    },
    signalCommitStart() {
      onCommitStart?.()
    },
    awaitCommitLedgerGate() {
      return commitLedgerGate
    },
  }
})

// Signal-only — never blocks. Proves the exclusive tree lock is already
// held by the time `commitWorkingTree` runs (`withTreeLock` acquires it
// BEFORE invoking its callback), so a test that waits for this signal
// before firing a concurrent edit knows that edit can only queue, never
// race ahead of the commit for the tree gate.
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

// Gates ONLY the `commit`-type ledger entry. An `edit`-type entry (the
// concurrent edit's own append) passes straight through, unblocked — so
// whether the edit's line can land BEFORE the commit's line depends
// entirely on whether the fix keeps the tree lock held across this call,
// not on incidental real-disk-I/O timing.
vi.mock("../../../../src/editor/ledger/edit-ledger.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/editor/ledger/edit-ledger.js")>()
  return {
    ...actual,
    appendLedgerEntry: async (
      canonicalRoot: string,
      entry: Parameters<typeof actual.appendLedgerEntry>[1],
    ) => {
      if (entry.type === "commit") {
        await hooks.awaitCommitLedgerGate()
      }
      return actual.appendLedgerEntry(canonicalRoot, entry)
    },
  }
})

import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"

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
  hooks.setOnCommitStart(null)
  hooks.setCommitLedgerGate(Promise.resolve())

  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-commitledger-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-commitledger-repo-"))
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

describe("the ledger commit marker lands before a queued edit can race it", () => {
  it("a queued edit's own ledger line always follows the commit line it was blocked behind", async () => {
    // App.vue is dirty on disk — this is what the commit actually sweeps.
    await writeFile(join(repoDir, "App.vue"), "<template><h1>Pricing</h1></template>\n")

    const commitStarted = new Promise<void>((resolve) => {
      hooks.setOnCommitStart(resolve)
    })
    let releaseCommitLedgerGate: () => void = () => {}
    hooks.setCommitLedgerGate(
      new Promise<void>((resolve) => (releaseCommitLedgerGate = resolve)),
    )

    // Fire the commit. `commitWorkingTree` signals `commitStarted` the
    // instant it's invoked — which is AFTER `withTreeLock` has already
    // acquired the exclusive tree gate — then runs for real (unblocked).
    const commitPromise = authedFetch("/api/editor/branches/commit", {
      method: "POST",
      body: JSON.stringify({ message: "ship pricing copy" }),
    })
    await commitStarted

    // The tree lock is provably held now, so this edit — which needs the
    // (shared) file-edit lock on Other.ts — is provably QUEUED behind it,
    // not racing to land first. Not awaited: with the fix it cannot even
    // resolve until the gate below opens; with the bug it resolves almost
    // immediately (the tree lock releases as soon as `commitWorkingTree`
    // returns, unaffected by the gate).
    const editPromise = authedFetch("/api/editor/edit", {
      method: "POST",
      body: JSON.stringify({
        edit: { kind: "overwrite", file: "Other.ts", newSource: "export const x = 2\n" },
      }),
    })

    // Give the buggy code's path every chance to let the queued edit land
    // and append its OWN ledger line while the `commit` line is still
    // gated — poll for that `edit` line to actually show up (bounded),
    // rather than guessing a fixed delay. A cold process's first dynamic
    // `import()` inside the edit lane can genuinely take tens of ms, and a
    // short fixed delay let the bug pass this test by accident once
    // already (the edit hadn't gotten far enough yet to be caught either
    // way). The bound is what keeps a PASSING (fixed-code) run fast: the
    // edit's line never appears while gated, so we wait out the bound and
    // move on — the fixed code can't produce it early by construction.
    const pollDeadline = Date.now() + 2000
    while (Date.now() < pollDeadline) {
      const soFar = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8").catch(
        () => "",
      )
      if (soFar.includes('"Other.ts"')) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    releaseCommitLedgerGate()

    const [commitRes, editRes] = await Promise.all([commitPromise, editPromise])
    expect(commitRes.status).toBe(200)
    expect(editRes.status).toBe(200)
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
    // The load-bearing assertion: file order matches the git boundary.
    // Before the fix, `editIdx` lands before `commitIdx` — the queued
    // edit's own append races ahead of the (then out-of-lock) commit
    // marker, held gated behind it.
    expect(editIdx).toBeGreaterThan(commitIdx)

    // And the consequence that actually matters to a user: Other.ts's
    // edit must read as NOT committed by App.vue's commit — its bytes
    // were written to disk strictly after that commit ran.
    const ledgerRes = await authedFetch("/api/editor/ledger")
    const { entries } = (await ledgerRes.json()) as {
      entries: { files: string[]; committed: boolean; sha?: string }[]
    }
    const otherEntry = entries.find((e) => e.files[0] === "Other.ts")
    expect(otherEntry).toBeDefined()
    expect(otherEntry?.committed).toBe(false)
  })
})
