/**
 * Tests for the HTTP-backed artifact store clients.
 *
 * Mocks `fetch` directly to keep the surface small. Each test
 * verifies: (a) the right URL + method + body get sent, (b) the
 * response is parsed correctly, (c) error responses become typed
 * `ArtifactStoreError` throws (or `null` from `get` on the
 * server's "not found" envelope).
 *
 * No live server is started — that's covered by the route-level
 * integration tests in editor-cli.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ArtifactStoreError,
  createHttpCanvasStore,
  createHttpCommentStore,
  createHttpNoteStore,
  createHttpScreenshotPlanStore,
  isArtifactStoreError,
  isMissingArtifactError,
} from "."

type FetchSig = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

let fetchMock: ReturnType<typeof vi.fn<FetchSig>>
let realFetch: typeof fetch

beforeEach(() => {
  fetchMock = vi.fn<FetchSig>()
  realFetch = global.fetch
  global.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  global.fetch = realFetch
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function expectRequest(call: Parameters<FetchSig>): {
  url: string
  method: string
  headers: Headers
  body: unknown
} {
  const [input, init] = call
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
  const method = init?.method ?? "GET"
  const headers = new Headers(init?.headers)
  const rawBody = init?.body
  const body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody
  return { url, method, headers, body }
}

const sampleAuthor = {
  uid: "u1",
  displayName: "Mo",
  email: "mo@example.com",
  photoURL: "",
}

describe("createHttpCommentStore", () => {
  it("list calls GET /api/editor/comments and unwraps `comments`", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { ok: true, comments: [{ id: "c1" }] }),
    )
    const store = createHttpCommentStore()
    const result = await store.list()
    expect(result).toEqual([{ id: "c1" }])

    const req = expectRequest(fetchMock.mock.calls[0])
    expect(req.url).toBe("/api/editor/comments")
    expect(req.method).toBe("GET")
  })

  it("create POSTs the input body and returns the created comment", async () => {
    const created = { id: "c1", number: 1 }
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, { ok: true, comment: created }),
    )
    const store = createHttpCommentStore()
    const result = await store.create({
      position: { anchorSelector: ".btn", page: "/login" },
      body: "x",
      author: sampleAuthor,
    })
    expect(result).toEqual(created)

    const req = expectRequest(fetchMock.mock.calls[0])
    expect(req.method).toBe("POST")
    expect(req.headers.get("Content-Type")).toBe("application/json")
    expect(req.body).toMatchObject({ body: "x" })
  })

  // Codex round-3: only the server's "X not found" envelope should
  // collapse to null. A 404 from a route typo or proxy fallback
  // surfaces as a real error so the regression is visible.
  it("get returns null only when the server reports 'not found'", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, { ok: false, reason: "Comment xyz not found" }),
    )
    const store = createHttpCommentStore()
    expect(await store.get("xyz")).toBeNull()
  })

  it("get throws for non-'not found' 404s (route typo, proxy etc.)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, { ok: false, reason: "Unknown API endpoint" }),
    )
    const store = createHttpCommentStore()
    await expect(store.get("xyz")).rejects.toThrow(ArtifactStoreError)
  })

  it("get throws ArtifactStoreError on non-404 errors", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(500, { ok: false, reason: "boom" }),
    )
    const store = createHttpCommentStore()
    await expect(store.get("abc")).rejects.toThrow(ArtifactStoreError)
  })

  it("update sends PATCH with the patch body", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { ok: true, comment: { id: "c1", resolved: true } }),
    )
    const store = createHttpCommentStore()
    await store.update("c1", { resolved: true })

    const req = expectRequest(fetchMock.mock.calls[0])
    expect(req.method).toBe("PATCH")
    expect(req.url).toBe("/api/editor/comments/c1")
    expect(req.body).toEqual({ resolved: true })
  })

  it("delete sends DELETE and ignores empty body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    const store = createHttpCommentStore()
    await store.delete("c1")

    const req = expectRequest(fetchMock.mock.calls[0])
    expect(req.method).toBe("DELETE")
    expect(req.url).toBe("/api/editor/comments/c1")
  })

  it("addReply POSTs to /:id/replies", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        ok: true,
        comment: { id: "c1", replies: [{ id: "r1" }] },
      }),
    )
    const store = createHttpCommentStore()
    await store.addReply("c1", { body: "agree", author: sampleAuthor })

    const req = expectRequest(fetchMock.mock.calls[0])
    expect(req.url).toBe("/api/editor/comments/c1/replies")
    expect(req.method).toBe("POST")
    expect(req.body).toMatchObject({ body: "agree" })
  })

  // Codex round-3: validate response shape, surface malformed
  // payloads as typed errors instead of returning `undefined`.
  it("throws when the server returns ok:true without `comments`", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    const store = createHttpCommentStore()
    await expect(store.list()).rejects.toThrow(/comments/i)
  })

  it("throws when the server returns `comments: null`", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { ok: true, comments: null }),
    )
    const store = createHttpCommentStore()
    await expect(store.list()).rejects.toThrow(/comments/i)
  })

  // Codex round-3: reject path-traversal-shaped ids at the client
  // boundary so URL normalization can't drag the fetch outside
  // the intended route.
  it("rejects '..' id with a TypeError before issuing the fetch", async () => {
    const store = createHttpCommentStore()
    await expect(store.get("..")).rejects.toThrow(TypeError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects ids containing '/' before issuing the fetch", async () => {
    const store = createHttpCommentStore()
    await expect(store.get("foo/bar")).rejects.toThrow(TypeError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("createHttpNoteStore", () => {
  it("list calls GET /api/editor/notes and unwraps `notes`", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { ok: true, notes: [{ id: "n1" }] }),
    )
    const store = createHttpNoteStore()
    const result = await store.list()
    expect(result).toEqual([{ id: "n1" }])
    expect(expectRequest(fetchMock.mock.calls[0]).url).toBe(
      "/api/editor/notes",
    )
  })
})

describe("createHttpScreenshotPlanStore", () => {
  it("list reads the plans array", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        plans: [
          { id: "p1", name: "All screens", baseUrl: "x", source: "route-enumeration", steps: [], createdAt: "t" },
        ],
      }),
    )
    const store = createHttpScreenshotPlanStore()
    const result = await store.list()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("p1")
    expect(expectRequest(fetchMock.mock.calls[0]).url).toBe(
      "/api/editor/screenshot-plans",
    )
  })

  it("createFromRoutes POSTs to the enumeration endpoint and returns plan + skipped", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        ok: true,
        plan: { id: "p2", name: "All screens", baseUrl: "u", source: "route-enumeration", steps: [], createdAt: "t" },
        skipped: [{ path: "/users/:id", why: "dynamic" }],
      }),
    )
    const store = createHttpScreenshotPlanStore()
    const result = await store.createFromRoutes({ baseUrl: "http://localhost:5173" })
    expect(result.plan.id).toBe("p2")
    expect(result.skipped).toEqual([{ path: "/users/:id", why: "dynamic" }])

    const req = expectRequest(fetchMock.mock.calls[0])
    expect(req.url).toBe("/api/editor/screenshot-plans/route-enumeration")
    expect(req.method).toBe("POST")
    expect(req.body).toEqual({ baseUrl: "http://localhost:5173" })
  })

  it("get returns null on the server's not-found envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, { ok: false, reason: "Screenshot plan nope not found" }),
    )
    const store = createHttpScreenshotPlanStore()
    expect(await store.get("nope")).toBeNull()
  })
})

describe("createHttpCanvasStore", () => {
  it("creates a canvas and posts the right body", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        ok: true,
        canvas: { id: "canv-1", name: "C", projectId: "local" },
      }),
    )
    const store = createHttpCanvasStore()
    const result = await store.createCanvas({ name: "C" })
    expect(result.id).toBe("canv-1")

    const req = expectRequest(fetchMock.mock.calls[0])
    expect(req.url).toBe("/api/editor/canvases")
    expect(req.method).toBe("POST")
    expect(req.body).toEqual({ name: "C" })
  })

  it("getCanvas returns null on the server's 'not found' envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, { ok: false, reason: "Canvas canv-1 not found" }),
    )
    const store = createHttpCanvasStore()
    expect(await store.getCanvas("canv-1")).toBeNull()
  })

  it("rejects '..' canvasId on nested resources before fetching", async () => {
    const store = createHttpCanvasStore()
    await expect(
      store.createFrame("..", {
        label: "x",
        capturedUrl: "/",
        baseUrl: "x",
        layout: { x: 0, y: 0, width: 1, height: 1 },
      }),
    ).rejects.toThrow(TypeError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("ArtifactStoreError + helpers", () => {
  it("carries status + reason + raw body", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { ok: false, reason: "bad input", details: ["x"] }),
    )
    const store = createHttpCommentStore()
    try {
      await store.create({
        position: { anchorSelector: ".x", page: "/" },
        body: "",
        author: sampleAuthor,
      })
      throw new Error("expected create() to throw")
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactStoreError)
      const ase = err as ArtifactStoreError
      expect(ase.status).toBe(400)
      expect(ase.reason).toBe("bad input")
      expect(ase.body).toMatchObject({ details: ["x"] })
    }
  })

  // Codex round-3: preserve the raw non-JSON body so a proxy 502
  // HTML page still gives the user something to grep.
  it("preserves the raw text body when the response isn't JSON", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>Bad Gateway</html>", {
        status: 502,
        statusText: "Bad Gateway",
      }),
    )
    const store = createHttpCommentStore()
    try {
      await store.list()
      throw new Error("expected list() to throw")
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactStoreError)
      const ase = err as ArtifactStoreError
      expect(ase.status).toBe(502)
      expect(ase.body).toBe("<html>Bad Gateway</html>")
    }
  })

  it("isArtifactStoreError is cross-realm safe (brand check)", () => {
    const e = new ArtifactStoreError(404, "x not found", { ok: false })
    expect(isArtifactStoreError(e)).toBe(true)
    expect(isArtifactStoreError({ status: 1, reason: "x" })).toBe(false)
    expect(isArtifactStoreError(new Error("x"))).toBe(false)
    // Brand simulating a separate-module copy of the class.
    const branded = {
      isArtifactStoreError: true,
      status: 404,
      reason: "missing not found",
    }
    expect(isArtifactStoreError(branded)).toBe(true)
  })

  it("isMissingArtifactError matches only 404 + 'not found' reason", () => {
    expect(
      isMissingArtifactError(
        new ArtifactStoreError(404, "Comment X not found", {}),
      ),
    ).toBe(true)
    expect(
      isMissingArtifactError(
        new ArtifactStoreError(404, "Unknown API endpoint", {}),
      ),
    ).toBe(false)
    expect(
      isMissingArtifactError(new ArtifactStoreError(500, "not found", {})),
    ).toBe(false)
    expect(isMissingArtifactError(new Error("not found"))).toBe(false)
  })
})
