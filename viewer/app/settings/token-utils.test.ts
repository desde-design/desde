import { describe, expect, it } from "vitest"
import {
  formatTimestamp,
  isMachineTokenScope,
  isMachineTokenView,
  isTokenExpired,
  tokenDisplayPrefix,
  validateExpiresInDays,
  validateTokenName,
  validateTokenScopes,
} from "./token-utils"

describe("isMachineTokenScope", () => {
  it("accepts read and write", () => {
    expect(isMachineTokenScope("read")).toBe(true)
    expect(isMachineTokenScope("write")).toBe(true)
  })

  it("rejects anything else", () => {
    expect(isMachineTokenScope("admin")).toBe(false)
    expect(isMachineTokenScope(1)).toBe(false)
    expect(isMachineTokenScope(null)).toBe(false)
  })
})

describe("isMachineTokenView", () => {
  const valid = {
    id: "abc123",
    name: "editor-macbook",
    scopes: ["read"],
    createdAt: "2026-08-01T00:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
  }

  it("accepts a well-formed view", () => {
    expect(isMachineTokenView(valid)).toBe(true)
  })

  it("accepts non-null lastUsedAt/expiresAt", () => {
    expect(
      isMachineTokenView({ ...valid, lastUsedAt: "2026-08-02T00:00:00.000Z", expiresAt: "2026-09-01T00:00:00.000Z" }),
    ).toBe(true)
  })

  it("rejects a missing id", () => {
    const rest: Record<string, unknown> = { ...valid }
    delete rest.id
    expect(isMachineTokenView(rest)).toBe(false)
  })

  it("rejects a non-array scopes", () => {
    expect(isMachineTokenView({ ...valid, scopes: "read" })).toBe(false)
  })

  it("rejects an invalid scope entry", () => {
    expect(isMachineTokenView({ ...valid, scopes: ["read", "admin"] })).toBe(false)
  })

  it("rejects a non-string/non-null lastUsedAt", () => {
    expect(isMachineTokenView({ ...valid, lastUsedAt: 123 })).toBe(false)
  })

  it("rejects null and non-objects", () => {
    expect(isMachineTokenView(null)).toBe(false)
    expect(isMachineTokenView("nope")).toBe(false)
    expect(isMachineTokenView(undefined)).toBe(false)
  })
})

describe("validateTokenName", () => {
  it("rejects empty and whitespace-only names", () => {
    expect(validateTokenName("")).not.toBeNull()
    expect(validateTokenName("   ")).not.toBeNull()
  })

  it("accepts a normal name", () => {
    expect(validateTokenName("editor-macbook")).toBeNull()
  })

  it("accepts exactly 64 characters and rejects 65", () => {
    expect(validateTokenName("a".repeat(64))).toBeNull()
    expect(validateTokenName("a".repeat(65))).not.toBeNull()
  })

  it("trims before checking length", () => {
    expect(validateTokenName("  ok  ")).toBeNull()
  })
})

describe("validateTokenScopes", () => {
  it("rejects an empty selection", () => {
    expect(validateTokenScopes([])).not.toBeNull()
  })

  it("accepts one or more scopes", () => {
    expect(validateTokenScopes(["read"])).toBeNull()
    expect(validateTokenScopes(["read", "write"])).toBeNull()
  })
})

describe("validateExpiresInDays", () => {
  it("accepts null (no expiry)", () => {
    expect(validateExpiresInDays(null)).toBeNull()
  })

  it("accepts the boundary values 1 and 365", () => {
    expect(validateExpiresInDays(1)).toBeNull()
    expect(validateExpiresInDays(365)).toBeNull()
  })

  it("rejects 0, negative, and above-365", () => {
    expect(validateExpiresInDays(0)).not.toBeNull()
    expect(validateExpiresInDays(-1)).not.toBeNull()
    expect(validateExpiresInDays(366)).not.toBeNull()
  })

  it("rejects non-integers", () => {
    expect(validateExpiresInDays(1.5)).not.toBeNull()
  })
})

describe("tokenDisplayPrefix", () => {
  it("wraps the id in the dsv_ prefix convention", () => {
    expect(tokenDisplayPrefix("0123456789abcdef")).toBe("dsv_0123456789abcdef…")
  })
})

describe("isTokenExpired", () => {
  const now = new Date("2026-08-07T12:00:00.000Z")

  it("treats null expiresAt as never expired", () => {
    expect(isTokenExpired(null, now)).toBe(false)
  })

  it("is false for a future expiry", () => {
    expect(isTokenExpired("2026-09-01T00:00:00.000Z", now)).toBe(false)
  })

  it("is true for a past expiry", () => {
    expect(isTokenExpired("2026-01-01T00:00:00.000Z", now)).toBe(true)
  })

  it("is true exactly at the expiry instant (<=)", () => {
    expect(isTokenExpired("2026-08-07T12:00:00.000Z", now)).toBe(true)
  })

  it("treats an unparseable date as not expired rather than throwing", () => {
    expect(isTokenExpired("not-a-date", now)).toBe(false)
  })
})

describe("formatTimestamp", () => {
  it("returns the default fallback for null", () => {
    expect(formatTimestamp(null)).toBe("Never")
  })

  it("returns a custom fallback for null", () => {
    expect(formatTimestamp(null, "—")).toBe("—")
  })

  it("formats a valid ISO string as YYYY-MM-DD in UTC", () => {
    expect(formatTimestamp("2026-08-07T23:59:59.000Z")).toBe("2026-08-07")
  })

  it("falls back for an unparseable string", () => {
    expect(formatTimestamp("garbage")).toBe("Never")
  })
})
