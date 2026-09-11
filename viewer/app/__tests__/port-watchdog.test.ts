import { describe, expect, it } from "vitest"
import { PORT_WATCHDOG_MS, shouldWarnPortUnreachable } from "../review/port-watchdog"

describe("shouldWarnPortUnreachable", () => {
  const base = { mode: "loopback" as const, bridgeReady: false, prototypeLoaded: false, elapsedMs: PORT_WATCHDOG_MS }
  it("warns in loopback mode when nothing has loaded after the bound", () => {
    expect(shouldWarnPortUnreachable(base)).toBe(true)
  })
  it("does not warn before the bound", () => {
    expect(shouldWarnPortUnreachable({ ...base, elapsedMs: PORT_WATCHDOG_MS - 1 })).toBe(false)
  })
  it("does not warn once either the frame loaded or the bridge answered", () => {
    expect(shouldWarnPortUnreachable({ ...base, prototypeLoaded: true })).toBe(false)
    expect(shouldWarnPortUnreachable({ ...base, bridgeReady: true })).toBe(false)
  })
  it("only applies to loopback mode: the other modes have no port to publish", () => {
    for (const mode of ["subdomain", "prototype-origin", "fallback"] as const) {
      expect(shouldWarnPortUnreachable({ ...base, mode })).toBe(false)
    }
  })
})
