/**
 * P1 (codex review round 6, SECURITY) — the read-side TOCTOU in
 * `createRealUndoDeps`'s `readBackup` (`../http-server.ts`).
 *
 * Round 5 closed the LEXICAL/symlink-at-request-time path-traversal
 * hole (`ledger-undo-route.test.ts`'s "backupDir path-traversal exploit"
 * describe block) by realpath-containing `backupDir` before any
 * stat/read. That check validates a PATH STRING. The round-5 `readBackup`
 * then did a completely separate `readFileAsync(real)` against that same
 * string — two independent filesystem operations with a gap between
 * them. A process inside the repo can replace the regular backup file
 * with a symlink to an arbitrary host file in exactly that gap;
 * `readFileAsync` follows symlinks, so the read would follow the swap
 * and Undo would copy the external file's bytes into the repo.
 *
 * This file drives that exact race DETERMINISTICALLY rather than only
 * testing the guard in isolation. There is no way to make two real OS
 * threads race inside a single-threaded Node test in a way that is both
 * deterministic and portable — so instead this hooks the precise seam
 * where the second operation (the open/read) begins, and performs the
 * attacker's swap there, as a side effect of THAT call. That is exactly
 * the interleaving the real bug required: the containment check has
 * already returned "safe" by the time the swap lands, and the read is
 * what has to prove that answer no longer applies.
 *
 * `node:fs/promises` is mocked file-wide (delegating to the real
 * implementation for everything except one intercepted `open` call) so
 * the swap can be injected without changing production code's control
 * flow. `raceHookState` is built via `vi.hoisted` — a plain module-level
 * `let` closed over by the `vi.mock` factory below is a documented
 * Vitest hazard (the factory is hoisted above the rest of the file, so a
 * non-hoisted outer binding it references is not safely established
 * yet); `vi.hoisted` is the sanctioned way to share mutable state with a
 * mock factory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const raceHookState = vi.hoisted(() => ({
  current: null as { targetPath: string; symlinkTo: string } | null,
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  const open: typeof actual.open = async (path, flags, mode) => {
    const hook = raceHookState.current
    if (hook !== null && path === hook.targetPath) {
      // One-shot: fires exactly once, exactly like a single attacker
      // action landing in a single race window — not a persistent
      // interception of every future open of this path.
      raceHookState.current = null
      await actual.unlink(hook.targetPath)
      await actual.symlink(hook.symlinkTo, hook.targetPath)
    }
    return actual.open(path, flags, mode)
  }
  return { ...actual, open }
})

function installOpenRaceHook(targetPath: string, symlinkTo: string): void {
  raceHookState.current = { targetPath, symlinkTo }
}

function clearOpenRaceHook(): void {
  raceHookState.current = null
}

import { execFile } from "node:child_process"
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
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

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let token: string
let shellOrigin: string

beforeEach(async () => {
  clearOpenRaceHook()

  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerundo-race-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerundo-race-repo-"))
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
  clearOpenRaceHook()
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
 * ledger entry — and its backup — are genuine, same as production. */
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

async function latestLedgerEntry(): Promise<{ id: string; backupDir?: string }> {
  const res = await authedFetch("/api/editor/ledger")
  const json = (await res.json()) as { entries: { id: string; backupDir?: string }[] }
  return json.entries[0]
}

describe("backup read TOCTOU (P1, codex review round 6, SECURITY)", () => {
  it("refuses undo when the backup file is swapped for a symlink between the containment check and the read", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerundo-race-secret-"))
    try {
      const secretContent = "-----BEGIN OPENSSH PRIVATE KEY-----\nSUPER SECRET\n-----END-----\n"
      const secretPath = join(outsideDir, "id_rsa")
      await writeFile(secretPath, secretContent)

      const editRes = await editTitleToWorld()
      expect(editRes.status).toBe(200)
      const editedContent = await readFile(join(repoDir, "App.vue"), "utf8")

      const entry = await latestLedgerEntry()
      if (!entry.backupDir) throw new Error("expected a real backup for this edit")

      // The exact real path `readBackup` will open — same containment
      // resolution production code does (realpath the repo root, then
      // join the (already-validated, already-real) `backupDir` onto it).
      const realRepoRoot = await realpath(repoDir)
      const backupFilePath = join(realRepoRoot, entry.backupDir, "App.vue")

      // Confirm the setup: at this point it's a genuine regular file —
      // the hook below is what turns it into a symlink, not this line.
      expect((await lstat(backupFilePath)).isSymbolicLink()).toBe(false)

      // Arms the swap to fire the FIRST time production code opens this
      // exact path — i.e. exactly at the seam between
      // `resolveContainedBackupPath`'s realpath validation (already run
      // and already passed by the time `readBackup` calls `open`) and
      // the read that follows it.
      installOpenRaceHook(backupFilePath, secretPath)

      const undoRes = await authedFetch(`/api/editor/ledger/${entry.id}/undo`, {
        method: "POST",
      })

      // The hook is one-shot and only fires on a real production `open`
      // call — if this is still armed, the test never exercised the
      // race at all, and a green run would prove nothing.
      expect(raceHookState.current).toBeNull()

      expect(undoRes.status).not.toBe(200)

      // The load-bearing assertion: the external secret never landed in
      // the repo. Before the fix (`readFileAsync(real)` on a second,
      // separate path lookup), this would read `secretContent` — the
      // symlink swap would have been followed and its target's bytes
      // written into App.vue as the "restored" content.
      const appContent = await readFile(join(repoDir, "App.vue"), "utf8")
      expect(appContent).not.toContain("SUPER SECRET")
      // Undo was refused entirely, so the file is untouched from
      // whatever the edit above left it as.
      expect(appContent).toBe(editedContent)
      // And the external file itself was never touched.
      expect(await readFile(secretPath, "utf8")).toBe(secretContent)
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })
})
