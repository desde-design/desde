/**
 * `VIEWER_ALLOWED_EMAIL_DOMAINS` parsing.
 *
 * The env var is an ADMISSION SEED, not a live check: `seedDomainRulesFromEnv`
 * (`auth/gate.ts`) turns these entries into stored instance domain rules on a
 * boot that has none, and `admitSignIn` decides with the stored rules from
 * then on. So the matching semantics are tested in `auth/gate.test.ts`
 * (`matchDomainRule` — whole-domain comparison, the last-`@` split, no
 * lookalikes) and the seeding semantics there too. What is left here is the
 * parse itself, which is the only thing `config.ts` still owns.
 *
 * The `isEmailAllowed` predicate that used to live beside it was deleted in
 * Task 5 with its two per-request callers (`getCurrentUser` and the PAT branch
 * of `resolveReadContext`), which re-evaluated the allowlist on every request
 * (audit K08) and killed sessions the admission gate had legitimately granted.
 */
import { describe, expect, it } from "vitest"
import { loadConfig, parseAllowedEmailDomains } from "../config"
import { tmpViewerDataDir } from "./test-config"

describe("parseAllowedEmailDomains", () => {
  it("normalizes punctuation and case so an operator need not guess", () => {
    expect(parseAllowedEmailDomains("@Example.com, other.org ")).toEqual(["example.com", "other.org"])
  })

  /**
   * "not configured" must stay distinct from "configured with nothing" —
   * treating a blank value as an empty allowlist would deny-all and lock an
   * operator out of their own deployment.
   */
  it("treats unset and blank as no allowlist, not an empty one", () => {
    expect(parseAllowedEmailDomains(undefined)).toBeNull()
    expect(parseAllowedEmailDomains("")).toBeNull()
    expect(parseAllowedEmailDomains("  ,  , ")).toBeNull()
    expect(loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() }).allowedEmailDomains).toBeNull()
  })

  /**
   * An exact-address entry survives the parse verbatim (the `@` is what
   * `seedDomainRulesFromEnv` detects in order to skip and warn about it — see
   * its test in `auth/gate.test.ts`). Stripping or rewriting it here would
   * turn one contractor's address into a rule opening their whole provider.
   */
  it("keeps an exact-address entry recognizable as one", () => {
    expect(parseAllowedEmailDomains("example.com, Contractor@Gmail.com")).toEqual([
      "example.com",
      "contractor@gmail.com",
    ])
  })
})
