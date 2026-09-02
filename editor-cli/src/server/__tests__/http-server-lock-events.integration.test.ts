import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import {
  projectIdForRepoRoot,
  saveSession,
} from "../../../../src/editor/agent-chat/session-store.js"
import { makeEmptySession } from "../../../../src/editor/agent-chat/types.js"
import {
  __resetWriteChainsForTests,
  appendLockEvent,
} from "../../../../src/editor/edit-service/lock-event-persistence.js"
import type { LockEvent } from "../../../../src/editor/edit-service/file-lock-manager.js"

/**
 * Phase 3 follow-up of tasks/editor-detached-sessions.md — CLI
 * mirror of the lock-events endpoint. Verifies the CLI route
 * behaves identically to the web route per the standing CLAUDE.md
 * "two routes stay behavior-identical" rule.
 *
 * Coverage: auth gate, path-traversal rejection, URL decoding
 * equivalence with web, embedded-slash + decoded-slash guards,
 * happy path with events, empty-events fall-through, cross-project
 * 404.
 */

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let token: string

beforeEach(async () => {
  __resetWriteChainsForTests()
  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")
  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-repo-"))

  const port = await pickFreePort()
  const shellOrigin = `http://127.0.0.1:${port}`
  const security = newSecurityContext(shellOrigin)
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
  __resetWriteChainsForTests()
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

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${token}` }
}

function ev(overrides: Partial<LockEvent> = {}): LockEvent {
  return {
    type: "acquired",
    absPath: "/tmp/x.vue",
    sessionId: "sess-cli-locks",
    waitedMs: 0,
    t: Date.now(),
    ...overrides,
  } as LockEvent
}

describe("GET /api/editor/chat/sessions/:id/lock-events (Phase 3 follow-up)", () => {
  it("returns 401 without a bearer token", async () => {
    const res = await fetch(
      `${handle.url}/api/editor/chat/sessions/any-id/lock-events`,
    )
    expect(res.status).toBe(401)
  })

  it("returns 400 when the id contains a path traversal segment", async () => {
    const res = await fetch(
      `${handle.url}/api/editor/chat/sessions/${encodeURIComponent("../etc/passwd")}/lock-events`,
      { headers: authHeaders() },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { ok: false; reason: string }
    expect(json.reason).toMatch(/UUID-shaped|sessionId/)
  })

  it("returns 400 for a percent-encoded slash that decodes inside the segment", async () => {
    const res = await fetch(
      `${handle.url}/api/editor/chat/sessions/${encodeURIComponent("foo/bar")}/lock-events`,
      { headers: authHeaders() },
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 for malformed percent encoding", async () => {
    const res = await fetch(
      `${handle.url}/api/editor/chat/sessions/%ZZ/lock-events`,
      { headers: authHeaders() },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { ok: false; reason: string }
    expect(json.reason).toMatch(/URL encoding|malformed/i)
  })

  it("decodes percent-encoded ids equivalently to web (404 on missing, not 400)", async () => {
    // %41bcdef decodes to Abcdef — a valid id that matches the
    // pattern. With no session file present, the route should 404,
    // not 400. Matches web behavior.
    const res = await fetch(
      `${handle.url}/api/editor/chat/sessions/%41bcdef/lock-events`,
      { headers: authHeaders() },
    )
    expect(res.status).toBe(404)
  })

  it("returns 404 when the session file does not exist", async () => {
    const res = await fetch(
      `${handle.url}/api/editor/chat/sessions/nonexistent-id/lock-events`,
      { headers: authHeaders() },
    )
    expect(res.status).toBe(404)
    const json = (await res.json()) as { ok: false; reason: string }
    expect(json.ok).toBe(false)
    expect(json.reason).toMatch(/not found/i)
  })

  it("returns 200 with empty events when the session has no persisted lock activity", async () => {
    const projectId = projectIdForRepoRoot(repoDir)
    const session = makeEmptySession(projectId, "sess-cli-empty-locks")
    await saveSession(repoDir, session)

    const res = await fetch(
      `${handle.url}/api/editor/chat/sessions/sess-cli-empty-locks/lock-events`,
      { headers: authHeaders() },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: true; events: LockEvent[] }
    expect(json.ok).toBe(true)
    expect(json.events).toEqual([])
  })

  it("returns 200 with persisted events in submission order", async () => {
    const projectId = projectIdForRepoRoot(repoDir)
    const session = makeEmptySession(projectId, "sess-cli-locks")
    await saveSession(repoDir, session)
    await appendLockEvent(repoDir, "sess-cli-locks", ev({ t: 10, type: "acquire-attempt", queueLength: 0 } as LockEvent))
    await appendLockEvent(repoDir, "sess-cli-locks", ev({ t: 20, type: "acquired" }))
    await appendLockEvent(repoDir, "sess-cli-locks", ev({ t: 30, type: "released", heldMs: 5 } as LockEvent))

    const res = await fetch(
      `${handle.url}/api/editor/chat/sessions/sess-cli-locks/lock-events`,
      { headers: authHeaders() },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: true; events: LockEvent[] }
    expect(json.events.map((e) => e.t)).toEqual([10, 20, 30])
    expect(json.events.map((e) => e.type)).toEqual([
      "acquire-attempt",
      "acquired",
      "released",
    ])
  })

  it("returns 404 when the file's on-disk projectId belongs to a foreign project", async () => {
    const sessionsDir = join(repoDir, ".desde", "chat-sessions")
    await mkdir(sessionsDir, { recursive: true })
    await writeFile(
      join(sessionsDir, "sess-foreign.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: { projectId: "foreignprojhash", sessionId: "sess-foreign" },
        createdAt: "x",
        updatedAt: "y",
        turns: [],
      }),
    )
    // Plant a lock-events file too — verify the route REFUSES to
    // surface it for a foreign-projectId session.
    await appendLockEvent(repoDir, "sess-foreign", ev({ sessionId: "sess-foreign" }))

    const res = await fetch(
      `${handle.url}/api/editor/chat/sessions/sess-foreign/lock-events`,
      { headers: authHeaders() },
    )
    expect(res.status).toBe(404)
  })
})
