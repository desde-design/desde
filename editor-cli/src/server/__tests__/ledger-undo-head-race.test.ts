// @vitest-environment node
/**
 * P1-3 (codex review round 7) — HEAD is not revalidated around the
 * mutation in `handleLedgerUndoRequest` (../http-server.ts).
 *
 * This is plain correctness, not security — it can fire with no attacker
 * at all. `withFileEditLocks` is IN-PROCESS ONLY: it cannot stop a
 * terminal `git checkout`/`git switch`, or a second Editor process on the
 * same repo, from moving HEAD after the branch-ownership check
 * (`undoAuthorizedForBranch`) has already passed but before the write
 * runs. If the newly checked-out branch happens to hold the exact same
 * file bytes the ledger entry's `afterHashes` recorded (a branch cut from
 * the exact commit the edit produced is exactly this shape), the
 * hash-only drift check in `planLedgerUndo` and the broker's own
 * precondition both still pass — so, without a HEAD bracket, the OLD
 * branch's backup would land on the NEW branch.
 *
 * Driving a REAL concurrent `git checkout` deterministically, from inside
 * a single in-process HTTP request, isn't possible without racing two
 * real OS processes against unreliable timing. Instead this hooks the
 * exact seam the fix reads twice: `readGitHeadRaw`
 * (`src/editor/ledger/edit-ledger.ts`, re-exported through
 * `src/editor/ledger/index.ts`, which is what `http-server.ts` imports).
 * The FIRST read of a request — inside `resolveBranchCachedWithHead`,
 * called from WITHIN `edit-ledger.ts` itself — resolves against its own
 * local binding, not the mocked export, so it is untouched by this mock
 * and returns the genuine, unmodified HEAD content (this repo never
 * performs a real checkout in this test — see below). The SECOND read —
 * `http-server.ts`'s own explicit call, reached through the barrel import
 * this mock replaces — is what gets swapped to a different value,
 * simulating a checkout having landed in the gap between the two reads
 * without this test needing to run one for real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const raceHookState = vi.hoisted(() => ({
  armed: false,
  fakeHead: null as string | null,
}))

vi.mock("../../../../src/editor/ledger/edit-ledger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/editor/ledger/edit-ledger.js")>()
  const readGitHeadRaw: typeof actual.readGitHeadRaw = async (root) => {
    if (raceHookState.armed && raceHookState.fakeHead !== null) {
      // One-shot: fires exactly once, exactly like a single external
      // checkout landing in a single race window.
      raceHookState.armed = false
      return raceHookState.fakeHead
    }
    return actual.readGitHeadRaw(root)
  }
  return { ...actual, readGitHeadRaw }
})

function installHeadRaceHook(fakeHead: string): void {
  raceHookState.armed = true
  raceHookState.fakeHead = fakeHead
}

function clearHeadRaceHook(): void {
  raceHookState.armed = false
  raceHookState.fakeHead = null
}

import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import { ensureLocallyIgnored } from "../../../../src/editor/worktree/ensure-locally-ignored.js"
import { resetSharedEditHistoryForTests } from "../../../../src/editor/edit-service/edit-history.js"
import { __resetSharedFileLockManagerForTests } from "../../../../src/editor/edit-service/file-lock-manager.js"

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
  clearHeadRaceHook()

  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerundo-headrace-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerundo-headrace-repo-"))
  await run("git", ["-C", repoDir, "init", "--initial-branch=main", "--quiet"])
  await run("git", ["-C", repoDir, "config", "user.email", "t@e.com"])
  await run("git", ["-C", repoDir, "config", "user.name", "T"])
  await run("git", ["-C", repoDir, "config", "commit.gpgsign", "false"])
  await writeFile(join(repoDir, "App.vue"), ORIGINAL_SOURCE)
  await run("git", ["-C", repoDir, "add", "App.vue"])
  await run("git", ["-C", repoDir, "commit", "-m", "init", "--quiet"])
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
  clearHeadRaceHook()
  __resetSharedFileLockManagerForTests()
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

describe("HEAD not revalidated around the undo mutation (P1-3, codex review round 7)", () => {
  it("refuses undo when HEAD moves to a different branch between the branch check and the write, even though the bytes still match", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(EDITED_SOURCE)
    const id = await latestLedgerEntryId()

    // Simulates a concurrent `git checkout other` landing in the gap
    // between the route's branch-ownership check (which reads the
    // GENUINE current HEAD — still "main" — and correctly authorizes,
    // since the entry belongs to "main" too) and the write. The route
    // never actually leaves "main" in this test; only the SECOND read
    // this fix performs is faked, which is exactly the read the fix adds.
    installHeadRaceHook("ref: refs/heads/other\n")

    const undoRes = await authedFetch(`/api/editor/ledger/${id}/undo`, { method: "POST" })

    // One-shot: if this is still armed, the route never reached the
    // second HEAD read at all, and this test proved nothing about it.
    expect(raceHookState.armed).toBe(false)

    expect(undoRes.status).toBe(409)
    const json = (await undoRes.json()) as { ok: boolean; code?: string; reason: string }
    expect(json.ok).toBe(false)
    expect(json.code).toBe("wrong-branch")

    // The load-bearing assertion: the file is untouched. Without the
    // fix, this same setup lets the write through (the branch check
    // above already passed, and the file's current bytes match
    // `afterHashes`, so `planLedgerUndo`'s drift check has nothing to
    // catch either) and the pre-edit backup would land here instead.
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(EDITED_SOURCE)
  })

  it("undoes normally when HEAD does not move", async () => {
    const editRes = await editTitleToWorld()
    expect(editRes.status).toBe(200)
    const id = await latestLedgerEntryId()

    // No hook armed — this is the ordinary, no-race path, pinned so the
    // fix above cannot be satisfied by refusing every undo unconditionally.
    const undoRes = await authedFetch(`/api/editor/ledger/${id}/undo`, { method: "POST" })
    expect(undoRes.status).toBe(200)
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(ORIGINAL_SOURCE)
  })
})
