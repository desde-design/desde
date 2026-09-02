/**
 * Unit coverage for the shared capped body reader (Task 7 of the
 * editor audit-fixes plan — promotes `artifact-http.ts`'s
 * `readJsonBody` to `http-body.ts` so `http-server.ts`'s per-route
 * handlers and `chat-handler.ts`'s 64MB chat reader share one
 * implementation instead of each having its own inline
 * `for await (const chunk of req) raw += chunk` accumulator).
 *
 * Exercises the reader directly with small injected `maxBytes` values
 * rather than a real 64MB body — proves the capping logic itself
 * (under-cap passes, over-cap throws, default applies) without a slow
 * multi-megabyte fixture. `http-server-body-caps.integration.test.ts`
 * covers the per-route wiring (413 status + each route's error shape)
 * through a real HTTP round trip.
 */

import { describe, expect, it } from "vitest"
import { PassThrough } from "node:stream"
import type { IncomingMessage } from "node:http"
import {
  BodyTooLargeError,
  DEFAULT_BODY_MAX_BYTES,
  readJsonBody,
  readRawBody,
} from "../http-body.js"

/**
 * A `PassThrough` is close enough to `IncomingMessage` for these
 * purposes: `readRawBody`/`readJsonBody` only ever `for await` over
 * the request as an async-iterable byte stream.
 */
function fakeRequest(body: string): IncomingMessage {
  const stream = new PassThrough()
  stream.end(body)
  return stream as unknown as IncomingMessage
}

describe("readRawBody", () => {
  it("returns the full body when under the cap", async () => {
    const req = fakeRequest("hello world")
    await expect(readRawBody(req, { maxBytes: 1024 })).resolves.toBe("hello world")
  })

  it("throws BodyTooLargeError when the body exceeds maxBytes", async () => {
    const req = fakeRequest("x".repeat(100))
    await expect(readRawBody(req, { maxBytes: 10 })).rejects.toThrow(BodyTooLargeError)
  })

  it("BodyTooLargeError carries the configured cap", async () => {
    const req = fakeRequest("x".repeat(100))
    try {
      await readRawBody(req, { maxBytes: 10 })
      expect.unreachable("expected BodyTooLargeError")
    } catch (err) {
      expect(err).toBeInstanceOf(BodyTooLargeError)
      expect((err as BodyTooLargeError).maxBytes).toBe(10)
      expect((err as Error).message).toMatch(/10 bytes/)
    }
  })

  it("accepts a body exactly at the cap (boundary, not off-by-one)", async () => {
    const req = fakeRequest("x".repeat(10))
    await expect(readRawBody(req, { maxBytes: 10 })).resolves.toBe("x".repeat(10))
  })

  it("uses DEFAULT_BODY_MAX_BYTES when no cap is passed", async () => {
    const underDefault = fakeRequest("x".repeat(1024))
    await expect(readRawBody(underDefault)).resolves.toHaveLength(1024)

    const overDefault = fakeRequest("x".repeat(DEFAULT_BODY_MAX_BYTES + 1))
    await expect(readRawBody(overDefault)).rejects.toThrow(BodyTooLargeError)
  })

  it("measures multi-byte UTF-8 characters by byte length, not char length", async () => {
    // Each "é" is 2 bytes in UTF-8. 6 chars = 12 bytes, over a 10-byte cap.
    const req = fakeRequest("é".repeat(6))
    await expect(readRawBody(req, { maxBytes: 10 })).rejects.toThrow(BodyTooLargeError)
  })
})

describe("readJsonBody", () => {
  it("parses a valid JSON body under the cap", async () => {
    const req = fakeRequest(JSON.stringify({ hello: "world" }))
    await expect(readJsonBody(req, { maxBytes: 1024 })).resolves.toEqual({ hello: "world" })
  })

  it("throws BodyTooLargeError before attempting to parse an oversized body", async () => {
    const req = fakeRequest(JSON.stringify({ giant: "x".repeat(1000) }))
    await expect(readJsonBody(req, { maxBytes: 10 })).rejects.toThrow(BodyTooLargeError)
  })

  it("throws SyntaxError on malformed JSON (distinct from BodyTooLargeError)", async () => {
    const req = fakeRequest("{not valid json")
    await expect(readJsonBody(req, { maxBytes: 1024 })).rejects.toThrow(SyntaxError)
  })

  it("treats an empty body as {} rather than throwing", async () => {
    const req = fakeRequest("")
    await expect(readJsonBody(req, { maxBytes: 1024 })).resolves.toEqual({})
  })

  it("treats a whitespace-only body as {}", async () => {
    const req = fakeRequest("   \n  ")
    await expect(readJsonBody(req, { maxBytes: 1024 })).resolves.toEqual({})
  })
})
