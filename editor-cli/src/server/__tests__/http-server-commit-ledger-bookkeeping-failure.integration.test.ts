/**
 * P1-1 (REGRESSION from round 5, whole-branch review finding, round 6,
 * 2026-08-19): `recordCommitInLedger` (`http-server.ts`) computes an
 * `excludedIds` list for the `commit` ledger marker by calling
 * `listDirtyRepoRelativePaths` — a function that THROWS BY DESIGN on a
 * git failure (round 3), so `reconcileLedger` can tell "git failed" from
 * "nothing dirty." Round 5's F1 fix started calling that same throwing
 * function on the COMMIT path, AFTER `commitWorkingTree` had already
 * created a real, durable git commit.
 *
 * Before this round's fix: a plausible git hiccup (a big `git status`
 * exceeding Node's default `maxBuffer`, say) would propagate out of
 * `recordCommitInLedger`, out of the `withTreeLock` callback at all
 * three call sites (Commit button, Push, Create-PR), and into the
 * route's top-level 500 handler — reporting a commit that is ALREADY
 * SITTING IN THE USER'S REPO as a failure, and aborting Push/Create-PR
 * before they push. The commit ledger marker being lost is real but a
 * much smaller harm than reporting a successful commit as failed.
 *
 * This test forces `listDirtyRepoRelativePaths` to throw (mocked,
 * mirroring the sibling `http-server-ledger-reconcile-after-commit-race`
 * test's own reasoning for a narrow mock over trying to make a real
 * `git status` blow its buffer deterministically) and proves the commit
 * itself is still reported as a success, with the real sha, and that
 * Push still reaches `pushToOrigin` rather than aborting first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const hooks = vi.hoisted(() => {
  let throwing = false
  return {
    setThrowing(v: boolean) {
      throwing = v
    },
    isThrowing() {
      return throwing
    },
  }
})

// Wraps the REAL `listDirtyRepoRelativePaths` so a test can force it to
// throw exactly as it does on a genuine git failure (round 3's own
// deliberate design). Every other export, including `commitWorkingTree`
// and `pushToOrigin`, passes through untouched.
vi.mock("../../../../src/editor/worktree/git-branches.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/editor/worktree/git-branches.js")>()
  return {
    ...actual,
    listDirtyRepoRelativePaths: async (root: string) => {
      if (hooks.isThrowing()) {
        throw new Error("stdout maxBuffer length exceeded")
      }
      return actual.listDirtyRepoRelativePaths(root)
    },
  }
})

import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import { appendLedgerEntry, hashContent } from "../../../../src/editor/ledger/index.js"

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
  hooks.setThrowing(false)

  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-commitbookkeeping-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-commitbookkeeping-repo-"))
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

describe("P1-1 (round-6): a commit ledger-bookkeeping failure must not fail the commit", () => {
  it("POST /api/editor/branches/commit still reports success with a real sha when the exclusion-list git call throws", async () => {
    const newContent = "<template><h1>Pricing</h1></template>\n"
    await writeFile(join(repoDir, "App.vue"), newContent)
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e1",
      at: new Date().toISOString(),
      kind: "prop",
      lane: "direct",
      files: ["App.vue"],
      afterHashes: { "App.vue": hashContent(newContent) },
      fields: { propName: "title", value: "Pricing" },
    })

    hooks.setThrowing(true)

    const commitRes = await authedFetch("/api/editor/branches/commit", {
      method: "POST",
      body: JSON.stringify({ message: "ship pricing copy" }),
    })
    // The load-bearing assertion. Before the fix this was a 500 —
    // `recordCommitInLedger`'s unguarded `listDirtyRepoRelativePaths`
    // call threw, propagated out of `withTreeLock`, and the route's
    // top-level handler reported "internal error" for a commit that had
    // already succeeded.
    expect(commitRes.status).toBe(200)
    const commitBody = (await commitRes.json()) as { ok: boolean; sha: string }
    expect(commitBody.ok).toBe(true)
    expect(commitBody.sha).toMatch(/^[0-9a-f]{40}$/)

    // The commit really landed in git, independent of ledger bookkeeping.
    const head = await run("git", ["-C", repoDir, "rev-parse", "HEAD"])
    expect(head.stdout.trim()).toBe(commitBody.sha)

    // No `commit` marker was written. Writing one with an empty
    // `excludedIds` here would have reintroduced F1 (round 5): with no
    // way to prove which pending edits `git add -A` actually staged, a
    // marker that sweeps everyone in is exactly the wrong guess.
    const raw = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8")
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.some((l) => l.type === "commit")).toBe(false)

    // The read route itself must not throw either, and the pending edit
    // still ends up committed on the next poll — via reconcile's own
    // from-scratch, ignored-path-aware dirty check, once bookkeeping can
    // run again.
    hooks.setThrowing(false)
    const ledgerRes = await authedFetch("/api/editor/ledger")
    expect(ledgerRes.status).toBe(200)
    const { entries } = (await ledgerRes.json()) as {
      entries: { id: string; committed: boolean }[]
    }
    expect(entries.find((e) => e.id === "e1")?.committed).toBe(true)
  })

  it("Push still reaches pushToOrigin (not a 500) after a commit whose ledger bookkeeping throws", async () => {
    const newContent = "<template><h1>Pricing</h1></template>\n"
    await writeFile(join(repoDir, "App.vue"), newContent)
    hooks.setThrowing(true)

    const res = await authedFetch("/api/editor/branches/push", { method: "POST" })
    // No remote is configured, so the push itself still fails — but with
    // a PUSH-stage failure, not a 500 from an uncaught bookkeeping
    // exception aborting the handler before `pushToOrigin` ever ran.
    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean; reason?: string }
    expect(body.ok).toBe(false)
    expect(body.reason ?? "").not.toMatch(/maxBuffer|internal error/i)

    // The pre-push commit landed regardless — App.vue's edit is no
    // longer a pending change against HEAD (only the untracked
    // `.desde/` ledger directory itself remains, which was never
    // part of the edit).
    const status = await run("git", ["-C", repoDir, "status", "--porcelain", "--", "App.vue"])
    expect(status.stdout.trim()).toBe("")
  })
})
