/**
 * Residual risk closed 2026-08-19, on top of F1 (round-8 whole-branch
 * review finding, 2026-08-19 — see the sibling
 * `http-server-ledger-external-checkout-race.integration.test.ts`).
 *
 * F1's fix brackets the ledger route's status snapshot with a raw HEAD
 * read on each side (`readGitHeadRaw`) and skips reconciling when they
 * disagree. That helper used to read only `<repoRoot>/.git/HEAD`. When
 * `repoRoot` is itself a LINKED git worktree (`git worktree add`),
 * `.git` there is a FILE — `gitdir: <path>` — not a directory, so
 * `<repoRoot>/.git/HEAD` never exists and every read came back
 * `undefined`. Before this fix, `undefined === undefined` read as "HEAD
 * held still," so the guard was silently inert for exactly the checkout
 * shape this product's own repo uses (this branch is itself developed in
 * a linked worktree).
 *
 * This test reruns F1's race — an external `git checkout -b` landing
 * between the route's two fingerprint reads — but with `ctx.repoRoot`
 * pointed at a linked worktree instead of an ordinary checkout, so it
 * fails if `readGitHeadRaw` regresses to reading only the ordinary
 * `.git/HEAD` path.
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

// Same wrapping technique as the sibling non-worktree test: lets a test
// land an external `git checkout` in the exact window between the route's
// pre-snapshot HEAD fingerprint read and the real status snapshot.
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
let originRepoDir: string
let worktreeDir: string
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

  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerheadrace-wt-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  originRepoDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerheadrace-wt-origin-"))
  await run("git", ["-C", originRepoDir, "init", "--initial-branch=main", "--quiet"])
  await run("git", ["-C", originRepoDir, "config", "user.email", "t@e.com"])
  await run("git", ["-C", originRepoDir, "config", "user.name", "T"])
  await run("git", ["-C", originRepoDir, "config", "commit.gpgsign", "false"])
  await writeFile(join(originRepoDir, "App.vue"), "<template><h1>Hi</h1></template>\n")
  await run("git", ["-C", originRepoDir, "add", "App.vue"])
  await run("git", ["-C", originRepoDir, "commit", "-m", "init", "--quiet"])

  // The load-bearing setup: `ctx.repoRoot` for this test is a LINKED
  // worktree, not the main checkout — `git worktree add` creates the
  // target directory itself, so a path that doesn't exist yet is passed
  // rather than a pre-created one.
  const worktreeParent = await mkdtemp(join(tmpdir(), "editor-cli-ledgerheadrace-wt-parent-"))
  worktreeDir = join(worktreeParent, "wt")
  await run("git", [
    "-C",
    originRepoDir,
    "worktree",
    "add",
    worktreeDir,
    "-b",
    "wt-main",
    "--quiet",
  ])

  const port = await pickFreePort()
  shellOrigin = `http://127.0.0.1:${port}`
  const security = newSecurityContext(shellOrigin)
  token = security.token

  handle = await startHttpServer({
    host: "127.0.0.1",
    port,
    repoRoot: worktreeDir,
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
  await rm(worktreeDir, { recursive: true, force: true })
  await rm(originRepoDir, { recursive: true, force: true })
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

describe("residual risk (2026-08-19): the round-8 HEAD-race guard works inside a LINKED git worktree", () => {
  it("does not durably reconcile a pending entry when an external checkout lands mid-poll, inside the worktree", async () => {
    // Armed: fires from inside the mocked `listDirtyRepoRelativePaths`,
    // AFTER the route has already taken its "before" HEAD fingerprint.
    // This checkout runs INSIDE the worktree the server is watching —
    // exactly the layout where `readGitHeadRaw` used to read `undefined`
    // on both sides and silently treat that as "nothing moved."
    hooks.setOnBeforeStatus(async () => {
      await run("git", ["-C", worktreeDir, "checkout", "-b", "other", "--quiet"])
    })

    await appendLedgerEntry(worktreeDir, {
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
    // both branches, so the entry reads "clean" either way — without a
    // worktree-aware `readGitHeadRaw`, the guard can't see that HEAD
    // moved and reconciles anyway, durably marking this entry committed
    // even though it was never actually scoped to the branch the status
    // snapshot just measured.
    expect(entry?.committed).toBe(false)

    // And the append-only consequence: no `reconcile` line should exist
    // at all yet.
    const raw = await readFile(join(worktreeDir, ".desde", "edit-log.jsonl"), "utf8")
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.some((l) => l.type === "reconcile")).toBe(false)
  })

  it("the SAME entry reconciles normally on the next poll, once HEAD holds still", async () => {
    // No external checkout this time — HEAD does not move between the
    // two fingerprint reads, so the guard is a no-op and reconcile runs
    // exactly as it would in an ordinary (non-worktree) checkout.
    await appendLedgerEntry(worktreeDir, {
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
