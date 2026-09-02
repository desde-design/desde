/**
 * The SDK chat lane and the `/api/editor/edit` route must serialize on the
 * SAME per-file lock (audit Task 13).
 *
 * The Agent SDK executes its built-in `Write`/`Edit` inside its own runtime,
 * so Editor's only bracketing points are the `PreToolUse` / `PostToolUse`
 * hooks. `createSdkWriteGuard` takes the CLI's per-file edit lock in the pre-
 * hook and holds it until the post-hook; the acquirer is injected by
 * `chat-handler.ts` as `acquireFileEditLock(repoRoot, …)` so the key lands in
 * the same namespace the edit route's `withFileEditLocks` uses.
 *
 * This test wires the REAL guard to the REAL lock and drives the REAL HTTP
 * edit route, proving three things end to end:
 *   1. while a chat write holds `App.vue`, a route edit to `App.vue` cannot
 *      land (the lost-update window Task 13 closes),
 *   2. a route edit to a DIFFERENT file is unaffected (Task 11's per-file
 *      scope survives — the guard doesn't reintroduce a repo-wide mutex), and
 *   3. releasing the hook's hold leaves no lock state behind.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSdkWriteGuard } from "../../../../src/editor/agent-chat-sdk/sdk-write-guard.js"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import {
  _inspectCliLocksForTests,
  _resetCliSessionLockForTests,
  acquireFileEditLock,
} from "../session-lock.js"
import type { ApplicatorLoaders } from "../edit-handler.js"

const SOURCE = ["<template>", '  <KInput placeholder="Search" />', "</template>"].join("\n")
const EDITED = SOURCE.replace("Search", "Filter")

const HOOK_ARGS = { signal: new AbortController().signal }

function preToolUseInput(target: string, toolUseId: string): unknown {
  return {
    hook_event_name: "PreToolUse",
    session_id: "s",
    transcript_path: "/dev/null",
    cwd: "/",
    tool_name: "Write",
    tool_input: { file_path: target, content: "agent output" },
    tool_use_id: toolUseId,
  }
}

function postToolUseInput(toolUseId: string): unknown {
  return {
    hook_event_name: "PostToolUse",
    session_id: "s",
    transcript_path: "/dev/null",
    cwd: "/",
    tool_name: "Write",
    tool_input: {},
    tool_response: {},
    tool_use_id: toolUseId,
  }
}

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

/** Deterministic prop applicator — the fast lane, no LLM, no mini-turn. */
function makeLoaders(): ApplicatorLoaders {
  return {
    loadApplyPropEdit: async () => ({
      applyPropEdit: ({ source }: { source: string }) => ({
        ok: true as const,
        source: source.replace("Search", "Filter"),
      }),
    }),
    loadApplyMoveEdit: async () => ({ applyMoveEdit: () => ({ ok: false, reason: "stub" }) }),
    loadApplyDetachEdit: async () => ({
      applyDetachEdit: () => ({ ok: false, reason: "stub" }),
    }),
    loadStyleGrounding: async () => ({
      loadStyleGrounding: () => ({ tokens: [], classTaxonomy: [], preprocessor: "css" as const }),
    }),
  } as unknown as ApplicatorLoaders
}

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let repoReal: string
let token: string
let shellOrigin: string

function authedFetch(path: string, body: unknown): Promise<Response> {
  return fetch(`${handle.url}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: shellOrigin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

function propEdit(file: string): unknown {
  return {
    edit: { kind: "prop", file, line: 2, column: 3, propName: "placeholder", value: "Filter" },
  }
}

beforeEach(async () => {
  _resetCliSessionLockForTests()
  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-guardlock-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-guardlock-repo-"))
  repoReal = await realpath(repoDir)
  await writeFile(join(repoDir, "App.vue"), SOURCE, "utf8")
  await writeFile(join(repoDir, "Other.vue"), SOURCE, "utf8")
  execFileSync("git", ["init", "-q"], { cwd: repoDir })
  execFileSync("git", ["add", "-A"], { cwd: repoDir })
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"],
    { cwd: repoDir },
  )

  const serverPort = await pickFreePort()
  const shellPort = await pickFreePort()
  shellOrigin = `http://127.0.0.1:${shellPort}`
  const security = newSecurityContext(shellOrigin)
  token = security.token

  handle = await startHttpServer({
    host: "127.0.0.1",
    port: serverPort,
    repoRoot: repoDir,
    uiBundleRoot: bundleDir,
    viteUrl: "http://localhost:5173",
    security,
    applicatorLoaders: makeLoaders(),
  })
})

afterEach(async () => {
  await handle.close()
  await rm(bundleDir, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
  _resetCliSessionLockForTests()
})

describe("SDK write guard ↔ /api/editor/edit serialization", () => {
  it("blocks a route edit to the file a chat write holds, and releases it on PostToolUse", async () => {
    const guard = createSdkWriteGuard({
      worktreeRoot: repoDir,
      // Exactly what chat-handler.ts injects.
      acquireWriteLock: (repoRelPath) => acquireFileEditLock(repoDir, repoRelPath),
    })

    // The chat lane's PreToolUse — journals App.vue and takes its edit lock.
    await guard.preToolUse(
      preToolUseInput(join(repoReal, "App.vue"), "tu-1") as never,
      "tu-1",
      HOOK_ARGS,
    )
    expect(guard.heldPathsForTests()).toEqual(["App.vue"])

    // A route edit to the SAME file must not land while the hold is open.
    let sameFileSettled = false
    const sameFile = authedFetch("/api/editor/edit", propEdit("App.vue")).then((r) => {
      sameFileSettled = true
      return r
    })

    // …while a DIFFERENT file is unaffected (Task 11's per-file scope).
    const otherRes = await authedFetch("/api/editor/edit", propEdit("Other.vue"))
    expect(otherRes.status).toBe(200)
    expect(await readFile(join(repoDir, "Other.vue"), "utf8")).toBe(EDITED)

    await new Promise((r) => setTimeout(r, 250))
    expect(sameFileSettled).toBe(false)
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(SOURCE)

    // Release the hold the way the SDK's PostToolUse would.
    await guard.release(postToolUseInput("tu-1") as never, "tu-1", HOOK_ARGS)

    const res = await sameFile
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(EDITED)

    // No lock state survives.
    expect(guard.heldPathsForTests()).toEqual([])
    const locks = _inspectCliLocksForTests()
    expect(locks.queueKeys).toEqual([])
    expect(locks.gateKeys).toEqual([])
  })

  it("leaves no lock state behind when the turn-end sweep is the only release", async () => {
    const guard = createSdkWriteGuard({
      worktreeRoot: repoDir,
      acquireWriteLock: (repoRelPath) => acquireFileEditLock(repoDir, repoRelPath),
      onWarn: () => {},
    })
    await guard.preToolUse(
      preToolUseInput(join(repoReal, "App.vue"), "tu-1") as never,
      "tu-1",
      HOOK_ARGS,
    )
    expect(_inspectCliLocksForTests().gateKeys).toHaveLength(1)

    // Simulate the crash path: no PostToolUse, only `releaseAll` from
    // runChatTurnSdk's finally.
    guard.releaseAll("turn end")
    await new Promise((r) => setTimeout(r, 0))

    const locks = _inspectCliLocksForTests()
    expect(locks.queueKeys).toEqual([])
    expect(locks.gateKeys).toEqual([])

    // …and the route can write the file again.
    const res = await authedFetch("/api/editor/edit", propEdit("App.vue"))
    expect(res.status).toBe(200)
    expect(await readFile(join(repoDir, "App.vue"), "utf8")).toBe(EDITED)
  })
})
