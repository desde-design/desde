/**
 * Direct unit tests for `artifact-http.ts` (Task 26 of the editor
 * audit-fixes plan). The body-reading primitives it re-exports
 * (`readJsonBody`, `BodyTooLargeError`, `DEFAULT_BODY_MAX_BYTES`) got
 * direct coverage in Task 7 (`http-body.test.ts`) when they were
 * promoted to `http-body.ts`; what was still untested is this module's
 * OWN logic — `sendJson`, `sendStoreError`'s error-shape mapping, and
 * `runHandler`'s try/catch delegation — which every artifact-store CRUD
 * handler (comments, notes, canvases, screenshot-plans, design-systems,
 * drift, launcher, project-link, auth-session) leans on for its error
 * responses. Previously this logic was only exercised indirectly,
 * handler-by-handler, through each route's own integration test.
 */

import { describe, expect, it, vi } from "vitest"
import type { ServerResponse } from "node:http"

import {
  sendJson,
  sendStoreError,
  runHandler,
  BodyTooLargeError,
  DEFAULT_BODY_MAX_BYTES,
  readJsonBody,
} from "../artifact-http.js"
import {
  BodyTooLargeError as HttpBodyBodyTooLargeError,
  DEFAULT_BODY_MAX_BYTES as HTTP_BODY_DEFAULT_MAX_BYTES,
  readJsonBody as httpBodyReadJsonBody,
} from "../http-body.js"

/** Minimal `ServerResponse` shim — status/headers/body capture only. */
class FakeRes {
  statusCode = 200
  headers: Record<string, string> = {}
  body = ""
  setHeader(name: string, value: string | number): void {
    this.headers[name.toLowerCase()] = String(value)
  }
  end(payload: string): void {
    this.body = payload
  }
}
function asRes(res: FakeRes): ServerResponse {
  return res as unknown as ServerResponse
}

describe("re-exports — identity with http-body.ts (Task 7's promoted module)", () => {
  it("BodyTooLargeError, DEFAULT_BODY_MAX_BYTES, readJsonBody are the SAME bindings, not copies", () => {
    expect(BodyTooLargeError).toBe(HttpBodyBodyTooLargeError)
    expect(DEFAULT_BODY_MAX_BYTES).toBe(HTTP_BODY_DEFAULT_MAX_BYTES)
    expect(readJsonBody).toBe(httpBodyReadJsonBody)
  })
})

describe("sendJson", () => {
  it("writes the status code, JSON content-type, and JSON-stringified body", () => {
    const res = new FakeRes()
    sendJson(asRes(res), 201, { ok: true, id: "abc" })
    expect(res.statusCode).toBe(201)
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8")
    expect(JSON.parse(res.body)).toEqual({ ok: true, id: "abc" })
  })
})

describe("sendStoreError — error-shape mapping", () => {
  it("BodyTooLargeError -> 413 with the error's own message as reason", () => {
    const res = new FakeRes()
    const err = new BodyTooLargeError(1024)
    sendStoreError(asRes(res), err)
    expect(res.statusCode).toBe(413)
    const body = JSON.parse(res.body) as { ok: boolean; reason: string }
    expect(body.ok).toBe(false)
    expect(body.reason).toBe(err.message)
    expect(body.reason).toMatch(/1024 bytes/)
  })

  it("SyntaxError (JSON.parse failure) -> 400 with an 'Invalid JSON body' prefix", () => {
    const res = new FakeRes()
    let caught: unknown
    try {
      JSON.parse("{not valid")
    } catch (err) {
      caught = err
    }
    sendStoreError(asRes(res), caught)
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as { ok: boolean; reason: string }
    expect(body.ok).toBe(false)
    expect(body.reason).toMatch(/^Invalid JSON body:/)
  })

  it("an Error whose message contains 'not found' (any case) -> 404", () => {
    const res = new FakeRes()
    sendStoreError(asRes(res), new Error("Comment thread not found"))
    expect(res.statusCode).toBe(404)
    const body = JSON.parse(res.body) as { ok: boolean; reason: string }
    expect(body.reason).toBe("Comment thread not found")
  })

  it("'not found' matching is case-insensitive", () => {
    const res = new FakeRes()
    sendStoreError(asRes(res), new Error("SCREENSHOT PLAN NOT FOUND"))
    expect(res.statusCode).toBe(404)
  })

  it("a generic Error (no 'not found', not a BodyTooLargeError/SyntaxError) -> 500", () => {
    const res = new FakeRes()
    sendStoreError(asRes(res), new Error("disk write failed"))
    expect(res.statusCode).toBe(500)
    const body = JSON.parse(res.body) as { ok: boolean; reason: string }
    expect(body.reason).toBe("disk write failed")
  })

  it("a non-Error thrown value -> 500 with String(err) as the reason", () => {
    const res = new FakeRes()
    sendStoreError(asRes(res), "just a string")
    expect(res.statusCode).toBe(500)
    const body = JSON.parse(res.body) as { ok: boolean; reason: string }
    expect(body.reason).toBe("just a string")
  })

  it("a non-Error thrown string containing 'not found' also gets mapped to 404", () => {
    // `sendStoreError` computes `message` from either `err.message` (Error) or
    // `String(err)` (anything else) and then applies the SAME "not found"
    // substring check to both — so a thrown plain string also gets mapped to
    // 404 when it contains "not found". Pinning that behavior explicitly since
    // it's easy to assume only Error instances are sniffed.
    const res = new FakeRes()
    sendStoreError(asRes(res), "widget not found")
    expect(res.statusCode).toBe(404)
  })
})

describe("runHandler", () => {
  it("on success: runs the handler and leaves error-mapping untouched (no forced status)", async () => {
    const res = new FakeRes()
    await runHandler(asRes(res), async () => {
      sendJson(asRes(res), 200, { ok: true })
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
  })

  it("on a thrown BodyTooLargeError: delegates to sendStoreError -> 413", async () => {
    const res = new FakeRes()
    await runHandler(asRes(res), async () => {
      throw new BodyTooLargeError(2048)
    })
    expect(res.statusCode).toBe(413)
  })

  it("on a thrown 'not found' Error: delegates to sendStoreError -> 404", async () => {
    const res = new FakeRes()
    await runHandler(asRes(res), async () => {
      throw new Error("note not found")
    })
    expect(res.statusCode).toBe(404)
  })

  it("on a thrown generic Error: delegates to sendStoreError -> 500, and does not rethrow", async () => {
    const res = new FakeRes()
    await expect(
      runHandler(asRes(res), async () => {
        throw new Error("boom")
      }),
    ).resolves.toBeUndefined()
    expect(res.statusCode).toBe(500)
  })

  it("propagates a rejected promise (not just a synchronous throw) through the same mapping", async () => {
    const res = new FakeRes()
    const fn = vi.fn().mockRejectedValue(new Error("async boom"))
    await runHandler(asRes(res), fn)
    expect(fn).toHaveBeenCalled()
    expect(res.statusCode).toBe(500)
  })
})
