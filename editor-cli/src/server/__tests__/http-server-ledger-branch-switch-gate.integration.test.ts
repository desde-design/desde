/**
 * P1-2 (whole-branch review finding, round 6, 2026-08-19): the ledger
 * route used to resolve the checked-out branch, read the ledger, take a
 * `git status` snapshot, and reconcile — none of it inside any lock. A
 * branch switch (which runs under `withTreeLock`, EXCLUSIVE) landing
 * anywhere in that window could leave the reconcile call scoped to the
 * OLD branch name while the dirty-status snapshot it's checking against
 * already reflects the NEW checkout. If a pending edit recorded on the
 * old branch happened to read clean on the new branch's tree,
 * `reconcileLedger` would durably append a `committed: true` marker for
 * a reconcile that was never actually scoped to the branch it claims —
 * the log is append-only, so nothing later corrects it.
 *
 * The fix holds the repo's tree gate SHARED across the whole
 * branch-resolve → ledger-read → status-snapshot → reconcile sequence
 * (`acquireTreeGateShared`, `session-lock.ts`) — the same primitive
 * ordinary file edits already use. A branch switch/create/rename takes
 * that gate EXCLUSIVE, and an exclusive acquisition cannot even START
 * until every existing shared holder releases — so the branch cannot
 * move while this poll is reconciling.
 *
 * Rather than trying to race a second REAL concurrent HTTP request
 * against this one (timing-dependent, and the very thing the fix is
 * supposed to make impossible), this test makes the ledger GET pause
 * mid-flight (a controllable gate inside a mocked
 * `listDirtyRepoRelativePaths`) and inspects the lock module's own
 * internal state (`_inspectCliLocksForTests`, `session-lock.ts`) at that
 * exact pause point. If the GET is holding the tree gate, the key for
 * this repo appears in `gateKeys` — deterministic, no reliance on real
 * subprocess timing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const hooks = vi.hoisted(() => {
  let onPaused: (() => void) | null = null
  let gate: Promise<void> | null = null
  return {
    arm(onPausedCb: () => void) {
      onPaused = onPausedCb
      let release: () => void = () => {}
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
      return release
    },
    disarm() {
      onPaused = null
      gate = null
    },
    async signalPausedAndWait() {
      if (!gate) return
      onPaused?.()
      await gate
    },
  }
})

// Wraps the REAL `listDirtyRepoRelativePaths` so a test can pause the
// ledger route mid-flight, AFTER it has already resolved the branch and
// acquired whatever lock it takes, but BEFORE the status snapshot
// actually runs — exactly the window P1-2 is about. Every other export
// passes through untouched.
vi.mock("../../../../src/editor/worktree/git-branches.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/editor/worktree/git-branches.js")>()
  return {
    ...actual,
    listDirtyRepoRelativePaths: async (root: string) => {
      await hooks.signalPausedAndWait()
      return actual.listDirtyRepoRelativePaths(root)
    },
  }
})

import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import { _inspectCliLocksForTests } from "../session-lock.js"

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
  hooks.disarm()

  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgergate-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgergate-repo-"))
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
  hooks.disarm()
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

describe("P1-2 (round-6): the ledger GET holds the tree gate across its reconcile window", () => {
  it("holds the repo's tree gate while paused mid-status-snapshot, and releases it once done", async () => {
    let pausedResolve: () => void = () => {}
    const paused = new Promise<void>((resolve) => {
      pausedResolve = resolve
    })
    const release = hooks.arm(() => pausedResolve())

    const getPromise = authedFetch("/api/editor/ledger")

    // Wait until the route is paused mid-flight, inside the mocked
    // status call — i.e., past the point where the fix acquires the
    // gate, and before the point where it releases it.
    await paused

    // The load-bearing assertion. Before the fix, `handleLedgerRequest`
    // took no lock at all, so `gateKeys` would be empty here — a
    // concurrent branch switch could run to completion in this exact
    // window. After the fix, the GET is holding the tree gate SHARED,
    // so this repo's tree-gate key is present.
    const midFlight = _inspectCliLocksForTests()
    expect(midFlight.gateKeys).toContain(`tree:${repoDir}`)

    // Let the paused status call — and the rest of the route — finish.
    release()
    const res = await getPromise
    expect(res.status).toBe(200)

    // And the gate must not leak: once the request is fully done, the
    // key is gone (the gate is garbage-collected once idle — see
    // `gcGate` in session-lock.ts).
    const afterDone = _inspectCliLocksForTests()
    expect(afterDone.gateKeys).not.toContain(`tree:${repoDir}`)
  })
})
