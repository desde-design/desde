/**
 * Regression coverage for audit Task 15 codex round-1 finding #2: the
 * post-commit retention sweep (`handleBranchCommitRequest` in
 * `http-server.ts`) was wired to `ctx.canonicalRoot` instead of
 * `ctx.repoRoot`. `.desde/` (backups, chat-sessions) lives under
 * the git ROOT (`repoRoot`) — in a monorepo subdirectory or the
 * editor-cli/self-host harness, `canonicalRoot` is a DIFFERENT,
 * deeper path. Passing the wrong root makes `gcBackups` ENOENT against
 * a directory nothing ever writes to and silently no-op — the whole
 * feature goes inert exactly where it matters (multi-root layouts).
 *
 * This test boots a real HTTP server with `repoRoot` and `canonicalRoot`
 * pointed at two DIFFERENT directories (proving the distinction isn't
 * just theoretical — `HttpServerOptions` allows it directly, same as a
 * monorepo boot would produce via `core.ts`'s `resolvePrototypeLocation`),
 * seeds a stale backup dir under `repoRoot` only, fires a real Commit,
 * and asserts the stale dir is gone — which only happens if the sweep
 * targeted `repoRoot`. Before the fix, this assertion would time out
 * (the sweep silently ENOENTs against `canonicalRoot`, which has no
 * `.desde/backups` at all).
 *
 * The sweep is fire-and-forget (`void runRetentionGc(...).catch(...)`,
 * Minor #1 of the same review round) so the HTTP response can return
 * before it finishes — the assertion below polls rather than checking
 * immediately after the fetch resolves.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"

const run = promisify(execFile)

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let canonicalDir: string
let token: string
let shellOrigin: string

beforeEach(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-commitgc-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  // repoDir is the git ROOT (a real repo, so `commitWorkingTree` can
  // actually succeed). canonicalDir is a SEPARATE path — simulating a
  // monorepo layout where the user-supplied path (canonicalRoot) is a
  // subdirectory of, or otherwise distinct from, the git root
  // (repoRoot). It deliberately has NO `.desde/` tree at all.
  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-commitgc-repo-"))
  await run("git", ["-C", repoDir, "init", "--initial-branch=main", "--quiet"])
  await run("git", ["-C", repoDir, "config", "user.email", "t@e.com"])
  await run("git", ["-C", repoDir, "config", "user.name", "T"])
  await run("git", ["-C", repoDir, "config", "commit.gpgsign", "false"])
  await writeFile(join(repoDir, "a.txt"), "a\n")
  await run("git", ["-C", repoDir, "add", "a.txt"])
  await run("git", ["-C", repoDir, "commit", "-m", "init", "--quiet"])

  canonicalDir = await mkdtemp(join(tmpdir(), "editor-cli-commitgc-canonical-"))

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
})

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

/** Seed a stale (30-day-old) backup dir under `root/.desde/backups/<name>`. */
async function seedStaleBackupDir(root: string, name: string): Promise<string> {
  const dir = join(root, ".desde", "backups", name)
  await mkdir(dir, { recursive: true })
  const file = join(dir, "original.vue")
  await writeFile(file, "<template></template>\n")
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  await utimes(dir, thirtyDaysAgo, thirtyDaysAgo)
  return dir
}

async function pathExists(p: string): Promise<boolean> {
  const { access } = await import("node:fs/promises")
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** Poll for a condition — the post-commit sweep is fire-and-forget. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`)
}

describe("POST /api/editor/branches/commit — retention sweep targets repoRoot, not canonicalRoot", () => {
  it("prunes a stale backup dir under repoRoot after a successful commit", async () => {
    const staleDir = await seedStaleBackupDir(repoDir, "2020-01-01_00-00-00-000-stale")
    expect(await pathExists(staleDir)).toBe(true)

    // Make an uncommitted change so the commit actually has something
    // to commit (a clean-tree commit fails before the GC sweep runs).
    await writeFile(join(repoDir, "a.txt"), "a\nb\n")

    const res = await authedFetch("/api/editor/branches/commit", {
      method: "POST",
      body: JSON.stringify({ message: "test commit" }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean }
    expect(json.ok).toBe(true)

    // Regression: before the fix, the sweep ran against canonicalDir
    // (which has no `.desde/backups` at all) and silently
    // no-op'd — this would time out.
    await waitFor(async () => !(await pathExists(staleDir)))
  })

  it("never creates or touches a .desde tree under canonicalRoot", async () => {
    await seedStaleBackupDir(repoDir, "2020-01-01_00-00-00-000-stale")
    await writeFile(join(repoDir, "a.txt"), "a\nb\n")

    await authedFetch("/api/editor/branches/commit", {
      method: "POST",
      body: JSON.stringify({ message: "test commit" }),
    })

    // Give the fire-and-forget sweep time to run (same window the
    // positive assertion above polls within).
    await new Promise((r) => setTimeout(r, 200))
    expect(await pathExists(join(canonicalDir, ".desde"))).toBe(false)
  })
})
