/**
 * Unit tests for the prototype read capability (security audit B1).
 *
 * This is the credential that lets the review iframe be SANDBOXED — and
 * therefore origin-isolated — while a private prototype's subresources still
 * load. It is the only thing standing between "the reviewer's shell realm is
 * protected from hostile repository code" and "it isn't", so the properties
 * below are load-bearing rather than incidental.
 *
 * The scoping tests matter most. Slug and deployment id are INPUTS to the MAC
 * rather than fields inside the token, so cross-project and cross-deployment
 * reuse fail structurally — there is no comparison step that could be
 * forgotten. These tests pin that that stays true.
 */
import { describe, expect, it } from "vitest"

import {
  CAPABILITY_TTL_MS,
  mintPrototypeCapability,
  verifyPrototypeCapability,
} from "../prototype-capability"
import {
  CAPABILITY_SEGMENT,
  prototypePathPrefix,
  splitCapabilityPrefix,
} from "../prototype-capability-path"

const SECRET = "test-session-secret-at-least-32-chars-long"
const SLUG = "acme"
const DEPLOYMENT = "dep_123"
const NOW = 1_700_000_000_000

function mint(over: Partial<Parameters<typeof mintPrototypeCapability>[0]> = {}): string {
  const token = mintPrototypeCapability({
    secret: SECRET,
    slug: SLUG,
    deploymentId: DEPLOYMENT,
    now: NOW,
    ...over,
  })
  if (token === null) throw new Error("expected a token")
  return token
}

function verify(token: string, over: Partial<Parameters<typeof verifyPrototypeCapability>[0]> = {}) {
  return verifyPrototypeCapability({
    token,
    secret: SECRET,
    slug: SLUG,
    deploymentId: DEPLOYMENT,
    now: NOW,
    ...over,
  })
}

describe("mintPrototypeCapability", () => {
  it("round-trips with the matching slug and deployment", () => {
    expect(verify(mint())).toBe(true)
  })

  it("returns null — not a throw — when there is no secret or no deployment", () => {
    // `null` is the documented "fall back to the pre-capability path" signal.
    expect(mintPrototypeCapability({ secret: null, slug: SLUG, deploymentId: DEPLOYMENT })).toBeNull()
    expect(mintPrototypeCapability({ secret: SECRET, slug: SLUG, deploymentId: null })).toBeNull()
  })

  it("produces a token containing no ambiguous URL characters", () => {
    // It travels as a path segment, so anything needing percent-encoding would
    // break subresource inheritance in ways that only show up in a browser.
    expect(mint()).toMatch(/^[A-Za-z0-9._~-]+$/)
  })
})

describe("verifyPrototypeCapability — scoping", () => {
  it("refuses a token minted for a DIFFERENT project", () => {
    // The cross-tenant case. A capability handed to a reviewer of project A
    // must not read project B, even though both are served by /p/{slug}/.
    const tokenForOtherProject = mint({ slug: "other-project" })
    expect(verify(tokenForOtherProject)).toBe(false)
  })

  it("refuses a token minted for a DIFFERENT deployment of the same project", () => {
    // Bounds a leaked capability in time as well as scope: once a new build is
    // activated, yesterday's token stops reading anything.
    const tokenForOldDeployment = mint({ deploymentId: "dep_OLD" })
    expect(verify(tokenForOldDeployment)).toBe(false)
  })

  it("refuses everything when the server has no secret", () => {
    expect(verify(mint(), { secret: null })).toBe(false)
  })

  it("refuses when the project currently has no active deployment", () => {
    expect(verify(mint(), { deploymentId: null })).toBe(false)
  })
})

describe("verifyPrototypeCapability — expiry", () => {
  it("accepts just inside the TTL and refuses just outside it", () => {
    const token = mint()
    expect(verify(token, { now: NOW + CAPABILITY_TTL_MS - 60_000 })).toBe(true)
    expect(verify(token, { now: NOW + CAPABILITY_TTL_MS + 60_000 })).toBe(false)
  })

  it("cannot be extended by rewriting the expiry", () => {
    // The expiry is covered by the MAC, so a caller who edits it to a distant
    // future value invalidates the signature rather than extending the token.
    const token = mint({ ttlMs: 60_000 })
    const [, signature] = token.split(".")
    const farFuture = Math.floor((NOW + 10 * 365 * 24 * 3600 * 1000) / 1000)
    const forged = `${farFuture.toString(36)}.${signature}`
    expect(verify(forged, { now: NOW + 120_000 })).toBe(false)
  })
})

describe("verifyPrototypeCapability — malformed and forged input", () => {
  it("refuses a tampered signature", () => {
    const token = mint()
    const [exp, signature] = token.split(".")
    const flipped = signature[0] === "A" ? `B${signature.slice(1)}` : `A${signature.slice(1)}`
    expect(verify(`${exp}.${flipped}`)).toBe(false)
  })

  it("refuses structurally malformed tokens", () => {
    for (const bad of ["", ".", "abc", ".sig", "exp.", "..", "not-base36!.sig"]) {
      expect(verify(bad), bad).toBe(false)
    }
  })

  it("refuses a non-canonical base36 expiry", () => {
    // One live capability must have exactly one spelling; otherwise a single
    // token becomes unboundedly many distinct cache keys and log entries.
    const token = mint()
    const [exp, signature] = token.split(".")
    expect(verify(`0${exp}.${signature}`)).toBe(false)
  })

  it("refuses an absurdly long token without doing the work", () => {
    expect(verify(`${"z".repeat(10_000)}.${"y".repeat(10_000)}`)).toBe(false)
  })
})

describe("capability path grammar", () => {
  it("omits the segment entirely when there is no capability", () => {
    expect(prototypePathPrefix(SLUG, null)).toBe(`/p/${SLUG}/`)
    expect(prototypePathPrefix(SLUG, undefined)).toBe(`/p/${SLUG}/`)
  })

  it("round-trips a capability through the prefix and back", () => {
    const token = mint()
    const prefix = prototypePathPrefix(SLUG, token)
    expect(prefix).toBe(`/p/${SLUG}/${CAPABILITY_SEGMENT}/${token}/`)

    // Simulate what the router does with the path AFTER the slug.
    const segments = prefix.replace(`/p/${SLUG}/`, "").split("/").filter(Boolean)
    const split = splitCapabilityPrefix([...segments, "assets", "app.js"])
    expect(split.token).toBe(token)
    // The capability segment is consumed, so the asset lookup sees the real
    // path — this is what makes a subresource under the prefix resolve at all.
    expect(split.segments).toEqual(["assets", "app.js"])
  })

  it("leaves an ordinary path untouched", () => {
    const split = splitCapabilityPrefix(["assets", "app.js"])
    expect(split.token).toBeNull()
    expect(split.segments).toEqual(["assets", "app.js"])
  })

  it("does not treat a real asset directory named like the segment as a capability", () => {
    // `~c` is reserved, but a bare `~c` with nothing after it is not a
    // capability and must not swallow the rest of the path.
    const split = splitCapabilityPrefix([CAPABILITY_SEGMENT])
    expect(split.token).toBeNull()
  })
})
