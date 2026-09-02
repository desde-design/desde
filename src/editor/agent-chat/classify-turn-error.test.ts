import { describe, expect, it } from "vitest"

import {
  AUTH_REAUTH_MESSAGE,
  classifyTurnError,
  extractRetryAfterFromError,
  isAuthError,
} from "./classify-turn-error"

describe("classifyTurnError", () => {
  describe("rate-limited detection", () => {
    it("matches a vendor 429 in the message", () => {
      const out = classifyTurnError(
        "Chat handler failed: AnthropicError: 429 too many requests",
      )
      expect(out.kind).toBe("rate-limited")
      expect(out.message).toBe(
        "AnthropicError: 429 too many requests",
      )
    })

    it("matches case-insensitive 'rate limit' (with underscore)", () => {
      expect(classifyTurnError("rate_limit_exceeded").kind).toBe("rate-limited")
      expect(classifyTurnError("Rate Limit hit").kind).toBe("rate-limited")
      expect(classifyTurnError("rate-limit reached").kind).toBe("rate-limited")
    })

    it("matches 'too many requests' phrasing", () => {
      expect(classifyTurnError("Too Many Requests").kind).toBe("rate-limited")
    })

    it("does not match unrelated numbers containing 429", () => {
      // 4290 is not 429 as a word; \b protects against substring
      // matches. (Also defends against random transcript content.)
      expect(classifyTurnError("status code 4290").kind).toBe("other")
      expect(classifyTurnError("user said: 14292").kind).toBe("other")
    })

    it("does not false-positive on phrases like 'separate limit' (codex round-1 #5)", () => {
      // Without the leading \b on the rate-limit pattern, the prior
      // regex matched "separate limit" / "corporate limit". The fix
      // anchors the left side as a word boundary.
      expect(classifyTurnError("hit the separate limit").kind).toBe("other")
      expect(classifyTurnError("corporate limit reached").kind).toBe("other")
    })

    it("classifies generic errors as 'other'", () => {
      expect(classifyTurnError("BridgeFrameworkAdapter disposed").kind).toBe(
        "other",
      )
      expect(classifyTurnError("bridge request aborted").kind).toBe("other")
      expect(classifyTurnError("").kind).toBe("other")
    })
  })

  describe("auth-failure detection", () => {
    it("maps the raw SDK 401 string to the re-login hint", () => {
      const out = classifyTurnError(
        "SDK query failed: Claude Code returned an error result: Failed to authenticate. " +
          'API Error: 401 {"type":"error","error":{"type":"authentication_error",' +
          '"message":"Invalid authentication credentials"}}',
      )
      expect(out.kind).toBe("other")
      expect(out.message).toBe(AUTH_REAUTH_MESSAGE)
    })

    it("matches each high-specificity auth marker", () => {
      expect(isAuthError("Failed to authenticate")).toBe(true)
      expect(isAuthError("Invalid authentication credentials")).toBe(true)
      expect(isAuthError('"type":"authentication_error"')).toBe(true)
    })

    it("does not false-positive on a bare 401 or unrelated text", () => {
      // A bare 401 is intentionally NOT enough — it could appear in
      // unrelated payloads. Only the specific auth markers map.
      expect(isAuthError("HTTP 401 on some unrelated endpoint")).toBe(false)
      expect(isAuthError("authenticated the request successfully")).toBe(false)
      expect(classifyTurnError("status code 401").message).toBe(
        "status code 401",
      )
    })

    it("rate-limit takes precedence over auth when both markers present", () => {
      // Defensive: a message that somehow carries both should classify
      // as recoverable (rate-limited) rather than swap to the auth hint.
      const out = classifyTurnError(
        "429 rate_limit_exceeded; failed to authenticate",
      )
      expect(out.kind).toBe("rate-limited")
      expect(out.message).not.toBe(AUTH_REAUTH_MESSAGE)
    })

    it("does not throw on nullish / non-string input", () => {
      expect(isAuthError(undefined)).toBe(false)
      expect(isAuthError(null)).toBe(false)
      expect(isAuthError(new Error("Failed to authenticate"))).toBe(true)
    })
  })

  describe("retry-after parsing", () => {
    it("parses 'retry after N seconds'", () => {
      const out = classifyTurnError("429 rate_limit retry after 30 seconds")
      expect(out.kind).toBe("rate-limited")
      expect(out.retryAfterSeconds).toBe(30)
    })

    it("parses 'try again in N'", () => {
      const out = classifyTurnError("rate_limit, try again in 60s")
      expect(out.retryAfterSeconds).toBe(60)
    })

    it("parses 'wait N seconds'", () => {
      const out = classifyTurnError("429 too many requests; wait 5 seconds")
      expect(out.retryAfterSeconds).toBe(5)
    })

    it("returns undefined retry-after when nothing matches", () => {
      const out = classifyTurnError("429 rate_limit no advice")
      expect(out.kind).toBe("rate-limited")
      expect(out.retryAfterSeconds).toBeUndefined()
    })

    it("caps absurd retry-after at 3600s", () => {
      const out = classifyTurnError("rate_limit retry after 99999 seconds")
      expect(out.retryAfterSeconds).toBe(3600)
    })

    it("ignores zero / negative retry-after", () => {
      expect(
        classifyTurnError("rate_limit retry after 0 seconds").retryAfterSeconds,
      ).toBeUndefined()
    })

    it("does NOT parse retry-after on 'other' kind", () => {
      // Defensive: even if the message happens to contain "wait 5
      // seconds", we don't surface retryAfterSeconds for non-rate-
      // limit errors because the UI uses retry-after as a cue for
      // the "Try again in Ns" affordance which only makes sense
      // for rate-limit recovery.
      const out = classifyTurnError("connection error; wait 5 seconds")
      expect(out.kind).toBe("other")
      expect(out.retryAfterSeconds).toBeUndefined()
    })
  })

  describe("message sanitisation", () => {
    it("strips 'Chat handler failed:' prefix", () => {
      const out = classifyTurnError("Chat handler failed: actual reason")
      expect(out.message).toBe("actual reason")
    })

    it("strips 'Failed to persist session:' prefix", () => {
      const out = classifyTurnError(
        "Failed to persist session: ENOENT no such directory",
      )
      expect(out.message).toBe("ENOENT no such directory")
    })

    it("preserves the original message when no known prefix is present", () => {
      expect(classifyTurnError("plain old error").message).toBe(
        "plain old error",
      )
    })
  })

  describe("input coercion", () => {
    it("accepts an Error object", () => {
      const out = classifyTurnError(new Error("429 rate_limit"))
      expect(out.kind).toBe("rate-limited")
      expect(out.message).toBe("429 rate_limit")
    })

    it("accepts a plain string", () => {
      expect(classifyTurnError("429").kind).toBe("rate-limited")
    })

    it("never throws on weird shapes", () => {
      expect(() => classifyTurnError(null)).not.toThrow()
      expect(() => classifyTurnError(undefined)).not.toThrow()
      expect(() => classifyTurnError(42)).not.toThrow()
      expect(() => classifyTurnError({ foo: "bar" })).not.toThrow()
    })
  })
})

describe("extractRetryAfterFromError (codex round-1 #1)", () => {
  it("extracts retry-after from a Fetch Headers-shaped error", () => {
    const headers = new Headers({ "retry-after": "30" })
    const err = Object.assign(new Error("429 rate_limit"), { headers })
    expect(extractRetryAfterFromError(err)).toBe(30)
  })

  it("extracts retry-after from a plain-record headers shape", () => {
    const err = { message: "rate_limit", headers: { "retry-after": "45" } }
    expect(extractRetryAfterFromError(err)).toBe(45)
  })

  it("accepts capitalised header names (Node http style)", () => {
    expect(
      extractRetryAfterFromError({ headers: { "Retry-After": "12" } }),
    ).toBe(12)
  })

  it("returns undefined when no headers are present", () => {
    expect(extractRetryAfterFromError(new Error("plain"))).toBeUndefined()
  })

  it("returns undefined when the header is missing / null", () => {
    const headers = new Headers()
    const err = Object.assign(new Error("rate_limit"), { headers })
    expect(extractRetryAfterFromError(err)).toBeUndefined()
  })

  it("ignores non-numeric retry-after values", () => {
    expect(
      extractRetryAfterFromError({ headers: { "retry-after": "soon" } }),
    ).toBeUndefined()
  })

  it("caps absurd retry-after at 3600s", () => {
    expect(
      extractRetryAfterFromError({ headers: { "retry-after": "999999" } }),
    ).toBe(3600)
  })

  it("never throws on weird shapes", () => {
    expect(() => extractRetryAfterFromError(null)).not.toThrow()
    expect(() => extractRetryAfterFromError(undefined)).not.toThrow()
    expect(() => extractRetryAfterFromError(42)).not.toThrow()
    expect(() => extractRetryAfterFromError({})).not.toThrow()
    expect(() => extractRetryAfterFromError({ headers: null })).not.toThrow()
  })
})
