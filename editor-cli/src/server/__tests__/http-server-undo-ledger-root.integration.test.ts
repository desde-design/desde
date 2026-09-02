/**
 * P2-2 (whole-branch review finding, 2026-08-18): the undo/redo route
 * (`handleHistoryRequest` in `../http-server.ts`) passed `ctx.canonicalRoot`
 * as `EditorEditHistory.applyTop`'s `canonicalRoot`, while every other
 * ledger producer/consumer — ordinary edits (`applyEdit`'s `rootReal`) and
 * `GET /api/editor/ledger` itself — agrees on `ctx.repoRoot`.
 * `canonicalRoot` is passed straight through to `brokeredWrite`, which uses
 * it for BOTH the backup journal AND the edit-ledger append, so in a
 * monorepo subdirectory (where `canonicalRoot` is a different, deeper path
 * than the git root) undo/redo's own writes landed under the WRONG
 * `.desde/` tree and never showed up in the repository ledger.
 *
 * Sibling test to `http-server-commit-retention-gc.integration.test.ts`,
 * which proved the identical `repoRoot`-vs-`canonicalRoot` confusion for
 * the retention sweep — same harness shape (a real HTTP server booted with
 * `repoRoot` and `canonicalRoot` pointed at two DIFFERENT directories).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import { resetSharedEditHistoryForTests } from "../../../../src/editor/edit-service/edit-history.js"

const run = promisify(execFile)

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let canonicalDir: string
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  resetSharedEditHistoryForTests()

  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-undoledger-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  // repoDir is the git ROOT — a real repo, so the edit + undo round trip
  // is genuine. canonicalDir is a SEPARATE path with NO `.desde/`
  // tree at all, simulating a monorepo layout where Editor is opened at a
  // package below the git root (same construction as the retention-GC
  // sibling test).
  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-undoledger-repo-"))
  await run("git", ["-C", repoDir, "init", "--initial-branch=main", "--quiet"])
  await run("git", ["-C", repoDir, "config", "user.email", "t@e.com"])
  await run("git", ["-C", repoDir, "config", "user.name", "T"])
  await run("git", ["-C", repoDir, "config", "commit.gpgsign", "false"])
  await writeFile(join(repoDir, "util.ts"), "export const x = 1\n")
  await run("git", ["-C", repoDir, "add", "util.ts"])
  await run("git", ["-C", repoDir, "commit", "-m", "init", "--quiet"])

  canonicalDir = await mkdtemp(join(tmpdir(), "editor-cli-undoledger-canonical-"))

  const port = await pickFreePort()
  shellOrigin = `http://127.0.0.1:${port}`
  const security = newSecurityContext(shellOrigin)
  token = security.token

  handle = await startHttpServer({
    host: "127.0.0.1",
    port,
    repoRoot: repoDir,
    canonicalRoot: canonicalDir,
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
  await rm(canonicalDir, { recursive: true, force: true })
  resetSharedEditHistoryForTests()
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

describe("undo writes its ledger + backup entries under repoRoot, not canonicalRoot", () => {
  it("undo lands its own ledger line under repoRoot and GET /api/editor/ledger sees it", async () => {
    // A real edit — this is what pushes an undoable step onto the shared
    // history stack AND writes the FIRST `edit` line to the repository
    // ledger under repoDir.
    const editRes = await authedFetch("/api/editor/edit", {
      method: "POST",
      body: JSON.stringify({
        edit: { kind: "overwrite", file: "util.ts", newSource: "export const x = 2\n" },
      }),
    })
    expect(editRes.status).toBe(200)

    const ledgerAfterEdit = await readFile(
      join(repoDir, ".desde", "edit-log.jsonl"),
      "utf8",
    )
    expect(ledgerAfterEdit.trim().split("\n")).toHaveLength(1)

    const undoRes = await authedFetch("/api/editor/history/undo", { method: "POST" })
    expect(undoRes.status).toBe(200)
    const undoBody = (await undoRes.json()) as { ok: boolean }
    expect(undoBody.ok).toBe(true)

    // Regression: before the fix, undo's own backup journal + ledger
    // append ran against `canonicalRoot`, so this second line never
    // landed under repoDir at all.
    const ledgerAfterUndo = await readFile(
      join(repoDir, ".desde", "edit-log.jsonl"),
      "utf8",
    )
    const lines = ledgerAfterUndo
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatchObject({ type: "edit", kind: "undo", lane: "undo" })

    // The consequence a user actually sees: the read route (which uses
    // ctx.repoRoot) must show the undo entry too.
    const ledgerRouteRes = await authedFetch("/api/editor/ledger")
    const { entries } = (await ledgerRouteRes.json()) as {
      entries: { kind: string; lane: string }[]
    }
    expect(entries.some((e) => e.kind === "undo" && e.lane === "undo")).toBe(true)

    // And canonicalRoot must never have grown a `.desde/` tree at all
    // — undo's writes never touched it, in either direction.
    expect(await pathExists(join(canonicalDir, ".desde"))).toBe(false)
  })
})
