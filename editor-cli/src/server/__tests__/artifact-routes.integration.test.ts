/**
 * End-to-end integration coverage for the artifact-store routes
 * (comments, notes, canvases).
 *
 * Unit tests cover the local-file stores in isolation. This test
 * proves the routing wires them through correctly — the right
 * handler runs, the bearer + Origin policy is applied, request
 * bodies make it through, and the response shape matches the
 * handler contract.
 *
 * Same pattern as http-server-mcp.integration.test.ts: boot a real
 * `http.Server`, hit it with `fetch`, tear down. Heavier than a
 * unit test but the routing seam is the most likely to bit-rot.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let token: string
let shellOrigin: string

beforeEach(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-artifact-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-artifact-repo-"))
  await mkdir(repoDir, { recursive: true })

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
    // Notes went dormant 2026-08-14 (`editor.notes`, refused by the route
    // while off). Dormancy covers the product surface and never the gate, so
    // the store's own round-trip coverage keeps running with it ON. The gate
    // itself is proven in `http-server-dormant-surfaces.integration.test.ts`,
    // which asserts both halves over the same socket.
    // Canvas went dormant 2026-08-04 and its ROUTES were gated 2026-09-01,
    // for the same reason and on the same terms. Same rule applies: the
    // store's round-trip coverage runs with the surface ON, and the gate is
    // proven next door.
    editor: { notes: true, canvas: true },
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

function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: shellOrigin,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })
}

describe("auth", () => {
  it("rejects state-changing requests without a bearer token (401/403)", async () => {
    const res = await fetch(`${handle.url}/api/editor/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: shellOrigin },
      body: JSON.stringify({}),
    })
    expect([401, 403]).toContain(res.status)
  })

  it("allows GET list endpoints without Origin (read-only-GET exception)", async () => {
    // Same precedent as icon-sets / chat-sessions: browsers omit
    // Origin on same-origin GETs. Bearer is still required.
    const res = await fetch(`${handle.url}/api/editor/comments`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })
})

describe("/api/editor/comments", () => {
  it("round-trips create / list / update / delete", async () => {
    // Create
    const createRes = await authedFetch(`${handle.url}/api/editor/comments`, {
      method: "POST",
      body: JSON.stringify({
        position: { anchorSelector: ".btn", page: "/login" },
        body: "looks off",
        author: {
          uid: "u1",
          displayName: "Mo",
          email: "mo@example.com",
          photoURL: "",
        },
      }),
    })
    expect(createRes.status).toBe(201)
    const { comment } = (await createRes.json()) as { comment: { id: string; number: number } }
    expect(comment.number).toBe(1)

    // List
    const listRes = await authedFetch(`${handle.url}/api/editor/comments`)
    expect(listRes.status).toBe(200)
    const listed = (await listRes.json()) as { comments: { id: string }[] }
    expect(listed.comments).toHaveLength(1)
    expect(listed.comments[0].id).toBe(comment.id)

    // Update
    const patchRes = await authedFetch(
      `${handle.url}/api/editor/comments/${comment.id}`,
      { method: "PATCH", body: JSON.stringify({ resolved: true }) },
    )
    expect(patchRes.status).toBe(200)
    const patched = (await patchRes.json()) as { comment: { resolved: boolean } }
    expect(patched.comment.resolved).toBe(true)

    // Delete
    const deleteRes = await authedFetch(
      `${handle.url}/api/editor/comments/${comment.id}`,
      { method: "DELETE" },
    )
    expect(deleteRes.status).toBe(200)

    const finalList = await authedFetch(`${handle.url}/api/editor/comments`)
    expect(((await finalList.json()) as { comments: unknown[] }).comments).toEqual([])
  })

  it("rejects creates with missing required fields (400)", async () => {
    const res = await authedFetch(`${handle.url}/api/editor/comments`, {
      method: "POST",
      body: JSON.stringify({ body: "no position" }),
    })
    expect(res.status).toBe(400)
  })

  it("returns 404 for unknown ids", async () => {
    const res = await authedFetch(`${handle.url}/api/editor/comments/nope`)
    expect(res.status).toBe(404)
  })

  it("returns 405 for unsupported methods", async () => {
    const res = await authedFetch(`${handle.url}/api/editor/comments`, {
      method: "DELETE",
    })
    expect(res.status).toBe(405)
  })

  it("appends replies", async () => {
    const author = {
      uid: "u1",
      displayName: "Mo",
      email: "mo@example.com",
      photoURL: "",
    }
    const created = (await (
      await authedFetch(`${handle.url}/api/editor/comments`, {
        method: "POST",
        body: JSON.stringify({
          position: { anchorSelector: ".x", page: "/" },
          body: "x",
          author,
        }),
      })
    ).json()) as { comment: { id: string } }

    const replied = (await (
      await authedFetch(
        `${handle.url}/api/editor/comments/${created.comment.id}/replies`,
        {
          method: "POST",
          body: JSON.stringify({ body: "agree", author }),
        },
      )
    ).json()) as { comment: { replies: unknown[] } }
    expect(replied.comment.replies).toHaveLength(1)
  })
})

describe("/api/editor/notes", () => {
  it("round-trips a note through HTTP (separate from comments)", async () => {
    const author = {
      uid: "u1",
      displayName: "Mo",
      email: "mo@example.com",
      photoURL: "",
    }
    const noteRes = await authedFetch(`${handle.url}/api/editor/notes`, {
      method: "POST",
      body: JSON.stringify({
        position: { anchorSelector: ".banner", page: "/home" },
        body: "remember this",
        author,
      }),
    })
    expect(noteRes.status).toBe(201)

    const list = (await (
      await authedFetch(`${handle.url}/api/editor/notes`)
    ).json()) as { notes: unknown[] }
    expect(list.notes).toHaveLength(1)

    // Confirm comments collection is independent.
    const comments = (await (
      await authedFetch(`${handle.url}/api/editor/comments`)
    ).json()) as { comments: unknown[] }
    expect(comments.comments).toEqual([])
  })
})

describe("/api/editor/canvases", () => {
  it("round-trips canvas + nested resources", async () => {
    // Create canvas
    const canvasRes = await authedFetch(`${handle.url}/api/editor/canvases`, {
      method: "POST",
      body: JSON.stringify({ name: "Login flow canvas" }),
    })
    expect(canvasRes.status).toBe(201)
    const { canvas } = (await canvasRes.json()) as { canvas: { id: string } }

    // Create a frame
    const frameRes = await authedFetch(
      `${handle.url}/api/editor/canvases/${canvas.id}/frames`,
      {
        method: "POST",
        body: JSON.stringify({
          label: "Home",
          capturedUrl: "/",
          baseUrl: "http://localhost:5173",
          layout: { x: 0, y: 0, width: 960, height: 540 },
        }),
      },
    )
    expect(frameRes.status).toBe(201)
    const { frame } = (await frameRes.json()) as { frame: { id: string } }

    // Create a comment annotation (coordinate-anchored)
    const annoRes = await authedFetch(
      `${handle.url}/api/editor/canvases/${canvas.id}/annotations`,
      {
        method: "POST",
        body: JSON.stringify({
          kind: "comment",
          position: { x: 200, y: 300 },
          size: { width: 32, height: 32 },
          body: "looks off",
        }),
      },
    )
    expect(annoRes.status).toBe(201)

    // Confirm list endpoints return the right shapes
    const frames = (await (
      await authedFetch(`${handle.url}/api/editor/canvases/${canvas.id}/frames`)
    ).json()) as { frames: { id: string }[] }
    expect(frames.frames).toHaveLength(1)
    expect(frames.frames[0].id).toBe(frame.id)

    const annotations = (await (
      await authedFetch(
        `${handle.url}/api/editor/canvases/${canvas.id}/annotations`,
      )
    ).json()) as { annotations: unknown[] }
    expect(annotations.annotations).toHaveLength(1)

    // Delete the canvas — cascades to frames/annotations
    const delRes = await authedFetch(
      `${handle.url}/api/editor/canvases/${canvas.id}`,
      { method: "DELETE" },
    )
    expect(delRes.status).toBe(200)

    const remaining = (await (
      await authedFetch(`${handle.url}/api/editor/canvases`)
    ).json()) as { canvases: unknown[] }
    expect(remaining.canvases).toEqual([])
  })

  it("refuses to create a frame against an unknown canvas (404)", async () => {
    const res = await authedFetch(
      `${handle.url}/api/editor/canvases/missing/frames`,
      {
        method: "POST",
        body: JSON.stringify({
          label: "x",
          capturedUrl: "/",
          baseUrl: "http://x",
          layout: { x: 0, y: 0, width: 1, height: 1 },
        }),
      },
    )
    expect(res.status).toBe(404)
  })

  // Codex round-1: nested canvas routes used to ignore extra path
  // segments — DELETE /canvases/:id/frames/:frameId/anything would
  // delete :frameId. Now blocked at the segment-count check.
  it("rejects extra trailing segments on nested canvas routes (404)", async () => {
    const canvasRes = await authedFetch(`${handle.url}/api/editor/canvases`, {
      method: "POST",
      body: JSON.stringify({ name: "C" }),
    })
    const { canvas } = (await canvasRes.json()) as { canvas: { id: string } }
    const res = await authedFetch(
      `${handle.url}/api/editor/canvases/${canvas.id}/frames/some-frame-id/extra`,
      { method: "DELETE" },
    )
    expect(res.status).toBe(404)
  })

  // Codex round-1: handler validators reject obviously malformed
  // input rather than persisting half-formed annotations.
  it("rejects malformed annotation create with 400", async () => {
    const { canvas } = (await (
      await authedFetch(`${handle.url}/api/editor/canvases`, {
        method: "POST",
        body: JSON.stringify({ name: "C" }),
      })
    ).json()) as { canvas: { id: string } }
    const res = await authedFetch(
      `${handle.url}/api/editor/canvases/${canvas.id}/annotations`,
      {
        method: "POST",
        body: JSON.stringify({
          kind: "bogus",
          position: {},
          size: {},
          body: "x",
        }),
      },
    )
    expect(res.status).toBe(400)
  })
})

// Codex round-1 regression tests for the bug fixes.
describe("codex round-1 fixes", () => {
  it("returns 400 (not 500) on malformed JSON", async () => {
    const res = await fetch(`${handle.url}/api/editor/comments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: shellOrigin,
        "Content-Type": "application/json",
      },
      body: "{not valid",
    })
    expect(res.status).toBe(400)
  })

  it("returns 413 when the body exceeds the default cap", async () => {
    // Default cap is 256 KiB. Send 300 KiB.
    const huge = "x".repeat(300 * 1024)
    const res = await fetch(`${handle.url}/api/editor/comments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: shellOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ giant: huge }),
    })
    expect(res.status).toBe(413)
  })

})
