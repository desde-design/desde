import { describe, expect, it } from "vitest"
import { MAX_EMAIL_CHARS, isValidEmail, normalizeEmailInput } from "../validate-email"

/**
 * `normalizeEmailInput` (viewer-membership X5) consolidates what used to be
 * three near-identical copies — `POST /auth/magic-link`, `POST
 * /instance/invites` (+ regenerate), and `POST /projects/:id/members` — into
 * one function every email-accepting write path now calls. Trims, rejects
 * whitespace/control characters, runs `isValidEmail`'s loose shape check, and
 * lowercases on success.
 */
describe("normalizeEmailInput", () => {
  it("trims and lowercases a valid address", () => {
    expect(normalizeEmailInput("  Mo@Example.COM  ")).toBe("mo@example.com")
  })

  it("passes an already-clean address through unchanged", () => {
    expect(normalizeEmailInput("mo@example.com")).toBe("mo@example.com")
  })

  it.each([null, undefined, 42, {}, [], true])("rejects a non-string input (%s)", (v) => {
    expect(normalizeEmailInput(v)).toBeNull()
  })

  it("rejects an empty string", () => {
    expect(normalizeEmailInput("")).toBeNull()
  })

  it("rejects a whitespace-only string", () => {
    expect(normalizeEmailInput("   ")).toBeNull()
  })

  it("rejects a value with no @", () => {
    expect(normalizeEmailInput("not-an-email")).toBeNull()
  })

  it("rejects a value with an empty local part or domain", () => {
    expect(normalizeEmailInput("@example.com")).toBeNull()
    expect(normalizeEmailInput("mo@")).toBeNull()
  })

  it("rejects a value with two @ signs", () => {
    expect(normalizeEmailInput("mo@example@com")).toBeNull()
  })

  /**
   * The defect this helper was built to close (codex, viewer-membership
   * final fix wave): an address destined for a mail transport can carry a
   * CRLF header-injection payload in the middle, which survives a plain
   * `.trim()` (that only strips the ends) and which `isValidEmail`'s loose
   * shape check does not look for at all.
   */
  it("rejects an interior CRLF — a header-injection payload trimming alone would not catch", () => {
    expect(normalizeEmailInput("victim@example.test\r\nBcc: attacker@evil.test")).toBeNull()
  })

  it("rejects an interior space", () => {
    expect(normalizeEmailInput("mo @example.com")).toBeNull()
  })

  it("rejects an interior tab", () => {
    expect(normalizeEmailInput("mo\t@example.com")).toBeNull()
  })

  it("rejects a NUL byte", () => {
    expect(normalizeEmailInput("mo@example.com\0")).toBeNull()
  })

  it("rejects an interior control character below the printable range", () => {
    expect(normalizeEmailInput("mo@examp\x01le.com")).toBeNull()
  })

  it("accepts an address exactly at the length cap, rejects one over it", () => {
    const domain = "@example.com"
    const atCap = "a".repeat(MAX_EMAIL_CHARS - domain.length) + domain
    expect(atCap.length).toBe(MAX_EMAIL_CHARS)
    expect(normalizeEmailInput(atCap)).toBe(atCap)

    const overCap = "a" + atCap
    expect(normalizeEmailInput(overCap)).toBeNull()
  })

  it("agrees with isValidEmail on the shape check, modulo trimming and case", () => {
    // Every value normalizeEmailInput accepts must be one isValidEmail
    // accepts too — the helper narrows, it never widens.
    const accepted = normalizeEmailInput("  Mo@Example.com  ")
    expect(accepted).not.toBeNull()
    expect(isValidEmail(accepted!)).toBe(true)
  })
})
