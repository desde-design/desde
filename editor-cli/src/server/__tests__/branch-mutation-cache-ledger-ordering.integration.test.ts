/**
 * A3 + B3 (round-2 whole-branch review findings, 2026-08-19) —
 * `handleBranchMutationRequest` in `../http-server.ts`.
 *
 * A3: the branch-cache invalidation (and the rename ledger line, and the
 * shared-edit-history clear) used to run AFTER `withTreeLock` released the
 * exclusive tree gate, not inside the same exclusive callback as the
 * mutation itself (`switchBranch`/`createBranch`/`renameBranch`). An edit
 * queued behind that lock resumes the INSTANT the lock releases — with the
 * bug, that release happened BEFORE the cache was invalidated, so the
 * queued edit could read the STALE cached branch and permanently stamp its
 * ledger entry with the OLD branch name.
 *
 * B3: even with A3 fixed, a direct edit reaches `resolveBranchCached` with
 * `rootReal` — the REALPATH of the repo, computed internally by
 * `edit-handler.ts` — as its cache key. `handleBranchMutationRequest` was
 * invalidating only `ctx.repoRoot` (the possibly-unresolved path the CLI
 * was booted with). Those are DIFFERENT `Map` keys whenever the repo root
 * has a realpath divergence — which, on macOS, is the COMMON case: `/tmp`
 * (and `os.tmpdir()`'s `/var/folders/…`) resolve through `/private/…`.
 * Invalidating only one key left the other's stale entry to outlive the
 * mutation.
 *
 * Two tests, matching how the findings actually differ:
 *   - The A3 test uses a repo root that is ALREADY its own realpath (no
 *     divergence), so B3 cannot affect the result — it isolates the
 *     ordering question and reuses the round-1 gate/signal technique
 *     (see `http-server-commit-ledger-ordering.integration.test.ts`'s own
 *     header for why an untimed version of this shape of test can pass
 *     even with the bug present).
 *   - The B3 test deliberately uses a root with a real realpath divergence
 *     (unresolved `os.tmpdir()` path vs. its realpath) and needs no
 *     concurrency at all — it is a plain cache-key mismatch, reproducible
 *     with two sequential edits around one rename.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const hooks = vi.hoisted(() => {
  let onRenameStart: (() => void) | null = null
  let renameLedgerGate: Promise<void> = Promise.resolve()
  return {
    setOnRenameStart(fn: (() => void) | null) {
      onRenameStart = fn
    },
    setRenameLedgerGate(p: Promise<void>) {
      renameLedgerGate = p
    },
    signalRenameStart() {
      onRenameStart?.()
    },
    awaitRenameLedgerGate() {
      return renameLedgerGate
    },
  }
})

// Signal-only — never blocks. Fires once `renameBranch` actually runs,
// which `withTreeLock` guarantees is only after the exclusive tree gate
// has been granted.
vi.mock("../../../../src/editor/worktree/git-branches.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/editor/worktree/git-branches.js")>()
  return {
    ...actual,
    renameBranch: async (root: string, from: string, to: string) => {
      hooks.signalRenameStart()
      return actual.renameBranch(root, from, to)
    },
  }
})

// Gates ONLY the rename's own ledger line (`type: 'rename'`). A concurrent
// edit's `edit`-type append passes straight through, unblocked — so
// whether that edit can land its OWN line while this one is gated depends
// entirely on whether the fix keeps the exclusive tree gate held across
// this append (A3), not on incidental real-disk-I/O timing.
vi.mock("../../../../src/editor/ledger/edit-ledger.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/editor/ledger/edit-ledger.js")>()
  return {
    ...actual,
    appendLedgerEntry: async (
      canonicalRoot: string,
      entry: Parameters<typeof actual.appendLedgerEntry>[1],
    ) => {
      if (entry.type === "rename") {
        await hooks.awaitRenameLedgerGate()
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

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "editor-cli-branchcache-repo-"))
  await run("git", ["-C", dir, "init", "--initial-branch=main", "--quiet"])
  await run("git", ["-C", dir, "config", "user.email", "t@e.com"])
  await run("git", ["-C", dir, "config", "user.name", "T"])
  await run("git", ["-C", dir, "config", "commit.gpgsign", "false"])
  await writeFile(join(dir, "App.vue"), "<template><h1>Hi</h1></template>\n")
  await writeFile(join(dir, "Other.ts"), "export const x = 1\n")
  await run("git", ["-C", dir, "add", "App.vue", "Other.ts"])
  await run("git", ["-C", dir, "commit", "-m", "init", "--quiet"])
  await run("git", ["-C", dir, "checkout", "-b", "feature", "--quiet"])
  return dir
}

async function startServer(opts: {
  repoRoot: string
  repoRootReal?: string
}): Promise<{ handle: HttpServerHandle; token: string; shellOrigin: string }> {
  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-branchcache-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")
  const port = await pickFreePort()
  const origin = `http://127.0.0.1:${port}`
  const security = newSecurityContext(origin)
  const h = await startHttpServer({
    host: "127.0.0.1",
    port,
    repoRoot: opts.repoRoot,
    ...(opts.repoRootReal !== undefined ? { repoRootReal: opts.repoRootReal } : {}),
    uiBundleRoot: bundleDir,
    viteUrl: "http://localhost:5173",
    security,
    branchMode: true,
  })
  return { handle: h, token: security.token, shellOrigin: origin }
}

function authedFetch(
  h: HttpServerHandle,
  tok: string,
  origin: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${h.url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${tok}`,
      Origin: origin,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })
}

/**
 * `GET /api/editor/ledger`'s JSON response deliberately doesn't expose
 * `branch` (see `LedgerRow` in `../http-server.ts`) — it's an internal
 * field used only to DECIDE what's shown, not part of the row shape
 * itself. Read it from the raw JSONL instead, the same way the sibling
 * `sdk-write-guard-commit-ledger-race`/`structural-tool-commit-ledger-race`
 * tests read ordering off the raw file.
 */
async function readRawLedgerEntries(root: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(join(root, ".desde", "edit-log.jsonl"), "utf8").catch(() => "")
  return raw
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

beforeEach(() => {
  hooks.setOnRenameStart(null)
  hooks.setRenameLedgerGate(Promise.resolve())
})

afterEach(async () => {
  await handle?.close()
  await rm(bundleDir, { recursive: true, force: true }).catch(() => {})
  await rm(repoDir, { recursive: true, force: true }).catch(() => {})
  vi.clearAllMocks()
})

describe("A3 — branch mutation cleanup runs inside the exclusive tree gate", () => {
  it("an edit queued behind a rename cannot land its own ledger line until the rename's cleanup (including its own ledger line) has finished", async () => {
    // A root that is ALREADY its own realpath, so this test isolates A3's
    // ordering question from B3's cache-key question entirely. `realpath`
    // does NOT copy anything — `raw` and its realpath name the SAME
    // directory (e.g. via macOS's /var -> /private/var symlink), so we
    // simply use the resolved spelling as `repoRoot` from the start
    // rather than deleting either name (they're the same files on disk).
    repoDir = await realpath(await makeRepo())

    const started = await startServer({ repoRoot: repoDir })
    handle = started.handle
    token = started.token
    shellOrigin = started.shellOrigin

    // Gate the rename's own ledger line shut before firing it.
    let openGate: () => void = () => {}
    hooks.setRenameLedgerGate(new Promise<void>((resolve) => (openGate = resolve)))
    const renameStarted = new Promise<void>((resolve) => hooks.setOnRenameStart(resolve))

    const renamePromise = authedFetch(handle, token, shellOrigin, "/api/editor/branches/rename", {
      method: "POST",
      body: JSON.stringify({ name: "feature", to: "feature-v2" }),
    })
    await renameStarted

    // Queued behind the exclusive tree gate the rename holds.
    const editPromise = authedFetch(handle, token, shellOrigin, "/api/editor/edit", {
      method: "POST",
      body: JSON.stringify({
        edit: { kind: "overwrite", file: "Other.ts", newSource: "export const x = 2\n" },
      }),
    })

    // Give the buggy code's path every chance to let the queued edit land
    // while the rename's own ledger line is still gated. Always opens the
    // gate afterward (even on assertion failure below) so a failing run
    // doesn't ALSO hang `afterEach` on a server close that's waiting for
    // these still-gated in-flight requests to finish.
    const pollDeadline = Date.now() + 2000
    let editLandedEarly = false
    while (Date.now() < pollDeadline) {
      const soFar = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8").catch(
        () => "",
      )
      if (soFar.includes('"Other.ts"')) {
        editLandedEarly = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    openGate()
    // The load-bearing assertion: with the fix, the queued edit cannot
    // have landed yet — the exclusive gate the rename holds cannot
    // release until the gated ledger append (opened only above) has
    // completed, and the branch-cache invalidation runs (synchronously,
    // earlier in the same callback) before that append is even reached.
    expect(editLandedEarly).toBe(false)

    const [renameRes, editRes] = await Promise.all([renamePromise, editPromise])
    expect(renameRes.status).toBe(200)
    expect(editRes.status).toBe(200)

    const rawEntries = await readRawLedgerEntries(repoDir)
    const otherEntry = rawEntries.find(
      (e) => e.type === "edit" && (e.files as string[]).includes("Other.ts"),
    )
    expect(otherEntry).toBeDefined()
    // The queued edit resumed only after the rename's cleanup finished —
    // it must see the NEW branch, not a cache stamped with the OLD one.
    expect(otherEntry?.branch).toBe("feature-v2")
  })
})

describe("B3 — branch-cache invalidation covers both the raw and realpath'd root", () => {
  it("a direct edit right after a rename sees the new branch even when repoRoot and its realpath differ", async () => {
    const raw = await makeRepo()
    repoDir = raw
    const repoRootReal = await realpath(raw)
    if (repoRootReal === repoDir) {
      // This Mac's tmp path has no realpath divergence for once — the test
      // can't exercise B3 without one, so it's a no-op pass rather than a
      // false failure. (Not expected in this repo's normal CI/dev
      // environment — macOS's /tmp -> /private/tmp routinely produces one.)
      return
    }

    const started = await startServer({ repoRoot: repoDir, repoRootReal })
    handle = started.handle
    token = started.token
    shellOrigin = started.shellOrigin

    // Warm the branch cache under the REALPATH key — the same key a
    // direct edit's own `resolveBranchCached(rootReal)` call uses.
    const first = await authedFetch(handle, token, shellOrigin, "/api/editor/edit", {
      method: "POST",
      body: JSON.stringify({
        edit: { kind: "overwrite", file: "Other.ts", newSource: "export const x = 2\n" },
      }),
    })
    expect(first.status).toBe(200)

    const renameRes = await authedFetch(handle, token, shellOrigin, "/api/editor/branches/rename", {
      method: "POST",
      body: JSON.stringify({ name: "feature", to: "feature-v2" }),
    })
    expect(renameRes.status).toBe(200)

    // Immediately after (well within the 5s TTL) — a DIFFERENT file, so
    // this is a fresh ledger entry whose branch reflects whatever
    // `resolveBranchCached(rootReal)` returns right now.
    const second = await authedFetch(handle, token, shellOrigin, "/api/editor/edit", {
      method: "POST",
      body: JSON.stringify({
        edit: { kind: "overwrite", file: "App.vue", newSource: "<template><h1>Pricing</h1></template>\n" },
      }),
    })
    expect(second.status).toBe(200)

    const rawEntries = await readRawLedgerEntries(repoDir)
    const appEntry = rawEntries.find(
      (e) => e.type === "edit" && (e.files as string[]).includes("App.vue"),
    )
    expect(appEntry).toBeDefined()
    // Before the fix: the realpath key was never invalidated, so this
    // reads the STALE cached 'feature' even though the checked-out
    // branch is now 'feature-v2'.
    expect(appEntry?.branch).toBe("feature-v2")
  })
})
