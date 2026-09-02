/**
 * Unit tests for the CLI manifest and catalog handlers.
 * These are contract-pinning tests — they pin the HTTP response shape
 * (status, body, headers) without testing the real manifest extraction
 * (that's covered by the grounding service's own tests).
 */

import { describe, expect, it, vi } from "vitest"
import {
  handleManifestRequest,
  handleCatalogRequest,
} from "../manifest-handler.js"
import type {
  ComponentManifest,
  ComponentManifestSource,
  DesignTokenSource,
  GroundingService,
} from "../../../../src/editor/core"

/** Create a minimal component manifest for testing. */
function componentManifest(over: Partial<ComponentManifest> = {}): ComponentManifest {
  return {
    id: "test-button",
    name: "Button",
    framework: "vue3",
    designSystem: "test-ds",
    props: [],
    ...over,
  }
}

/** Create a minimal ComponentManifestSource stub. */
function manifestSource(over: Partial<ComponentManifestSource> = {}): ComponentManifestSource {
  return {
    id: "test-source",
    framework: "vue3",
    designSystem: "test-ds",
    listComponents: vi.fn(async () => [componentManifest()]),
    getComponent: vi.fn(async (name: string) =>
      name === "Button" ? componentManifest() : null,
    ),
    ...over,
  }
}

/** Create a minimal DesignTokenSource stub. */
function designTokenSource(over: Partial<DesignTokenSource> = {}): DesignTokenSource {
  return {
    id: "test-tokens",
    designSystem: "test-ds",
    listTokens: vi.fn(async () => []),
    getToken: vi.fn(async () => null),
    ...over,
  }
}

/** Create a minimal GroundingService stub. */
function groundingService(over: Partial<GroundingService> = {}): GroundingService {
  return {
    getManifestSource: vi.fn(async () => manifestSource()),
    tokens: designTokenSource(),
    getProjectKnowledge: () => ({
      rules: "",
      rulesFiles: [],
      docIndex: [],
      truncated: false,
    }),
    getGroundingHealth: vi.fn(async () => null),
    ...over,
  }
}

describe("handleManifestRequest", () => {
  it("named component found → 200 + body + Cache-Control: no-store", async () => {
    const result = await handleManifestRequest(
      vi.fn(async () => groundingService()),
      "Button",
    )
    expect(result.status).toBe(200)
    expect(result.body).toEqual(componentManifest())
    expect(result.headers).toEqual({ "Cache-Control": "no-store" })
  })

  it("named component not found → 404 + null body + Cache-Control: no-store", async () => {
    const result = await handleManifestRequest(
      vi.fn(async () => groundingService()),
      "NonExistent",
    )
    expect(result.status).toBe(404)
    expect(result.body).toBeNull()
    expect(result.headers).toEqual({ "Cache-Control": "no-store" })
  })

  it("no name → 200 + component list + Cache-Control: no-store", async () => {
    const result = await handleManifestRequest(
      vi.fn(async () => groundingService()),
      null,
    )
    expect(result.status).toBe(200)
    expect(Array.isArray(result.body)).toBe(true)
    expect((result.body as ComponentManifest[]).length).toBeGreaterThan(0)
    expect(result.headers).toEqual({ "Cache-Control": "no-store" })
  })

  it("getManifestSource resolves null → 503 + error body (no-store implied)", async () => {
    const grounding = groundingService({
      getManifestSource: vi.fn(async () => null),
    })
    const result = await handleManifestRequest(
      vi.fn(async () => grounding),
      "Button",
    )
    expect(result.status).toBe(503)
    expect(result.body).toEqual({
      error: "Manifest source unavailable (prototype root unreadable)",
    })
  })

  it("getGrounding rejects → 500 + failed-to-build-source error", async () => {
    const error = new Error("root not readable")
    const result = await handleManifestRequest(
      vi.fn(async () => {
        throw error
      }),
      "Button",
    )
    expect(result.status).toBe(500)
    expect(result.body).toEqual({
      error: "failed-to-build-source",
      detail: "root not readable",
    })
  })

  it("source.getComponent throws → 500 + manifest-resolution-failed error", async () => {
    const error = new Error("TS checker failed")
    const source = manifestSource({
      getComponent: vi.fn(async () => {
        throw error
      }),
    })
    const grounding = groundingService({
      getManifestSource: vi.fn(async () => source),
    })
    const result = await handleManifestRequest(
      vi.fn(async () => grounding),
      "Button",
    )
    expect(result.status).toBe(500)
    expect(result.body).toEqual({
      error: "manifest-resolution-failed",
      detail: "TS checker failed",
    })
  })

  it("source.listComponents throws → 500 + manifest-resolution-failed error", async () => {
    const error = new Error("list failed")
    const source = manifestSource({
      listComponents: vi.fn(async () => {
        throw error
      }),
    })
    const grounding = groundingService({
      getManifestSource: vi.fn(async () => source),
    })
    const result = await handleManifestRequest(
      vi.fn(async () => grounding),
      null,
    )
    expect(result.status).toBe(500)
    expect(result.body).toEqual({
      error: "manifest-resolution-failed",
      detail: "list failed",
    })
  })
})

describe("handleCatalogRequest", () => {
  it("happy path → 200 + buildCatalog output (array) + Cache-Control: no-store", async () => {
    const result = await handleCatalogRequest(
      vi.fn(async () => groundingService()),
    )
    expect(result.status).toBe(200)
    expect(Array.isArray(result.body)).toBe(true)
    expect(result.headers).toEqual({ "Cache-Control": "no-store" })
  })

  it("getManifestSource resolves null → 503 + error body", async () => {
    const grounding = groundingService({
      getManifestSource: vi.fn(async () => null),
    })
    const result = await handleCatalogRequest(
      vi.fn(async () => grounding),
    )
    expect(result.status).toBe(503)
    expect(result.body).toEqual({
      error: "Manifest source unavailable (prototype root unreadable)",
    })
  })

  it("getGrounding rejects → 500 + failed-to-build-source error", async () => {
    const error = new Error("root not readable")
    const result = await handleCatalogRequest(
      vi.fn(async () => {
        throw error
      }),
    )
    expect(result.status).toBe(500)
    expect(result.body).toEqual({
      error: "failed-to-build-source",
      detail: "root not readable",
    })
  })

  it("source.listComponents throws → 500 + catalog-build-failed error", async () => {
    const error = new Error("list failed")
    const source = manifestSource({
      listComponents: vi.fn(async () => {
        throw error
      }),
    })
    const grounding = groundingService({
      getManifestSource: vi.fn(async () => source),
    })
    const result = await handleCatalogRequest(
      vi.fn(async () => grounding),
    )
    expect(result.status).toBe(500)
    expect(result.body).toEqual({
      error: "catalog-build-failed",
      detail: "list failed",
    })
  })
})
