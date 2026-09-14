import { describe, expect, it } from "vitest"
import { webhooksReachable } from "../webhook-reachability"

describe("webhooksReachable", () => {
  it("is false on the loopback name, which is what a laptop viewer serves", () => {
    expect(webhooksReachable("http://localhost:3100")).toBe(false)
  })

  /**
   * Local subdomain mode made this the DEFAULT shell address (2026-09-13), so
   * a stock laptop viewer lands here rather than on the bare name above.
   */
  it("is false under .localhost, the default local shell address", () => {
    expect(webhooksReachable("http://desde.localhost:3100")).toBe(false)
  })

  it("is false on the loopback literals", () => {
    expect(webhooksReachable("http://127.0.0.1:3100")).toBe(false)
    expect(webhooksReachable("http://[::1]:3100")).toBe(false)
  })

  it("is true on a deployed viewer, which is the case the webhook exists for", () => {
    expect(webhooksReachable("https://viewer.example.com")).toBe(true)
  })

  it("does not match a registered domain that merely contains the string", () => {
    expect(webhooksReachable("https://localhost.example.com")).toBe(true)
  })

  it("compares host names case-insensitively, the way host names compare", () => {
    expect(webhooksReachable("http://Desde.LOCALHOST:3100")).toBe(false)
  })

  /**
   * A typo in `VIEWER_PUBLIC_URL` is reported by config validation. This must
   * not ALSO be the thing that quietly strips a deployment's webhook.
   */
  it("assumes reachable when the public URL cannot be parsed", () => {
    expect(webhooksReachable("not a url")).toBe(true)
  })
})
