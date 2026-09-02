import { describe, expect, it } from "vitest"
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  readCookie,
  serializeSessionCookie,
  sessionCookieName,
  signSessionId,
  verifySessionCookie,
} from "./session-cookie"

describe("signSessionId / verifySessionCookie", () => {
  const secret = "top-secret"
  const sessionId = "11111111-1111-4111-8111-111111111111"

  it("round-trips a signed session id", () => {
    const signed = signSessionId(secret, sessionId)
    expect(verifySessionCookie(secret, signed)).toBe(sessionId)
  })

  it("has the <id>.<base64url hmac> shape", () => {
    const signed = signSessionId(secret, sessionId)
    const dot = signed.indexOf(".")
    expect(dot).toBeGreaterThan(0)
    expect(signed.slice(0, dot)).toBe(sessionId)
    // base64url alphabet only: letters, digits, -, _ (no padding, no +//)
    expect(signed.slice(dot + 1)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("rejects a tampered signature", () => {
    const signed = signSessionId(secret, sessionId)
    const flipped = signed.endsWith("A") ? `${signed.slice(0, -1)}B` : `${signed.slice(0, -1)}A`
    expect(verifySessionCookie(secret, flipped)).toBeNull()
  })

  it("rejects a tampered session id (signature no longer matches)", () => {
    const signed = signSessionId(secret, sessionId)
    const dot = signed.indexOf(".")
    const otherId = "22222222-2222-4222-8222-222222222222"
    const tampered = `${otherId}${signed.slice(dot)}`
    expect(verifySessionCookie(secret, tampered)).toBeNull()
  })

  it("rejects a malformed value with no dot", () => {
    expect(verifySessionCookie(secret, "no-dot-here")).toBeNull()
  })

  it("rejects an empty value", () => {
    expect(verifySessionCookie(secret, "")).toBeNull()
  })

  it("rejects a value that is only a dot with nothing on either side", () => {
    expect(verifySessionCookie(secret, ".")).toBeNull()
  })

  it("rejects a value signed with a different secret", () => {
    const signed = signSessionId("secret-a", sessionId)
    expect(verifySessionCookie("secret-b", signed)).toBeNull()
  })
})

describe("sessionCookieName", () => {
  it("prefixes __Host- on https (secure), plain name on http (insecure)", () => {
    expect(sessionCookieName(true)).toBe(`__Host-${SESSION_COOKIE_NAME}`)
    expect(sessionCookieName(false)).toBe(SESSION_COOKIE_NAME)
  })
})

describe("serializeSessionCookie", () => {
  it("names the cookie __Host-viewer_session on https and viewer_session on http", () => {
    const insecure = serializeSessionCookie("v", { secure: false, maxAgeSeconds: 10 })
    const secure = serializeSessionCookie("v", { secure: true, maxAgeSeconds: 10 })
    expect(insecure.startsWith("viewer_session=v")).toBe(true)
    expect(secure.startsWith("__Host-viewer_session=v")).toBe(true)
    // The __Host- form must satisfy the browser's constraints: Secure + Path=/
    // + no Domain. Those already held; the prefix only asserts them.
    expect(secure).toContain("Secure")
    expect(secure).toContain("Path=/")
    expect(secure).not.toMatch(/Domain=/i)
  })

  it("emits HttpOnly, SameSite=Lax, Path=/, and Max-Age", () => {
    const header = serializeSessionCookie("signed-value", {
      secure: false,
      maxAgeSeconds: 60 * 60 * 24 * 30,
    })
    expect(header).toContain(`${SESSION_COOKIE_NAME}=signed-value`)
    expect(header).toContain("HttpOnly")
    expect(header).toContain("SameSite=Lax")
    expect(header).toContain("Path=/")
    expect(header).toContain(`Max-Age=${60 * 60 * 24 * 30}`)
  })

  it("includes Secure only when secure: true", () => {
    const insecure = serializeSessionCookie("v", { secure: false, maxAgeSeconds: 10 })
    const secure = serializeSessionCookie("v", { secure: true, maxAgeSeconds: 10 })
    expect(insecure).not.toContain("Secure")
    expect(secure).toContain("Secure")
  })
})

describe("clearSessionCookie", () => {
  it("clears the __Host- name on https and the plain name on http", () => {
    expect(clearSessionCookie({ secure: false }).startsWith("viewer_session=;")).toBe(true)
    expect(clearSessionCookie({ secure: true }).startsWith("__Host-viewer_session=;")).toBe(true)
  })

  it("emits Max-Age=0", () => {
    expect(clearSessionCookie({ secure: false })).toContain("Max-Age=0")
  })

  it("includes Secure only when secure: true", () => {
    expect(clearSessionCookie({ secure: false })).not.toContain("Secure")
    expect(clearSessionCookie({ secure: true })).toContain("Secure")
  })
})

describe("readCookie", () => {
  it("finds a value among several cookies", () => {
    const header = "a=1; viewer_session=abc123; other=xyz"
    expect(readCookie(header, SESSION_COOKIE_NAME)).toBe("abc123")
  })

  it("returns null when the cookie is absent", () => {
    const header = "a=1; other=xyz"
    expect(readCookie(header, SESSION_COOKIE_NAME)).toBeNull()
  })

  it("returns null when the header itself is undefined", () => {
    expect(readCookie(undefined, SESSION_COOKIE_NAME)).toBeNull()
  })

  it("decodes a percent-encoded value", () => {
    const header = `${SESSION_COOKIE_NAME}=${encodeURIComponent("id.sig+with/chars")}`
    expect(readCookie(header, SESSION_COOKIE_NAME)).toBe("id.sig+with/chars")
  })
})
