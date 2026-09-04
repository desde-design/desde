import { describe, expect, it } from "vitest"

import {
  AUTH_REAUTH_MESSAGE,
  classifyTurnError,
  extractRetryAfterFromError,
  isAuthError,
} from "./classify-turn-error"
import { ANTHROPIC_DESCRIPTOR } from "../llm-providers/descriptors/anthropic"
import { OPENAI_DESCRIPTOR } from "../llm-providers/descriptors/openai"
// Real SDK error classes, re-exported from the one file allowed to import
// the AI SDK. A hand-shaped stand-in is what let an earlier fix pass while
// being wrong.
import { APICallError, RetryError } from "../llm-providers/ai-sdk-provider"

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

    it("auth takes precedence over rate-limit when both markers present", () => {
      // Task 39: auth is checked FIRST now. OpenAI answers an exhausted
      // quota with a 429, so if rate-limit won this race a dead account
      // would badge "recoverable, try again shortly" and the user would
      // wait for a window that never opens.
      const out = classifyTurnError(
        "429 rate_limit_exceeded; failed to authenticate",
      )
      expect(out.kind).toBe("other")
      expect(out.message).toBe(AUTH_REAUTH_MESSAGE)
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

describe('classifyTurnError — provider error patterns', () => {
  it('classifies an OpenAI quota failure as auth, with OpenAI remediation copy', () => {
    const result = classifyTurnError('OpenAI answered 429: insufficient_quota', {
      errorPatterns: OPENAI_DESCRIPTOR.errorPatterns,
    })
    expect(result.kind).toBe('other')
    expect(result.message).toBe(OPENAI_DESCRIPTOR.errorPatterns!.reauthMessage)
    // An exhausted quota is not a wait-and-retry, so it must not wear the
    // rate-limit badge even though the vendor answered 429.
    expect(result.retryAfterSeconds).toBeUndefined()
  })

  it('classifies an OpenAI bad key as auth', () => {
    for (const message of [
      'OpenAI answered 401: invalid_api_key',
      'Incorrect API key provided: sk-abc***',
    ]) {
      const result = classifyTurnError(message, { errorPatterns: OPENAI_DESCRIPTOR.errorPatterns })
      expect(result.message, message).toBe(OPENAI_DESCRIPTOR.errorPatterns!.reauthMessage)
    }
  })

  it('classifies an OpenAI rate limit as rate-limited', () => {
    const result = classifyTurnError('rate_limit_exceeded, retry after 12', {
      errorPatterns: OPENAI_DESCRIPTOR.errorPatterns,
    })
    expect(result.kind).toBe('rate-limited')
    expect(result.retryAfterSeconds).toBe(12)
  })

  it('still uses the Anthropic copy for the Anthropic descriptor', () => {
    const result = classifyTurnError('Failed to authenticate. API Error: 401', {
      errorPatterns: ANTHROPIC_DESCRIPTOR.errorPatterns,
    })
    expect(result.message).toBe(AUTH_REAUTH_MESSAGE)
  })

  it('keeps its old behaviour when no patterns are supplied', () => {
    // Every existing call site passes nothing, so the generic sets must stay
    // the whole answer for them.
    expect(classifyTurnError('Failed to authenticate. API Error: 401').message).toBe(
      AUTH_REAUTH_MESSAGE,
    )
    expect(classifyTurnError('429 Too Many Requests').kind).toBe('rate-limited')
  })

  it('does not let one provider\'s patterns leak into another\'s classification', () => {
    // `insufficient_quota` is OpenAI's word. Classified without OpenAI's
    // patterns it must stay generic, or a shared classifier becomes a place
    // where vendors quietly inherit each other's error vocabulary.
    expect(classifyTurnError('insufficient_quota').message).toBe('insufficient_quota')
  })
})

describe("the OpenAI descriptor's copy, against errors OpenAI actually produces", () => {
  /**
   * The point of these cases: the descriptor's first patterns matched OpenAI
   * error CODES (`insufficient_quota`, `invalid_api_key`,
   * `rate_limit_exceeded`), and a code never reaches the classifier. The AI
   * SDK builds `APICallError.message` from `data.error.message` alone, so
   * only the vendor's PROSE is ever matched against. An exhausted quota
   * therefore classified as generic `other` and the user never saw the
   * billing-page remediation the descriptor exists to give.
   *
   * Each error below is a real `APICallError` built from the body OpenAI
   * sends, not a hand-written string containing the code.
   */
  const patterns = { errorPatterns: OPENAI_DESCRIPTOR.errorPatterns }

  function openAiError(body: {
    message: string
    code: string
    type: string
    status: number
  }): APICallError {
    return new APICallError({
      message: body.message,
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: {},
      statusCode: body.status,
      responseBody: JSON.stringify({
        error: { message: body.message, type: body.type, code: body.code, param: null },
      }),
      data: { error: { message: body.message, type: body.type, code: body.code } },
      isRetryable: body.status === 429,
    })
  }

  it("sends an exhausted quota to the billing-page copy, not to a generic failure", () => {
    const err = openAiError({
      message:
        "You exceeded your current quota, please check your plan and billing details.",
      code: "insufficient_quota",
      type: "insufficient_quota",
      status: 429,
    })
    expect(classifyTurnError(err, patterns).message).toBe(
      OPENAI_DESCRIPTOR.errorPatterns?.reauthMessage,
    )
  })

  it("reaches the same copy through the SDK's RetryError envelope", () => {
    const inner = openAiError({
      message:
        "You exceeded your current quota, please check your plan and billing details.",
      code: "insufficient_quota",
      type: "insufficient_quota",
      status: 429,
    })
    const wrapped = new RetryError({
      message: `Failed after 3 attempts. Last error: ${inner.message}`,
      reason: "maxRetriesExceeded",
      errors: [inner],
    })
    expect(classifyTurnError(wrapped, patterns).message).toBe(
      OPENAI_DESCRIPTOR.errorPatterns?.reauthMessage,
    )
  })

  it("sends a rejected key to the same copy", () => {
    const err = openAiError({
      message:
        "Incorrect API key provided: sk-***. You can find your API key at https://platform.openai.com/account/api-keys.",
      code: "invalid_api_key",
      type: "invalid_request_error",
      status: 401,
    })
    expect(classifyTurnError(err, patterns).message).toBe(
      OPENAI_DESCRIPTOR.errorPatterns?.reauthMessage,
    )
  })

  it("still classifies a real TPM rate limit as recoverable, not as an auth failure", () => {
    const err = openAiError({
      message:
        "Rate limit reached for gpt-5.6 in organization org-x on tokens per min (TPM): Limit 30000, Used 29000, Requested 5000. Please try again in 2s.",
      code: "rate_limit_exceeded",
      type: "requests",
      status: 429,
    })
    const out = classifyTurnError(err, patterns)
    expect(out.kind).toBe("rate-limited")
    expect(out.retryAfterSeconds).toBe(2)
  })
})
