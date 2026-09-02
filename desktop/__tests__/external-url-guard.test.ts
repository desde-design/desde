import { describe, expect, it, vi } from "vitest"
import { isSafeExternalUrl, openExternalIfSafe } from "../external-url-guard.js"

describe("isSafeExternalUrl", () => {
  it("allows a plain https url", () => {
    expect(isSafeExternalUrl("https://example.com/")).toBe(true)
  })

  it("allows a plain http url", () => {
    expect(isSafeExternalUrl("http://example.com/")).toBe(true)
  })

  it("rejects a file: url", () => {
    expect(isSafeExternalUrl("file:///Users/someone/.ssh/id_rsa")).toBe(false)
  })

  it("rejects a javascript: url", () => {
    expect(isSafeExternalUrl("javascript:alert(document.cookie)")).toBe(false)
  })

  it("rejects a custom/app-registered scheme", () => {
    expect(isSafeExternalUrl("desde://some/deep-link")).toBe(false)
  })

  it("rejects a malformed/unparseable url rather than throwing", () => {
    expect(isSafeExternalUrl("not a url")).toBe(false)
    expect(isSafeExternalUrl("")).toBe(false)
  })
})

describe("openExternalIfSafe", () => {
  it("calls openExternal for a legitimate https url", () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    openExternalIfSafe("https://example.com/", openExternal)
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/")
  })

  it("calls openExternal for a legitimate http url", () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    openExternalIfSafe("http://example.com/", openExternal)
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("http://example.com/")
  })

  // The whole point of this helper: a return-value-only assertion would not
  // catch a regression where the refusal is computed correctly but
  // `openExternal` is called anyway (e.g. a stray call above the check, or a
  // future edit that reorders the guard past the call). Every refusal case
  // below asserts the mock was NEVER invoked, not just that nothing threw.
  it("refuses a file: url — does not call openExternal", () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    openExternalIfSafe("file:///Users/someone/.ssh/id_rsa", openExternal)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it("refuses a javascript: url — does not call openExternal", () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    openExternalIfSafe("javascript:alert(document.cookie)", openExternal)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it("refuses a custom/app-registered scheme — does not call openExternal", () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    openExternalIfSafe("desde://some/deep-link", openExternal)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it("refuses a malformed/unparseable url — does not call openExternal, does not throw", () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    expect(() => openExternalIfSafe("not a url", openExternal)).not.toThrow()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it("never throws even if the (allowed) openExternal call itself rejects", async () => {
    const openExternal = vi.fn().mockRejectedValue(new Error("boom"))
    expect(() => openExternalIfSafe("https://example.com/", openExternal)).not.toThrow()
    // Let the rejected promise's .catch() run before the test ends, so an
    // unhandled-rejection warning would show up here rather than leaking
    // into a later, unrelated test.
    await new Promise((r) => setTimeout(r, 0))
  })

  it("never throws even if the (allowed) openExternal call itself throws synchronously", () => {
    const openExternal = vi.fn(() => {
      throw new Error("boom")
    })
    expect(() => openExternalIfSafe("https://example.com/", openExternal)).not.toThrow()
  })
})
