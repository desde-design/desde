/**
 * `safeReturnPath` — the open-redirect gate on `?next=`.
 *
 * The attack this exists to stop: `…/auth/github?next=https://evil.example`
 * sends someone through a sign-in they trust and hands them to a page that
 * can imitate this deployment while they hold a fresh session. Every reject
 * case below is a real shape that has been used against `next` parameters,
 * not a hypothetical.
 */

import { describe, expect, it } from "vitest"
import { DEFAULT_RETURN_PATH, safeReturnPath } from "../return-path"

describe("safeReturnPath — accepts same-origin paths", () => {
  it("keeps a plain path", () => {
    expect(safeReturnPath("/review/ai-gateway")).toBe("/review/ai-gateway")
  })

  it("keeps a path that merely LOOKS like a host — it is same-origin", () => {
    // `/@evil.example` resolves to `<this origin>/@evil.example`. Refusing it
    // would be cargo-culting the shape of an attack rather than the attack.
    expect(safeReturnPath("/@evil.example")).toBe("/@evil.example")
  })

  it("keeps a query string and a hash", () => {
    expect(safeReturnPath("/settings?section=github")).toBe("/settings?section=github")
    expect(safeReturnPath("/review/x?repo=1#top")).toBe("/review/x?repo=1#top")
  })
})

describe("safeReturnPath — refuses anything that could leave this origin", () => {
  const hostile: [string, unknown][] = [
    ["an absolute URL", "https://evil.example/"],
    ["a scheme-only prefix", "javascript:alert(1)"],
    ["protocol-relative", "//evil.example/"],
    ["backslash protocol-relative", "/\\evil.example/"],
    ["a backslash anywhere", "/review\\@evil.example"],
    ["a newline (header injection)", "/review\nLocation: https://evil.example"],
    ["a carriage return", "/review\r\nSet-Cookie: a=b"],
    ["a leading space a client may trim", " //evil.example"],
    ["a tab", "/review\tx"],
    ["a bare word", "review/ai-gateway"],
    ["an empty string", ""],
    ["a non-string", 42],
    ["null", null],
    ["undefined", undefined],
  ]

  for (const [name, value] of hostile) {
    it(`refuses ${name}`, () => {
      expect(safeReturnPath(value)).toBe(DEFAULT_RETURN_PATH)
    })
  }

  it("refuses anything past the length cap", () => {
    expect(safeReturnPath(`/${"a".repeat(600)}`)).toBe(DEFAULT_RETURN_PATH)
  })

  /**
   * The character rules above are a denylist, and a denylist is only ever as
   * good as its author's imagination. This is the property that has to hold
   * regardless: whatever comes back, resolving it against ANY origin must
   * land on that same origin.
   */
  it("never returns something that resolves off-origin", () => {
    const probes = [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/@evil.example",
      "/%2f%2fevil.example",
      "/..//evil.example",
      "/./../../evil.example",
      "\t//evil.example",
      "/review/ok",
    ]
    for (const probe of probes) {
      const resolved = new URL(safeReturnPath(probe), "https://viewer.test")
      expect(resolved.origin, `probe: ${JSON.stringify(probe)}`).toBe("https://viewer.test")
    }
  })
})
