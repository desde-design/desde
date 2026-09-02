/**
 * P1-2 (codex review round 7, SECURITY) — an INTERMEDIATE directory swap
 * defeats round 6's `O_NOFOLLOW` fix in `createRealUndoDeps`'s `readBackup`
 * (`../http-server.ts`).
 *
 * Round 6 closed the case where the backup FILE itself (the final path
 * component) gets swapped for a symlink between `resolveContainedBackupPath`'s
 * containment check and the read, by opening with `O_NOFOLLOW` and reading
 * through that same handle. `O_NOFOLLOW` only inspects the FINAL path
 * component, though — it says nothing about an INTERMEDIATE one. This file
 * drives that exact gap: the `backupDir` component itself
 * (`.desde/backups/<uuid>`) gets replaced with a symlink to an
 * external directory in the window between the containment check returning
 * and the `open()` call. `open()` re-walks the WHOLE path string, following
 * the swapped intermediate exactly like a shell would, and lands on
 * whatever the attacker's directory points at — a REAL, non-symlink file at
 * that point, so `O_NOFOLLOW` on the final component never sees anything
 * wrong.
 *
 * Same technique as `ledger-undo-backup-race.test.ts` (round 6): there is
 * no way to make two real OS threads race inside a single-threaded Node
 * test both deterministically and portably, so this hooks the precise seam
 * where the read's `open` call begins and performs the attacker's swap
 * there, as a side effect of that call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const raceHookState = vi.hoisted(() => ({
  current: null as { targetPath: string; backupDirPath: string; symlinkTo: string } | null,
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  const open: typeof actual.open = async (path, flags, mode) => {
    const hook = raceHookState.current
    if (hook !== null && path === hook.targetPath) {
      // One-shot: fires exactly once, exactly like a single attacker
      // action landing in a single race window — not a persistent
      // interception of every future open of this path. Swaps the
      // INTERMEDIATE backupDir itself (not the leaf `path` being
      // opened) — the leaf name inside the symlinked-to directory is
      // real and non-symlink, so `O_NOFOLLOW` on `path`'s own open
      // never sees anything to refuse.
      raceHookState.current = null
      await actual.rm(hook.backupDirPath, { recursive: true, force: true })
      await actual.symlink(hook.symlinkTo, hook.backupDirPath)
    }
    return actual.open(path, flags, mode)
  }
  return { ...actual, open }
})

function installOpenRaceHook(targetPath: string, backupDirPath: string, symlinkTo: string): void {
  raceHookState.current = { targetPath, backupDirPath, symlinkTo }
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

  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerundo-dirrace-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerundo-dirrace-repo-"))
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

describe("backup INTERMEDIATE-directory swap TOCTOU (P1-2, codex review round 7, SECURITY)", () => {
  it("refuses undo when the backupDir itself is swapped for a symlink between the containment check and the read", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgerundo-dirrace-secret-"))
    try {
      const secretContent = "-----BEGIN OPENSSH PRIVATE KEY-----\nSUPER SECRET FROM OUTSIDE\n-----END-----\n"
      // Same LEAF NAME as the real backup file — the whole point of this
      // exploit shape is that `O_NOFOLLOW` on the final component sees a
      // perfectly ordinary regular file, because the redirection happened
      // one level up, at the directory the leaf lives inside.
      await writeFile(join(outsideDir, "App.vue"), secretContent)

      const editRes = await editTitleToWorld()
      expect(editRes.status).toBe(200)
      const editedContent = await readFile(join(repoDir, "App.vue"), "utf8")

      const entry = await latestLedgerEntry()
      if (!entry.backupDir) throw new Error("expected a real backup for this edit")

      const realRepoRoot = await realpath(repoDir)
      const backupDirPath = join(realRepoRoot, entry.backupDir)
      const backupFilePath = join(backupDirPath, "App.vue")

      // Confirm the setup: at this point the backup directory is a real
      // directory, not a symlink — the hook below is what turns it into
      // one, not this line.
      expect((await lstat(backupDirPath)).isDirectory()).toBe(true)
      expect((await lstat(backupDirPath)).isSymbolicLink()).toBe(false)

      // Arms the swap to fire the FIRST time production code opens the
      // backup file's leaf path — i.e. exactly at the seam between
      // `resolveContainedBackupPath`'s realpath validation (already run
      // and already passed by the time `readBackup` calls `open`) and the
      // read that follows it. The swap replaces the DIRECTORY the leaf
      // lives in, not the leaf itself.
      installOpenRaceHook(backupFilePath, backupDirPath, outsideDir)

      const undoRes = await authedFetch(`/api/editor/ledger/${entry.id}/undo`, {
        method: "POST",
      })

      // The hook is one-shot and only fires on a real production `open`
      // call — if this is still armed, the test never exercised the race
      // at all, and a green run would prove nothing.
      expect(raceHookState.current).toBeNull()

      expect(undoRes.status).not.toBe(200)

      // The load-bearing assertion: the external secret never landed in
      // the repo. Before this fix, `O_NOFOLLOW` on the leaf's own open
      // would have let this through — the swap happened one directory
      // level up, invisible to a check that only inspects the final path
      // component — and `readFileAsync`/`handle.readFile()` would have
      // returned `secretContent`, which Undo would then have written into
      // App.vue as the "restored" content.
      const appContent = await readFile(join(repoDir, "App.vue"), "utf8")
      expect(appContent).not.toContain("SUPER SECRET")
      // Undo was refused entirely, so the file is untouched from whatever
      // the edit above left it as.
      expect(appContent).toBe(editedContent)
      // And the external file itself was never touched.
      expect(await readFile(join(outsideDir, "App.vue"), "utf8")).toBe(secretContent)
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })
})
