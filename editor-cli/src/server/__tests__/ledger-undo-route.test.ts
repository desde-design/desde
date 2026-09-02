/**
 * Plan B, Task 1 — `POST /api/editor/ledger/:id/undo`.
 *
 * Harness copied from `http-server-lock-events.integration.test.ts`
 * (`beforeEach`/`afterEach`/`pickFreePort` verbatim) plus the real-edit +
 * git-repo setup from `http-server-history.integration.test.ts` (the
 * closest suite that drives a genuine `brokeredWrite`-backed restore
 * through a real ledger entry against a real git repo).
 *
 * The load-bearing assertion in this file is the "file untouched on
 * refusal" check below: a refused undo must never have written anything.
 * Reverting the drift guard in `planLedgerUndo` and re-running this file
 * is how that claim was verified, not merely asserted — see the task
 * report.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { promisify } from "node:util"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import { ensureLocallyIgnored } from "../../../../src/editor/worktree/ensure-locally-ignored.js"
import { appendLedgerEntry, hashContent } from "../../../../src/editor/ledger/edit-ledger.js"
import { resetSharedEditHistoryForTests } from "../../../../src/editor/edit-service/edit-history.js"
import {
  getSharedFileLockManager,
  __resetSharedFileLockManagerForTests,
  __setSharedFileLockManagerForTests,
  type FileLockManager,
} from "../../../../src/editor/edit-service/file-lock-manager.js"

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
  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerundo-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerundo-repo-"))
  await run("git", ["-C", repoDir, "init", "--initial-branch=main", "--quiet"])
  await run("git", ["-C", repoDir, "config", "user.email", "t@e.com"])
  await run("git", ["-C", repoDir, "config", "user.name", "T"])
  await run("git", ["-C", repoDir, "config", "commit.gpgsign", "false"])
  await writeFile(join(repoDir, "App.vue"), ORIGINAL_SOURCE)
  await run("git", ["-C", repoDir, "add", "App.vue"])
  await run("git", ["-C", repoDir, "commit", "-m", "init", "--quiet"])
  // Real CLI boot always runs this before serving a request, so
  // `.desde/` (backups, edit-log.jsonl) never shows up in `git
  // status`. This harness calls `startHttpServer` directly and skips
  // that boot step — without it, the ledger's own writes (and the
  // undo's own backup journal) would make the tree look dirty for
  // reasons unrelated to what this file is testing.
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
  // Safety net for the P1-2 test below, which installs an instrumented
  // lock manager mid-test — a thrown assertion there must not leak it
  // into later tests in this file (or, since the manager is a
  // process-wide singleton, later files in the same worker).
  __resetSharedFileLockManagerForTests()
  // Same reasoning for the P2-3 round-3 test below, which now reads the
  // shared toolbar undo/redo stack — also a process-wide singleton.
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
      const port = typeof addr === "object" && addr ? addr.port : 0
      server.close(() => resolve(port))
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

/** Drives a real deterministic prop edit through the edit route, so the
 * ledger entry it produces carries genuine before/after bytes and a real
 * backup directory — same as production. */
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

async function latestLedgerEntryId(): Promise<string> {
  const res = await authedFetch("/api/editor/ledger")
  const json = (await res.json()) as { entries: { id: string }[] }
  return json.entries[0].id
}

async function gitStatusPorcelain(): Promise<string> {
  const { stdout } = await run("git", ["-C", repoDir, "status", "--porcelain"])
  return stdout
}

describe("POST /api/editor/ledger/:id/undo", () => {
  it("restores the pre-edit bytes and returns 200", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(EDITED_SOURCE)

    const id = await latestLedgerEntryId()
    const undoRes = await authedFetch(`/api/editor/ledger/${id}/undo`, { method: "POST" })
    expect(undoRes.status).toBe(200)
    const json = (await undoRes.json()) as { ok: boolean }
    expect(json.ok).toBe(true)

    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(ORIGINAL_SOURCE)
  })

  it("leaves the restored file dirty in git — undoing a committed edit is a new uncommitted change", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)
    const id = await latestLedgerEntryId()

    const commitRes = await authedFetch("/api/editor/branches/commit", {
      method: "POST",
      body: JSON.stringify({ message: "edit title" }),
    })
    expect(commitRes.status).toBe(200)
    expect(await gitStatusPorcelain()).toBe("")

    const undoRes = await authedFetch(`/api/editor/ledger/${id}/undo`, { method: "POST" })
    expect(undoRes.status).toBe(200)

    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(ORIGINAL_SOURCE)
    // The whole contract: undoing a COMMITTED edit does not touch git
    // history — it leaves a fresh, uncommitted working-tree change.
    expect(await gitStatusPorcelain()).toContain("App.vue")
  })

  it("refuses with 409 and leaves the file untouched when it changed after the edit", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)
    const id = await latestLedgerEntryId()

    const driftedContent = "<template>EXTERNAL</template>\n"
    await writeFile(join(repoDir, "App.vue"), driftedContent)

    const undoRes = await authedFetch(`/api/editor/ledger/${id}/undo`, { method: "POST" })
    expect(undoRes.status).toBe(409)
    const json = (await undoRes.json()) as { ok: boolean; code: string; reason: string }
    expect(json.ok).toBe(false)
    expect(json.code).toBe("drifted")
    expect(json.reason).toContain("App.vue")

    // The load-bearing assertion: a refusal must leave the file exactly
    // as it was. A refusal that already wrote is the failure this whole
    // task exists to prevent.
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(driftedContent)
  })

  it("returns 404 for an unknown id", async () => {
    const res = await authedFetch("/api/editor/ledger/nonexistent-id/undo", { method: "POST" })
    expect(res.status).toBe(404)
    const json = (await res.json()) as { ok: boolean; reason: string }
    expect(json.ok).toBe(false)
  })

  it("returns 401 without a bearer token", async () => {
    const res = await fetch(`${handle.url}/api/editor/ledger/any-id/undo`, {
      method: "POST",
      headers: { Origin: shellOrigin },
    })
    expect(res.status).toBe(401)
  })

  it("returns 403 with a foreign Origin", async () => {
    const res = await fetch(`${handle.url}/api/editor/ledger/any-id/undo`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Origin: "http://evil.example" },
    })
    expect(res.status).toBe(403)
  })

  it("appends a ledger entry with lane: 'undo'", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)
    const id = await latestLedgerEntryId()

    const undoRes = await authedFetch(`/api/editor/ledger/${id}/undo`, { method: "POST" })
    expect(undoRes.status).toBe(200)

    const ledgerRes = await authedFetch("/api/editor/ledger")
    const ledgerJson = (await ledgerRes.json()) as {
      entries: { id: string; lane: string; kind: string }[]
    }
    const undoEntry = ledgerJson.entries.find((e) => e.lane === "undo")
    expect(undoEntry).toBeDefined()
    expect(undoEntry?.kind).toBe("undo")
  })

  // P1-1 (codex review finding, 2026-08-20): the panel's own ledger poll
  // is stale between ticks. If a branch switch lands in that window, the
  // panel can still show a row from the branch just left — this drives
  // exactly that: the edit happens (and is recorded) on `main`, `main`
  // is committed so its tree matches the edit's own afterHashes, and a
  // NEW branch is created FROM that exact commit — so `feature` starts
  // with byte-identical content, the one case the hash-only drift check
  // cannot catch on its own. Undoing the `main` entry while `feature` is
  // checked out must be refused, not silently restore `main`'s backup
  // onto `feature`.
  it("refuses undo when the entry's branch is not the checked-out branch, even when the bytes still match (P1-1)", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)
    const id = await latestLedgerEntryId()

    const commitRes = await authedFetch("/api/editor/branches/commit", {
      method: "POST",
      body: JSON.stringify({ message: "edit title" }),
    })
    expect(commitRes.status).toBe(200)

    const createRes = await authedFetch("/api/editor/branches/create", {
      method: "POST",
      body: JSON.stringify({ name: "feature", base: "current" }),
    })
    expect(createRes.status).toBe(200)

    // Sanity check on the exploit's own premise: `feature` really does
    // start with the exact bytes the entry's `afterHashes` were computed
    // against, so a hash-only check would find nothing wrong.
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(EDITED_SOURCE)

    const undoRes = await authedFetch(`/api/editor/ledger/${id}/undo`, { method: "POST" })
    expect(undoRes.status).toBe(409)
    const json = (await undoRes.json()) as { ok: boolean; reason: string }
    expect(json.ok).toBe(false)
    expect(json.reason).toContain("main")

    // The load-bearing assertion: `main`'s backup must never land on
    // `feature`.
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(EDITED_SOURCE)
  })

  // P1-2 (codex review finding, 2026-08-20): `withFileEditLocks` (the
  // CLI's own outer lock, held for planning + writing) and the broker's
  // OWN `FileLockManager` are documented separate namespaces — an SDK
  // structural tool calls `brokeredWrite` directly, taking only the
  // latter, so it can land in the gap between `planLedgerUndo`'s own
  // (unlocked) drift-check read and `brokeredWrite`'s own lock
  // acquisition for the same file. This test forces exactly that gap,
  // deterministically, by installing an instrumented `FileLockManager`
  // (mirrors `edit-history.test.ts`'s own TOCTOU regression test) whose
  // `withWriteLock` writes interloper bytes to the target path the
  // INSTANT it's asked to lock it — i.e. after the route's plan already
  // read the pre-interloper bytes and decided undo was safe, but before
  // the broker's own snapshot/precondition check has run.
  it("refuses (and never overwrites) when a concurrent write lands between planning and the broker's own lock acquisition (P1-2)", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)
    const id = await latestLedgerEntryId()

    const targetAbsPath = join(repoDir, "App.vue")
    const realLockManager = getSharedFileLockManager()
    const interloperLockManager: FileLockManager = {
      withLock: (p, fn, o) => realLockManager.withLock(p, fn, o),
      withWriteLock: (p, fn, o) =>
        realLockManager.withWriteLock(
          p,
          async () => {
            if (p === targetAbsPath) {
              await writeFile(p, "FROM-CONCURRENT-STRUCTURAL-TOOL")
            }
            return fn()
          },
          o,
        ),
      inspect: () => realLockManager.inspect(),
    }
    __setSharedFileLockManagerForTests(interloperLockManager)

    const undoRes = await authedFetch(`/api/editor/ledger/${id}/undo`, { method: "POST" })
    expect(undoRes.status).toBe(409)
    const json = (await undoRes.json()) as { ok: boolean; code?: string; reason: string }
    expect(json.ok).toBe(false)

    // The load-bearing assertion: the concurrent writer's bytes survive.
    // A refusal here must never have clobbered a write that landed after
    // planning had already decided undo was safe.
    expect(await readFile(targetAbsPath, "utf8")).toBe("FROM-CONCURRENT-STRUCTURAL-TOOL")
  })

  // P1-1 ROUND 2 (codex review finding, 2026-08-20): the round-1 branch
  // check above authorized undo whenever EITHER the checked-out branch
  // matched OR the entry's recorded branch was "orphaned"
  // (`isOrphanedBranch`, `src/editor/ledger/rename-aliases.ts`) — a
  // helper that function's own doc comment describes as DISPLAY-ONLY
  // fail-open (showing an extra ledger row is the smaller harm than
  // hiding real work forever). Reusing it to AUTHORIZE a write flips that
  // posture: if the entry's branch no longer exists at all, the old
  // check let the undo through.
  //
  // The round-1 test above does NOT catch this — it leaves `main`
  // (the entry's recorded branch) EXISTING while `feature` is checked
  // out, so `isOrphanedBranch` returns false there regardless of the
  // bug, and the old code refused correctly for the wrong reason. This
  // test instead deletes `main` outright (as a merge-then-cleanup would),
  // so `isOrphanedBranch('main', existingBranches)` — which the OLD code
  // consulted — trips its fail-open branch. `feature` still holds the
  // exact post-edit bytes (it was branched from that exact commit), so a
  // hash-only check finds nothing wrong either.
  it("refuses undo when the entry's recorded branch no longer exists at all, even though the checked-out branch's bytes match (P1-1 round 2)", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)
    const id = await latestLedgerEntryId()

    const commitRes = await authedFetch("/api/editor/branches/commit", {
      method: "POST",
      body: JSON.stringify({ message: "edit title" }),
    })
    expect(commitRes.status).toBe(200)

    const createRes = await authedFetch("/api/editor/branches/create", {
      method: "POST",
      body: JSON.stringify({ name: "feature", base: "current" }),
    })
    expect(createRes.status).toBe(200)

    // `main` is no longer checked out (create switched to `feature`), so
    // it can be force-deleted — simulating a branch that was merged and
    // cleaned up after the edit landed on it. This is the fact the
    // display-only `isOrphanedBranch` was built to tolerate; a write must
    // not tolerate it the same way.
    await run("git", ["-C", repoDir, "branch", "-D", "main"])

    // Sanity check on the exploit's own premise: `feature` really does
    // hold the exact bytes the entry's `afterHashes` were computed
    // against.
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(EDITED_SOURCE)

    const undoRes = await authedFetch(`/api/editor/ledger/${id}/undo`, { method: "POST" })
    expect(undoRes.status).toBe(409)
    const json = (await undoRes.json()) as { ok: boolean; reason: string }
    expect(json.ok).toBe(false)
    expect(json.reason).toContain("main")

    // The load-bearing assertion: the deleted `main`'s backup must never
    // land on `feature`.
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(EDITED_SOURCE)
  })

  // P1-2 ROUND 2 (codex review finding, 2026-08-20): the round-1
  // precondition check above re-verifies the SAME bytes `planLedgerUndo`
  // already verified — but both checks read the file with `readFile`,
  // which FOLLOWS symlinks. Neither can tell "the file still holds these
  // bytes" apart from "the file was REPLACED BY A SYMLINK whose CURRENT
  // target happens to hold these bytes." This drives that exploit end to
  // end: after the edit, `App.vue` is deleted and replaced with a symlink
  // to a file OUTSIDE the repo entirely that happens to hold the exact
  // post-edit bytes. Undo must refuse, and — the load-bearing assertions
  // — neither the symlink nor its target may be touched: `writeFile`
  // (what the round-1 fix alone would have reached) ALSO follows
  // symlinks, so an unguarded restore would silently overwrite a file
  // outside the repository with the pre-edit backup.
  it("refuses (and never writes through) a symlink standing in for the edited file (P1-2 round 2)", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)
    const id = await latestLedgerEntryId()

    const outsideDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerundo-outside-"))
    try {
      const evilTarget = join(outsideDir, "evil-target.vue")
      await writeFile(evilTarget, EDITED_SOURCE)

      const appVuePath = join(repoDir, "App.vue")
      await unlink(appVuePath)
      await symlink(evilTarget, appVuePath)

      // Sanity check on the exploit's own premise: reading THROUGH the
      // symlink returns exactly the bytes the entry's `afterHashes` were
      // computed against, so a hash-only check (the drift check, and the
      // round-1 precondition re-check) finds nothing wrong.
      expect(await readFile(appVuePath, "utf8")).toBe(EDITED_SOURCE)

      const undoRes = await authedFetch(`/api/editor/ledger/${id}/undo`, { method: "POST" })
      expect(undoRes.status).toBe(409)
      const json = (await undoRes.json()) as { ok: boolean; code?: string; reason: string }
      expect(json.ok).toBe(false)
      expect(json.code).toBe("drifted")

      // The load-bearing assertions: the symlink itself is untouched
      // (never replaced with plain restored content), and its target — a
      // file outside the repo entirely — was never overwritten with the
      // pre-edit backup.
      expect((await lstat(appVuePath)).isSymbolicLink()).toBe(true)
      expect(await readFile(evilTarget, "utf8")).toBe(EDITED_SOURCE)
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  // P1-1 (codex review ROUND 3, 2026-08-20): `planLedgerUndo` treated a
  // missing `backupDir` — the WHOLE-ENTRY case, not the per-file
  // "backup exists but lacks this file" case round 1's P1-3 already
  // fixed — as proof every touched file was created by this edit. That
  // inference is false whenever a producer appends an `edit` entry with
  // a real `afterHash` but genuinely never wrote a backup for a file
  // that already existed. `src/editor/agent-chat-sdk/fs-structural-tools.ts`'s
  // `manage_package` handler does exactly this for its lockfile-tracking
  // follow-up append (the loop after `install()` runs): it records the
  // lockfile's post-install hash with no `backupDir` at all, whether or
  // not the lockfile pre-existed. This test reproduces that exact shape —
  // appended directly rather than driven through `manage_package` itself,
  // since the defect is in the PLANNER's inference from `backupDir`
  // alone, not in how any particular caller produces that shape.
  it("refuses undo (and never deletes) for a manage_package-shaped entry with no backup, for a file that already existed (P1-1 round 3)", async () => {
    const lockfileContent = '{"lockfileVersion": 1}\n'
    await writeFile(join(repoDir, "App.vue"), lockfileContent)

    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "manage-package-entry",
      at: new Date().toISOString(),
      branch: "main",
      kind: "manage_package",
      lane: "chat",
      files: ["App.vue"],
      // Deliberately NO backupDir and NO createdFiles — the exact shape
      // `manage_package`'s lockfile append produces for a pre-existing
      // file. Only `afterHashes` is populated, matching the file's
      // CURRENT (pre-existing) content, so the drift check alone finds
      // nothing wrong.
      afterHashes: { "App.vue": hashContent(Buffer.from(lockfileContent)) },
    })

    const undoRes = await authedFetch("/api/editor/ledger/manage-package-entry/undo", {
      method: "POST",
    })
    expect(undoRes.status).toBe(409)
    const json = (await undoRes.json()) as { ok: boolean; code?: string; reason: string }
    expect(json.ok).toBe(false)
    expect(json.code).toBe("unbacked")

    // The load-bearing assertion: the file survives. Before the fix, a
    // missing `backupDir` was read as proof this write created the
    // file, and undo would have DELETED an existing lockfile.
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(lockfileContent)
  })

  // P1-2 (codex review ROUND 3, 2026-08-20): undoing an UNCOMMITTED edit
  // whose pre-edit bytes happen to already match HEAD — the ordinary
  // case for the first edit since the last commit — restores the
  // working tree to exactly what HEAD holds. `reconcileLedger` (run by
  // `GET /api/editor/ledger`, which the panel polls right after any
  // write) reads "this entry's files are no longer dirty" as proof of a
  // commit it never actually observed, and durably marks BOTH the
  // original edit and the undo entry itself committed — even though no
  // `git commit` ever ran. The append-only log can never take that back.
  it("undoing an uncommitted edit whose pre-edit bytes match HEAD does not mark either entry committed (P1-2 round 3)", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)
    const originalId = await latestLedgerEntryId()

    // Never committed — HEAD still holds ORIGINAL_SOURCE, exactly what
    // undo is about to restore.
    const undoRes = await authedFetch(`/api/editor/ledger/${originalId}/undo`, {
      method: "POST",
    })
    expect(undoRes.status).toBe(200)
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(ORIGINAL_SOURCE)

    // Sanity check on the exploit's own premise: the working tree is now
    // clean relative to HEAD — precisely the condition the reconcile
    // heuristic used to misread as "this must have been committed."
    expect(await gitStatusPorcelain()).toBe("")

    // `GET /api/editor/ledger` is exactly what the panel's poll hits
    // right after this write — reconcile runs as a side effect of the
    // read.
    const ledgerRes = await authedFetch("/api/editor/ledger")
    const ledgerJson = (await ledgerRes.json()) as {
      entries: { id: string; lane: string; committed: boolean }[]
    }
    const originalEntry = ledgerJson.entries.find((e) => e.id === originalId)
    const undoEntry = ledgerJson.entries.find((e) => e.lane === "undo")
    expect(originalEntry).toBeDefined()
    expect(undoEntry).toBeDefined()

    // The load-bearing assertions: neither half of the undo/original
    // pair is durably marked committed. No `git commit` ever ran.
    expect(originalEntry?.committed).toBe(false)
    expect(undoEntry?.committed).toBe(false)
  })

  // F1 (codex review ROUND 4, 2026-08-20): round 3's fix above closed the
  // false-positive, but it did so by excluding the undo entry from
  // "clean means committed" FOREVER — which is wrong the moment a REAL
  // commit lands afterward. A commit made from the user's own terminal
  // (as here) appends no product `commit` line at all, so the permanent
  // exclusion meant this entry could never self-heal into "Committed",
  // even once HEAD had genuinely moved past it.
  it("marks the undo entry committed once a real commit lands afterward, even from the user's own terminal (F1 round 4)", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)
    const originalId = await latestLedgerEntryId()

    const undoRes = await authedFetch(`/api/editor/ledger/${originalId}/undo`, {
      method: "POST",
    })
    expect(undoRes.status).toBe(200)
    expect(await gitStatusPorcelain()).toBe("")

    // Round 3's own guarantee still holds on the very first read, with
    // nothing else having happened since the undo.
    const firstRes = await authedFetch("/api/editor/ledger")
    const firstJson = (await firstRes.json()) as {
      entries: { id: string; lane: string; committed: boolean }[]
    }
    expect(firstJson.entries.find((e) => e.lane === "undo")?.committed).toBe(false)

    // A REAL commit from the user's own terminal — unrelated to App.vue,
    // and not through this product at all, so no `commit` line is ever
    // appended for it. HEAD moves regardless of which file the commit
    // itself touches.
    await writeFile(join(repoDir, "Other.vue"), "<template><div /></template>\n")
    await run("git", ["-C", repoDir, "add", "Other.vue"])
    await run("git", ["-C", repoDir, "commit", "-m", "unrelated", "--quiet"])

    const secondRes = await authedFetch("/api/editor/ledger")
    const secondJson = (await secondRes.json()) as {
      entries: { id: string; lane: string; committed: boolean }[]
    }
    // The load-bearing assertion: the undo entry now reads "Committed" —
    // HEAD moved past the fingerprint recorded at its own write time.
    expect(secondJson.entries.find((e) => e.lane === "undo")?.committed).toBe(true)
    // The entry it reverted never does — its changes were thrown away,
    // not committed, and this fix must not change that (see the round-3
    // test above, which this must not regress).
    expect(secondJson.entries.find((e) => e.id === originalId)?.committed).toBe(false)
  })

  // P2-3 (codex review ROUND 3, 2026-08-20): the ledger-undo route wrote
  // through `brokeredWrite` with no `record` option, so the toolbar's
  // OWN undo/redo stack (`EditorEditHistory`) never learned this write
  // happened. Its top step — pushed when `editTitleToWorld()` ran, via
  // `applyEdit`'s own `record` option — kept expecting the file to hold
  // `EDITED_SOURCE`; the ledger undo replaced that with `ORIGINAL_SOURCE`
  // behind its back. Before the fix, `POST /api/editor/history/undo`
  // right after a ledger undo refused 409 (`stranded: true`), asking the
  // user to discard a step that the file's actual state had already made
  // moot.
  it("records the ledger undo as a toolbar history step, so the toolbar's own Undo doesn't strand on the stale pre-undo step (P2-3 round 3)", async () => {
    resetSharedEditHistoryForTests()

    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)
    const id = await latestLedgerEntryId()

    const undoRes = await authedFetch(`/api/editor/ledger/${id}/undo`, { method: "POST" })
    expect(undoRes.status).toBe(200)
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(ORIGINAL_SOURCE)

    // The load-bearing assertion: the toolbar's own undo route must not
    // strand right after this write.
    const toolbarUndoRes = await authedFetch("/api/editor/history/undo", { method: "POST" })
    const toolbarUndoJson = (await toolbarUndoRes.json()) as {
      ok: boolean
      stranded?: boolean
      reason?: string
    }
    expect(toolbarUndoJson.stranded).not.toBe(true)
    expect(toolbarUndoRes.status).toBe(200)

    // The newly-recorded step's `before` is exactly the state the file
    // held right before the ledger undo ran — so undoing IT (the
    // toolbar's next click) re-applies the original edit.
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(EDITED_SOURCE)
  })

  // P1 (codex review ROUND 5, 2026-08-20, SECURITY): the ledger file
  // (`.desde/edit-log.jsonl`) lives INSIDE the repository, so every
  // field on a line — including `backupDir` — is attacker-controlled for
  // anyone who can get a repo opened in the Editor. Before this fix,
  // `createRealUndoDeps`'s `backupDirExists`/`backupHasFile`/`readBackup`
  // joined `backupDir` straight onto `canonicalRoot` with NO containment
  // check: a crafted entry naming a `backupDir` outside the repo, with
  // `files` naming something that ALSO exists there and an `afterHashes`
  // matching an in-repo placeholder the attacker also ships, made
  // clicking Undo read the EXTERNAL file and write its bytes into the
  // repo — where the attacker can read them back. This drives that
  // exploit end to end, appended directly (not through a real edit),
  // since the defect is in what the undo route trusts from the ledger,
  // not in how any particular caller produces the entry.
  describe("backupDir path-traversal exploit (P1, codex review round 5, SECURITY)", () => {
    it("refuses undo and never copies an external secret into the repo via a ../-escaping backupDir", async () => {
      const outsideDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerundo-secret-"))
      try {
        const secretContent = "-----BEGIN OPENSSH PRIVATE KEY-----\nSUPER SECRET\n-----END-----\n"
        await writeFile(join(outsideDir, "id_rsa"), secretContent)

        // The in-repo placeholder the attacker also ships — a normal
        // repo file at the SAME repo-relative path `files` names, so the
        // drift check (which hashes THIS file, not the external one)
        // passes.
        const placeholderContent = "placeholder\n"
        await writeFile(join(repoDir, "id_rsa"), placeholderContent)

        // Computed with `path.relative` rather than hand-counting `../`
        // segments — the exact count depends on the repo's location on
        // disk (varies by machine/CI), but the exploit shape (a
        // `backupDir` that resolves outside `.desde/backups`) does
        // not.
        const maliciousBackupDir = relative(repoDir, outsideDir)

        await appendLedgerEntry(repoDir, {
          type: "edit",
          id: "evil-traversal",
          at: new Date().toISOString(),
          branch: "main",
          kind: "prop",
          lane: "direct",
          files: ["id_rsa"],
          backupDir: maliciousBackupDir,
          afterHashes: { id_rsa: hashContent(Buffer.from(placeholderContent)) },
        })

        const undoRes = await authedFetch("/api/editor/ledger/evil-traversal/undo", {
          method: "POST",
        })
        expect(undoRes.status).not.toBe(200)
        const json = (await undoRes.json()) as { ok: boolean; code?: string; reason: string }
        expect(json.ok).toBe(false)

        // The load-bearing assertion: the external secret never landed
        // in the repo. Before the fix, this would read `secretContent`.
        expect(await readFile(join(repoDir, "id_rsa"), "utf8")).toBe(placeholderContent)
        // And the external file itself was never touched (read-only
        // exfiltration would still leave it byte-identical, but this
        // guards against a hypothetical write-back path too).
        expect(await readFile(join(outsideDir, "id_rsa"), "utf8")).toBe(secretContent)
      } finally {
        await rm(outsideDir, { recursive: true, force: true })
      }
    })

    // The `../` case above is caught by EITHER of the two fixes this
    // round shipped: `readLedger`'s lexical pre-filter (which strips an
    // escaping `backupDir` before the route ever sees one) AND
    // `createRealUndoDeps`'s realpath containment check. A LEXICALLY
    // valid `backupDir` — one that genuinely resolves under
    // `.desde/backups` as a STRING — defeats the lexical pre-filter
    // by construction; only a symlink planted on disk at that path can
    // still redirect it outside the repo, and only the realpath check
    // (which resolves every symlink in the chain, not just the leaf)
    // catches that. This test isolates that second layer: reverting
    // ONLY `readLedger`'s fix must NOT turn this red, because the lexical
    // check was never what was protecting this case.
    it("refuses undo through a backupDir that is lexically valid but is a symlink to outside the repo", async () => {
      const outsideDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerundo-secret-"))
      try {
        const secretContent = "-----BEGIN OPENSSH PRIVATE KEY-----\nSUPER SECRET\n-----END-----\n"
        await writeFile(join(outsideDir, "id_rsa"), secretContent)

        const placeholderContent = "placeholder\n"
        await writeFile(join(repoDir, "id_rsa"), placeholderContent)

        // `.desde/backups/evil-1` is a real symlink ENTRY under the
        // real backups root — the STRING lexically resolves inside it —
        // but on disk it points entirely outside the repo.
        await mkdir(join(repoDir, ".desde", "backups"), { recursive: true })
        await symlink(outsideDir, join(repoDir, ".desde", "backups", "evil-1"))

        await appendLedgerEntry(repoDir, {
          type: "edit",
          id: "evil-symlink",
          at: new Date().toISOString(),
          branch: "main",
          kind: "prop",
          lane: "direct",
          files: ["id_rsa"],
          backupDir: ".desde/backups/evil-1",
          afterHashes: { id_rsa: hashContent(Buffer.from(placeholderContent)) },
        })

        const undoRes = await authedFetch("/api/editor/ledger/evil-symlink/undo", {
          method: "POST",
        })
        expect(undoRes.status).not.toBe(200)
        const json = (await undoRes.json()) as { ok: boolean; code?: string; reason: string }
        expect(json.ok).toBe(false)

        expect(await readFile(join(repoDir, "id_rsa"), "utf8")).toBe(placeholderContent)
        expect(await readFile(join(outsideDir, "id_rsa"), "utf8")).toBe(secretContent)
        // The symlink itself survives untouched — never replaced with
        // plain restored content.
        expect(
          (await lstat(join(repoDir, ".desde", "backups", "evil-1"))).isSymbolicLink(),
        ).toBe(true)
      } finally {
        await rm(outsideDir, { recursive: true, force: true })
      }
    })
  })
})
