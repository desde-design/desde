import { describe, expect, it } from "vitest"
import { isTrustedNavigationTarget, loopbackHttpOrigin } from "../navigation-guard.js"

const LAUNCHER_ORIGIN = "http://127.0.0.1:4321"
const EDITOR_ORIGIN = "http://127.0.0.1:63461"
const TRUSTED = new Set([LAUNCHER_ORIGIN, EDITOR_ORIGIN])

describe("isTrustedNavigationTarget", () => {
  it("accepts a url whose origin is in the trusted set", () => {
    expect(isTrustedNavigationTarget(`${LAUNCHER_ORIGIN}/`, TRUSTED)).toBe(true)
    expect(
      isTrustedNavigationTarget(`${EDITOR_ORIGIN}/?url=http%3A%2F%2F127.0.0.1%3A5173%2F`, TRUSTED),
    ).toBe(true)
  })

  it("rejects a loopback-shaped url whose origin is NOT in the trusted set", () => {
    // Shape alone (127.0.0.1, http) is necessary but not sufficient — some
    // other, unrelated local service could be listening on this port.
    expect(isTrustedNavigationTarget("http://127.0.0.1:9999/", TRUSTED)).toBe(false)
  })

  it("rejects an empty trusted set unconditionally", () => {
    expect(isTrustedNavigationTarget(`${LAUNCHER_ORIGIN}/`, new Set())).toBe(false)
  })

  it("rejects localhost even if somehow present in the trusted set", () => {
    // Can't happen in practice (loopbackHttpOrigin only ever adds
    // 127.0.0.1 origins) — asserted directly against a hand-built set to
    // pin the shape check as independent from set membership.
    expect(isTrustedNavigationTarget("http://localhost:4321/", new Set(["http://localhost:4321"]))).toBe(
      false,
    )
  })

  it("rejects https even on a trusted host:port — this app never serves https", () => {
    expect(isTrustedNavigationTarget("https://127.0.0.1:4321/", new Set(["https://127.0.0.1:4321"]))).toBe(
      false,
    )
  })

  it("rejects an arbitrary external origin", () => {
    expect(isTrustedNavigationTarget("https://evil.example.com/", TRUSTED)).toBe(false)
  })

  it("returns false rather than throwing on an unparseable url", () => {
    expect(isTrustedNavigationTarget("not a url", TRUSTED)).toBe(false)
    expect(isTrustedNavigationTarget("", TRUSTED)).toBe(false)
  })
})

describe("loopbackHttpOrigin", () => {
  it("returns the normalized origin for a loopback http url", () => {
    expect(loopbackHttpOrigin("http://127.0.0.1:4321/some/path?x=1")).toBe("http://127.0.0.1:4321")
  })

  it("returns null for localhost", () => {
    expect(loopbackHttpOrigin("http://localhost:4321/")).toBeNull()
  })

  it("returns null for https, even on 127.0.0.1", () => {
    expect(loopbackHttpOrigin("https://127.0.0.1:4321/")).toBeNull()
  })

  it("returns null for a lookalike hostname (127.0.0.1.evil.example.com)", () => {
    expect(loopbackHttpOrigin("http://127.0.0.1.evil.example.com/")).toBeNull()
  })

  it("returns null for a non-http scheme (file:, javascript:, data:)", () => {
    expect(loopbackHttpOrigin("file:///etc/passwd")).toBeNull()
    expect(loopbackHttpOrigin("javascript:alert(1)")).toBeNull()
    expect(loopbackHttpOrigin("data:text/html,<script>alert(1)</script>")).toBeNull()
  })

  it("returns null rather than throwing on an unparseable url", () => {
    expect(loopbackHttpOrigin("not a url")).toBeNull()
    expect(loopbackHttpOrigin("")).toBeNull()
  })
})
