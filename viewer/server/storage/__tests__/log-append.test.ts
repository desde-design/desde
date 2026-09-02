/**
 * `appendBounded` — shared truncation logic for `appendDeploymentLog`, used
 * by both storage impls (see `storage-adapter-contract.ts`'s "deployment
 * build log append" block for the cross-impl conformance suite; these are
 * unit tests of the pure function itself, colocated because K02's fix lives
 * entirely in this one module).
 */
import { describe, expect, it } from "vitest"
import { LOG_TRUNCATION_MARKER, appendBounded } from "../log-append"

describe("appendBounded", () => {
  it("appends chunks in order under the cap", () => {
    const a = appendBounded("", "one\n", 1000)
    expect(a).toBe("one\n")
    const b = appendBounded(a ?? "", "two\n", 1000)
    expect(b).toBe("one\ntwo\n")
  })

  it("truncates at the cap and marks it exactly once, dropping further chunks", () => {
    const first = appendBounded("", "abcdefghij", 6)
    expect(first).not.toBeNull()
    expect(first!.startsWith("abcdef")).toBe(true)
    expect(first).toContain("truncated")

    // A second call at/over the cap returns `null` — "nothing changed" —
    // not a growing string with the marker appended again.
    const second = appendBounded(first!, "klmnop", 6)
    expect(second).toBeNull()

    // A third call, same story: no unbounded growth from repeatedly hitting
    // the truncated branch (this is the failure mode a naive
    // `length >= maxBytes` fix WITHOUT the `endsWith` check would have —
    // every call would re-append another copy of the marker forever).
    const third = appendBounded(first!, "qrstuv", 6)
    expect(third).toBeNull()
  })

  /**
   * K02 — the actual vulnerability. The OLD implementation decided
   * truncation with `existing.includes(LOG_TRUNCATION_MARKER)`, so build
   * output (attacker-controlled: it's the repo's own install/build stdout,
   * see S7) that merely PRINTS the marker string silences every append from
   * then on, forever — long before the log is anywhere near its real byte
   * cap. This is exactly that shape: the marker text shows up at byte ~50,
   * nowhere near the 100,000-byte cap.
   */
  it("does not let build output silence the log by printing the marker text early", () => {
    let log: string | null = "some early, ordinary log output\n"
    const attackerChunk = `before ${LOG_TRUNCATION_MARKER} after\n`
    const afterAttack = appendBounded(log, attackerChunk, 100_000)
    expect(afterAttack).not.toBeNull()
    log = afterAttack

    // The REAL subsequent build output must still land — this is what the
    // old `.includes()` check broke.
    const next = appendBounded(log!, "the actual build error nobody would otherwise see\n", 100_000)
    expect(next).not.toBeNull()
    expect(next).toContain("the actual build error nobody would otherwise see")
  })

  it("still truncates for real once the log genuinely reaches the cap, even after an early marker-shaped chunk", () => {
    const log = "x".repeat(50) + LOG_TRUNCATION_MARKER // marker present, but nowhere near cap=100
    const grown = appendBounded(log, "y".repeat(200), 100)
    expect(grown).not.toBeNull()
    expect(grown!.length).toBeGreaterThanOrEqual(100)
    expect(grown).toContain("truncated")
  })

  it("is a no-op for an unknown/empty starting log under the cap with an empty chunk", () => {
    expect(appendBounded("", "", 10)).toBe("")
  })
})
