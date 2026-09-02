/**
 * `GET /api/editor/ledger` — the edit ledger's read endpoint.
 *
 * Harness copied from `http-server-lock-events.integration.test.ts`, the
 * established pattern for booting `http-server` against a temp repo.
 * `repoDir` here is a BARE temp directory with no git repo, so
 * `resolveBranchCached` returns `undefined` — which is why a seeded entry
 * with no `branch` recorded is still returned unconditionally: the route
 * cannot prove it is foreign.
 * (`http-server-ledger-commit.integration.test.ts` covers the route
 * against a REAL git repo, including the commit-site write path and the
 * untracked-directory / cross-branch reconcile guards.)
 *
 * `listDirtyRepoRelativePaths` (what the route's reconcile step now uses
 * to decide what's dirty — whole-branch review, 2026-08-18) THROWS on a
 * non-git directory, unlike the old `listWorkingTreeChanges`-based dirty
 * check, which silently returned `[]` here and let reconcile read every
 * pending edit as clean. Before that fix, EVERY GET against this bare
 * `repoDir` durably reconciled its seeded pending entries as
 * "committed": true. The route now catches the failure and skips
 * reconcile for that poll instead — see the "no git repo → reconcile is
 * skipped, not falsely-clean" case below.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile, appendFile, mkdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import { appendLedgerEntry, ledgerPath } from "../../../../src/editor/ledger/index.js"

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let token: string
let origin: string

async function pickFreePort(): Promise<number> {
  const net = await import("node:net")
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      server.close(() => resolve(port))
    })
  })
}

beforeEach(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")
  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-repo-"))

  const port = await pickFreePort()
  origin = `http://127.0.0.1:${port}`
  const security = newSecurityContext(origin)
  token = security.token

  handle = await startHttpServer({
    host: "127.0.0.1",
    port,
    repoRoot: repoDir,
    uiBundleRoot: bundleDir,
    viteUrl: "http://localhost:5173",
    security,
  })
})

afterEach(async () => {
  await handle.close()
  await rm(bundleDir, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
})

function get(path: string) {
  return fetch(`${origin}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Origin: origin },
  })
}

describe("GET /api/editor/ledger", () => {
  it("returns an empty list for a repo with no edits", async () => {
    const res = await get("/api/editor/ledger")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ entries: [] })
  })

  it("renders a description and commit state for each edit", async () => {
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e1",
      at: "2026-08-18T10:00:00.000Z",
      kind: "prop",
      lane: "direct",
      files: ["src/App.vue"],
      afterHashes: { "src/App.vue": "abc" },
      fields: { propName: "title", value: "Pricing" },
    })
    await appendLedgerEntry(repoDir, {
      type: "commit",
      at: "2026-08-18T10:01:00.000Z",
      sha: "deadbeef",
      message: "wip",
      committedIds: ["e1"],
    })

    const res = await get("/api/editor/ledger")
    const body = (await res.json()) as { entries: Array<Record<string, unknown>> }
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0]).toMatchObject({
      id: "e1",
      description: 'title = "Pricing"',
      committed: true,
      sha: "deadbeef",
      afterHashes: { "src/App.vue": "abc" },
    })
  })

  it("refuses without the bearer token", async () => {
    const res = await fetch(`${origin}/api/editor/ledger`, { headers: { Origin: origin } })
    expect(res.status).toBe(401)
  })

  it("does not 500 on a malformed-but-typed entry, and drops it from the response", async () => {
    // A line that parses and carries a recognised `type` but is missing
    // the fields a real entry always has — the shape a torn append can
    // leave behind (`{"type":"edit"}` is valid, complete JSON). Written
    // directly to the file since `appendLedgerEntry` only accepts a
    // properly-typed `LedgerEntry` and cannot construct this by
    // construction. `readLedger`'s validation is what should catch this
    // before it ever reaches `describeLedgerEntry` (which reads
    // `entry.files[0]` unconditionally and would throw on it).
    await mkdir(join(repoDir, ".desde"), { recursive: true })
    await appendFile(ledgerPath(repoDir), '{"type":"edit"}\n', "utf8")
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e1",
      at: "2026-08-18T10:00:00.000Z",
      kind: "prop",
      lane: "direct",
      files: ["src/App.vue"],
      afterHashes: { "src/App.vue": "abc" },
      fields: { propName: "title", value: "Pricing" },
    })

    const res = await get("/api/editor/ledger")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: Array<Record<string, unknown>> }
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0]).toMatchObject({ id: "e1" })
  })

  // F5 (codex review round 4, 2026-08-20): the design spec's horizon —
  // ledger entries since the second-most-recent commit line, plus every
  // dirty path — was never implemented. This drives it directly: three
  // "commit generations" (no branch recorded on any entry, so
  // `editBelongsToBranch` treats every one of them as eligible on this
  // bare, branch-less repo — the horizon logic itself doesn't need a real
  // git checkout to exercise).
  it("shows entries since the second-most-recent commit, plus every still-pending edit, and trims older committed history", async () => {
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "old1",
      at: "2026-08-18T09:00:00.000Z",
      kind: "prop",
      lane: "direct",
      files: ["src/Old.vue"],
      afterHashes: { "src/Old.vue": "h1" },
    })
    await appendLedgerEntry(repoDir, {
      type: "commit",
      at: "2026-08-18T09:01:00.000Z",
      sha: "sha1",
      message: "first",
      committedIds: ["old1"],
    })
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "mid1",
      at: "2026-08-18T10:00:00.000Z",
      kind: "prop",
      lane: "direct",
      files: ["src/Mid.vue"],
      afterHashes: { "src/Mid.vue": "h2" },
    })
    await appendLedgerEntry(repoDir, {
      type: "commit",
      at: "2026-08-18T10:01:00.000Z",
      sha: "sha2",
      message: "second",
      committedIds: ["mid1"],
    })
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "new1",
      at: "2026-08-18T11:00:00.000Z",
      kind: "prop",
      lane: "direct",
      files: ["src/New.vue"],
      afterHashes: { "src/New.vue": "h3" },
    })
    await appendLedgerEntry(repoDir, {
      type: "commit",
      at: "2026-08-18T11:01:00.000Z",
      sha: "sha3",
      message: "third",
      committedIds: ["new1"],
    })
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "pending1",
      at: "2026-08-18T12:00:00.000Z",
      kind: "prop",
      lane: "direct",
      files: ["src/Pending.vue"],
      afterHashes: { "src/Pending.vue": "h4" },
    })

    const res = await get("/api/editor/ledger")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: Array<{ id: string }> }
    const ids = body.entries.map((e) => e.id)

    // "sha3" is the most recent commit; "sha2" is the second-most-recent —
    // the horizon starts right after sha2's commit line. `mid1` (covered
    // BY sha2 itself) and `old1`/`sha1` (before it) fall out of horizon.
    // `new1` (the batch the horizon exists to keep visible right after a
    // commit) and the still-pending edit both stay — newest first.
    expect(ids).toEqual(["pending1", "new1"])
    expect(ids).not.toContain("mid1")
    expect(ids).not.toContain("old1")
  })

  // Companion to the horizon test above: the horizon must never trim a
  // PENDING entry, no matter how far back it was appended — only already-
  // COMMITTED history is bounded. A dirty file silently dropped from the
  // panel is the exact lie this whole feature exists to prevent.
  it("never trims a still-pending edit from the horizon, however old it is relative to later commits", async () => {
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "ancient-pending",
      at: "2026-08-18T08:00:00.000Z",
      kind: "prop",
      lane: "direct",
      files: ["src/NeverCommitted.vue"],
      afterHashes: { "src/NeverCommitted.vue": "h0" },
    })
    for (let i = 0; i < 3; i++) {
      await appendLedgerEntry(repoDir, {
        type: "edit",
        id: `c${i}`,
        at: `2026-08-18T09:0${i}:00.000Z`,
        kind: "prop",
        lane: "direct",
        files: [`src/C${i}.vue`],
        afterHashes: { [`src/C${i}.vue`]: `h${i}` },
      })
      await appendLedgerEntry(repoDir, {
        type: "commit",
        at: `2026-08-18T09:0${i}:30.000Z`,
        sha: `sha-c${i}`,
        message: `commit ${i}`,
        committedIds: [`c${i}`],
      })
    }

    const res = await get("/api/editor/ledger")
    const body = (await res.json()) as { entries: Array<{ id: string; committed: boolean }> }
    const ancient = body.entries.find((e) => e.id === "ancient-pending")
    expect(ancient).toBeDefined()
    expect(ancient?.committed).toBe(false)
  })

  it("no git repo -> reconcile is skipped, not falsely-clean (a pending edit with no commit stays pending)", async () => {
    // `repoDir` has no `.git` at all, so the dirty-check `git status` call
    // fails outright. Before the fix, the route's dirty check silently
    // treated that failure the same as "nothing is dirty" (`[]`), and
    // reconcile read every file as clean — this exact entry, on the very
    // first GET, was durably marked "committed": true despite no commit
    // ever happening.
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e1",
      at: "2026-08-18T10:00:00.000Z",
      kind: "prop",
      lane: "direct",
      files: ["src/App.vue"],
      afterHashes: { "src/App.vue": "abc" },
      fields: { propName: "title", value: "Pricing" },
    })

    const res = await get("/api/editor/ledger")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: Array<Record<string, unknown>> }
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0]).toMatchObject({ id: "e1", committed: false })

    const raw = await readFile(ledgerPath(repoDir), "utf8")
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.some((l) => l.type === "reconcile")).toBe(false)
  })
})
