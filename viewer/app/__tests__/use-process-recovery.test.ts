import { describe, expect, it } from "vitest"
import { shouldRefreshAfterPoll } from "../review/use-process-recovery"
import type { ProcessStatus } from "../../server/serve/prototype-processes"

/**
 * Codex round 2, item 2: a crash panel resolved server-side never noticed
 * the manager's restart budget aging out. This table is the decision
 * `useProcessRecovery` (same file) drives `router.refresh()` from — every
 * row is a shape the polled `prototype-origin` route can actually answer
 * with.
 */
describe("shouldRefreshAfterPoll", () => {
  it("refreshes when the poll reports no process at all (a static deployment, or an unparsed body)", () => {
    expect(shouldRefreshAfterPoll(undefined)).toBe(true)
  })

  it("refreshes when the process is no longer crashed", () => {
    const rows: ProcessStatus[] = [
      { state: "stopped" },
      { state: "starting" },
      { state: "running", port: 4321, since: "2026-09-10T00:00:00.000Z" },
    ]
    for (const status of rows) {
      expect(shouldRefreshAfterPoll(status)).toBe(true)
    }
  })

  it("refreshes when still crashed but the manager would retry it now", () => {
    const status: ProcessStatus = {
      state: "crashed",
      exitCode: 1,
      restarts: 1,
      reason: "The server exited.",
      retryable: true,
    }
    expect(shouldRefreshAfterPoll(status)).toBe(true)
  })

  it("does NOT refresh while still crashed and still not retryable — the one state the page already shows correctly", () => {
    const status: ProcessStatus = {
      state: "crashed",
      exitCode: 1,
      restarts: 4,
      reason: "The server kept exiting.",
      retryable: false,
    }
    expect(shouldRefreshAfterPoll(status)).toBe(false)
  })
})
