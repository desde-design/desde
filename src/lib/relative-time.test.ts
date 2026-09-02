/**
 * `formatRelativeSpan` — the two-directional one.
 *
 * Its siblings are covered through their call sites; this one gets a suite of
 * its own because it is the only one that can produce a FUTURE string, and
 * because the unit boundaries are where a rounding change would show up.
 *
 * Time is frozen rather than computed from a live `Date.now()`, so a test that
 * passes at 23:59 still passes at 00:01.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { formatRelativeSpan } from "./relative-time"

const NOW = new Date("2026-08-21T12:00:00.000Z")

/** `NOW` shifted by `days`; negative is the past. */
function daysFromNow(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("formatRelativeSpan", () => {
  it("says 'ago' for the past and 'in' for the future", () => {
    expect(formatRelativeSpan(daysFromNow(-11))).toBe("11 days ago")
    expect(formatRelativeSpan(daysFromNow(11))).toBe("in 11 days")
  })

  it("singularises one of anything", () => {
    expect(formatRelativeSpan(daysFromNow(-1))).toBe("1 day ago")
    expect(formatRelativeSpan(daysFromNow(365))).toBe("in 1 year")
    expect(formatRelativeSpan(daysFromNow(-30))).toBe("1 month ago")
  })

  it("keeps going past 30 days instead of falling back to a date", () => {
    // This is the whole reason it exists next to `formatRelativeTime`, which
    // prints a date here. An expiry wants a span, not a calendar entry.
    expect(formatRelativeSpan(daysFromNow(90))).toBe("in 3 months")
    expect(formatRelativeSpan(daysFromNow(-400))).toBe("1 year ago")
  })

  it("climbs the units in order", () => {
    expect(formatRelativeSpan(new Date(NOW.getTime() - 30_000).toISOString())).toBe("just now")
    expect(formatRelativeSpan(new Date(NOW.getTime() + 30_000).toISOString())).toBe("in a moment")
    expect(formatRelativeSpan(new Date(NOW.getTime() - 45 * 60_000).toISOString())).toBe(
      "45 minutes ago",
    )
    expect(formatRelativeSpan(new Date(NOW.getTime() - 5 * 3_600_000).toISOString())).toBe(
      "5 hours ago",
    )
  })

  it("rounds rather than floors, matching its siblings", () => {
    // 90 minutes is nearer 2h than 1h. Flooring would say "1 hour ago", which
    // is the half-hour-adrift answer the other two functions avoid.
    expect(formatRelativeSpan(new Date(NOW.getTime() - 90 * 60_000).toISOString())).toBe(
      "2 hours ago",
    )
  })

  it("returns an empty string for an unparseable input", () => {
    // A caller renders nothing, rather than "NaN days ago".
    expect(formatRelativeSpan("not a date")).toBe("")
    expect(formatRelativeSpan("")).toBe("")
  })
})
