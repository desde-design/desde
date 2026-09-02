/**
 * Task 6 of the toolbar undo/redo plan — end-to-end HTTP coverage for the
 * undo/redo endpoints (`POST /api/editor/history/undo` and `.../redo`)
 * and the `history` field piggybacked onto the `GET /api/editor/branches`
 * poll.
 *
 * Harness copied from `http-server-commit-retention-gc.integration.test.ts`
 * (boots a real `startHttpServer` against a real git repo, real bearer +
 * Origin auth) — the closest integration suite that drives the branches
 * route end-to-end. The edit itself goes through the REAL
 * `POST /api/editor/edit` route with the default (real) applicator
 * loaders, same as `http-server-mini-turn-lock.integration.test.ts`'s
 * `propEdit` helper, so undo/redo restore genuine before/after file bytes
 * recorded by the edit handler's history-recording lane (Task 3).
 *
 * `getSharedEditHistory()` is a process-level singleton (see
 * `edit-history.ts`), so every test resets it in `beforeEach` — otherwise
 * a step recorded by an earlier test in this file (or another file sharing
 * the vitest worker) would leak into the "fresh process" assertions here.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import { resetSharedEditHistoryForTests } from "../../../../src/editor/edit-service/edit-history"
import { ensureLocallyIgnored } from "../../../../src/editor/worktree/ensure-locally-ignored.js"

const run = promisify(execFile)

const ORIGINAL_SOURCE = [
  "<template>",
  '  <KEmptyState title="Hello" />',
  "</template>",
  "",
].join("\n")
const EDITED_SOURCE = ORIGINAL_SOURCE.replace("Hello", "World")

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let token: string
let shellOrigin: string

beforeEach(async () => {
  resetSharedEditHistoryForTests()

  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-history-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-history-repo-"))
  await run("git", ["-C", repoDir, "init", "--initial-branch=main", "--quiet"])
  await run("git", ["-C", repoDir, "config", "user.email", "t@e.com"])
  await run("git", ["-C", repoDir, "config", "user.name", "T"])
  await run("git", ["-C", repoDir, "config", "commit.gpgsign", "false"])
  await writeFile(join(repoDir, "App.vue"), ORIGINAL_SOURCE)
  await run("git", ["-C", repoDir, "add", "App.vue"])
  await run("git", ["-C", repoDir, "commit", "-m", "init", "--quiet"])
  // Real CLI boot (`core.ts`) always runs this before serving a single
  // request, so `.desde/` (backups, chat-sessions, and — since the
  // edit ledger — edit-log.jsonl) never shows up in `git status`. This
  // harness calls `startHttpServer` directly and skips that boot step, so
  // without it the ledger's OWN writes make the tree look dirty to git —
  // which switch/create correctly refuse on. Not simulating a real boot
  // here would fail create/switch for a reason no real session ever hits.
  await ensureLocallyIgnored(repoDir, ".desde/")

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
  resetSharedEditHistoryForTests()
  await handle.close()
  await rm(bundleDir, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
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

/** Drives a real deterministic prop edit through the edit route. */
async function editTitleToWorld(): Promise<Response> {
  return authedFetch("/api/editor/edit", {
    method: "POST",
    body: JSON.stringify({
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "title",
        value: "World",
      },
    }),
  })
}

describe("GET /api/editor/branches — history piggyback", () => {
  it("includes history {canUndo:false, canRedo:false} on a fresh process", async () => {
    const res = await authedFetch("/api/editor/branches")
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; history: unknown }
    expect(json.ok).toBe(true)
    expect(json.history).toEqual({
      canUndo: false,
      canRedo: false,
      undoLabel: null,
      redoLabel: null,
    })
  })

  it("reflects canRedo:true after an edit is undone", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)

    const undoRes = await authedFetch("/api/editor/history/undo", { method: "POST" })
    expect(undoRes.status).toBe(200)

    const branchesRes = await authedFetch("/api/editor/branches")
    const json = (await branchesRes.json()) as { history: { canUndo: boolean; canRedo: boolean } }
    expect(json.history).toMatchObject({ canUndo: false, canRedo: true })
  })
})

describe("POST /api/editor/history/undo|redo", () => {
  it('undo with an empty stack returns 409 with reason "Nothing to undo."', async () => {
    const res = await authedFetch("/api/editor/history/undo", { method: "POST" })
    expect(res.status).toBe(409)
    const json = (await res.json()) as { ok: boolean; reason: string; history: unknown }
    expect(json.ok).toBe(false)
    expect(json.reason).toBe("Nothing to undo.")
    expect(json.history).toEqual({
      canUndo: false,
      canRedo: false,
      undoLabel: null,
      redoLabel: null,
    })
  })

  it('redo with an empty stack returns 409 with reason "Nothing to redo."', async () => {
    const res = await authedFetch("/api/editor/history/redo", { method: "POST" })
    expect(res.status).toBe(409)
    const json = (await res.json()) as { ok: boolean; reason: string }
    expect(json.ok).toBe(false)
    expect(json.reason).toBe("Nothing to redo.")
  })

  it("undo after a real edit: 200, file restored on disk, state flips to canRedo:true", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(EDITED_SOURCE)

    const undoRes = await authedFetch("/api/editor/history/undo", { method: "POST" })
    expect(undoRes.status).toBe(200)
    const json = (await undoRes.json()) as { ok: boolean; history: unknown }
    expect(json.ok).toBe(true)
    expect(json.history).toMatchObject({ canUndo: false, canRedo: true })

    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(ORIGINAL_SOURCE)
  })

  it("redo after an undo: 200, file re-patched, state flips back to canUndo:true", async () => {
    await editTitleToWorld()
    const undoRes = await authedFetch("/api/editor/history/undo", { method: "POST" })
    expect(undoRes.status).toBe(200)

    const redoRes = await authedFetch("/api/editor/history/redo", { method: "POST" })
    expect(redoRes.status).toBe(200)
    const json = (await redoRes.json()) as { ok: boolean; history: unknown }
    expect(json.ok).toBe(true)
    expect(json.history).toMatchObject({ canUndo: true, canRedo: false })

    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(EDITED_SOURCE)
  })

  it("undo requires bearer + Origin auth (401/403 without credentials)", async () => {
    await editTitleToWorld()
    const res = await fetch(`${handle.url}/api/editor/history/undo`, { method: "POST" })
    expect([401, 403]).toContain(res.status)

    // The unauthenticated call must not have mutated anything.
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(EDITED_SOURCE)
  })
})

describe("undo 409s carry stranded through when the refusal is stranded (Task 3)", () => {
  it("undo after an external edit refuses with stranded:true", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)

    // Simulate a concurrent external edit to the same file, so the byte
    // guard in `applyTop` refuses instead of restoring.
    await writeFile(join(repoDir, "App.vue"), "<template>EXTERNAL</template>\n")

    const undoRes = await authedFetch("/api/editor/history/undo", { method: "POST" })
    expect(undoRes.status).toBe(409)
    const json = (await undoRes.json()) as { ok: boolean; reason: string; stranded?: boolean }
    expect(json.ok).toBe(false)
    expect(json.stranded).toBe(true)
  })

  it("undo with an empty stack refuses WITHOUT stranded", async () => {
    const res = await authedFetch("/api/editor/history/undo", { method: "POST" })
    expect(res.status).toBe(409)
    const json = (await res.json()) as { ok: boolean; reason: string; stranded?: boolean }
    expect(json.ok).toBe(false)
    expect(json.stranded).toBeUndefined()
  })

  it("a stranded undo 409 carries the refusing step's stepId", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)
    await writeFile(join(repoDir, "App.vue"), "<template>EXTERNAL</template>\n")

    const undoRes = await authedFetch("/api/editor/history/undo", { method: "POST" })
    expect(undoRes.status).toBe(409)
    const json = (await undoRes.json()) as { ok: boolean; stranded?: boolean; stepId?: string }
    expect(json.stranded).toBe(true)
    expect(typeof json.stepId).toBe("string")
    expect(json.stepId).toBeTruthy()
  })

  it("an empty-stack undo 409 carries NO stepId", async () => {
    const res = await authedFetch("/api/editor/history/undo", { method: "POST" })
    expect(res.status).toBe(409)
    const json = (await res.json()) as { ok: boolean; stepId?: string }
    expect(json.stepId).toBeUndefined()
  })
})

describe("POST /api/editor/history/discard", () => {
  it("discards the top undo step without touching disk: 200, canUndo flips false", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(EDITED_SOURCE)

    const discardRes = await authedFetch("/api/editor/history/discard", {
      method: "POST",
      body: JSON.stringify({ direction: "undo" }),
    })
    expect(discardRes.status).toBe(200)
    const json = (await discardRes.json()) as { ok: boolean; history: { canUndo: boolean } }
    expect(json.ok).toBe(true)
    expect(json.history.canUndo).toBe(false)

    // Disk is untouched — discard never applies anything.
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(EDITED_SOURCE)
  })

  it("discard from undo does not grow the redo stack", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)

    const discardRes = await authedFetch("/api/editor/history/discard", {
      method: "POST",
      body: JSON.stringify({ direction: "undo" }),
    })
    expect(discardRes.status).toBe(200)
    const json = (await discardRes.json()) as {
      history: { canUndo: boolean; canRedo: boolean }
    }
    expect(json.history).toMatchObject({ canUndo: false, canRedo: false })
  })

  it("discard with an empty stack returns 409 with reason and unchanged history", async () => {
    const res = await authedFetch("/api/editor/history/discard", {
      method: "POST",
      body: JSON.stringify({ direction: "undo" }),
    })
    expect(res.status).toBe(409)
    const json = (await res.json()) as { ok: boolean; reason: string }
    expect(json.ok).toBe(false)
    expect(json.reason).toBe("Nothing to undo.")
  })

  it("discard with a mismatched expectedTopId returns 409", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)

    const res = await authedFetch("/api/editor/history/discard", {
      method: "POST",
      body: JSON.stringify({ direction: "undo", expectedTopId: "bogus-id" }),
    })
    expect(res.status).toBe(409)
    const json = (await res.json()) as { ok: boolean; reason: string }
    expect(json.ok).toBe(false)
    expect(json.reason).toBe("History changed. Try again.")
  })

  it("two-tabs regression: a STALE (but once-real) expectedTopId 409s instead of popping the new top, stack untouched", async () => {
    // Tab A's flow: edit -> external drift -> stranded 409 captures the
    // step's real id -> discard with that id succeeds.
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)
    await writeFile(join(repoDir, "App.vue"), "<template>EXTERNAL</template>\n")

    const undoRes = await authedFetch("/api/editor/history/undo", { method: "POST" })
    expect(undoRes.status).toBe(409)
    const { stepId: staleId } = (await undoRes.json()) as { stepId: string }
    expect(staleId).toBeTruthy()

    const firstDiscard = await authedFetch("/api/editor/history/discard", {
      method: "POST",
      body: JSON.stringify({ direction: "undo", expectedTopId: staleId }),
    })
    expect(firstDiscard.status).toBe(200)

    // A brand-new edit lands (e.g. from tab A's own next action), pushing a
    // NEW, different step onto the undo stack.
    await writeFile(join(repoDir, "App.vue"), ORIGINAL_SOURCE)
    const secondEditRes = await editTitleToWorld()
    expect(secondEditRes.status).toBe(200)

    const beforeStale = (await (await authedFetch("/api/editor/branches")).json()) as {
      history: { canUndo: boolean; undoLabel: string | null }
    }
    expect(beforeStale.history).toMatchObject({ canUndo: true })

    // Tab B's stale click, still carrying the FIRST step's (now discarded)
    // id — must refuse, not silently pop the new step it never observed.
    const staleDiscard = await authedFetch("/api/editor/history/discard", {
      method: "POST",
      body: JSON.stringify({ direction: "undo", expectedTopId: staleId }),
    })
    expect(staleDiscard.status).toBe(409)
    const staleJson = (await staleDiscard.json()) as { ok: boolean; reason: string }
    expect(staleJson.ok).toBe(false)
    expect(staleJson.reason).toBe("History changed. Try again.")

    // The new step is untouched.
    const afterStale = (await (await authedFetch("/api/editor/branches")).json()) as {
      history: { canUndo: boolean; undoLabel: string | null }
    }
    expect(afterStale.history).toMatchObject(beforeStale.history)
  })

  it("rejects an invalid 'direction' with 400", async () => {
    const res = await authedFetch("/api/editor/history/discard", {
      method: "POST",
      body: JSON.stringify({ direction: "sideways" }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { ok: boolean; reason: string }
    expect(json.ok).toBe(false)
  })

  it("rejects a missing 'direction' with 400", async () => {
    const res = await authedFetch("/api/editor/history/discard", {
      method: "POST",
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it("requires bearer + Origin auth (401/403 without credentials)", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)

    const res = await fetch(`${handle.url}/api/editor/history/discard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "undo" }),
    })
    expect([401, 403]).toContain(res.status)

    // The unauthenticated call must not have discarded the step.
    const branchesRes = await authedFetch("/api/editor/branches")
    const json = (await branchesRes.json()) as { history: { canUndo: boolean } }
    expect(json.history.canUndo).toBe(true)
  })
})

describe("history clears on a checkout change (codex P2)", () => {
  // Reproduces the exact cross-branch scenario from the finding: edit on
  // branch A, commit (the step survives commit by design), then create +
  // switch to branch B off the SAME commit. B's file bytes byte-match the
  // step's recorded after-state, so without the fix the byte-verify guard
  // in `applyTop` can't tell branch A's history apart from branch B's tree
  // and would apply A's before-bytes onto B.
  it("create (base: current) clears history: canUndo flips false, undo 409s", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(EDITED_SOURCE)

    const commitRes = await authedFetch("/api/editor/branches/commit", {
      method: "POST",
      body: JSON.stringify({ message: "edit title" }),
    })
    expect(commitRes.status).toBe(200)

    // The step survives the commit (by design) — still undoable right up
    // until the checkout changes.
    const midBranches = (await (await authedFetch("/api/editor/branches")).json()) as {
      history: { canUndo: boolean }
    }
    expect(midBranches.history.canUndo).toBe(true)

    const createRes = await authedFetch("/api/editor/branches/create", {
      method: "POST",
      body: JSON.stringify({ name: "branch-b", base: "current" }),
    })
    expect(createRes.status).toBe(200)

    const branchesRes = await authedFetch("/api/editor/branches")
    const json = (await branchesRes.json()) as {
      history: { canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null }
    }
    expect(json.history).toEqual({
      canUndo: false,
      canRedo: false,
      undoLabel: null,
      redoLabel: null,
    })

    const undoRes = await authedFetch("/api/editor/history/undo", { method: "POST" })
    expect(undoRes.status).toBe(409)
    const undoJson = (await undoRes.json()) as { ok: boolean; reason: string }
    expect(undoJson.ok).toBe(false)
    expect(undoJson.reason).toBe("Nothing to undo.")

    // Branch B's file is untouched — the old-branch history was never
    // applied to it.
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(EDITED_SOURCE)
  })

  it("switch clears history", async () => {
    // Set up a second branch to switch to, off the same commit, with no
    // pending edits at switch time (switch requires a clean tree).
    await run("git", ["-C", repoDir, "branch", "branch-b"])

    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)
    const commitRes = await authedFetch("/api/editor/branches/commit", {
      method: "POST",
      body: JSON.stringify({ message: "edit title" }),
    })
    expect(commitRes.status).toBe(200)

    const switchRes = await authedFetch("/api/editor/branches/switch", {
      method: "POST",
      body: JSON.stringify({ name: "branch-b" }),
    })
    expect(switchRes.status).toBe(200)

    const branchesRes = await authedFetch("/api/editor/branches")
    const json = (await branchesRes.json()) as { history: { canUndo: boolean } }
    expect(json.history.canUndo).toBe(false)

    const undoRes = await authedFetch("/api/editor/history/undo", { method: "POST" })
    expect(undoRes.status).toBe(409)
  })

  it("rename does NOT clear history (same tree, no checkout change)", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)

    const renameRes = await authedFetch("/api/editor/branches/rename", {
      method: "POST",
      body: JSON.stringify({ name: "main", to: "renamed-main" }),
    })
    expect(renameRes.status).toBe(200)

    const branchesRes = await authedFetch("/api/editor/branches")
    const json = (await branchesRes.json()) as { history: { canUndo: boolean } }
    expect(json.history.canUndo).toBe(true)
  })

  it("commit does NOT clear history (the step is designed to survive commit)", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)

    const commitRes = await authedFetch("/api/editor/branches/commit", {
      method: "POST",
      body: JSON.stringify({ message: "edit title" }),
    })
    expect(commitRes.status).toBe(200)

    const branchesRes = await authedFetch("/api/editor/branches")
    const json = (await branchesRes.json()) as { history: { canUndo: boolean } }
    expect(json.history.canUndo).toBe(true)
  })
})
