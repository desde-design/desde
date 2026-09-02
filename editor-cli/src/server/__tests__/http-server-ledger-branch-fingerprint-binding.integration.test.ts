/**
 * F1 (round-10 whole-branch review finding, 2026-08-19): the round-8 fix
 * (`http-server-ledger-external-checkout-race.integration.test.ts`)
 * brackets the dirty-status snapshot with a raw `.git/HEAD` read on each
 * side and skips reconciling when they disagree. But the route built its
 * "before" fingerprint from a SEPARATE `readGitHeadRaw` call, made AFTER
 * both `branch = resolveBranchCached(...)` and a ledger read had already
 * run. That left a gap of its own: an external checkout landing between
 * resolving `branch` and that later fingerprint read moves HEAD somewhere
 * neither the "before" nor the "after" read can see happening — both end
 * up reading the NEW checkout, so they agree with each other, even though
 * `branch` still names the OLD one. The round-8 guard is a no-op here: it
 * only ever compares two reads that already both landed on the wrong side
 * of the checkout.
 *
 * The fix binds `branch` and the "before" fingerprint to the SAME
 * `resolveBranchCachedWithHead` read, so there is no window between them
 * left for a checkout to land in. This test makes the round-10 gap
 * deterministic by wrapping the real `readLedger` (called immediately
 * after branch resolution, and before the route's status snapshot) so
 * that, on its FIRST call only, a test hook performs a REAL
 * `git checkout -b` against the repo — landing exactly in the window this
 * round's fix closes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const hooks = vi.hoisted(() => {
  let onFirstReadLedger: (() => Promise<void>) | null = null
  return {
    armOnFirstReadLedger(fn: () => Promise<void>) {
      onFirstReadLedger = fn
    },
    // One-shot: the route reads the ledger a SECOND time after this
    // sequence's guarded section returns (to build the response rows).
    // Only the first call is inside the window this test is about — a
    // second checkout attempt on an already-checked-out branch would just
    // fail, so this fires at most once regardless of how many times
    // `readLedger` is called in a request.
    async fireOnce() {
      const fn = onFirstReadLedger
      onFirstReadLedger = null
      await fn?.()
    },
  }
})

// Wraps the REAL `readLedger` so a test can land an external `git
// checkout` in the exact window round 10 closes: AFTER the route resolves
// `branch`, but where the OLD code took its separate "before" HEAD
// fingerprint read. Every other export passes through untouched.
vi.mock("../../../../src/editor/ledger/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/editor/ledger/index.js")>()
  return {
    ...actual,
    readLedger: async (root: string) => {
      await hooks.fireOnce()
      return actual.readLedger(root)
    },
  }
})

import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import { appendLedgerEntry, hashContent } from "../../../../src/editor/ledger/index.js"

// `App.vue`'s content as written by `beforeEach` below — used to give the
// hand-built ledger entries a REAL `afterHashes` entry. `reconcileLedger`
// now requires positive evidence (HEAD's content genuinely matching the
// entry's own recorded hash), not just a clean working tree — an empty
// `afterHashes` can never satisfy that, regardless of how clean the file
// reads. See `edit-ledger.ts`'s `reconcileLedger` doc comment.
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
  hooks.armOnFirstReadLedger(async () => {})

  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerfpgap-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerfpgap-repo-"))
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
  hooks.armOnFirstReadLedger(async () => {})
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

describe("F1 (round-10): branch resolution and the reconcile fingerprint come from one read", () => {
  it("does not durably reconcile a pending entry when an external checkout lands between branch resolution and the ledger read", async () => {
    // Armed: fires the moment the route reads the ledger — which, on the
    // OLD code, ran BEFORE the route's own "before" HEAD fingerprint
    // read. This stands in for a `git checkout` typed in the user's own
    // terminal, or a second Editor process, landing in exactly that gap.
    hooks.armOnFirstReadLedger(async () => {
      await run("git", ["-C", repoDir, "checkout", "-b", "other", "--quiet"])
    })

    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "pending",
      at: new Date().toISOString(),
      kind: "prop",
      lane: "direct",
      branch: "main",
      files: ["App.vue"],
      afterHashes: { "App.vue": hashContent(APP_VUE_CONTENT) },
    })

    const ledgerRes = await authedFetch("/api/editor/ledger")
    expect(ledgerRes.status).toBe(200)
    const { entries } = (await ledgerRes.json()) as { entries: LedgerRow[] }
    const entry = entries.find((e) => e.id === "pending")
    expect(entry).toBeDefined()
    // The load-bearing assertion. App.vue is byte-identical to HEAD on
    // BOTH branches (nothing modified it), so the entry reads "clean"
    // regardless of which checkout the status snapshot measures.
    // Pre-fix, `branch` was resolved against `main` (before the checkout)
    // while both fingerprint reads landed on `other` (after it) and
    // therefore agreed with each other — so the guard passed and
    // `reconcileLedger` ran, durably marking this `main`-recorded entry
    // committed off a snapshot that was never actually scoped to `main`.
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
    // No external checkout this time — HEAD does not move at all during
    // the request, so the fix is a no-op and reconcile runs exactly as it
    // did before this round.
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "pending",
      at: new Date().toISOString(),
      kind: "prop",
      lane: "direct",
      branch: "main",
      files: ["App.vue"],
      afterHashes: { "App.vue": hashContent(APP_VUE_CONTENT) },
    })

    const ledgerRes = await authedFetch("/api/editor/ledger")
    expect(ledgerRes.status).toBe(200)
    const { entries } = (await ledgerRes.json()) as { entries: LedgerRow[] }
    expect(entries.find((e) => e.id === "pending")?.committed).toBe(true)
  })
})
