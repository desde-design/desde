import { describe, expect, it } from "vitest"
import {
  clearStateCookie,
  isSecurePublicUrl,
  serializeStateCookie,
  stateCookieName,
  statesMatch,
} from "./state-cookie"

const OAUTH = "viewer_oauth_state"
const SETUP = "viewer_setup_state"

describe("stateCookieName", () => {
  it("prefixes __Host- on https (secure), plain base on http (insecure)", () => {
    expect(stateCookieName(OAUTH, true)).toBe(`__Host-${OAUTH}`)
    expect(stateCookieName(OAUTH, false)).toBe(OAUTH)
    expect(stateCookieName(SETUP, true)).toBe(`__Host-${SETUP}`)
    expect(stateCookieName(SETUP, false)).toBe(SETUP)
  })
})

describe("serializeStateCookie", () => {
  it("names the cookie __Host-<base> on https and <base> on http", () => {
    const insecure = serializeStateCookie(OAUTH, "nonce", false)
    const secure = serializeStateCookie(OAUTH, "nonce", true)
    expect(insecure.startsWith(`${OAUTH}=nonce`)).toBe(true)
    expect(secure.startsWith(`__Host-${OAUTH}=nonce`)).toBe(true)
    // __Host- requires Secure + Path=/ + no Domain — already all true here.
    expect(secure).toContain("Secure")
    expect(secure).toContain("Path=/")
    expect(secure).not.toMatch(/Domain=/i)
  })

  it("keeps HttpOnly, SameSite=Lax, Path=/, Max-Age on both transports", () => {
    for (const secure of [false, true]) {
      const header = serializeStateCookie(SETUP, "nonce", secure)
      expect(header).toContain("HttpOnly")
      expect(header).toContain("SameSite=Lax")
      expect(header).toContain("Path=/")
      expect(header).toContain("Max-Age=600")
      expect(secure ? header.includes("Secure") : !header.includes("Secure")).toBe(true)
    }
  })
})

describe("clearStateCookie", () => {
  it("clears the __Host- name on https and the plain base on http", () => {
    expect(clearStateCookie(OAUTH, false).startsWith(`${OAUTH}=;`)).toBe(true)
    expect(clearStateCookie(OAUTH, true).startsWith(`__Host-${OAUTH}=;`)).toBe(true)
    expect(clearStateCookie(OAUTH, false)).toContain("Max-Age=0")
    expect(clearStateCookie(OAUTH, true)).toContain("Max-Age=0")
  })
})

describe("isSecurePublicUrl", () => {
  it("is true only for an https publicUrl", () => {
    expect(isSecurePublicUrl("https://viewer.example.com")).toBe(true)
    expect(isSecurePublicUrl("http://localhost:3100")).toBe(false)
  })
})

describe("statesMatch", () => {
  it("matches equal states and rejects unequal ones", () => {
    expect(statesMatch("abc", "abc")).toBe(true)
    expect(statesMatch("abc", "abd")).toBe(false)
  })
})
