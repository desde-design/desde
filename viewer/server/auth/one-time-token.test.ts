import { describe, expect, it } from "vitest"
import {
  generateOneTimeToken,
  hashOneTimeToken,
  oneTimeTokenMatches,
  parseOneTimeToken,
  type OneTimeTokenPrefix,
} from "./one-time-token"

const PREFIXES: OneTimeTokenPrefix[] = ["dsi", "dss"]

describe("generateOneTimeToken", () => {
  it.each(PREFIXES)("produces a %s_<id>_<secret> token with a matching hash", (prefix) => {
    const gen = generateOneTimeToken(prefix)
    expect(gen.token.startsWith(`${prefix}_`)).toBe(true)
    expect(gen.id).toMatch(/^[0-9a-f]{16}$/)
    expect(gen.token).toMatch(new RegExp(`^${prefix}_${gen.id}_[A-Za-z0-9_-]{43}$`))
    expect(gen.tokenHash).toBe(hashOneTimeToken(gen.token))
  })

  it("never repeats an id or token across calls (CSPRNG, not Math.random)", () => {
    const ids = new Set<string>()
    const tokens = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const gen = generateOneTimeToken("dsi")
      expect(ids.has(gen.id)).toBe(false)
      expect(tokens.has(gen.token)).toBe(false)
      ids.add(gen.id)
      tokens.add(gen.token)
    }
  })

  /**
   * The whole point of hashing at rest: what is stored must be useless to
   * anyone who reads the database. A hash that contained (or equalled) the
   * plaintext would satisfy every round-trip test in this file and store the
   * credential in the clear.
   */
  it("returns a hash that is neither the token nor contains it", () => {
    const gen = generateOneTimeToken("dss")
    expect(gen.tokenHash).not.toBe(gen.token)
    expect(gen.tokenHash).not.toContain(gen.token)
    expect(gen.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    // The secret segment must not survive into the hash either.
    const secret = gen.token.slice(`dss_${gen.id}_`.length)
    expect(gen.tokenHash).not.toContain(secret)
  })

  it("carries the id in the token, so a lookup never needs the secret", () => {
    const gen = generateOneTimeToken("dsi")
    expect(parseOneTimeToken(gen.token)).toEqual({ prefix: "dsi", id: gen.id })
  })

  it("mints a fresh secret for an EXISTING id when one is passed (regenerate), never a new id", () => {
    const first = generateOneTimeToken("dsi")
    const regenerated = generateOneTimeToken("dsi", first.id)
    expect(regenerated.id).toBe(first.id)
    expect(regenerated.token).not.toBe(first.token)
    expect(regenerated.tokenHash).not.toBe(first.tokenHash)
    expect(parseOneTimeToken(regenerated.token)).toEqual({ prefix: "dsi", id: first.id })
  })
})

describe("parseOneTimeToken", () => {
  const validId = "0123456789abcdef"
  const validSecret = "A".repeat(43)

  it.each(PREFIXES)("parses a well-formed %s token", (prefix) => {
    expect(parseOneTimeToken(`${prefix}_${validId}_${validSecret}`)).toEqual({
      prefix,
      id: validId,
    })
  })

  it.each<[string, string]>([
    ["empty string", ""],
    ["missing prefix", `${validId}_${validSecret}`],
    ["unknown prefix", `ptx_${validId}_${validSecret}`],
    // `dsv_` is the MACHINE-token prefix. A PAT must never parse as a
    // one-time token: the two live in different tables, so a token that
    // crossed the boundary would be looked up in the wrong one.
    ["a machine-token prefix", `dsv_${validId}_${validSecret}`],
    ["prefix uppercase", `PTI_${validId}_${validSecret}`],
    ["id too short", `dsi_${validId.slice(1)}_${validSecret}`],
    ["id too long", `dsi_${validId}0_${validSecret}`],
    ["id uppercase hex", `dsi_${validId.toUpperCase()}_${validSecret}`],
    ["id non-hex chars", `dsi_${"g".repeat(16)}_${validSecret}`],
    ["secret too short", `dsi_${validId}_${validSecret.slice(1)}`],
    ["secret too long", `dsi_${validId}_${validSecret}A`],
    ["secret has a padding char", `dsi_${validId}_${validSecret.slice(0, 42)}=`],
    ["missing separators entirely", `dsi${validId}${validSecret}`],
    ["leading whitespace", ` dsi_${validId}_${validSecret}`],
    ["trailing newline", `dsi_${validId}_${validSecret}\n`],
  ])("returns null for %s", (_label, input) => {
    expect(parseOneTimeToken(input)).toBeNull()
  })
})

describe("hashOneTimeToken", () => {
  it("is deterministic", () => {
    const gen = generateOneTimeToken("dsi")
    expect(hashOneTimeToken(gen.token)).toBe(hashOneTimeToken(gen.token))
  })

  it("differs for two tokens that share an id but not a secret", () => {
    const a = generateOneTimeToken("dsi")
    const b = generateOneTimeToken("dsi")
    const forged = `dsi_${a.id}_${b.token.slice(`dsi_${b.id}_`.length)}`
    expect(hashOneTimeToken(forged)).not.toBe(a.tokenHash)
  })

  /**
   * The prefix is inside the hashed material, so an invite token and a
   * sign-in token that somehow shared an id and secret would still not
   * verify against each other's stored hash.
   */
  it("differs across prefixes for otherwise identical tokens", () => {
    const id = "0123456789abcdef"
    const secret = "A".repeat(43)
    expect(hashOneTimeToken(`dsi_${id}_${secret}`)).not.toBe(hashOneTimeToken(`dss_${id}_${secret}`))
  })
})

describe("oneTimeTokenMatches", () => {
  it.each(PREFIXES)("accepts a freshly minted %s token against its own hash", (prefix) => {
    const gen = generateOneTimeToken(prefix)
    expect(oneTimeTokenMatches(gen.token, gen.tokenHash)).toBe(true)
  })

  it("rejects a different token", () => {
    const a = generateOneTimeToken("dsi")
    const b = generateOneTimeToken("dsi")
    expect(oneTimeTokenMatches(b.token, a.tokenHash)).toBe(false)
  })

  it("rejects the right id with the wrong secret", () => {
    const a = generateOneTimeToken("dss")
    const b = generateOneTimeToken("dss")
    const forged = `dss_${a.id}_${b.token.slice(`dss_${b.id}_`.length)}`
    expect(oneTimeTokenMatches(forged, a.tokenHash)).toBe(false)
  })

  it("rejects the same secret under the wrong prefix", () => {
    const gen = generateOneTimeToken("dsi")
    const swapped = `dss_${gen.token.slice("dsi_".length)}`
    expect(oneTimeTokenMatches(swapped, gen.tokenHash)).toBe(false)
  })

  /**
   * `timingSafeEqual` throws on unequal-length buffers, so a stored hash of
   * any other shape — a corrupted row, a hand-edited database, a hash from a
   * future algorithm — must return false rather than blow up the request that
   * is verifying a credential.
   */
  it.each<[string, string]>([
    ["empty", ""],
    ["short", "deadbeef"],
    ["longer than sha256 hex", "a".repeat(128)],
    ["not hex at all", "not-a-hash"],
  ])("returns false (never throws) for a stored hash that is %s", (_label, storedHash) => {
    const gen = generateOneTimeToken("dsi")
    expect(oneTimeTokenMatches(gen.token, storedHash)).toBe(false)
  })

  it("returns false for a malformed token rather than throwing", () => {
    const gen = generateOneTimeToken("dsi")
    expect(oneTimeTokenMatches("", gen.tokenHash)).toBe(false)
    expect(oneTimeTokenMatches("not-a-token", gen.tokenHash)).toBe(false)
  })
})
