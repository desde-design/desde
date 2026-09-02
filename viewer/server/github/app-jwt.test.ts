import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto"
import { describe, expect, it } from "vitest"
import { buildAppJwt } from "./app-jwt"

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
})

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"))
}

describe("buildAppJwt", () => {
  it("produces a three-segment JWT with the RS256 header", () => {
    const jwt = buildAppJwt("12345", privateKey)
    const segments = jwt.split(".")
    expect(segments).toHaveLength(3)
    expect(decodeSegment(segments[0])).toEqual({ alg: "RS256", typ: "JWT" })
  })

  it("sets iss to the App id verbatim", () => {
    const jwt = buildAppJwt("app-987", privateKey)
    const payload = decodeSegment(jwt.split(".")[1]) as { iss: string }
    expect(payload.iss).toBe("app-987")
  })

  it("backdates iat by 60s and keeps exp within GitHub's 10-minute ceiling", () => {
    const now = new Date("2026-08-07T12:00:00.000Z")
    const jwt = buildAppJwt("12345", privateKey, now)
    const payload = decodeSegment(jwt.split(".")[1]) as { iat: number; exp: number }

    const nowSeconds = Math.floor(now.getTime() / 1000)
    expect(payload.iat).toBe(nowSeconds - 60)
    // exp must be in the future relative to now, and strictly under the
    // 10-minute-from-now ceiling GitHub enforces.
    expect(payload.exp).toBeGreaterThan(nowSeconds)
    expect(payload.exp).toBeLessThan(nowSeconds + 600)
    // exp - iat must also never exceed GitHub's 10-minute cap on that
    // relationship specifically (the two checks are independent — clamping
    // one doesn't automatically clamp the other).
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600)
  })

  it("produces a signature that verifies against the corresponding public key", () => {
    const jwt = buildAppJwt("12345", privateKey)
    const [header, payload, signature] = jwt.split(".")
    const signingInput = Buffer.from(`${header}.${payload}`, "utf8")
    const signatureBuf = Buffer.from(signature, "base64url")

    const ok = cryptoVerify("RSA-SHA256", signingInput, publicKey, signatureBuf)
    expect(ok).toBe(true)
  })

  it("produces a DIFFERENT signature (and fails verification) against an unrelated key pair", () => {
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    })
    const jwt = buildAppJwt("12345", privateKey)
    const [header, payload, signature] = jwt.split(".")
    const signingInput = Buffer.from(`${header}.${payload}`, "utf8")
    const signatureBuf = Buffer.from(signature, "base64url")

    const ok = cryptoVerify("RSA-SHA256", signingInput, other.publicKey, signatureBuf)
    expect(ok).toBe(false)
  })
})
