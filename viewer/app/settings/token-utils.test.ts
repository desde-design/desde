import { describe, expect, it } from "vitest"
import {
  editorConnectUrl,
  editorConnectUrlDiffers,
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

describe("editorConnectUrl", () => {
  it("drops the subdomain in local subdomain mode, because Node cannot resolve *.localhost", () => {
    expect(editorConnectUrl("http://desde.localhost:3100")).toBe("http://localhost:3100")
  })

  it("keeps the port, which is the part that actually varies between instances", () => {
    expect(editorConnectUrl("http://desde.localhost:8080")).toBe("http://localhost:8080")
  })

  it("drops every label, not just the first, so a deeper name still lands on the shell", () => {
    expect(editorConnectUrl("http://apps.desde.localhost:3100")).toBe("http://localhost:3100")
  })

  it("leaves the bare name alone: it already resolves everywhere", () => {
    expect(editorConnectUrl("http://localhost:3100")).toBe("http://localhost:3100")
  })

  it("leaves a deployed viewer exactly as it is", () => {
    expect(editorConnectUrl("https://viewer.example.com")).toBe("https://viewer.example.com")
  })

  it("keeps a non-default port on a deployed viewer", () => {
    expect(editorConnectUrl("https://viewer.example.com:8443")).toBe("https://viewer.example.com:8443")
  })

  it("does not rewrite a registered domain that merely contains the string", () => {
    expect(editorConnectUrl("https://localhost.example.com")).toBe("https://localhost.example.com")
  })

  it("compares host names case-insensitively, the way host names compare", () => {
    expect(editorConnectUrl("http://Desde.LOCALHOST:3100")).toBe("http://localhost:3100")
  })

  it("returns unparseable input untouched rather than throwing with a secret on screen", () => {
    expect(editorConnectUrl("not a url")).toBe("not a url")
  })
})

describe("editorConnectUrlDiffers", () => {
  it("is true only where the address bar would mislead", () => {
    expect(editorConnectUrlDiffers("http://desde.localhost:3100")).toBe(true)
  })

  it("is false on a deployed viewer, so the dialog stays quiet", () => {
    expect(editorConnectUrlDiffers("https://viewer.example.com")).toBe(false)
  })

  it("is false on the Safari fallback address, which is already pasteable", () => {
    expect(editorConnectUrlDiffers("http://localhost:3100")).toBe(false)
  })
})
