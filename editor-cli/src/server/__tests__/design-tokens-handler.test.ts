/**
 * Tests for design-tokens-handler.ts — the CLI HTTP handler for
 * `GET /api/editor/design-tokens`.
 *
 * Covers all status codes (503 no grounding, 500 internal error, 200 happy
 * path) using a fake GroundingService so no real filesystem / node_modules
 * access is needed.
 */

import { describe, expect, it } from "vitest"
import { getDesignTokens } from "../design-tokens-handler.js"
import type {
  DesignToken,
  DesignTokenSource,
  GroundingService,
} from "../../../../src/editor/core"

const FAKE_TOKENS: DesignToken[] = [
  {
    name: "--acme-color-background-primary",
    value: "#0044f4",
    category: "color",
    subcategory: "background",
    source: "@acme/design-tokens",
  },
  {
    name: "--acme-space-40",
    value: "10px",
    category: "space",
    source: "@acme/design-tokens",
  },
]

function tokenSource(listTokens: () => Promise<DesignToken[]>): DesignTokenSource {
  return {
    id: "fake",
    designSystem: "acme-ds",
    listTokens,
    getToken: async (name) =>
      (await listTokens()).find((t) => t.name === name) ?? null,
  }
}

function fakeGrounding(tokens: DesignTokenSource): GroundingService {
  return {
    getManifestSource: async () => null,
    tokens,
    getProjectKnowledge: () => ({
      rules: "",
      rulesFiles: [],
      docIndex: [],
      truncated: false,
    }),
    getGroundingHealth: async () => null,
  }
}

describe("getDesignTokens", () => {
  it("returns 503 when grounding is null", async () => {
    const result = await getDesignTokens(null)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(503)
    // 503 omits `detail` — only 500 carries the wrapped error message.
    expect(result.ok === false && result.detail).toBeUndefined()
  })

  it("returns 200 with tokens on success", async () => {
    const result = await getDesignTokens(async () =>
      fakeGrounding(tokenSource(async () => FAKE_TOKENS)),
    )
    expect(result.ok).toBe(true)
    expect(result.ok === true && result.status).toBe(200)
    expect(result.ok === true && result.tokens).toEqual(FAKE_TOKENS)
  })

  it("returns empty array (not an error) when the token source is empty", async () => {
    const result = await getDesignTokens(async () =>
      fakeGrounding(tokenSource(async () => [])),
    )
    expect(result.ok).toBe(true)
    expect(result.ok === true && result.tokens).toEqual([])
  })

  // Handler-level safety net, not a composite-contract test: this fakes the
  // exposed `tokens` DesignTokenSource rejecting outright. It does NOT pin
  // "one bad source 500s the endpoint" — the real GroundingService token
  // source (`DeferredDesignTokenSource` over `buildDesignTokenSources`,
  // grounding Phase 2 Task 3) degrades gracefully: a single bad stylesheet
  // source is warned + skipped by the composite's default error handling,
  // never propagated as a rejection. This test only proves the handler still
  // 500s if `tokens.listTokens()` itself ever rejects, for whatever reason.
  it("returns 500 when the token source throws", async () => {
    const result = await getDesignTokens(async () =>
      fakeGrounding(
        tokenSource(async () => {
          throw new Error("simulated disk failure")
        }),
      ),
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(500)
    // 500 envelope: { error: 'failed-to-load-tokens', detail: '<message>' }
    // matches the web route's response shape so hooks parse identically.
    expect(result.ok === false && result.error).toBe("failed-to-load-tokens")
    expect(result.ok === false && result.detail).toMatch(/simulated disk failure/)
  })

  it("returns the endpoint's JSON 500 when grounding construction fails (not a generic 500)", async () => {
    // codex Phase 2 P2: resolving grounding INSIDE the handler keeps a
    // construction failure on the endpoint's contract.
    const result = await getDesignTokens(async () => {
      throw new Error("grounding build failed")
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(500)
    expect(result.ok === false && result.error).toBe("failed-to-load-tokens")
    expect(result.ok === false && result.detail).toMatch(/grounding build failed/)
  })
})
