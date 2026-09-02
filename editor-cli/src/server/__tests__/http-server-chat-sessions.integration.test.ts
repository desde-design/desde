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

/**
 * Phase 3 of tasks/editor-detached-sessions.md — integration
 * coverage for the new `/api/editor/chat/sessions/:id` detail
 * endpoint. The route returns the full `ChatSession` so the
 * picker's detail panel can render transcripts + tool calls +
 * file lists.
 *
 * Exercises auth, input validation, the not-found path, and the
 * cross-project guard.
 */

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let token: string
let shellOrigin: string

beforeEach(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")
  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-repo-"))

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
  })
})

afterEach(async () => {
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

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${token}` }
}

describe("GET /api/editor/chat/sessions/:id (Phase 3)", () => {
  it("returns 401 without a bearer token", async () => {
    const res = await fetch(`${handle.url}/api/editor/chat/sessions/any-id`)
    expect(res.status).toBe(401)
  })

  it("returns 400 when the id contains a path traversal segment", async () => {
    // URL-encoded ../etc/passwd — the server's `startsWith` slice
    // then sees `..%2Fetc%2Fpasswd` which is a single segment but
    // contains characters outside the allowed pattern.
    const res = await fetch(
      `${handle.url}/api/editor/chat/sessions/${encodeURIComponent("../etc/passwd")}`,
      { headers: authHeaders() },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { ok: false; reason: string }
    expect(json.reason).toMatch(/UUID-shaped|sessionId/)
  })

  it("returns 400 for an embedded slash (multi-segment after /sessions/)", async () => {
    const res = await fetch(
      `${handle.url}/api/editor/chat/sessions/foo/bar`,
      { headers: authHeaders() },
    )
    expect(res.status).toBe(400)
  })

  it("returns 404 when the session file does not exist", async () => {
    const res = await fetch(
      `${handle.url}/api/editor/chat/sessions/nonexistent-id`,
      { headers: authHeaders() },
    )
    expect(res.status).toBe(404)
    const json = (await res.json()) as { ok: false; reason: string }
    expect(json.ok).toBe(false)
    expect(json.reason).toMatch(/not found/i)
  })

  it("returns 200 with the full ChatSession when the file exists", async () => {
    const projectId = projectIdForRepoRoot(repoDir)
    const session = makeEmptySession(projectId, "sess-cli-detail")
    session.turns.push({
      id: "t-1",
      startedAt: "2026-05-24T00:00:00Z",
      completedAt: "2026-05-24T00:00:01Z",
      userMessage: "Refactor the auth middleware",
      assistantContent: [
        { type: "text", text: "Reading the file…" },
        {
          type: "tool_use",
          toolUseId: "tu-1",
          name: "read_file",
          input: { path: "src/middleware.ts" },
        },
      ],
      toolResults: {
        "tu-1": { ok: true, output: { content: "export function …" } },
      },
      editProposals: [],
    })
    await saveSession(repoDir, session)

    const res = await fetch(
      `${handle.url}/api/editor/chat/sessions/sess-cli-detail`,
      { headers: authHeaders() },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: true
      session: {
        id: { sessionId: string; projectId: string }
        turns: Array<{ userMessage: string; assistantContent: Array<{ type: string }> }>
      }
    }
    expect(json.ok).toBe(true)
    expect(json.session.id.sessionId).toBe("sess-cli-detail")
    expect(json.session.id.projectId).toBe(projectId)
    expect(json.session.turns).toHaveLength(1)
    expect(json.session.turns[0].userMessage).toBe(
      "Refactor the auth middleware",
    )
    // Verify the full transcript shape made it through — not a summary.
    expect(json.session.turns[0].assistantContent).toHaveLength(2)
    expect(json.session.turns[0].assistantContent[1].type).toBe("tool_use")
  })

  it("URL-decodes the path segment so percent-encoded ids equivalent to web are accepted (codex round-1 #5)", async () => {
    // Web's Next.js dynamic-segment parser decodes `params.id`
    // before the handler runs. CLI's raw `url.pathname` slice
    // doesn't — without decoding, `%41` (encoded "A") would 400
    // here while the web route would 404 (treats it as "A").
    // The decode aligns the two behaviors. We send a percent-
    // encoded id that decodes to a valid pattern match; the
    // route should reach loadSession and 404 (no such file) —
    // NOT reject as malformed.
    const res = await fetch(
      `${handle.url}/api/editor/chat/sessions/%41bcdef`,
      { headers: authHeaders() },
    )
    // %41bcdef -> Abcdef which matches /^[A-Za-z0-9_-]{1,64}$/.
    // No file exists → 404, not 400.
    expect(res.status).toBe(404)
  })

  it("rejects malformed percent encoding with 400 (defensive)", async () => {
    // decodeURIComponent throws on lone %, %ZZ, etc. The handler
    // catches URIError and 400s rather than crashing.
    const res = await fetch(
      `${handle.url}/api/editor/chat/sessions/%ZZ`,
      { headers: authHeaders() },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { ok: false; reason: string }
    expect(json.reason).toMatch(/URL encoding|malformed/i)
  })

  it("rejects a percent-encoded slash that bypasses the pre-decode guard", async () => {
    // `/sessions/foo%2Fbar` looks like a single segment to the
    // raw pathname.slice + includes('/') check, but decodes to
    // `foo/bar` which we must NOT route to a sessionId. Re-check
    // after decode catches it.
    const res = await fetch(
      `${handle.url}/api/editor/chat/sessions/${encodeURIComponent("foo/bar")}`,
      { headers: authHeaders() },
    )
    expect(res.status).toBe(400)
  })

  it("returns 404 when the file's on-disk projectId belongs to a foreign project", async () => {
    // Plant a session file at the right path with a hand-crafted
    // payload whose projectId belongs to a different prototype.
    // normalizeLoadedSession rejects it → fresh schema-mismatch →
    // route returns 404 (no silent leakage across prototypes).
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
    const res = await fetch(
      `${handle.url}/api/editor/chat/sessions/sess-foreign`,
      { headers: authHeaders() },
    )
    expect(res.status).toBe(404)
  })
})
