/**
 * `nextSlugCandidate` — the suffixing behind transparent slug uniqueness.
 *
 * The route's job is the search and the conflict retry; this file covers the
 * part that can be wrong without any database involved, which is the length
 * cap. A suffix appended blindly to a slug already at 63 characters produces
 * one the route's own `SLUG_PATTERN` would reject — the create would then
 * fail on a value the server invented, not on anything the caller sent.
 */

import { describe, expect, it } from "vitest"
import { nextSlugCandidate } from "../free-slug"

/** Kept in step with `SLUG_PATTERN` in `projects-routes.ts`. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/

describe("nextSlugCandidate", () => {
  it("returns the requested slug unchanged for the first attempt", () => {
    expect(nextSlugCandidate("checkout-redesign", 1)).toBe("checkout-redesign")
  })

  it("appends an incrementing suffix after that", () => {
    expect(nextSlugCandidate("checkout-redesign", 2)).toBe("checkout-redesign-2")
    expect(nextSlugCandidate("checkout-redesign", 11)).toBe("checkout-redesign-11")
  })

  it("keeps every candidate inside the slug pattern, even at the length cap", () => {
    const atCap = "a".repeat(63)
    expect(atCap).toMatch(SLUG_PATTERN)
    for (const n of [2, 9, 10, 50]) {
      const candidate = nextSlugCandidate(atCap, n)
      expect(candidate.length, `n=${n}`).toBeLessThanOrEqual(63)
      expect(candidate, `n=${n}`).toMatch(SLUG_PATTERN)
    }
  })

  it("does not leave a trailing hyphen when trimming lands on one", () => {
    // 62 chars ending in a run of hyphens: slicing for "-2" cuts mid-run.
    const base = "a".repeat(58) + "-----"
    const candidate = nextSlugCandidate(base, 2)
    expect(candidate).not.toMatch(/--\d+$/)
    expect(candidate).toMatch(SLUG_PATTERN)
  })

  it("still starts with an alphanumeric when the base is almost all hyphens", () => {
    const candidate = nextSlugCandidate("a" + "-".repeat(62), 2)
    expect(candidate).toMatch(SLUG_PATTERN)
  })
})
