import { describe, it, expect } from "vitest"
import type { IncomingMessage } from "node:http"
import { checkAuth, newSecurityContext } from "../auth.js"

/**
 * `IncomingMessage` is a streaming object with a lot of surface; the
 * checkAuth function only reads `headers.origin` and `headers.authorization`.
 * A typed shim is enough for the tests and avoids spinning up a real
 * server per case.
 */
function fakeRequest(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

const SHELL_ORIGIN = "http://127.0.0.1:4321"

describe("checkAuth — originPolicy: 'required' (default, /api/*)", () => {
  it("rejects missing Origin with 403", () => {
    const ctx = newSecurityContext(SHELL_ORIGIN)
    const result = checkAuth(
      fakeRequest({ authorization: `Bearer ${ctx.token}` }),
      ctx,
    )
    expect(result).toEqual({
      ok: false,
      status: 403,
      reason: expect.stringContaining("Invalid Origin"),
    })
  })

  it("rejects mismatched Origin with 403", () => {
    const ctx = newSecurityContext(SHELL_ORIGIN)
    const result = checkAuth(
      fakeRequest({
        origin: "https://evil.example",
        authorization: `Bearer ${ctx.token}`,
      }),
      ctx,
    )
    expect(result).toMatchObject({ ok: false, status: 403 })
  })

  it("accepts matching Origin + valid bearer", () => {
    const ctx = newSecurityContext(SHELL_ORIGIN)
    const result = checkAuth(
      fakeRequest({
        origin: SHELL_ORIGIN,
        authorization: `Bearer ${ctx.token}`,
      }),
      ctx,
    )
    expect(result).toEqual({ ok: true })
  })

  it("rejects missing bearer with 401 even when Origin matches", () => {
    const ctx = newSecurityContext(SHELL_ORIGIN)
    const result = checkAuth(
      fakeRequest({ origin: SHELL_ORIGIN }),
      ctx,
    )
    expect(result).toMatchObject({ ok: false, status: 401 })
  })

  it("rejects wrong bearer with 401", () => {
    const ctx = newSecurityContext(SHELL_ORIGIN)
    const result = checkAuth(
      fakeRequest({
        origin: SHELL_ORIGIN,
        authorization: "Bearer wrong",
      }),
      ctx,
    )
    expect(result).toMatchObject({ ok: false, status: 401 })
  })

  it("explicit originPolicy: 'required' matches the default", () => {
    const ctx = newSecurityContext(SHELL_ORIGIN)
    const noOrigin = checkAuth(
      fakeRequest({ authorization: `Bearer ${ctx.token}` }),
      ctx,
      { originPolicy: "required" },
    )
    expect(noOrigin).toMatchObject({ ok: false, status: 403 })
  })
})

describe("checkAuth — originPolicy: 'if-present' (/mcp/*)", () => {
  it("accepts no Origin + valid bearer (most MCP clients don't send Origin)", () => {
    const ctx = newSecurityContext(SHELL_ORIGIN)
    const result = checkAuth(
      fakeRequest({ authorization: `Bearer ${ctx.token}` }),
      ctx,
      { originPolicy: "if-present" },
    )
    expect(result).toEqual({ ok: true })
  })

  it("rejects mismatched Origin with 403 (defense-in-depth for browser-originated MCP calls)", () => {
    const ctx = newSecurityContext(SHELL_ORIGIN)
    const result = checkAuth(
      fakeRequest({
        origin: "https://evil.example",
        authorization: `Bearer ${ctx.token}`,
      }),
      ctx,
      { originPolicy: "if-present" },
    )
    expect(result).toMatchObject({ ok: false, status: 403 })
  })

  it("accepts matching Origin + valid bearer", () => {
    const ctx = newSecurityContext(SHELL_ORIGIN)
    const result = checkAuth(
      fakeRequest({
        origin: SHELL_ORIGIN,
        authorization: `Bearer ${ctx.token}`,
      }),
      ctx,
      { originPolicy: "if-present" },
    )
    expect(result).toEqual({ ok: true })
  })

  it("rejects no bearer with 401 regardless of Origin presence", () => {
    const ctx = newSecurityContext(SHELL_ORIGIN)
    const noOrigin = checkAuth(
      fakeRequest({}),
      ctx,
      { originPolicy: "if-present" },
    )
    expect(noOrigin).toMatchObject({ ok: false, status: 401 })

    const withOrigin = checkAuth(
      fakeRequest({ origin: SHELL_ORIGIN }),
      ctx,
      { originPolicy: "if-present" },
    )
    expect(withOrigin).toMatchObject({ ok: false, status: 401 })
  })

  it("rejects wrong bearer with 401", () => {
    const ctx = newSecurityContext(SHELL_ORIGIN)
    const result = checkAuth(
      fakeRequest({ authorization: "Bearer wrong" }),
      ctx,
      { originPolicy: "if-present" },
    )
    expect(result).toMatchObject({ ok: false, status: 401 })
  })

  it("treats empty-string Origin as 'absent' (browser sends 'null' but never empty)", () => {
    const ctx = newSecurityContext(SHELL_ORIGIN)
    const result = checkAuth(
      fakeRequest({ origin: "", authorization: `Bearer ${ctx.token}` }),
      ctx,
      { originPolicy: "if-present" },
    )
    expect(result).toEqual({ ok: true })
  })
})

describe("checkAuth — token comparison hygiene", () => {
  it("uses length check before byte loop (prevents short-token timing leak)", () => {
    const ctx = newSecurityContext(SHELL_ORIGIN)
    // Different length than the real token — must not crash, must reject.
    const result = checkAuth(
      fakeRequest({
        origin: SHELL_ORIGIN,
        authorization: "Bearer short",
      }),
      ctx,
    )
    expect(result).toMatchObject({ ok: false, status: 401 })
  })
})
