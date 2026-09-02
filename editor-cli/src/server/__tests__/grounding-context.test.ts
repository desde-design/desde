/**
 * Tests for grounding-context.ts — the process-memoized GroundingService
 * accessor that the manifest + design-tokens endpoints share.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  getGroundingService,
  resetGroundingCache,
  type GroundingLoaders,
} from "../grounding-context.js"
import type { GroundingHealth, GroundingService } from "../../../../src/editor/core"

function fakeService(health: GroundingHealth | null = null): GroundingService {
  return {
    getManifestSource: async () => null,
    tokens: {
      id: "fake",
      designSystem: "acme-ds",
      listTokens: async () => [],
      getToken: async () => null,
    },
    getProjectKnowledge: () => ({
      rules: "",
      rulesFiles: [],
      docIndex: [],
      truncated: false,
    }),
    getGroundingHealth: async () => health,
  }
}

function fakeHealth(): GroundingHealth {
  return {
    root: "/root",
    builtAt: new Date().toISOString(),
    sources: [
      { step: "first-party", sourceId: "a", discovered: 3, status: "ok" },
      { step: "acme-ds", sourceId: "b", discovered: 10, status: "ok" },
      { step: "extra", sourceId: "c", discovered: 0, status: "skipped", reason: "not installed" },
      { step: "broken", sourceId: "d", discovered: 0, status: "failed", reason: "parse error" },
    ],
    runtimeErrors: [
      { sourceId: "b", method: "listComponents", message: "boom", at: new Date().toISOString() },
    ],
  }
}

function loadersFor(
  createGroundingService: (opts: { root: string }) => GroundingService,
): GroundingLoaders {
  return {
    loadCreateGroundingService: async () =>
      ({ createGroundingService }) as unknown as Awaited<
        ReturnType<GroundingLoaders["loadCreateGroundingService"]>
      >,
  }
}

afterEach(() => resetGroundingCache())

describe("getGroundingService", () => {
  it("constructs once per root and memoizes the service", async () => {
    const createGroundingService = vi.fn(() => fakeService())
    const loaders = loadersFor(createGroundingService)

    const a = await getGroundingService("/root", loaders)
    const b = await getGroundingService("/root", loaders)

    expect(a).toBe(b)
    expect(createGroundingService).toHaveBeenCalledTimes(1)
    expect(createGroundingService).toHaveBeenCalledWith({ root: "/root" })
  })

  it("rebuilds when the canonical root changes", async () => {
    const createGroundingService = vi.fn(() => fakeService())
    const loaders = loadersFor(createGroundingService)

    await getGroundingService("/root-a", loaders)
    await getGroundingService("/root-b", loaders)

    expect(createGroundingService).toHaveBeenCalledTimes(2)
  })

  it("does not cache a failed construction (next call retries)", async () => {
    let calls = 0
    const loaders: GroundingLoaders = {
      loadCreateGroundingService: async () => {
        calls += 1
        if (calls === 1) throw new Error("import failed")
        return { createGroundingService: () => fakeService() } as unknown as Awaited<
          ReturnType<GroundingLoaders["loadCreateGroundingService"]>
        >
      },
    }

    await expect(getGroundingService("/root", loaders)).rejects.toThrow(
      "import failed",
    )
    const service = await getGroundingService("/root", loaders)
    expect(service).toBeDefined()
    expect(calls).toBe(2)
  })
})

describe("getGroundingService boot log", () => {
  it("logs one [grounding] summary line after the first successful getManifestSource() resolution", async () => {
    const logs: string[] = []
    const loaders: GroundingLoaders = {
      loadCreateGroundingService: async () =>
        ({ createGroundingService: () => fakeService(fakeHealth()) }) as unknown as Awaited<
          ReturnType<GroundingLoaders["loadCreateGroundingService"]>
        >,
      logger: (msg) => logs.push(msg),
    }

    const service = await getGroundingService("/root", loaders)
    await service.getManifestSource()

    expect(logs).toEqual(["[grounding] 2 sources, 1 skipped, 2 failed (/root)"])
  })

  it("logs only once even when getManifestSource() resolves repeatedly", async () => {
    const logs: string[] = []
    const loaders: GroundingLoaders = {
      loadCreateGroundingService: async () =>
        ({ createGroundingService: () => fakeService(fakeHealth()) }) as unknown as Awaited<
          ReturnType<GroundingLoaders["loadCreateGroundingService"]>
        >,
      logger: (msg) => logs.push(msg),
    }

    const service = await getGroundingService("/root", loaders)
    await service.getManifestSource()
    await service.getManifestSource()
    const other = await getGroundingService("/root", loaders)
    await other.getManifestSource()

    expect(logs).toHaveLength(1)
  })

  it("logs exactly once when two getManifestSource() calls race concurrently", async () => {
    // Regression test for a TOCTOU race: the boot-log guard used to check
    // `loggedBootSummary`, `await getGroundingHealth()`, then set the flag —
    // two concurrent callers (realistic: manifest + catalog requests firing
    // together on cold boot) could both pass the check before either set it,
    // producing two boot lines. The fix reserves the flag synchronously
    // before the await, so only one of the two calls below logs.
    const logs: string[] = []
    const loaders: GroundingLoaders = {
      loadCreateGroundingService: async () =>
        ({ createGroundingService: () => fakeService(fakeHealth()) }) as unknown as Awaited<
          ReturnType<GroundingLoaders["loadCreateGroundingService"]>
        >,
      logger: (msg) => logs.push(msg),
    }

    const service = await getGroundingService("/root", loaders)
    await Promise.all([service.getManifestSource(), service.getManifestSource()])

    expect(logs).toEqual(["[grounding] 2 sources, 1 skipped, 2 failed (/root)"])
  })

  it("does not log when health is still null after resolution", async () => {
    const logs: string[] = []
    const loaders: GroundingLoaders = {
      loadCreateGroundingService: async () =>
        ({ createGroundingService: () => fakeService(null) }) as unknown as Awaited<
          ReturnType<GroundingLoaders["loadCreateGroundingService"]>
        >,
      logger: (msg) => logs.push(msg),
    }

    const service = await getGroundingService("/root", loaders)
    await service.getManifestSource()

    expect(logs).toHaveLength(0)
  })

  it("defaults the logger to console.log when not injected", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const loaders: GroundingLoaders = {
      loadCreateGroundingService: async () =>
        ({ createGroundingService: () => fakeService(fakeHealth()) }) as unknown as Awaited<
          ReturnType<GroundingLoaders["loadCreateGroundingService"]>
        >,
    }

    const service = await getGroundingService("/root", loaders)
    await service.getManifestSource()

    expect(consoleSpy).toHaveBeenCalledWith(
      "[grounding] 2 sources, 1 skipped, 2 failed (/root)",
    )
    consoleSpy.mockRestore()
  })
})
