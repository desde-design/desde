import { describe, expect, it } from "vitest"
import { shouldWarnPortUnreachable } from "../review/port-watchdog"

describe("shouldWarnPortUnreachable", () => {
  const base = { mode: "loopback" as const, bridgeReady: false, probe: "pending" as const }

  it("warns only once the probe reports unreachable", () => {
    expect(shouldWarnPortUnreachable({ ...base, probe: "unreachable" })).toBe(true)
  })

  it("does not warn while the probe is still pending", () => {
    expect(shouldWarnPortUnreachable({ ...base, probe: "pending" })).toBe(false)
  })

  it("does not warn once the probe reports reachable", () => {
    expect(shouldWarnPortUnreachable({ ...base, probe: "reachable" })).toBe(false)
  })

  it("does not warn once the bridge has answered, even if the probe says unreachable", () => {
    expect(shouldWarnPortUnreachable({ ...base, probe: "unreachable", bridgeReady: true })).toBe(false)
  })

  it("only applies to loopback mode: the other modes have no port to publish", () => {
    for (const mode of ["subdomain", "prototype-origin", "fallback"] as const) {
      expect(shouldWarnPortUnreachable({ ...base, mode, probe: "unreachable" })).toBe(false)
    }
  })
})
